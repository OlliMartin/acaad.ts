import {
  ComponentDescriptor,
  AcaadUnitOfMeasure,
  Component,
  AcaadHost,
  AcaadServerMetadata,
  ComponentCommandOutcomeEvent,
  AcaadUnhandledEventReceivedEvent
} from '../model';

import { Option } from 'effect/Option';
import { AcaadError } from '../errors';
import { Duration } from 'effect';
import { InboundStateUpdate } from '../model/InboundStateUpdate';

export type ChangeType = 'action' | 'query';

export type OutboundStateChangeCallback = (
  host: AcaadHost,
  componentDescriptor: ComponentDescriptor,
  type: ChangeType,
  value: Option<unknown>
) => Promise<boolean>;

type __funcDef = (...args: any[]) => any;
export type ConnectedServiceFunction = {
  [K in keyof IConnectedServiceAdapterFunctional]: IConnectedServiceAdapterFunctional[K] extends
    | __funcDef
    | undefined
    ? K
    : never;
}[keyof IConnectedServiceAdapterFunctional];

export interface IConnectedServiceAdapterFunctional {
  getComponentDescriptorByComponent(component: Component): ComponentDescriptor;

  transformUnitOfMeasure(uom: AcaadUnitOfMeasure): unknown;

  createServerModelAsync(server: AcaadServerMetadata, as: AbortSignal): Promise<void>;

  onServerConnectedAsync(server: AcaadHost, as: AbortSignal): Promise<void>;

  onServerDisconnectedAsync(server: AcaadHost, as: AbortSignal): Promise<void>;

  createComponentModelAsync(component: Component, as: AbortSignal): Promise<void>;

  registerStateChangeCallbackAsync(cb: OutboundStateChangeCallback, as: AbortSignal): Promise<void>;

  updateComponentStateAsync(
    cd: ComponentDescriptor,
    inboundStateUpdate: InboundStateUpdate,
    as: AbortSignal
  ): Promise<void>;

  getConnectedServersAsync(as: AbortSignal): Promise<AcaadHost[]>;

  getAllowedConcurrency(): number;

  onUnhandledEventAsync?(unhandledEvent: AcaadUnhandledEventReceivedEvent, as: AbortSignal): Promise<void>;

  onUnmappedComponentEventAsync?(event: ComponentCommandOutcomeEvent, as: AbortSignal): Promise<void>;

  shouldSyncMetadataOnServerConnect(): boolean;

  getMetadataSyncInterval?(): number | string;

  shouldSyncMetadata?(host: AcaadHost, lastSync: number | undefined): boolean;
}

export interface ICsErrorHandler {
  mapServiceError(functionName: ConnectedServiceFunction, error: unknown): AcaadError;

  onErrorAsync?(acaadError: AcaadError, as: AbortSignal): Promise<void>;
}

export interface IConnectedServiceAdapter extends IConnectedServiceAdapterFunctional, ICsErrorHandler {}

export default IConnectedServiceAdapter;
