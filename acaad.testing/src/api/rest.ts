import { IAcaadServer } from './index';
import { createServer } from '@mocks-server/main';
import { openApiRoutes } from '@mocks-server/plugin-openapi';

import openApi from './routes/open-api';
import collectionFactory from './collections';
import { getNextPortAsync, getRandomInt, getTestLogger, LogFunc } from '../utility';
import {
  IComponentConfiguration,
  IMockedComponentModel,
  IPortConfiguration,
  MockedComponentDescriptor,
  MockedSwitchComponentDescriptor
} from './types';
import { ComponentDescriptor, ComponentType, TraceInfo, ApplicationState } from '@acaad/abstractions';

export class TrackedRequest {
  url: string;
  method: string;
  headers: unknown;
  body: unknown;
  traceParent: string | undefined;
  traceInfo: TraceInfo | undefined;

  constructor(req: any) {
    this.url = req.url;
    this.method = req.method;
    this.headers = req.headers;
    this.body = req.body;

    this.traceParent = (this.headers as any).traceparent;

    if (this.traceParent) {
      this.traceInfo = new TraceInfo(this.traceParent);
    }
  }

  getTraceId(): string | undefined {
    return this.traceInfo?.traceId;
  }

  getSpanId(): string | undefined {
    return this.traceInfo?.spanId;
  }
}

export interface IAcaadApiServer extends IAcaadServer {
  getRandomComponent(type: ComponentType): MockedComponentDescriptor;

  enableRequestTracking(): void;
  getTrackedRequests(traceId?: string, spanId?: string): TrackedRequest[];
  clearTrackedRequests(): void;

  useCollectionAsync(collectionName: string): Promise<void>;
  resetCollectionAsync(): Promise<void>;

  pauseAsync(): Promise<void>;
  resumeAsync(): Promise<void>;
}

export class AcaadApiServer implements IAcaadApiServer {
  private server: any;

  private readonly componentConfiguration: IComponentConfiguration;
  public port: number;
  public adminPort: number;

  private readonly componentModel: IMockedComponentModel;
  private readonly log: LogFunc;

  private readonly collections: { id: string }[] = [];
  private loadedCollections: string[] = [];

  private readonly defaultCollection: string;
  private collectionOverride: string;

  private state: ApplicationState;

  private constructor(
    port: number,
    adminPort: number,
    selectedCollection: string | undefined,
    componentConfiguration: IComponentConfiguration
  ) {
    this.log = getTestLogger('Api');
    this.collections = collectionFactory();

    this.port = port;
    this.adminPort = adminPort;

    this.componentConfiguration = componentConfiguration;
    this.componentModel = AcaadApiServer.createComponentModel(componentConfiguration);

    this.requestTrackingMiddleware = this.requestTrackingMiddleware.bind(this);

    this.defaultCollection = selectedCollection ?? 'generated';
    this.collectionOverride = this.defaultCollection;

    this.state = 'Initialized';

    this.server = createServer({
      server: {
        port: port
      },
      mock: {
        collections: {
          selected: this.defaultCollection
        }
      },
      plugins: {
        adminApi: {
          port: adminPort
        }
      },
      // @ts-ignore
      log: global.__ENABLE_TEST_FWK_LOGS__ ? 'info' : 'silent'
    });
  }

  async pauseAsync(): Promise<void> {
    this.state = 'Stopping';
    await this.server.stop();
    this.state = 'Stopped';
  }
  async resumeAsync(): Promise<void> {
    if (this.state !== 'Running') {
      await this.server.start();
      this.state = 'Running';
    }
  }

  private static createComponentModel(
    componentConfiguration: IComponentConfiguration
  ): IMockedComponentModel {
    const prefix = componentConfiguration.componentPrefix ?? '';

    return {
      sensors: Array.from({ length: componentConfiguration.sensorCount ?? 0 }).map(
        (_, idx) => new ComponentDescriptor(`${prefix}sensor-${idx}`)
      ),
      buttons: Array.from({ length: componentConfiguration.buttonCount ?? 0 }).map(
        (_, idx) => new ComponentDescriptor(`${prefix}button-${idx}`)
      ),
      switches: Array.from({ length: componentConfiguration.switchCount ?? 0 }).map(
        (_, idx) => new MockedSwitchComponentDescriptor(`${prefix}switch-${idx}`)
      )
    };
  }

  public getRandomComponent(type: ComponentType): ComponentDescriptor {
    if (type === ComponentType.Sensor) {
      return AcaadApiServer.getRandomComponentInternal('sensor', this.componentModel.sensors);
    } else if (type === ComponentType.Button) {
      return AcaadApiServer.getRandomComponentInternal('button', this.componentModel.buttons);
    } else if (type === ComponentType.Switch) {
      return AcaadApiServer.getRandomComponentInternal('switch', this.componentModel.switches);
    } else {
      throw new Error(
        `Invalid type ${type}. Was it newly introduced? This needs to be fixed in the '@acaad/testing' project.`
      );
    }
  }

  private static getRandomComponentInternal(name: string, cdArray?: ComponentDescriptor[]) {
    const length = cdArray?.length ?? 0;

    if (length < 1) {
      throw new Error(
        `Cannot retrieve random ${name}. The passed configuration did define ${name}s to be generated.`
      );
    }

    const idx = getRandomInt(length - 1);
    return cdArray![idx];
  }

