import path from 'node:path';
import { createClient } from '../api.js';
import { loadRc, resolveConfig } from '../config.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { isDirectory, pathExists } from '../util/fs.js';
import { loadWorkflows } from '../workflow/store.js';

/**
 * @typedef {object} CommandContext
 * @property {Record<string, any>} options      parsed flags (camelCase)
 * @property {string[]} positionals
 * @property {Record<string, string|undefined>} env
 * @property {string} cwd
 * @property {import('../util/logger.js').Logger} logger
 * @property {typeof fetch} [fetch]
 * @property {() => Date} now
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {string} version
 */

/**
 * @typedef {object} Command
 * @property {string} name
 * @property {string} summary
 * @property {string} usage
 * @property {import('../util/args.js').OptionSpecs} options
 * @property {string[]} [examples]
 * @property {(context: CommandContext) => Promise<number>} run   resolves to the exit code
 */

/** Options understood by every command. @type {import('../util/args.js').OptionSpecs} */
export const GLOBAL_OPTIONS = {
  config: { type: 'string', short: 'c', placeholder: 'file', description: 'Path to .n8nsyncrc.json (default: searched upwards from the working directory)' },
  env: { type: 'string', short: 'e', placeholder: 'name', description: 'Named environment from the config file' },
  'base-url': { type: 'string', placeholder: 'url', description: 'n8n instance URL (or N8N_BASE_URL)' },
  'api-key': { type: 'string', placeholder: 'key', description: 'n8n API key (prefer the N8N_API_KEY environment variable)' },
  timeout: { type: 'number', placeholder: 'ms', description: 'Per-request timeout in milliseconds' },
  retries: { type: 'number', placeholder: 'n', description: 'Retries on 429/5xx and network errors' },
  verbose: { type: 'boolean', short: 'v', description: 'Print debug output to stderr' },
  quiet: { type: 'boolean', short: 'q', description: 'Only print errors' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
};

/** Options shared by commands that read or write the workflow directory. @type {import('../util/args.js').OptionSpecs} */
export const DIR_OPTION = {
  dir: { type: 'string', short: 'd', placeholder: 'path', description: 'Workflow directory [default: workflows]' },
};

/**
 * Load the rc file and resolve configuration for a command.
 * @param {CommandContext} context
 * @param {{requireApi?: boolean, flags?: Record<string, any>}} [extra]
 */
export async function loadConfig(context, extra = {}) {
  const { rc, rcPath } = await loadRc({ cwd: context.cwd, explicitPath: context.options.config });
  return resolveConfig({
    flags: { ...context.options, ...(extra.flags ?? {}) },
    env: context.env,
    rc,
    rcPath,
    cwd: context.cwd,
    requireApi: extra.requireApi ?? false,
  });
}

/**
 * Resolve configuration and build an API client.
 * @param {CommandContext} context
 * @param {Record<string, any>} [flags]
 */
export async function connect(context, flags) {
  const config = await loadConfig(context, { requireApi: true, flags });
  if (config.sources.apiKey === 'flag') {
    context.logger.warn('Passing --api-key on the command line exposes it in shell history and process lists; prefer N8N_API_KEY');
  }
  if (config.baseUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(config.baseUrl)) {
    context.logger.warn('The base URL uses plain http; the API key is sent unencrypted');
  }
  const client = createClient(config, { fetch: context.fetch, logger: context.logger, sleep: context.sleep });
  return { config, client };
}

/**
 * Load workflows from positional targets (files or directories), falling
 * back to the configured workflow directory. Parse errors are fatal.
 * @param {CommandContext} context
 * @param {string[]} targets
 * @returns {Promise<Array<import('../workflow/store.js').LocalWorkflow & {display: string}>>}
 */
export async function loadTargets(context, targets) {
  let roots = targets;
  if (roots.length === 0) {
    const config = await loadConfig(context);
    roots = [config.dir];
  }
  /** @type {Array<import('../workflow/store.js').LocalWorkflow & {display: string}>} */
  const out = [];
  /** @type {string[]} */
  const problems = [];
  for (const target of roots) {
    const absolute = path.resolve(context.cwd, target);
    if (!(await pathExists(absolute))) throw new UsageError(`No such file or directory: ${target}`);
    const loaded = await loadWorkflows(absolute);
    const base = (await isDirectory(absolute)) ? absolute : path.dirname(absolute);
    for (const wf of loaded.workflows) {
      const rel = path.relative(context.cwd, path.join(base, wf.file)).split(path.sep).join('/');
      out.push({ ...wf, display: rel.startsWith('..') ? wf.absolute : rel });
    }
    for (const error of loaded.errors) problems.push(`${path.join(target, error.file)}: ${error.message}`);
    if (!(await isDirectory(absolute)) && loaded.workflows.length === 0 && loaded.errors.length === 0) {
      problems.push(`${target}: not an n8n workflow (expected an object with a "nodes" array)`);
    }
  }
  if (problems.length > 0) throw new CliError(`Could not read workflows:\n  ${problems.join('\n  ')}`, EXIT.FINDINGS);
  return out.sort((a, b) => a.display.localeCompare(b.display));
}

/**
 * Pick a single workflow out of a list by id, name or file path.
 * @param {Array<import('../workflow/store.js').LocalWorkflow & {display: string}>} workflows
 * @param {string} ref
 */
export function selectWorkflow(workflows, ref) {
  const matches = workflows.filter((wf) => wf.id === ref || wf.workflow.name === ref || wf.file === ref || wf.display === ref);
  if (matches.length === 0) throw new UsageError(`No workflow matches "${ref}"`);
  if (matches.length > 1) {
    throw new UsageError(`"${ref}" is ambiguous; it matches ${matches.map((m) => m.display).join(', ')}`);
  }
  return matches[0];
}
