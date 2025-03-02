import {
  AcaadPopulatedMetadata,
  AcaadServerMetadata,
  getAcaadMetadata,
  IConnectedServiceAdapter,
  ChangeType,
  AcaadEvent,
  AcaadPopulatedEvent,
  ICsLogger,
  AcaadError,
  CalloutError,
  Component,
  AcaadMetadata,
  AcaadHost,
  AcaadServerUnreachableError,
  ComponentCommandOutcomeEvent,
  AcaadServerConnectedEvent,
  AcaadServerDisconnectedEvent,
  AcaadUnhandledEventReceivedEvent,
  ComponentDescriptor,
  ApplicationState
} from '@acaad/abstractions';

import { inject, injectable } from 'tsyringe';
import { DependencyInjectionTokens } from './model/DependencyInjectionTokens';

import { ConnectionManager } from './ConnectionManager';

import { Semaphore } from 'effect/Effect';

import { equals } from 'effect/Equal';
import { RuntimeFiber } from 'effect/Fiber';

import { IMetadataModel } from './MetadataModel';
import { Resource } from 'effect/Resource';
import { Configuration } from '@effect/opentelemetry/src/NodeSdk';

import {
  Cause,
  Chunk,
  Data,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  GroupBy,
  Layer,
  ManagedRuntime,
  Option,
  Queue,
  Schedule,
  Stream
} from 'effect';

import { QueueWrapper } from './QueueWrapper';
import { onErrorEff, executeCsAdapter, nameof } from './utility';

class MetadataByComponent extends Data.Class<{ component: Component; metadata: AcaadMetadata[] }> {}

// noinspection JSPotentiallyInvalidUsageOfClassThis
@injectable()
export class ComponentManager {
  private _appState: ApplicationState;

  private _serviceAdapter: IConnectedServiceAdapter;
  private _abortController: AbortController;
  private _connectionManager: ConnectionManager;
  private _metadataModel: IMetadataModel;

  private _logger: ICsLogger;
  public _eventQueue: Queue.Queue<AcaadPopulatedEvent>;
  private _openTelLayer: () => Layer.Layer<Resource<Configuration>>;

  public constructor(
    @inject(DependencyInjectionTokens.ConnectedServiceAdapter) serviceAdapter: IConnectedServiceAdapter,
    @inject(DependencyInjectionTokens.ConnectionManager) connectionManager: ConnectionManager,
    @inject(DependencyInjectionTokens.Logger) logger: ICsLogger,
    @inject(DependencyInjectionTokens.EventQueue) eventQueueWrapper: QueueWrapper,
    @inject(DependencyInjectionTokens.MetadataModel) metadataModel: IMetadataModel,
    @inject(DependencyInjectionTokens.OpenTelLayer) openTelLayer: () => Layer.Layer<Resource<Configuration>>
  ) {
    this._appState = 'Initialized';
    this._abortController = new AbortController();

    this._connectionManager = connectionManager;
    this._serviceAdapter = serviceAdapter;
    this._metadataModel = metadataModel;

    this._logger = logger;
    this._eventQueue = eventQueueWrapper.getQueue();
    this._openTelLayer = openTelLayer;

    this.handleOutboundStateChangeAsync = this.handleOutboundStateChangeAsync.bind(this);
    this.processComponentsByServer = this.processComponentsByServer.bind(this);
    this.getServerMetadata = this.getServerMetadata.bind(this);
    this.processSingleComponent = this.processSingleComponent.bind(this);

    this.checkConnectedServiceAdapter();
  }

  public getState(): ApplicationState {
    return this._appState;
  }

  private checkConnectedServiceAdapter() {
    if (this._serviceAdapter.shouldSyncMetadataOnServerConnect()) {
      if (
        this._serviceAdapter.shouldSyncMetadata === undefined &&
        this._serviceAdapter.getMetadataSyncInterval === undefined
      ) {
        throw new Error(
          `Programming error: If '${nameof<IConnectedServiceAdapter>('shouldSyncMetadataOnServerConnect')}' returns true, either '${nameof<IConnectedServiceAdapter>('getMetadataSyncInterval')}' or '${nameof<IConnectedServiceAdapter>('shouldSyncMetadata')}' MUST be implemented.`
        );
      }
    }
  }

