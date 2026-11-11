import path from 'node:path';
import { ConfigError } from './errors.js';
import { pathExists, readJsonFile } from './util/fs.js';
import { isPlainObject } from './util/json.js';

export const RC_FILE_NAME = '.n8nsyncrc.json';

/**
 * @typedef {object} EnvironmentConfig
 * @property {string} [baseUrl]
 * @property {string} [apiKey]
 * @property {string} [apiKeyEnv]  name of the environment variable holding the key
 * @property {string} [dir]
 * @property {string} [idMap]
 * @property {Record<string, string>} [credentialMap]  source credential name -> target credential name
 */

/**
 * @typedef {object} RcFile
 * @property {string} [baseUrl]
 * @property {string} [apiKey]
 * @property {string} [dir]
 * @property {string} [defaultEnvironment]
 * @property {Record<string, EnvironmentConfig>} [environments]
 * @property {{stripVolatile?: boolean, groupBy?: 'none'|'tag'|'project', keepPinData?: boolean, includeArchived?: boolean}} [pull]
 * @property {{activate?: 'keep'|'never'|'always'}} [push]
 * @property {{timeoutMs?: number, retries?: number, retryDelayMs?: number, pageSize?: number}} [http]
 * @property {import('./lint/engine.js').LintConfig} [lint]
 * @property {{dir?: string, keep?: number, maxAgeDays?: number}} [backup]
 */

/**
 * @typedef {object} ResolvedConfig
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} dir
 * @property {string|null} environment
 * @property {string|null} idMap
 * @property {Record<string, string>} credentialMap
 * @property {{stripVolatile: boolean, groupBy: 'none'|'tag'|'project', keepPinData: boolean, includeArchived: boolean}} pull
 * @property {{activate: 'keep'|'never'|'always'}} push
 * @property {{timeoutMs: number, retries: number, retryDelayMs: number, pageSize: number}} http
 * @property {import('./lint/engine.js').LintConfig} lint
 * @property {{dir: string, keep: number, maxAgeDays: number}} backup
 * @property {string|null} rcPath
 * @property {Record<string, {baseUrl: string, apiKey: string, dir: string, idMap: string}>} sources where each value came from
 */

export const DEFAULTS = Object.freeze({
  dir: 'workflows',
  pull: Object.freeze({ stripVolatile: true, groupBy: 'none', keepPinData: false, includeArchived: false }),
  push: Object.freeze({ activate: 'keep' }),
  http: Object.freeze({ timeoutMs: 30000, retries: 3, retryDelayMs: 500, pageSize: 100 }),
  backup: Object.freeze({ dir: 'backups', keep: 0, maxAgeDays: 0 }),
});

/**
 * Walk up from `cwd` until an rc file is found.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function findRcFile(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, RC_FILE_NAME);
    if (await pathExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Validate the shape of an rc file. Throws ConfigError listing every problem.
 * @param {unknown} rc
 * @param {string} label
 * @returns {RcFile}
 */
export function validateRc(rc, label) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(rc)) throw new ConfigError(`${label}: expected a JSON object at the top level`);
  /**
   * @param {Record<string, unknown>} obj
   * @param {string} key
   * @param {string} type
   * @param {string} where
   */
  const check = (obj, key, type, where) => {
    if (obj[key] === undefined) return;
    const actual = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
    if (type === 'object' ? !isPlainObject(obj[key]) : actual !== type) {
      problems.push(`${where}${key} must be ${type === 'object' ? 'an object' : `a ${type}`}`);
    }
  };
  for (const key of ['baseUrl', 'apiKey', 'dir', 'defaultEnvironment']) check(rc, key, 'string', '');
  for (const key of ['environments', 'pull', 'push', 'http', 'lint', 'backup']) check(rc, key, 'object', '');
  if (isPlainObject(rc.environments)) {
    for (const [name, env] of Object.entries(rc.environments)) {
      if (!isPlainObject(env)) {
        problems.push(`environments.${name} must be an object`);
        continue;
      }
      for (const key of ['baseUrl', 'apiKey', 'apiKeyEnv', 'dir', 'idMap']) check(env, key, 'string', `environments.${name}.`);
      check(env, 'credentialMap', 'object', `environments.${name}.`);
    }
  }
  if (isPlainObject(rc.pull)) {
    check(rc.pull, 'stripVolatile', 'boolean', 'pull.');
    check(rc.pull, 'keepPinData', 'boolean', 'pull.');
    check(rc.pull, 'includeArchived', 'boolean', 'pull.');
    if (rc.pull.groupBy !== undefined && !['none', 'tag', 'project'].includes(String(rc.pull.groupBy))) {
      problems.push('pull.groupBy must be one of none, tag, project');
    }
  }
  if (isPlainObject(rc.push) && rc.push.activate !== undefined
    && !['keep', 'never', 'always'].includes(String(rc.push.activate))) {
    problems.push('push.activate must be one of keep, never, always');
  }
  if (isPlainObject(rc.http)) {
    for (const key of ['timeoutMs', 'retries', 'retryDelayMs', 'pageSize']) check(rc.http, key, 'number', 'http.');
  }
  if (isPlainObject(rc.backup)) {
    check(rc.backup, 'dir', 'string', 'backup.');
    check(rc.backup, 'keep', 'number', 'backup.');
    check(rc.backup, 'maxAgeDays', 'number', 'backup.');
  }
  if (typeof rc.defaultEnvironment === 'string' && isPlainObject(rc.environments)
    && !(rc.defaultEnvironment in rc.environments)) {
    problems.push(`defaultEnvironment "${rc.defaultEnvironment}" is not defined under environments`);
  }
  if (problems.length > 0) {
    throw new ConfigError(`${label}: invalid configuration\n  - ${problems.join('\n  - ')}`);
  }
  return /** @type {RcFile} */ (rc);
}

