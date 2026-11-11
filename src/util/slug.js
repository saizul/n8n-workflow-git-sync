/**
 * Filename helpers. Workflow names are free text, so they must be reduced to
 * something that is safe on every filesystem and stable between runs.
 */

const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Lowercase ASCII slug: diacritics are folded, everything that is not a letter
 * or digit becomes a single dash.
 * @param {string} input
 * @param {{maxLength?: number, fallback?: string}} [options]
 */
export function slugify(input, options = {}) {
  const { maxLength = 60, fallback = 'untitled' } = options;
  let slug = String(input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > maxLength) slug = slug.slice(0, maxLength).replace(/-+$/g, '');
  if (slug === '' || RESERVED.has(slug)) slug = slug === '' ? fallback : `${slug}-wf`;
  return slug;
}

/**
 * Make an id safe for use inside a filename.
 * @param {string|number} id
 */
export function safeId(id) {
  const text = String(id ?? '').replace(/[^A-Za-z0-9_-]+/g, '');
  return text === '' ? 'noid' : text;
}

/**
 * `<slug>--<id>.json`. The double dash makes the id unambiguous to extract.
 * @param {{id?: string|number, name?: string}} workflow
 */
export function workflowFileName(workflow) {
  return `${slugify(workflow.name ?? '')}--${safeId(workflow.id ?? '')}.json`;
}

/**
 * Extract the id suffix from a file name produced by {@link workflowFileName}.
 * @param {string} fileName
 * @returns {string|null}
 */
export function idFromFileName(fileName) {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const match = /--([A-Za-z0-9_-]+)\.json$/.exec(base);
  return match ? match[1] : null;
}

/**
 * Timestamp suitable for directory names: `20260131T235959Z`.
 * @param {Date} date
 */
export function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Inverse of {@link compactTimestamp}.
 * @param {string} stamp
 * @returns {Date|null}
 */
export function parseCompactTimestamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
