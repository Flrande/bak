import { CommanderError, type Command } from 'commander';
import { createProgram } from './program.js';
import { RpcClientError } from './rpc/client.js';

function hasCliFlag(flag: string): boolean {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--') {
      break;
    }
    if (arg === flag) {
      return true;
    }
  }
  return false;
}

const jsonErrorsEnabled = hasCliFlag('--json-errors');
const program = createProgram();
const programOutput = {
  writeOut: (str: string) => process.stdout.write(str),
  writeErr: jsonErrorsEnabled ? (() => undefined) : ((str: string) => process.stderr.write(str)),
  outputError: jsonErrorsEnabled ? (() => undefined) : ((str: string, write: (str: string) => void) => write(str))
};

function applyCommanderOverrides(command: Command): void {
  command.exitOverride();
  command.configureOutput(programOutput);
  for (const subcommand of command.commands) {
    applyCommanderOverrides(subcommand);
  }
}

applyCommanderOverrides(program);

program
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    if (error instanceof CommanderError && (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')) {
      process.exit(0);
      return;
    }

    if (jsonErrorsEnabled) {
      const message = error instanceof Error ? error.message : String(error);
      const payload =
        error instanceof RpcClientError
          ? {
              ok: false,
              error: {
                code: error.rpcCode ?? -32603,
                message,
                data: {
                  bakCode: error.bakCode,
                  ...(error.details ?? {})
                }
              }
            }
          : error instanceof CommanderError
            ? {
                ok: false,
                error: {
                  code: -32602,
                  message,
                  data: {
                    commanderCode: error.code,
                    exitCode: error.exitCode
                  }
                }
              }
            : {
                ok: false,
                error: {
                  code: -32603,
                  message
                }
              };
      process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exit(1);
      return;
    }

    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof CommanderError ? error.exitCode : 1);
  });
