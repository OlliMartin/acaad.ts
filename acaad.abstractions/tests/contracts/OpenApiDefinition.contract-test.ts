import { autoInjectable, injectable, singleton } from 'tsyringe';
import { IContractTest, IContractTester } from './interfaces/IContractTester';
import { OpenApiDefinitionFactory } from '../../src';

@injectable()
export class OpenApiDefinitionContractTest implements IContractTester {
  getContractTests(): IContractTest[] {
    return [
      {
        name: 'full',
        request: {
          url: 'openapi/v1.json',
          method: 'get'
        },
        validator: OpenApiDefinitionFactory.verifyResponsePayload
      },
      {
        name: 'validate-excess',
        request: {
          url: 'openapi/v1.json',
          method: 'get'
        },
        validator: (data) => OpenApiDefinitionFactory.verifyResponsePayload(data, 'error')
      }
    ];
  }
  name: string = 'open-api-definition';
}