  syncMetadataEff(hosts?: AcaadHost[]) {
    return Effect.gen(this, function* () {
      const serverMetadata: Stream.Stream<Either.Either<AcaadServerMetadata, AcaadError>> =
        yield* this.queryComponentConfigurations(hosts);

      // TODO: Partition by OpenApiDefinition, ResponseSchemaError, ConnectionRefused (or whatever Axios returns)
      // Then continue processing only OpenApiDefinition.
      const partition = serverMetadata.pipe(
        Stream.partition((e) => Either.isRight(e)),
        Effect.withSpan('acaad:sync:partition')
      );

      const res = Effect.scoped(
        Effect.gen(this, function* () {
          const [failed, openApiDefinitions] = yield* partition;

          const availableServers = openApiDefinitions.pipe(
            Stream.map((r) => r.right),
            Stream.withSpan('acaad:sync:map-right')
          );

          const groupedByServer = this.createMetadataByServer(availableServers);

          const createRes = yield* this.updateConnectedServiceModel(groupedByServer).pipe(
            Effect.withSpan('acaad:sync:cs:refresh-metadata')
          );

          return yield* Stream.runCollect(
            failed.pipe(
              Stream.map((l) => l.left),
              Stream.tap((e) => onErrorEff(this._serviceAdapter, e)),
              Stream.groupByKey((e) => e._tag),
              GroupBy.evaluate((tag, errors) =>
                Effect.gen(this, function* () {
                  // TODO: Improve error handling :)

                  if (tag === AcaadServerUnreachableError.Tag) {
                    const unreachableErrors = yield* Stream.runCollect(
                      errors.pipe(
                        Stream.map((e) => e as AcaadServerUnreachableError),
                        Stream.map(
                          (unreachable) =>
                            `'${unreachable.host.friendlyName}'->${unreachable.host.host}:${unreachable.host.port}`
                        )
                      )
                    );

                    this._logger.logWarning(
                      `The following server(s) are unreachable: [${Chunk.toArray(unreachableErrors).join(', ')}]`
                    );
                    return Effect.succeed(undefined);
                  }

                  const otherErrors = yield* Stream.runCollect(errors);

                  this._logger.logWarning(
                    `The following server(s) did not respond in the expected way: [${Chunk.toArray(otherErrors).join(', ')}]`
                  );

                  const errorsChunked = Stream.runCollect(errors);
                  return Effect.fail(
                    new AcaadError(
                      errorsChunked,
                      'One or more unhandled errors occurred. This should never happen.'
                    )
                  );
                })
              )
            )
          ).pipe(Effect.withSpan('acaad:sync:run-collect'));
        })
      );

      return yield* res;
    });
  }

  public async createMissingComponentsAsync(): Promise<boolean> {
    this._logger.logInformation('Syncing components from ACAAD servers.');

    const result = await Effect.runPromiseExit(
      this.syncMetadataEff().pipe(
        Effect.withSpan('acaad:sync'),
        Effect.provide(this._openTelLayer()),
        Effect.tapError((err) => onErrorEff(this._serviceAdapter, err))
      )
    );

    return Exit.match(result, {
      onFailure: (cause) => {
        this._logger.logWarning(`Exited with failure state: ${Cause.pretty(cause)}`, cause.toJSON());
        return false;
      },
      onSuccess: (_) => {
        this._logger.logInformation('Successfully created missing components.');
        return true;
      }
    });
  }

  private getServerMetadata(host: AcaadHost): Effect.Effect<Either.Either<AcaadServerMetadata, AcaadError>> {
    return Effect.gen(this, function* () {
      const metadata = yield* this._connectionManager.queryComponentConfigurationAsync(host).pipe(
        Effect.withSpan('acaad:sync:query:api', {
          attributes: {
            host: host.friendlyName
          }
        })
      );

      return Either.map(
        metadata,
        (openApi) =>
          ({
            ...openApi,
            friendlyName: host.friendlyName,
            host: host
          }) as AcaadServerMetadata
      );
    });
  }

  queryComponentConfigurations(hosts?: AcaadHost[]) {
    return Effect.gen(this, function* () {
      let configuredServers: AcaadHost[];
      if (hosts !== undefined) {
        configuredServers = hosts;
      } else {
        configuredServers = yield* this._connectionManager.getHosts;
      }

      const concurrency = this._serviceAdapter.getAllowedConcurrency();

      return Stream.fromIterable(configuredServers).pipe(
        Stream.mapEffect(this.getServerMetadata, {
          concurrency
        })
      );
    });
  }

