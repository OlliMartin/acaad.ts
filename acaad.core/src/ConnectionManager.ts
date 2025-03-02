import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';

import {
  AcaadError,
  AcaadEvent,
  AcaadHost,
  AcaadPopulatedMetadata,
  AcaadServerUnreachableError,
  CalloutError,
  IConnectedServiceAdapter,
  ICsLogger,
  ITokenCache,
  OAuth2Token,
  OpenApiDefinition,
  OpenApiDefinitionSchema,
  ResponseSchemaError,
  ResponseStatusCodeError,
  OpenApiDefinitionFactory
} from '@acaad/abstractions';

import { inject, injectable } from 'tsyringe';
import { DependencyInjectionTokens } from './model/DependencyInjectionTokens';

import { Context, Effect, Either, pipe, Schema, Stream } from 'effect';

import { map, mapLeft } from 'effect/Either';

import { HubConnectionWrapper } from './HubConnectionWrapper';
import { QueueWrapper } from './QueueWrapper';
import { executeCsAdapter } from './utility';
import { NoSuchElementException } from 'effect/Cause';

interface TraceHeaders {
  traceparent: string;
}

class AxiosSvc extends Context.Tag('axios')<AxiosSvc, { readonly instance: AxiosInstance }>() {}

// noinspection JSPotentiallyInvalidUsageOfClassThis
@injectable()
export class ConnectionManager {
  private readonly _openApiEndpoint = 'openapi/v1.json';

  private readonly axiosInstance: AxiosInstance;
  private readonly hubConnections: HubConnectionWrapper[] = [];

  constructor(
    @inject(DependencyInjectionTokens.Logger) private logger: ICsLogger,
    @inject(DependencyInjectionTokens.TokenCache) private tokenCache: ITokenCache,
    @inject(DependencyInjectionTokens.ConnectedServiceAdapter)
    private connectedServiceAdapter: IConnectedServiceAdapter,
    @inject(DependencyInjectionTokens.EventQueue)
    private eventQueueWrapper: QueueWrapper
  ) {
    this.axiosInstance = axios.create({
      headers: {
        'Content-Type': 'application/json'
      }
    });
    this.queryComponentConfigurationAsync = this.queryComponentConfigurationAsync.bind(this);
  }

  public getHosts = Effect.gen(this, function* () {
    return yield* executeCsAdapter(this.connectedServiceAdapter, 'getConnectedServersAsync', (ad, as) =>
      ad.getConnectedServersAsync(as)
    ).pipe(Effect.withSpan('acaad:cs:onServerDisconnected'));
  });

  private async retrieveAuthenticationAsync(): Promise<OAuth2Token> {
    // Logic to retrieve authentication token
    return new OAuth2Token(0, '', '', []);
  }

  public getTraceHeaders(): Effect.Effect<TraceHeaders> {
    return Effect.gen(this, function* () {
      const span = yield* Effect.currentSpan.pipe(
        Effect.catchAll((e: NoSuchElementException) => {
          this.logger.logError(
            undefined,
            undefined,
            "No current span found in effect context. Cannot populate 'traceparent' header. This is a programming error."
          );
          return Effect.makeSpan('acaad:sync:query:api:span-fallback');
        })
      );
      return {
        traceparent: `00-${span.traceId}-${span.spanId}-01`
      };
    });
  }

  private handleCalloutErrorEff(host: AcaadHost, error: unknown) {
    return Effect.gen(function* () {
      let resultError: AcaadError | undefined;

      if (error instanceof AxiosError) {
        const axiosError: AxiosError = error;

        if (axiosError.code === 'ECONNREFUSED') {
          resultError = new AcaadServerUnreachableError(host, axiosError);
        }

        if (axiosError.code === 'ERR_BAD_REQUEST' || axiosError.code === 'ERR_BAD_RESPONSE') {
          resultError = new ResponseStatusCodeError(host, 200, axiosError.status, axiosError);
        }
      }

      resultError ??= new CalloutError(error);

      yield* Effect.annotateCurrentSpan('raised-error', resultError);

      return resultError;
    }).pipe(Effect.withSpan('acaad:conn:error-mapper'));
  }