/**
 * Load the rc file. `explicitPath` (from `--config`) must exist; otherwise the
 * file is searched for upwards from `cwd` and is optional.
 * @param {{cwd: string, explicitPath?: string}} options
 * @returns {Promise<{rc: RcFile, rcPath: string|null}>}
 */
export async function loadRc({ cwd, explicitPath }) {
  let rcPath = null;
  if (explicitPath) {
    rcPath = path.resolve(cwd, explicitPath);
    if (!(await pathExists(rcPath))) throw new ConfigError(`Config file not found: ${rcPath}`);
  } else {
    rcPath = await findRcFile(cwd);
  }
  if (!rcPath) return { rc: {}, rcPath: null };
  let raw;
  try {
    raw = await readJsonFile(rcPath);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  return { rc: validateRc(raw, rcPath), rcPath };
}

/**
 * Normalise a base URL: trim, require http(s), drop trailing slashes and a
 * trailing `/api/v1` so both forms are accepted.
 * @param {string} input
 */
export function normalizeBaseUrl(input) {
  const trimmed = String(input).trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(`Invalid base URL: "${trimmed}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`Base URL must use http or https: "${trimmed}"`);
  }
  if (url.username || url.password) {
    throw new ConfigError('Base URL must not contain embedded credentials');
  }
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${url.origin}${pathname}`;
}

/**
 * Resolve the effective configuration. Precedence, highest first:
 * command-line flags, environment variables, the selected named environment
 * in the rc file, rc top-level values, built-in defaults.
 *
 * @param {object} input
 * @param {Record<string, any>} [input.flags]
 * @param {Record<string, string|undefined>} [input.env]
 * @param {RcFile} [input.rc]
 * @param {string|null} [input.rcPath]
 * @param {string} [input.cwd]
 * @param {boolean} [input.requireApi]  fail when baseUrl / apiKey are missing
 * @returns {ResolvedConfig}
 */
export function resolveConfig({ flags = {}, env = {}, rc = {}, rcPath = null, cwd = process.cwd(), requireApi = false }) {
  const environments = rc.environments ?? {};
  const envName = flags.env ?? env.N8N_SYNC_ENV ?? rc.defaultEnvironment ?? null;
  /** @type {EnvironmentConfig} */
  let named = {};
  if (envName !== null) {
    if (!environments[envName]) {
      const known = Object.keys(environments);
      throw new ConfigError(
        `Unknown environment "${envName}". ${known.length ? `Defined: ${known.join(', ')}` : `No environments are defined in ${RC_FILE_NAME}`}`,
      );
    }
    named = environments[envName];
  }
  const rcBase = rcPath ? path.dirname(rcPath) : cwd;
  /** @type {ResolvedConfig['sources']} */
  const sources = {};

  /**
   * @param {string} field
   * @param {Array<[unknown, string]>} candidates
   */
  const pick = (field, candidates) => {
    for (const [value, source] of candidates) {
      if (typeof value === 'string' && value.trim() !== '') {
        sources[field] = source;
        return value.trim();
      }
    }
    sources[field] = 'default';
    return '';
  };

  const namedKeyFromEnv = named.apiKeyEnv ? env[named.apiKeyEnv] : undefined;
  // A named environment selected explicitly must not be silently overridden by
  // the generic N8N_* variables, otherwise `--env prod` could talk to dev.
  const explicitEnv = flags.env !== undefined;
  const baseUrlRaw = pick('baseUrl', explicitEnv
    ? [[flags.baseUrl, 'flag'], [named.baseUrl, `environment:${envName}`], [env.N8N_BASE_URL, 'env'], [rc.baseUrl, 'rc']]
    : [[flags.baseUrl, 'flag'], [env.N8N_BASE_URL, 'env'], [named.baseUrl, `environment:${envName}`], [rc.baseUrl, 'rc']]);
  const apiKey = pick('apiKey', explicitEnv
    ? [[flags.apiKey, 'flag'], [namedKeyFromEnv, `env:${named.apiKeyEnv}`], [named.apiKey, `environment:${envName}`], [env.N8N_API_KEY, 'env'], [rc.apiKey, 'rc']]
    : [[flags.apiKey, 'flag'], [env.N8N_API_KEY, 'env'], [namedKeyFromEnv, `env:${named.apiKeyEnv}`], [named.apiKey, `environment:${envName}`], [rc.apiKey, 'rc']]);

  let dir = pick('dir', [[flags.dir, 'flag'], [env.N8N_SYNC_DIR, 'env'], [named.dir, `environment:${envName}`], [rc.dir, 'rc']]);
  if (dir === '') dir = DEFAULTS.dir;
  const dirBase = sources.dir === 'flag' || sources.dir === 'env' ? cwd : rcBase;
  const idMapRaw = pick('idMap', [[flags.idMap, 'flag'], [named.idMap, `environment:${envName}`]]);
  const idMapBase = sources.idMap === 'flag' ? cwd : rcBase;

  if (requireApi) {
    if (baseUrlRaw === '') {
      throw new ConfigError('Missing n8n base URL. Pass --base-url, set N8N_BASE_URL, or add baseUrl to .n8nsyncrc.json');
    }
    if (apiKey === '') {
      throw new ConfigError('Missing n8n API key. Set N8N_API_KEY (recommended), pass --api-key, or configure apiKeyEnv in .n8nsyncrc.json');
    }
  }

  /**
   * @param {unknown} flag
   * @param {string|undefined} envValue
   * @param {number|undefined} rcValue
   * @param {number} fallback
   * @param {string} label
   */
  const num = (flag, envValue, rcValue, fallback, label) => {
    const raw = flag ?? (envValue !== undefined && envValue !== '' ? Number(envValue) : undefined) ?? rcValue ?? fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new ConfigError(`${label} must be a non-negative number`);
    return value;
  };

  return {
    baseUrl: baseUrlRaw === '' ? '' : normalizeBaseUrl(baseUrlRaw),
    apiKey,
    dir: path.resolve(dirBase, dir),
    environment: envName,
    idMap: idMapRaw === '' ? null : path.resolve(idMapBase, idMapRaw),
    credentialMap: { ...(named.credentialMap ?? {}) },
    pull: {
      stripVolatile: flags.stripVolatile ?? rc.pull?.stripVolatile ?? DEFAULTS.pull.stripVolatile,
      groupBy: flags.groupBy ?? rc.pull?.groupBy ?? DEFAULTS.pull.groupBy,
      keepPinData: flags.keepPinData ?? rc.pull?.keepPinData ?? DEFAULTS.pull.keepPinData,
      includeArchived: flags.includeArchived ?? rc.pull?.includeArchived ?? DEFAULTS.pull.includeArchived,
    },
    push: {
      activate: flags.activate ?? rc.push?.activate ?? DEFAULTS.push.activate,
    },
    http: {
      timeoutMs: num(flags.timeout, env.N8N_SYNC_TIMEOUT_MS, rc.http?.timeoutMs, DEFAULTS.http.timeoutMs, 'timeout'),
      retries: Math.floor(num(flags.retries, env.N8N_SYNC_RETRIES, rc.http?.retries, DEFAULTS.http.retries, 'retries')),
      retryDelayMs: num(undefined, undefined, rc.http?.retryDelayMs, DEFAULTS.http.retryDelayMs, 'retryDelayMs'),
      pageSize: Math.max(1, Math.floor(num(flags.pageSize, undefined, rc.http?.pageSize, DEFAULTS.http.pageSize, 'pageSize'))),
    },
    lint: rc.lint ?? {},
    backup: {
      dir: path.resolve(flags.backupDir ? cwd : rcBase, flags.backupDir ?? rc.backup?.dir ?? DEFAULTS.backup.dir),
      keep: num(flags.keep, undefined, rc.backup?.keep, DEFAULTS.backup.keep, 'keep'),
      maxAgeDays: num(flags.maxAgeDays, undefined, rc.backup?.maxAgeDays, DEFAULTS.backup.maxAgeDays, 'maxAgeDays'),
    },
    rcPath,
    sources,
  };
}