  createComponentHierarchy = (
    allMetadata: Stream.Stream<AcaadPopulatedMetadata>
  ): Stream.Stream<Option.Option<Component>> => {
    return allMetadata.pipe(
      Stream.groupByKey((m) => `${m.serverMetadata.host.friendlyName}.${m.component.name}`),
      GroupBy.evaluate((key: string, metadata: Stream.Stream<AcaadPopulatedMetadata>) =>
        Effect.gen(this, function* () {
          const m = yield* Stream.runCollect(metadata);
          this._logger.logTrace(`Generating metadata for component ${key}.`);
          return Component.fromMetadata(m);
        })
      )
    );
  };

  private createMetadataByServer(
    serverMetadata: Stream.Stream<AcaadServerMetadata>
  ): GroupBy.GroupBy<AcaadServerMetadata, Component> {
    return serverMetadata.pipe(
      Stream.tap(this._metadataModel.clearServerMetadata),
      Stream.flatMap(getAcaadMetadata),
      this.createComponentHierarchy,
      Stream.filter((cOpt) => Option.isSome(cOpt)),
      Stream.map((cSome) => cSome.value),
      Stream.groupByKey((c) => c.serverMetadata)
    );
  }

  private updateConnectedServiceModel(acaadServerMetadata: GroupBy.GroupBy<AcaadServerMetadata, Component>) {
    return Effect.gen(this, function* () {
      const sem = yield* Effect.makeSemaphore(this._serviceAdapter.getAllowedConcurrency());

      const start = Date.now();
      const stream = acaadServerMetadata.pipe(
        GroupBy.evaluate((server, components) =>
          Effect.gen(this, function* () {
            const componentChunk = yield* this._metadataModel.populateServerMetadata(server, components);

            yield* this.processServerWithSemaphore(server, sem);
            const componentResult = yield* this.processComponentsWithSemaphore(
              server.host.friendlyName,
              componentChunk,
              sem
            );
            this._metadataModel.onServerMetadataSynced(server.host);
            return componentResult;
          })
        )
      );

      const chunked = yield* Stream.runCollect(stream);
      const flattened = Chunk.flatMap(chunked, (r) => r);

      this._logger.logInformation(
        `Processing ${flattened.length} components of ${chunked.length} servers took ${Date.now() - start}ms.`
      );

      return chunked;
    });
  }

  private processServerWithSemaphore(
    server: AcaadServerMetadata,
    sem: Semaphore
  ): Effect.Effect<void, AcaadError> {
    return Effect.gen(this, function* () {
      yield* sem.take(1).pipe(Effect.withSpan('acaad:sem:wait'));
      const res = executeCsAdapter(this._serviceAdapter, 'createServerModelAsync', (ad, as) =>
        ad.createServerModelAsync(server, as)
      ).pipe(
        Effect.withSpan('acaad:sync:cs:server-metadata', {
          attributes: {
            server: server.host.friendlyName
          }
        })
      );

      yield* sem.release(1);

      return yield* res;
    });
  }

  private processComponentsWithSemaphore(
    friendlyName: string,
    components: Chunk.Chunk<Component>,
    sem: Semaphore
  ) {
    return Effect.gen(this, function* () {
      yield* sem.take(1).pipe(Effect.withSpan('acaad:sem:wait'));
      this._logger.logDebug(`Processing components for server: '${friendlyName}'.`);
      const res = this.processComponentsByServer(friendlyName, components);
      yield* sem.release(1);

      return yield* res;
    });
  }

  private processComponentsByServer(
    friendlyName: string,
    components: Chunk.Chunk<Component>
  ): Effect.Effect<Chunk.Chunk<string>, AcaadError> {
    return Effect.gen(this, function* () {
      return yield* Stream.runCollect(
        Stream.fromIterable(components).pipe(Stream.mapEffect(this.processSingleComponent))
      ).pipe(
        Effect.withSpan('acaad:sync:cs:component-metadata', {
          attributes: {
            server: friendlyName
          }
        })
      );
    });
  }

  private processSingleComponent(cmp: Component): Effect.Effect<string, AcaadError> {
    return Effect.gen(this, function* () {
      yield* executeCsAdapter(this._serviceAdapter, 'createComponentModelAsync', (ad, as) =>
        ad.createComponentModelAsync(cmp, as)
      );

      return cmp.name;
    });
  }

