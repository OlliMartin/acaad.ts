import { AxiosRequestConfig } from 'axios';
import { Effect } from 'effect';
import { AcaadError } from '../../../src';

export interface IContractTest {
  name: string;
  request: AxiosRequestConfig;
  validator: (data: unknown) => Effect.Effect<unknown, AcaadError>;
}

export interface IContractTester {
  name: string;
  getContractTests(): IContractTest[];
}
