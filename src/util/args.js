import { UsageError } from '../errors.js';

/**
 * @typedef {object} OptionSpec
 * @property {'string'|'boolean'|'number'|'list'} type
 * @property {string} [short]     single-letter alias
 * @property {string} [description]
 * @property {unknown} [default]
 * @property {string[]} [choices]
 * @property {string} [placeholder]
 */

/** @typedef {Record<string, OptionSpec>} OptionSpecs */

/** @param {string} name */
function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Small, strict argument parser. Supports `--flag`, `--no-flag`,
 * `--key value`, `--key=value`, `-k value`, repeated/comma-separated lists
 * and `--` to end option parsing. Unknown options are an error.
 *
 * @param {string[]} argv
 * @param {OptionSpecs} specs  keyed by kebab-case long name
 * @returns {{options: Record<string, any>, positionals: string[]}}
 */
export function parseArgs(argv, specs) {
  /** @type {Record<string, any>} */
  const options = {};
  /** @type {string[]} */
  const positionals = [];
  /** @type {Map<string, string>} */
  const shorts = new Map();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.short) shorts.set(spec.short, name);
    if (spec.default !== undefined) options[camel(name)] = spec.default;
    else if (spec.type === 'list') options[camel(name)] = [];
  }

  /**
   * @param {string} name
   * @param {string} raw
   */
  const assign = (name, raw) => {
    const spec = specs[name];
    const key = camel(name);
    if (spec.type === 'number') {
      const num = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(num)) {
        throw new UsageError(`Option --${name} expects a number, got "${raw}"`);
      }
      options[key] = num;
    } else if (spec.type === 'list') {
      const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
      options[key] = [...(options[key] ?? []), ...parts];
    } else {
      options[key] = raw;
    }
    if (spec.choices) {
      const values = Array.isArray(options[key]) ? options[key] : [options[key]];
      for (const v of values) {
        if (!spec.choices.includes(String(v))) {
          throw new UsageError(`Option --${name} must be one of: ${spec.choices.join(', ')} (got "${v}")`);
        }
      }
    }
  };

  let listReset = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    let name;
    /** @type {string|undefined} */
    let inline;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      inline = eq === -1 ? undefined : arg.slice(eq + 1);
    } else {
      const short = arg.slice(1, 2);
      const mapped = shorts.get(short);
      if (!mapped) throw new UsageError(`Unknown option: -${short}`);
      name = mapped;
      inline = arg.length > 2 ? arg.slice(2).replace(/^=/, '') : undefined;
    }

    if (!specs[name] && name.startsWith('no-') && specs[name.slice(3)]?.type === 'boolean') {
      if (inline !== undefined) throw new UsageError(`Option --${name} does not take a value`);
      options[camel(name.slice(3))] = false;
      continue;
    }
    const spec = specs[name];
    if (!spec) throw new UsageError(`Unknown option: --${name}`);

    if (spec.type === 'boolean') {
      if (inline === undefined) options[camel(name)] = true;
      else if (/^(true|1|yes)$/i.test(inline)) options[camel(name)] = true;
      else if (/^(false|0|no)$/i.test(inline)) options[camel(name)] = false;
      else throw new UsageError(`Option --${name} expects true or false, got "${inline}"`);
      continue;
    }
    if (inline === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next !== '--')) {
        throw new UsageError(`Option --${name} requires a value`);
      }
      inline = next;
      i += 1;
    }
    if (spec.type === 'list' && !listReset.has(name)) {
      // an explicit flag replaces a default list rather than appending to it
      options[camel(name)] = [];
      listReset.add(name);
    }
    assign(name, inline);
  }
  return { options, positionals };
}

/**
 * Render an aligned option table for help output.
 * @param {OptionSpecs} specs
 * @returns {string}
 */
export function formatOptions(specs) {
  const rows = Object.entries(specs).map(([name, spec]) => {
    const short = spec.short ? `-${spec.short}, ` : '    ';
    const value = spec.type === 'boolean' ? '' : ` <${spec.placeholder ?? spec.type}>`;
    let description = spec.description ?? '';
    if (spec.choices) description += ` (${spec.choices.join('|')})`;
    if (spec.default !== undefined && spec.default !== false && !(Array.isArray(spec.default) && spec.default.length === 0)) {
      description += ` [default: ${Array.isArray(spec.default) ? spec.default.join(',') : spec.default}]`;
    }
    return [`  ${short}--${name}${value}`, description];
  });
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${left.padEnd(width + 2)}${right}`.trimEnd()).join('\n');
}
