import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState
} from '@microsoft/signalr';

import { Effect, Exit, Fiber, Option, Queue, Schedule } from 'effect';
import { RuntimeFiber } from 'effect/Fiber';
import { isObject } from 'effect/Predicate';
import { ParseError } from 'effect/ParseResult';

import {
  AcaadEvent,
  AcaadHost,
  AcaadPopulatedEvent,
  AcaadServerConnectedEvent,
  AcaadServerDisconnectedEvent,
  AcaadServerUnreachableError,
  AcaadUnhandledEventReceivedEvent,
  CalloutError,
  EventFactory,
  ICsLogger
} from '@acaad/abstractions';

const CONST = {
  EVENT_HUB_PATH: 'events',
  RECEIVE_EVENTS_METHOD: 'receiveEvent'
};

const isServerUnavailable = (err: unknown): boolean => {
  return isObject(err) && 'errorType' in err && err.errorType === 'FailedToNegotiateWithServerError';
};

// noinspection JSPotentiallyInvalidUsageOfClassThis
export class HubConnectionWrapper {
  private hubConnection: HubConnection;
  private reconnectFiber: RuntimeFiber<number, CalloutError>;

  constructor(
    public host: AcaadHost,
    private eventQueue: Queue.Queue<AcaadPopulatedEvent>,
    private logger: ICsLogger
  ) {
    const signalrUrl = host.appendSignalR(CONST.EVENT_HUB_PATH);

    const hubConnection = new HubConnectionBuilder()
      .withUrl(signalrUrl, {
        skipNegotiation: true,
        transport: HttpTransportType.WebSockets,
        withCredentials: false // TODO: Obvious..
      })
      .build();

    hubConnection.on(CONST.RECEIVE_EVENTS_METHOD, this.buildEventCallback(host));
    hubConnection.onclose((err) => {
      if (err !== undefined) {
        this.logger.logError(undefined, err, `An error occurred in hub connection ${host.friendlyName}.`);
      }

      Effect.runSync(this.raiseHubStoppedEvent(host));
    });

    this.hubConnection = hubConnection;

    this.logger.logDebug(`Hub connection to ${host.friendlyName} created.`);

    const reconnectEff = this.tryReconnectEff.pipe(Effect.repeat(Schedule.fixed(5_000)));
    this.reconnectFiber = Effect.runSync(Effect.forkDaemon(reconnectEff));
  }

  private tryReconnectEff = Effect.gen(this, function* () {
    if (this.hubConnection.state !== HubConnectionState.Disconnected) {
      return;
    }

    return yield* Effect.either(this.startEff);
  });

  public startEff = Effect.gen(this, function* () {
    if (this.hubConnection.state !== HubConnectionState.Disconnected) {
      return;
    }

    yield* Effect.tryPromise({
      try: async (_) => {
        await this.hubConnection.start();
      },
      catch: (err) => {
        this.logger.logError(undefined, undefined, (err as any).toString());

        if (isServerUnavailable(err)) {
          return new AcaadServerUnreachableError(this.host, err);
        }

        return new CalloutError('An unexpected error occurred starting hub connection', err);
      }
    });

    this.logger.logTrace(`(Re)connected to '${this.host.friendlyName}'.`);
    yield* this.raiseHubStartedEvent(this.host);
  });

  private buildEventCallback(host: AcaadHost): (event: unknown) => Promise<void> {
    return async (event: unknown) => {
      const result = await Effect.runPromiseExit(this.onEventEff(host, event));

      Exit.match(result, {
        onFailure: (cause) =>
          this.logger.logError(cause, undefined, `An error occurred processing inbound event.`),
        onSuccess: (res) => {
          this.logger.logTrace(`Successfully processed/enqueued event ${res.toString()}.`);
        }
      });
    };
  }

  private onEventEff(host: AcaadHost, eventUntyped: unknown): Effect.Effect<AcaadEvent, ParseError> {
    return Effect.gen(this, function* () {
      const event = yield* EventFactory.createEvent(eventUntyped);

      const transformedEvent = Option.isSome(event)
        ? { ...event.value, host }
        : new AcaadUnhandledEventReceivedEvent(host, eventUntyped);

      yield* Queue.offer(this.eventQueue, transformedEvent);

      return transformedEvent;
    });
  }

  private raiseHubStartedEvent(host: AcaadHost): Effect.Effect<boolean> {
    this.logger.logDebug(`Hub connection to ${host.friendlyName} started.`);
    return this.eventQueue.offer(new AcaadServerConnectedEvent(host));
  }

  private raiseHubStoppedEvent(host: AcaadHost): Effect.Effect<boolean> {
    return this.eventQueue.offer(new AcaadServerDisconnectedEvent(host));
  }

  public stopHubConnection = Effect.gen(this, function* () {
    this.logger.logTrace(`Shutting down hub connection to server ${this.host.friendlyName}.`);

    yield* Fiber.interrupt(this.reconnectFiber);

    yield* Effect.tryPromise({
      try: () => this.hubConnection.stop(),
      catch: (err) => new CalloutError('Error stopping hub connection', err)
    });

    this.logger.logInformation(`Shut down hub connection to server ${this.host.friendlyName}.`);
  });
}
