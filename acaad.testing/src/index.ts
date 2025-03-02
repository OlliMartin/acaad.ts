import {
  AcaadApiServer,
  AcaadSignalRServer,
  IAcaadApiServer,
  IAcaadSignalRServer,
  TrackedRequest
} from './api';
import { AcaadAuthentication, AcaadHost, ComponentDescriptor, ComponentType } from '@acaad/abstractions';
import { v4 as uuidv4 } from 'uuid';
import { IComponentConfiguration, IPortConfiguration, MockedComponentDescriptor } from './api/types';

export { IComponentConfiguration, IAcaadServer } from './api/types';

export {
  AcaadApiServer,
  IAcaadApiServer,
  AcaadSignalRServer,
  IAcaadSignalRServer,
  IEventReceiver,
  TrackedRequest
} from './api';
export { delay, getRandomInt, LogFunc, getTestLogger } from './utility';

export class ServerMocks implements IAcaadApiServer, IAcaadSignalRServer {
  port: number;

  serverName: string;
  apiServer: IAcaadApiServer;
  signalrServer: IAcaadSignalRServer;

  constructor(apiServer: IAcaadApiServer, signalrServer: IAcaadSignalRServer) {
    this.serverName = `mock-${uuidv4()}`;

    this.apiServer = apiServer;
    this.port = apiServer.port;

    this.signalrServer = signalrServer;
  }

  static async createMockServersAsync(
    selectedCollection: string | undefined,
    componentConfiguration: IComponentConfiguration,
    ports?: IPortConfiguration
  ): Promise<ServerMocks> {
    const [apiServer, signalrServer] = await Promise.all([
      AcaadApiServer.createMockServerAsync(selectedCollection, componentConfiguration, ports),
      AcaadSignalRServer.createMockServerAsync(ports)
    ]);

    return new ServerMocks(apiServer, signalrServer);
  }

  public getRandomComponent(type: ComponentType): MockedComponentDescriptor {
    return this.apiServer.getRandomComponent(type);
  }

  public getHost(): AcaadHost {
    const auth = new AcaadAuthentication('', '', '', []);
    return new AcaadHost(this.serverName, 'localhost', this.apiServer.port, auth, this.signalrServer.port);
  }

  public async startAsync() {
    await Promise.all([this.apiServer.startAsync(), this.signalrServer.startAsync()]);
  }

  public async disposeAsync() {
    await Promise.all([this.apiServer.disposeAsync(), this.signalrServer.disposeAsync()]);
  }

  pushEvent(event: unknown): Promise<void> {
    return this.signalrServer.pushEvent(event);
  }
  enableRequestTracking(): void {
    this.apiServer.enableRequestTracking();
  }
  getTrackedRequests(traceId?: string, spanId?: string): TrackedRequest[] {
    return this.apiServer.getTrackedRequests(traceId, spanId);
  }

  async useCollectionAsync(collectionName: string): Promise<void> {
    return await this.apiServer.useCollectionAsync(collectionName);
  }

  clearTrackedRequests(): void {
    this.apiServer.enableRequestTracking();
  }

  async resetCollectionAsync(): Promise<void> {
    await this.apiServer.resetCollectionAsync();
  }

  async pauseAsync(): Promise<void> {
    await this.apiServer.pauseAsync();
  }

  async resumeAsync(): Promise<void> {
    return this.apiServer.resumeAsync();
  }
}