  async handleOutboundStateChangeAsync(
    host: AcaadHost,
    componentDescriptor: ComponentDescriptor,
    type: ChangeType,
    value: Option.Option<unknown>
  ): Promise<boolean> {
    const componentOpt = this._metadataModel.getComponentByDescriptor(host, componentDescriptor);

    if (Option.isNone(componentOpt)) {
      this._logger.logWarning(
        `Could not find component by host ${host.friendlyName} and descriptor ${componentDescriptor.toIdentifier()}. This is either a problem in the connected service or the component is not yet synced.`
      );

      return Promise.resolve(false);
    }

    const component = componentOpt.value;

    this._logger.logDebug(
      `Handling outbound state (type=${type}) change for component ${host.friendlyName}:${component.name} and value ${value}.`
    );

    const metadadataFilter = this.getMetadataFilter(type, value);

    const potentialMetadata = Stream.fromIterable(component.metadata).pipe(Stream.filter(metadadataFilter));

    const result = await Effect.runPromiseExit(
      this.getMetadataToExecuteOpt(potentialMetadata).pipe(
        Effect.andThen((m) =>
          this._connectionManager
            .updateComponentStateAsync(m)
            .pipe(Effect.withSpan('acaad:events:outbound:api'))
        ),
        Effect.tapError((err) => onErrorEff(this._serviceAdapter, err)),
        Effect.withSpan('acaad:events', {
          parent: undefined,
          root: true,
          attributes: {
            server: host.friendlyName,
            ['component-name']: component.name
          }
        }),
        Effect.provide(this._openTelLayer())
      )
    );

    Exit.match(result, {
      onFailure: (cause) =>
        this._logger.logError(
          cause,
          undefined,
          `Outbound state change handling failed for component ${component.name}.`
        ),
      onSuccess: (_) => {
        this._logger.logInformation(`Successfully updated outbound state for component ${component.name}.`);
      }
    });

    return Exit.isSuccess(result);
  }

  handleInboundStateChangeAsync(event: AcaadPopulatedEvent): Effect.Effect<void, AcaadError> {
    const isComponentCommandOutcomeEvent = (e: AcaadEvent): e is ComponentCommandOutcomeEvent =>
      e.name === 'ComponentCommandOutcomeEvent';

    return Effect.gen(this, function* () {
      if (!isComponentCommandOutcomeEvent(event)) {
        return;
      }

      this._logger.logTrace(
        `Received event '${event.name}::${event.component.name}' from host ${event.host.friendlyName}`
      );

      const component = this._metadataModel.getComponentByMetadata(event.host, event.component);

      if (Option.isSome(component)) {
        const cd = this._serviceAdapter.getComponentDescriptorByComponent(component.value);

        yield* executeCsAdapter(this._serviceAdapter, 'updateComponentStateAsync', (ad, as) =>
          ad.updateComponentStateAsync(
            cd,
            { originalOutcome: event.outcome, determinedTargetState: Option.none<unknown>() },
            as
          )
        ).pipe(Effect.withSpan('acaad:cs:updateComponentState'));
      } else {
        this._logger.logWarning(
          `Received event for unknown component '${event.name}' from host ${event.host.friendlyName}`
        );

        return yield* executeCsAdapter(
          this._serviceAdapter,
          'onUnmappedComponentEventAsync',
          (ad, as) =>
            ad.onUnmappedComponentEventAsync?.call(this._serviceAdapter, event, as) ?? Promise.resolve()
        ).pipe(Effect.withSpan('acaad:cs:onUnmappedComponentEvent'));
      }
    });
  }

  private getMetadataToExecuteOpt(
    stream: Stream.Stream<AcaadPopulatedMetadata>
  ): Effect.Effect<AcaadPopulatedMetadata, AcaadError> {
    return Effect.gen(this, function* () {
      const metadata = yield* Stream.runCollect(stream);

      if (metadata.length === 0) {
        const msg = 'No executable metadata/endpoint information found for component.';
        this._logger.logWarning(msg);
        return yield* Effect.fail(new CalloutError(msg));
      }
      if (metadata.length > 1) {
        const msg = 'Identified too many metadata applicable for execution. Do not know what to do.';
        this._logger.logWarning(msg);
        return yield* Effect.fail(new CalloutError(msg));
      }

      return Chunk.toArray(metadata)[0];
    });
  }

