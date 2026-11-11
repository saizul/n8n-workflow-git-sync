/**
 * Minimal leveled logger with secret redaction. Every string that passes
 * through the logger is scrubbed of registered secrets (the API key first of
 * all) so a credential can never end up in CI logs by accident.
 */

const LEVELS = Object.freeze({ silent: 0, error: 1, warn: 2, info: 3, debug: 4 });

/** @typedef {'silent'|'error'|'warn'|'info'|'debug'} LogLevel */

/**
 * Build a function that replaces every registered secret with a mask.
 * @param {Array<string|undefined|null>} secrets
 * @param {string} [mask]
 * @returns {(text: string) => string}
 */
export function createRedactor(secrets, mask = '***') {
  const list = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))]
    .map((s) => /** @type {string} */ (s))
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const secret of list) out = out.split(secret).join(mask);
    // Defence in depth: mask header-looking fragments even for unknown keys.
    out = out.replace(/(x-n8n-api-key["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi, `$1${mask}`);
    out = out.replace(/(authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)([^"'\s,}]+)/gi, `$1${mask}`);
    return out;
  };
}

/**
 * @typedef {object} Logger
 * @property {(...args: unknown[]) => void} error
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} debug
 * @property {(text: string) => void} out   write a line to stdout (command result)
 * @property {(secret: string|undefined) => void} addSecret
 * @property {(text: string) => string} redact
 * @property {LogLevel} level
 */

/**
 * @param {{level?: LogLevel, stdout?: (text: string) => void, stderr?: (text: string) => void, secrets?: string[]}} [options]
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const level = options.level ?? 'info';
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  /** @type {string[]} */
  const secrets = [...(options.secrets ?? [])];
  let redactor = createRedactor(secrets);

  /** @param {unknown} arg */
  const render = (arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.message;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  };

  /**
   * @param {LogLevel} at
   * @param {string} prefix
   */
  const emit = (at, prefix) => (/** @type {unknown[]} */ ...args) => {
    if (LEVELS[level] < LEVELS[at]) return;
    stderr(`${prefix}${redactor(args.map(render).join(' '))}\n`);
  };

  return {
    level,
    error: emit('error', 'error: '),
    warn: emit('warn', 'warning: '),
    info: emit('info', ''),
    debug: emit('debug', 'debug: '),
    out: (text) => stdout(`${redactor(text)}\n`),
    addSecret: (secret) => {
      if (typeof secret === 'string' && secret.length >= 4) {
        secrets.push(secret);
        redactor = createRedactor(secrets);
      }
    },
    redact: (text) => redactor(text),
  };
}

/**
 * Logger that records everything in memory; used by tests and by library
 * consumers that want to capture output.
 * @param {{level?: LogLevel}} [options]
 */
export function createMemoryLogger(options = {}) {
  /** @type {string[]} */
  const stdout = [];
  /** @type {string[]} */
  const stderr = [];
  const logger = createLogger({
    level: options.level ?? 'debug',
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return Object.assign(logger, {
    stdout,
    stderr,
    /** Combined stdout text. */
    text: () => stdout.join(''),
    /** Combined stderr text. */
    errText: () => stderr.join(''),
  });
}
