/**
 * JSON helpers: deterministic serialisation, deep comparison, JSON-path
 * utilities. Determinism matters because the output lands in git and noisy
 * diffs defeat the purpose of version control.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Compare two keys using code-unit order so the result does not depend on the
 * locale of the machine producing the file.
 * @param {string} a
 * @param {string} b
 */
export function compareKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recursively sort object keys. `priority` keys are emitted first (in the
 * given order) at the top level only, which keeps `id` and `name` at the top
 * of a workflow file where humans expect them.
 * @template T
 * @param {T} value
 * @param {string[]} [priority]
 * @returns {T}
 */
export function sortKeysDeep(value, priority = []) {
  if (Array.isArray(value)) {
    return /** @type {any} */ (value.map((item) => sortKeysDeep(item)));
  }
  if (!isPlainObject(value)) return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  const keys = Object.keys(value).sort(compareKeys);
  const head = priority.filter((k) => keys.includes(k));
  const tail = keys.filter((k) => !head.includes(k));
  for (const key of [...head, ...tail]) {
    const v = value[key];
    if (v === undefined) continue;
    out[key] = sortKeysDeep(v);
  }
  return /** @type {any} */ (out);
}

/**
 * Deterministic JSON string with sorted keys and a trailing newline.
 * @param {unknown} value
 * @param {{indent?: number, priority?: string[], newline?: boolean}} [options]
 */
export function stableStringify(value, options = {}) {
  const { indent = 2, priority = [], newline = true } = options;
  const text = JSON.stringify(sortKeysDeep(value, priority), null, indent);
  return newline ? `${text}\n` : text;
}

/**
 * Canonical compact form used for hashing.
 * @param {unknown} value
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Structural deep equality for JSON-compatible values. `undefined` object
 * members are treated as absent.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = /** @type {Record<string, unknown>} */ (a);
    const bo = /** @type {Record<string, unknown>} */ (b);
    const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
    const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
    if (ak.length !== bk.length) return false;
    for (const key of ak) {
      if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
      if (!deepEqual(ao[key], bo[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Structured clone for JSON data.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Render a path (array of keys / indexes) as a JSON-path string, e.g.
 * `$.parameters.headers[0].value` or `$["odd key"]`.
 * @param {Array<string|number>} segments
 * @param {string} [root]
 */
export function formatPath(segments, root = '$') {
  let out = root;
  for (const seg of segments) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (IDENT.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/**
 * Parse a JSON-path produced by {@link formatPath} back into segments.
 * @param {string} path
 * @returns {Array<string|number>}
 */
export function parsePath(path) {
  /** @type {Array<string|number>} */
  const segments = [];
  let i = path.startsWith('$') ? 1 : 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      let j = i + 1;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j += 1;
      segments.push(path.slice(i + 1, j));
      i = j;
    } else if (ch === '[') {
      if (path[i + 1] === '"') {
        let j = i + 2;
        while (j < path.length && !(path[j] === '"' && path[j - 1] !== '\\')) j += 1;
        segments.push(JSON.parse(path.slice(i + 1, j + 1)));
        i = j + 2;
      } else {
        const j = path.indexOf(']', i);
        if (j === -1) throw new SyntaxError(`Unterminated index in path: ${path}`);
        segments.push(Number(path.slice(i + 1, j)));
        i = j + 1;
      }
    } else {
      throw new SyntaxError(`Unexpected character "${ch}" in path: ${path}`);
    }
  }
  return segments;
}

/**
 * @param {unknown} root
 * @param {Array<string|number>} segments
 * @returns {unknown}
 */
export function getAtPath(root, segments) {
  /** @type {any} */
  let cur = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Set a value in place. Intermediate containers must already exist.
 * @param {unknown} root
 * @param {Array<string|number>} segments
 * @param {unknown} value
 * @returns {boolean} whether the value was set
 */
export function setAtPath(root, segments, value) {
  if (segments.length === 0) return false;
  /** @type {any} */
  const parent = getAtPath(root, segments.slice(0, -1));
  if (parent === null || typeof parent !== 'object') return false;
  parent[segments[segments.length - 1]] = value;
  return true;
}

/**
 * Depth-first walk over every leaf (non-container) value.
 * @param {unknown} value
 * @param {(leaf: unknown, path: Array<string|number>) => void} visit
 * @param {Array<string|number>} [path]
 */
export function walkLeaves(value, visit, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkLeaves(item, visit, [...path, index]));
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) walkLeaves(value[key], visit, [...path, key]);
  } else {
    visit(value, path);
  }
}

/**
 * Generic structural diff between two JSON values.
 * @param {unknown} before
 * @param {unknown} after
 * @param {Array<string|number>} [path]
 * @returns {Array<{op: 'add'|'remove'|'replace', path: Array<string|number>, before?: unknown, after?: unknown}>}
 */
export function diffJson(before, after, path = []) {
  if (deepEqual(before, after)) return [];
  if (before === undefined) return [{ op: 'add', path, after }];
  if (after === undefined) return [{ op: 'remove', path, before }];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareKeys);
    return keys.flatMap((key) => diffJson(before[key], after[key], [...path, key]));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length);
    /** @type {ReturnType<typeof diffJson>} */
    const out = [];
    for (let i = 0; i < max; i += 1) out.push(...diffJson(before[i], after[i], [...path, i]));
    return out;
  }
  return [{ op: 'replace', path, before, after }];
}

/**
 * Parse JSON with a helpful error message that includes the source label.
 * @param {string} text
 * @param {string} label
 */
export function parseJson(text, label) {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SyntaxError(`Invalid JSON in ${label}: ${message}`);
  }
}