  async startAsync(): Promise<void> {
    this.state = 'Starting';

    await this.server.start();
    const { loadRoutes, loadCollections } = this.server.mock.createLoaders();
    const { route, generatedBody, realisticBody } = openApi(this.componentModel);

    const generatedComponentRoutes =
      this.componentConfiguration.suppressComponentEndpoints !== true
        ? await openApiRoutes({
            basePath: '/',
            document: { ...generatedBody }
          })
        : [];

    const realisticRoutes =
      this.componentConfiguration.suppressComponentEndpoints !== true
        ? await openApiRoutes({
            basePath: '/',
            document: { ...realisticBody }
          })
        : [];

    const middlewareVariantId = 'request-tracking-middleware';
    const globalMiddlewareRoute = {
      id: 'global-middleware',
      url: '*',
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      variants: [
        {
          id: middlewareVariantId,
          type: 'middleware',
          options: {
            middleware: this.requestTrackingMiddleware
          }
        }
      ]
    };

    const allRoutes = [globalMiddlewareRoute, ...route, ...generatedComponentRoutes, ...realisticRoutes];

    loadRoutes(allRoutes);

    const defaultRoutes = [`${globalMiddlewareRoute.id}:${middlewareVariantId}`];

    this.mergeRoutesInCollection(this.collections[1], defaultRoutes, generatedComponentRoutes, '200-status');

    const collCount = this.collections.length;
    this.mergeRoutesInCollection(
      this.collections[collCount - 1],
      defaultRoutes,
      realisticRoutes,
      '200-status'
    );

    const statusRegex = new RegExp('\\d{3}-status');

    this.collections
      .filter((coll) => {
        const res = statusRegex.test(coll.id);
        this.log(`Checked collection id: ${coll.id}; Result is: ${res}`);
        return res;
      })
      .map((coll) => ({ variantId: coll.id, collection: coll }))
      .forEach(({ variantId, collection }) =>
        this.mergeRoutesInCollection(collection, defaultRoutes, generatedComponentRoutes, variantId)
      );

    loadCollections(this.collections);

    this.collections.forEach((c) => this.loadedCollections.push(c.id));

    this.state = 'Running';
  }

  mergeRoutesInCollection(collection: any, defaultRoutes: any, additionalRoutes: any, variantId: string) {
    this.log(`Merging collection with id=${collection.id} and ${collection.routes.length} routes.`);

    collection.routes = additionalRoutes
      // @ts-ignore
      .map((route) =>
        route.variants
          // @ts-ignore
          .filter((variant) => (variant.id as string).includes(variantId))
          // @ts-ignore
          .map((variant) => `${route.id}:${variant.id}`)
      )
      // @ts-ignore
      .reduce((aggr, curr) => [...aggr, ...curr], [...defaultRoutes, ...collection.routes]);
  }

  async resetCollectionAsync(): Promise<void> {
    if (this.collectionOverride === this.defaultCollection) {
      return;
    }

    await this.useCollectionAsync(this.defaultCollection);
    this.collectionOverride = this.defaultCollection;
  }

  async useCollectionAsync(collectionName: string): Promise<void> {
    if (!this.loadedCollections.includes(collectionName)) {
      throw new Error(`${collectionName} is not loaded. Cannot proceed.`);
    }

    this.collectionOverride = collectionName;
    return this.server.mock.collections.select(collectionName, { check: true });
  }

  async disposeAsync(): Promise<void> {
    await this.server.stop();
  }

  public static createMockServerAsync = async (
    selectedCollection: string | undefined,
    componentConfiguration: IComponentConfiguration,
    ports?: IPortConfiguration
  ) => {
    const nextFreePort = ports?.api ?? (await getNextPortAsync());
    const adminPort = ports?.adminApi ?? (await getNextPortAsync());

    return new AcaadApiServer(nextFreePort, adminPort, selectedCollection, componentConfiguration);
  };

  private requestTrackingMiddleware(req: any, res: any, next: any, core: any) {
    this.log(`Request to ${req.url} received at ${new Date().toISOString()}`);

    if (this.withRequestTracking) {
      if (req.url === '/_/requests/tracked' && req.method === 'GET') {
        res.status(200);
        res.send(this.trackedRequests);
        return;
      }

      const url = req.url as string;
      if (url.startsWith('/_/requests/tracked/') && req.method === 'GET') {
        const traceId = url.split('/').at(-1);

        if (traceId) {
          res.status(200);
          res.send(this.getTrackedRequest(traceId));
          return;
        }
      }

      this.log(`Tracked request to ${req.url} received at ${new Date().toISOString()}`);
      this.trackedRequests.push(new TrackedRequest(req));
    }

    next();
  }

  trackedRequests: TrackedRequest[] = [];
  withRequestTracking: boolean = false;

  enableRequestTracking(): void {
    this.log('Enabling request tracking.');
    this.withRequestTracking = true;
  }

  getTrackedRequests(traceId?: string, spanId?: string): TrackedRequest[] {
    if (!this.withRequestTracking) {
      throw new Error('Request tracking is not enabled.');
    }

    let collection = this.trackedRequests;

    if (traceId) {
      collection = collection.filter((tr) => tr.getTraceId() === traceId);
    }

    if (spanId) {
      collection = collection.filter((tr) => tr.getSpanId() === spanId);
    }

    return collection;
  }

  getTrackedRequest(traceId: string): TrackedRequest[] {
    if (!this.withRequestTracking) {
      throw new Error('Request tracking is not enabled.');
    }

    return this.trackedRequests.filter((tr) => tr.getTraceId() === traceId);
  }

  clearTrackedRequests() {
    this.log('Clearing tracked requests.');
    this.trackedRequests = [];
  }
}
