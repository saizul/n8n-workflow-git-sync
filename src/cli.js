import { readFileSync } from 'node:fs';
import { COMMANDS, getCommand } from './commands/index.js';
import { GLOBAL_OPTIONS } from './commands/common.js';
import { ApiError, CliError, EXIT, UsageError } from './errors.js';
import { formatOptions, parseArgs } from './util/args.js';
import { createLogger } from './util/logger.js';

/** Version from package.json, read once. */
export const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  } catch {
    return '0.0.0';
  }
})();

/** Top-level help text. */
export function mainHelp() {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  return [
    `n8n-sync ${VERSION} - keep self-hosted n8n workflows under version control`,
    '',
    'Usage: n8n-sync <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    'Global options:',
    formatOptions(GLOBAL_OPTIONS),
    '',
    'Configuration precedence: command-line flags, then environment variables',
    '(N8N_BASE_URL, N8N_API_KEY, N8N_SYNC_ENV, N8N_SYNC_DIR), then .n8nsyncrc.json.',
    '',
    'Exit codes: 0 ok, 1 findings or differences, 2 usage or configuration error,',
    '            3 API error, 4 conflict, 70 internal error.',
    '',
    'Run "n8n-sync <command> --help" for the options of a command.',
  ].join('\n');
}

/** @param {import('./commands/common.js').Command} command */
export function commandHelp(command) {
  const lines = [command.summary, '', `Usage: ${command.usage}`, '', 'Options:', formatOptions(command.options)];
  lines.push('', 'Global options:', formatOptions(GLOBAL_OPTIONS));
  if (command.examples?.length) lines.push('', 'Examples:', ...command.examples.map((example) => `  ${example}`));
  return lines.join('\n');
}

/**
 * Pull `--verbose` / `--quiet` out of argv before full parsing so that the
 * logger exists even when parsing fails.
 * @param {string[]} argv
 */
function logLevel(argv) {
  const before = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  if (before.includes('--quiet') || before.includes('-q')) return 'error';
  if (before.includes('--verbose') || before.includes('-v')) return 'debug';
  return 'info';
}

/**
 * @typedef {object} RunOptions
 * @property {Record<string, string|undefined>} [env]
 * @property {string} [cwd]
 * @property {typeof fetch} [fetch]
 * @property {import('./util/logger.js').Logger} [logger]
 * @property {(text: string) => void} [stdout]
 * @property {(text: string) => void} [stderr]
 * @property {() => Date} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/**
 * Run the CLI. Never throws and never calls `process.exit`; resolves to the
 * exit code so that the function can be driven from tests.
 * @param {string[]} argv   arguments after the executable name
 * @param {RunOptions} [io]
 * @returns {Promise<number>}
 */
export async function run(argv, io = {}) {
  const env = io.env ?? process.env;
  const logger = io.logger ?? createLogger({
    level: logLevel(argv),
    stdout: io.stdout,
    stderr: io.stderr,
    secrets: Object.entries(env)
      .filter(([key, value]) => /API_KEY$/.test(key) && typeof value === 'string' && value.length >= 4)
      .map(([, value]) => String(value)),
  });
  try {
    const [first, ...rest] = argv;
    if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
      const topic = first === 'help' ? rest[0] : undefined;
      if (topic) {
        const command = getCommand(topic);
        if (!command) throw new UsageError(`Unknown command "${topic}"`);
        logger.out(commandHelp(command));
      } else {
        logger.out(mainHelp());
      }
      return first === undefined ? EXIT.USAGE : EXIT.OK;
    }
    if (first === '--version' || first === '-V' || first === 'version') {
      logger.out(VERSION);
      return EXIT.OK;
    }
    const command = getCommand(first);
    if (!command) {
      const hint = first.startsWith('-') ? ' (the command must come before any options)' : '';
      throw new UsageError(`Unknown command "${first}"${hint}. Run "n8n-sync --help" for the list of commands.`);
    }
    const { options, positionals } = parseArgs(rest, { ...GLOBAL_OPTIONS, ...command.options });
    if (options.help) {
      logger.out(commandHelp(command));
      return EXIT.OK;
    }
    if (typeof options.apiKey === 'string') logger.addSecret(options.apiKey);
    return await command.run({
      options,
      positionals,
      env,
      cwd: io.cwd ?? process.cwd(),
      logger,
      fetch: io.fetch,
      now: io.now ?? (() => new Date()),
      sleep: io.sleep,
      version: VERSION,
    });
  } catch (err) {
    return reportError(err, logger);
  }
}

/**
 * Print an error and map it to an exit code.
 * @param {unknown} err
 * @param {import('./util/logger.js').Logger} logger
 * @returns {number}
 */
export function reportError(err, logger) {
  if (err instanceof ApiError) {
    logger.error(err.message);
    if (err.attempts > 1) logger.error(`  gave up after ${err.attempts} attempts`);
    return err.exitCode;
  }
  if (err instanceof CliError) {
    logger.error(err.message);
    return err.exitCode;
  }
  const message = err instanceof Error ? (logger.level === 'debug' ? err.stack ?? err.message : err.message) : String(err);
  logger.error(`Unexpected failure: ${message}`);
  return EXIT.INTERNAL;
}
