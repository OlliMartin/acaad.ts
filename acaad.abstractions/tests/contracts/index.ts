import 'reflect-metadata';

import util from 'util';
import { Command } from '@commander-js/extra-typings';
import { ContractTestCliOptions, getLogger } from './interfaces/types';
import { ContractTestRunner } from './ContractTestRunner';
import { pretty } from 'effect/Logger';

const program = new Command()
  .name('acaad:tests:contracts')
  .description(
    'Run contract tests against one or more ACaaD (backend) servers to ensure the actual service matches the mocks.'
  )
  .requiredOption(
    '-s, --servers <servers...>',
    'Define one or more servers (including port) to run the contract checks against.'
  )
  .option('-v, --verbose', 'Enable verbose logging', false);

program.parse();

const cliOptions: ContractTestCliOptions = program.opts();

const hostRegex = RegExp('^[\\d\\w\\.-]+:\\d{2,5}$');
const invalidServers: string[] = cliOptions.servers.filter((s) => !hostRegex.test(s));

const abortController = new AbortController();
const log = getLogger('main');

process.on('SIGINT', () => {
  log('Caught interrupt signal, signalling controller');
  abortController.abort('User interrupt');
});

if (invalidServers.length > 0) {
  log(
    `[ERROR] The following servers are in an invalid format: [${invalidServers.join(', ')}] Cannot proceed.`
  );
} else {
  const runner = ContractTestRunner.getInstance(cliOptions);

  runner
    .runAsync(abortController.signal)
    .then((summary) => {
      log('Contract Test Summary:', util.inspect(summary, false, null, true));
    })
    .catch((err) => log('[ERROR] An error occurred running contract tests.', err));
}