  private getMetadataFilter(type: ChangeType, v: Option.Option<unknown>): (m: AcaadMetadata) => boolean {
    switch (type) {
      case 'action':
        return (m) =>
          !!m.actionable &&
          // Match provided (CS) value only if the metadata specifically defines a reference value.
          // If not defined in metadata, ignore value coming from CS.
          (Option.isNone(m.forValue) || (Option.isSome(m.forValue) && equals(m.forValue, v)));
      case 'query':
        return (m) => !!m.queryable;
    }
  }

  private startEff() {
    return Effect.gen(this, function* () {
      yield* this.startEventListener.pipe(Effect.withSpan('acaad:startup:start-event-listener'));

      yield* this._connectionManager.startMissingHubConnections.pipe(
        Effect.withSpan('acaad:startup:start-hub-connections')
      );

      yield* executeCsAdapter(this._serviceAdapter, 'registerStateChangeCallbackAsync', (ad, as) =>
        ad.registerStateChangeCallbackAsync(this.handleOutboundStateChangeAsync, as)
      ).pipe(Effect.withSpan('acaad:startup:cs:register-state-chance-callback'));
    });
  }

  async startAsync(): Promise<boolean> {
    this._logger.logInformation(`Starting component manager.`);
    this._appState = 'Starting';

    const result = await Effect.runPromiseExit(
      this.startEff().pipe(
        Effect.withSpan('acaad:startup'),
        Effect.provide(this._openTelLayer()),
        Effect.tapError((err) => onErrorEff(this._serviceAdapter, err))
      )
    );

    Exit.match(result, {
      onFailure: (cause) =>
        this._logger.logError(cause, undefined, `An error occurred starting component manager.`),
      onSuccess: (_) => {
        this._logger.logInformation(`Started component manager. Listening for events..`);
      }
    });

    this._logger.logInformation('Started.');
    this._appState = Exit.isSuccess(result) ? 'Running' : 'Crashed';

    return Exit.isSuccess(result);
  }

  private listenerFiber: RuntimeFiber<void | number> | null = null;
  private startEventListener = Effect.gen(this, function* () {
    this.listenerFiber = yield* Effect.forkDaemon(
      // TODO: Use error handler (potentially sharable with comp. model creation)
      this.runEventListener.pipe(
        Effect.onError((err) => {
          if (Cause.isInterruptType(err)) {
            this._logger.logDebug(
              'Event listener fiber was interrupted. This is normal in a graceful shutdown.'
            );
            return Effect.void;
          }

          this._logger.logError(err, undefined, 'An error occurred processing event.');
          return Effect.void;
        }),
        Effect.either,
        Effect.repeat(Schedule.forever),
        Effect.provide(Layer.fresh(this._openTelLayer()))
      )
    );
  });

  private runEventListener = Effect.gen(this, function* () {
    const event = yield* Queue.take(this._eventQueue);
    const instrumented = this.processEventWithSpan(event).pipe(
      Effect.withSpan('acaad:events', {
        parent: undefined,
        root: true
      }),
      Effect.tapError((err) => onErrorEff(this._serviceAdapter, err))
    );

    return yield* instrumented;
  });

  private shouldSyncMetadataIntervalBased(lastSyncOpt: number | undefined): boolean {
    if (this._serviceAdapter.getMetadataSyncInterval === undefined) {
      return false;
    }

    const durationPrim = this._serviceAdapter.getMetadataSyncInterval();
    const durationOpt = Duration.decodeUnknown(durationPrim);

    if (Option.isNone(durationOpt)) {
      this._logger.logError(
        undefined,
        undefined,
        `Could not parse duration '${durationPrim}' provided by service adapter. Ignoring time-based resync.`
      );

      return false;
    }

    const duration = durationOpt.value;
    if (duration === Duration.infinity) {
      // Never resync on duration 'infinity'
      return false;
    }

    if (lastSyncOpt === undefined) {
      return true;
    }

    return Date.now() > lastSyncOpt + Duration.toMillis(duration);
  }