  queryComponentConfigurationAsync(
    host: AcaadHost
  ): Effect.Effect<Either.Either<OpenApiDefinition, AcaadError>> {
    this.logger.logDebug(`Querying component configuration from ${host.restBase()}.`);

    const requestUrl = host.append(this._openApiEndpoint);
    this.logger.logTrace('Using request URL:', requestUrl);

    const result = Effect.gen(this, function* () {
      const { instance } = yield* AxiosSvc;

      const request: AxiosRequestConfig = {
        method: 'get',
        url: requestUrl,
        headers: {
          ...(yield* this.getTraceHeaders())
        }
      };

      const res = yield* Effect.tryPromise({
        try: (abortSignal) => instance.request<OpenApiDefinition>({ ...request, signal: abortSignal }),
        catch: (err) => Effect.runSync(this.handleCalloutErrorEff(host, err))
      }).pipe(Effect.withSpan('acaad:sync:query:api:request-wait'));

      const openApi = yield* OpenApiDefinitionFactory.verifyResponsePayload(res.data).pipe(
        Effect.withSpan('acaad:sync:query:api:request-parse')
      );

      this.logger.logTrace(
        `Received acaad configuration with ${openApi.paths.length} paths from host ${host.friendlyName}.`
      );

      return openApi;
    });

    return Effect.provideService(result, AxiosSvc, {
      instance: this.axiosInstance
    }).pipe(Effect.either);
  }

  private executeComponentRequest(
    metadata: AcaadPopulatedMetadata
  ): Effect.Effect<AcaadEvent, AcaadError, AxiosSvc> {
    return Effect.gen(this, function* () {
      const { instance } = yield* AxiosSvc;

      const host = metadata.serverMetadata.host;
      const requestUrl = host.append(metadata.path);

      const request: AxiosRequestConfig = {
        method: metadata.method,
        url: requestUrl,
        headers: {
          ...(yield* this.getTraceHeaders())
        }
      };

      this.logger.logDebug(`Executing request generated from metadata: ${metadata.method}::${requestUrl}`);

      const response = yield* Effect.tryPromise({
        try: (abortSignal) => {
          return instance.request<AcaadEvent>({ ...request, signal: abortSignal });
        },
        catch: (err) => Effect.runSync(this.handleCalloutErrorEff(host, err))
      });

      return response.data;
    });
  }

  updateComponentStateAsync(metadata: AcaadPopulatedMetadata): Effect.Effect<AcaadEvent, AcaadError> {
    const eff = AxiosSvc.pipe(Effect.andThen(this.executeComponentRequest(metadata)));

    return Effect.provideService(eff, AxiosSvc, {
      instance: this.axiosInstance
    });
  }

  public startMissingHubConnections = Effect.gen(this, function* () {
    const hosts = yield* this.getHosts;

    const startedHosts = Stream.fromIterable(hosts).pipe(
      Stream.filter((host) => this.hubConnections.find((hc) => hc.host === host) === undefined),
      Stream.map((host) => new HubConnectionWrapper(host, this.eventQueueWrapper.getQueue(), this.logger)),
      Stream.tap((hc) => Effect.succeed(this.hubConnections.push(hc))),
      Stream.mapEffect((hc) => hc.startEff),
      Stream.either,
      Stream.runCollect
    );

    return yield* startedHosts;
  });

  public stopHubConnections = Effect.gen(this, function* () {
    this.logger.logTrace(`Stopping ${this.hubConnections.length} hub connections.`);

    const stopProcesses = Stream.fromIterable(this.hubConnections).pipe(
      Stream.mapEffect((hc) => hc.stopHubConnection),
      Stream.either,
      Stream.runCollect
    );

    return yield* stopProcesses;
  });
}
