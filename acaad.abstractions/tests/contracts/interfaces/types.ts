import { AcaadError } from '../../../src';

export interface ContractTestCliOptions {
  servers: string[];
  verbose: boolean;
}

export interface ContractTestOutcome {
  success: boolean;
  name: string;
  host: string;
}

export interface ContractTestSuccess extends ContractTestOutcome {}

export interface ContractTestFailure extends ContractTestOutcome {
  message: string;
  error?: AcaadError;
  additionalData?: Record<string, string>;
}

export interface ContractTestSummary {
  successes: ContractTestSuccess[];
  failures: ContractTestFailure[];
}

export type Logger = (...args: any[]) => void;

export function getLogger(name: string): Logger {
  return (message?: any, ...optionalParams: any[]) =>
    console.log(`[${new Date().toISOString()}][${name}]`, message, ...optionalParams);
}
