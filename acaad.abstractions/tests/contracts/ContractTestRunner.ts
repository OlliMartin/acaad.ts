import {
  ContractTestCliOptions,
  ContractTestFailure,
  ContractTestOutcome,
  ContractTestSuccess,
  ContractTestSummary,
  getLogger,
  Logger
} from './interfaces/types';
import { container, DependencyContainer, inject, injectable, injectAll, registry } from 'tsyringe';
import { IContractTest, IContractTester } from './interfaces/IContractTester';
import { OpenApiDefinitionContractTest } from './OpenApiDefinition.contract-test';
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { Chunk, Console, Effect, Either, GroupBy, Stream } from 'effect';
import { AcaadError, ResponseSchemaError } from '../../src';

// noinspection JSPotentiallyInvalidUsageOfClassThis
@injectable()
@registry([
  {
    token: 'testers',
    useClass: OpenApiDefinitionContractTest
  }
])
export class ContractTestRunner {
  private readonly options: ContractTestCliOptions;
  private readonly log: Logger;
  private readonly testers: IContractTester[];

  constructor(
    @inject('options') options: ContractTestCliOptions,
    @injectAll('testers') testers: IContractTester[]
  ) {
    this.log = getLogger('runner');

    this.log(
      `Received configuration for ${options.servers.length} servers. ${testers.length} test runners are registered.`
    );
    this.options = options;
    this.testers = testers;
  }

  public async runAsync(as: AbortSignal): Promise<ContractTestSummary> {
    const outcomes = await Effect.runPromise(this.executeTestsEff());

    const asArray = Chunk.toArray(outcomes);

    return {
      successes: asArray.filter((i) => i.success),
      failures: asArray.filter((i) => !i.success).map((o) => o as ContractTestFailure)
    };
  }

  private executeTestsEff(): Effect.Effect<Chunk.Chunk<ContractTestOutcome>> {
    const tests: Stream.Stream<{ tester: IContractTester; test: IContractTest }> = Stream.fromIterable(
      this.testers
    ).pipe(
      Stream.map((tester) =>
        Stream.fromIterable(tester.getContractTests().map((ct) => ({ tester, test: ct })))
      ),
      Stream.flatten()
    );

    const axiosInstances = Stream.fromIterable(this.options.servers).pipe(
      Stream.map((server) =>
        axios.create({
          baseURL: `http://${server}`
        })
      )
    );

    const baseStream: Stream.Stream<
      [axios: AxiosInstance, { tester: IContractTester; test: IContractTest }]
    > = Stream.cross(axiosInstances, tests);

    const runStream = baseStream.pipe(
      Stream.mapEffect(([axios, { tester, test }]) =>
        this.executeTest(axios, tester, test).pipe(Effect.either)
      ),
      Stream.map(Either.getOrElse<ContractTestFailure, ContractTestOutcome>((fail) => fail)),
      Stream.map((item) => item as ContractTestOutcome)
    );

    return Stream.runCollect(runStream);
  }

  private mapAcaadError(testName: string, host: string, error: AcaadError): ContractTestFailure {
    if (error instanceof ResponseSchemaError) {
      return {
        success: false,
        name: testName,
        host: host,
        message: error.message,
        error: error
      };
    }

    return {
      success: false,
      name: testName,
      host: host,
      message: error.message ?? 'Unknown response validation error'
    };
  }

  private executeTest(
    instance: AxiosInstance,
    tester: IContractTester,
    test: IContractTest
  ): Effect.Effect<ContractTestSuccess, ContractTestFailure> {
    return Effect.gen(this, function* () {
      const testName = `${tester.name}:${test.name}`;

      const response = yield* this.executeRequest(testName, instance, test.request);

      const validated = yield* test
        .validator(response.data)
        .pipe(
          Effect.mapError<AcaadError, ContractTestFailure>((err) =>
            this.mapAcaadError(testName, instance.defaults.baseURL!, err)
          )
        );

      return {
        success: true,
        name: testName,
        host: instance.defaults.baseURL!
      };
    });
  }

  private executeRequest(
    testName: string,
    instance: AxiosInstance,
    request: AxiosRequestConfig
  ): Effect.Effect<AxiosResponse, ContractTestFailure> {
    return Effect.tryPromise({
      try: (as) => instance.request({ ...request, signal: as }),
      catch: (err) =>
        ({
          name: testName,
          success: false,
          message: `API request not successful: ${err}`,
          host: instance.defaults.baseURL!
        }) as ContractTestFailure
    });
  }

  static getInstance(options: ContractTestCliOptions) {
    const diContainer: DependencyContainer = container;

    diContainer.register('options', {
      useValue: options
    });

    return diContainer.resolve(ContractTestRunner);
  }
}