  private shouldSyncMetadata(host: AcaadHost): boolean {
    if (!this._serviceAdapter.shouldSyncMetadataOnServerConnect()) {
      return false;
    }

    const lastSyncOpt = this._metadataModel.getLastSyncByServer(host);

    const shouldSyncFromInterval = this.shouldSyncMetadataIntervalBased(lastSyncOpt);
    const shouldSyncForHost =
      this._serviceAdapter.shouldSyncMetadata?.call(this._serviceAdapter, host, lastSyncOpt) ?? false;

    return shouldSyncFromInterval || shouldSyncForHost;
  }

  private processEventWithSpan(event: AcaadPopulatedEvent) {
    return Effect.gen(this, function* () {
      yield* Effect.annotateCurrentSpan('event:name', event.name);

      if (event.name === 'ComponentCommandOutcomeEvent') {
        return yield* this.handleInboundStateChangeAsync(event);
      }

      if (event.name === AcaadServerConnectedEvent.Tag) {
        this._logger.logDebug(`Events: Server ${event.host.friendlyName} connected.`);

        if (this.shouldSyncMetadata(event.host)) {
          yield* this.syncMetadataEff([event.host]).pipe(
            Effect.withSpan('acaad:sync'),
            Effect.tapError((err) => onErrorEff(this._serviceAdapter, err))
          );
        }

        const result = yield* executeCsAdapter(this._serviceAdapter, 'onServerConnectedAsync', (ad, as) =>
          ad.onServerConnectedAsync(event.host, as)
        ).pipe(Effect.withSpan('acaad:cs:onServerConnected'));

        return result;
      }

      if (event.name === AcaadServerDisconnectedEvent.Tag) {
        return yield* executeCsAdapter(this._serviceAdapter, 'onServerDisconnectedAsync', (ad, as) =>
          ad.onServerDisconnectedAsync(event.host, as)
        ).pipe(Effect.withSpan('acaad:cs:onServerDisconnected'));
      }

      if (event.name === AcaadUnhandledEventReceivedEvent.Tag) {
        this._logger.logDebug(`Discarded unhandled server2client event: '${event.name}'`);
        this._logger.logTrace(`Dropped event full: '${JSON.stringify(event)}'.`);

        return yield* executeCsAdapter(
          this._serviceAdapter,
          'onUnhandledEventAsync',
          (ad, as) =>
            ad.onUnhandledEventAsync?.call(
              this._serviceAdapter,
              event as AcaadUnhandledEventReceivedEvent,
              as
            ) ?? Promise.resolve()
        ).pipe(Effect.withSpan('acaad:cs:onUnhandledEvent'));
      }

      this._logger.logWarning(`Discarded valid, but unhandled event: '${event.name}'`);
      return yield* Effect.void;
    });
  }

  private shutdownEventQueue = Effect.gen(this, function* () {
    yield* Queue.shutdown(this._eventQueue);
  });

  private stopEff = Effect.gen(this, function* () {
    this._appState = 'Stopping';

    this._logger.logDebug(`Stopping hub connections.`);
    const connections = yield* this._connectionManager.stopHubConnections.pipe(
      Effect.withSpan('acaad:shutdown:stop-hub-connections')
    );

    this._logger.logDebug('Stopping event queue.');
    const eventQueue = yield* this.shutdownEventQueue.pipe(
      Effect.withSpan('acaad:shutdown:stop-event-queue')
    );

    this._logger.logDebug(`Interrupting event listener fiber.`);
    if (this.listenerFiber !== null) {
      yield* Fiber.interrupt(this.listenerFiber).pipe(
        Effect.withSpan('acaad:shutdown:interrupt-listener-fiber')
      );
    }

    this._logger.logDebug(`Shut down all concurrent processes.`);
    this._appState = 'Stopped';
  });

  async shutdownAsync(): Promise<void> {
    this._logger.logInformation('Stopping component manager.');

    const exit = await Effect.runPromiseExit(
      this.stopEff.pipe(
        Effect.withSpan('acaad:shutdown'),
        Effect.provide(Layer.fresh(this._openTelLayer())),
        Effect.tapError((err) => onErrorEff(this._serviceAdapter, err))
      )
    );

    Exit.match(exit, {
      onFailure: (cause) =>
        this._logger.logError(cause, undefined, `An error occurred stopping component manager.`),
      onSuccess: (_) => {
        this._logger.logInformation(`Successfully stopped component manager.`);
      }
    });
  }
}
