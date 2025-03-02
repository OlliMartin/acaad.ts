import { Component, ComponentDescriptor } from '@acaad/abstractions';
import { v4 as uuidv4 } from 'uuid';

export interface IAcaadServer {
  startAsync(): Promise<void>;

  disposeAsync(): Promise<void>;

  port: number;
}

export interface IPortConfiguration {
  api: number;
  adminApi: number;
  signalr: number;
}

export interface IComponentConfiguration {
  sensorCount?: number;
  buttonCount?: number;
  switchCount?: number;
  componentPrefix?: string;
  suppressComponentEndpoints?: boolean;
}

export interface MockedComponentDescriptor extends ComponentDescriptor {
  onIff?: unknown;
}

export class MockedSwitchComponentDescriptor
  extends ComponentDescriptor
  implements MockedComponentDescriptor
{
  onIff?: unknown;

  constructor(name: string) {
    super(name);

    this.onIff = uuidv4();
  }
}

export interface IMockedComponentModel {
  sensors?: MockedComponentDescriptor[];
  buttons?: MockedComponentDescriptor[];
  switches?: MockedComponentDescriptor[];
}
