import path from 'node:path';
import { listFiles, pathExists, readJsonFile, writeIfChanged } from '../util/fs.js';
import { isPlainObject, stableStringify } from '../util/json.js';
import { idFromFileName, slugify, workflowFileName } from '../util/slug.js';
import { projectName, tagNames } from './normalize.js';

export const MANIFEST_FILE = 'n8n-sync.manifest.json';
export const MANIFEST_VERSION = 1;

/**
 * @typedef {object} ManifestEntry
 * @property {string} name
 * @property {string} file        POSIX path relative to the workflow directory
 * @property {string} hash        content hash of the remote workflow at last sync
 * @property {boolean} active
 * @property {string[]} tags
 * @property {string|null} project
 * @property {number} nodeCount
 */

/**
 * @typedef {object} Manifest
 * @property {number} version
 * @property {string} source     origin of the instance the directory mirrors
 * @property {Record<string, ManifestEntry>} workflows   keyed by workflow id
 */

/**
 * @typedef {object} LocalWorkflow
 * @property {string} file        POSIX path relative to the directory
 * @property {string} absolute
 * @property {Record<string, any>} workflow
 * @property {string|null} id
 */

/** @param {string} [source] @returns {Manifest} */
export function emptyManifest(source = '') {
  return { version: MANIFEST_VERSION, source, workflows: {} };
}

/**
 * @param {string} dir
 * @returns {Promise<Manifest>}
 */
export async function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  if (!(await pathExists(file))) return emptyManifest();
  const raw = await readJsonFile(file);
  if (!isPlainObject(raw) || !isPlainObject(raw.workflows)) {
    throw new SyntaxError(`${file} is not a valid manifest (expected an object with a "workflows" map)`);
  }
  if (typeof raw.version === 'number' && raw.version > MANIFEST_VERSION) {
    throw new SyntaxError(`${file} has manifest version ${raw.version}; this tool understands up to ${MANIFEST_VERSION}`);
  }
  return {
    version: MANIFEST_VERSION,
    source: typeof raw.source === 'string' ? raw.source : '',
    workflows: /** @type {Record<string, ManifestEntry>} */ (raw.workflows),
  };
}

/**
 * @param {string} dir
 * @param {Manifest} manifest
 * @returns {Promise<boolean>} whether the file changed
 */
export async function writeManifest(dir, manifest) {
  return writeIfChanged(path.join(dir, MANIFEST_FILE), stableStringify(manifest, { priority: ['version', 'source', 'workflows'] }));
}

/**
 * Relative path where a workflow is stored.
 * @param {Record<string, any>} workflow  raw (non-stripped) workflow
 * @param {'none'|'tag'|'project'} groupBy
 */
export function workflowRelativePath(workflow, groupBy = 'none') {
  const file = workflowFileName(workflow);
  if (groupBy === 'tag') {
    const tags = tagNames(workflow);
    return `${tags.length > 0 ? slugify(tags[0]) : '_untagged'}/${file}`;
  }
  if (groupBy === 'project') {
    const project = projectName(workflow);
    return `${project ? slugify(project) : '_no-project'}/${file}`;
  }
  return file;
}

/**
 * Heuristic: does this JSON value look like an n8n workflow?
 * @param {unknown} value
 */
export function looksLikeWorkflow(value) {
  return isPlainObject(value) && Array.isArray(value.nodes) && (value.connections === undefined || isPlainObject(value.connections));
}

/**
 * Load every workflow JSON file below a directory (or a single file).
 * Files that are not workflows (manifest, id maps, package.json ...) are
 * reported in `skipped`; unreadable JSON is reported in `errors`.
 * @param {string} target directory or file
 * @returns {Promise<{workflows: LocalWorkflow[], skipped: string[], errors: Array<{file: string, message: string}>}>}
 */
export async function loadWorkflows(target) {
  /** @type {LocalWorkflow[]} */
  const workflows = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {Array<{file: string, message: string}>} */
  const errors = [];
  /** @type {Array<{file: string, absolute: string}>} */
  let files;
  if (target.endsWith('.json') && (await pathExists(target))) {
    files = [{ file: path.basename(target), absolute: path.resolve(target) }];
  } else {
    const names = await listFiles(target, (rel) => rel.endsWith('.json'));
    files = names.map((file) => ({ file, absolute: path.join(target, file) }));
  }
  for (const { file, absolute } of files) {
    if (path.basename(file) === MANIFEST_FILE) continue;
    let value;
    try {
      value = await readJsonFile(absolute);
    } catch (err) {
      errors.push({ file, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!looksLikeWorkflow(value)) {
      skipped.push(file);
      continue;
    }
    const id = value.id !== undefined && value.id !== null && value.id !== '' ? String(value.id) : idFromFileName(file);
    workflows.push({ file, absolute, workflow: value, id: id === 'noid' ? null : id });
  }
  return { workflows, skipped, errors };
}

/**
 * Detect workflows that share the same id inside one directory.
 * @param {LocalWorkflow[]} workflows
 * @returns {Array<{id: string, files: string[]}>}
 */
export function findDuplicateIds(workflows) {
  /** @type {Map<string, string[]>} */
  const byId = new Map();
  for (const wf of workflows) {
    if (!wf.id) continue;
    byId.set(wf.id, [...(byId.get(wf.id) ?? []), wf.file]);
  }
  return [...byId.entries()].filter(([, files]) => files.length > 1).map(([id, files]) => ({ id, files }));
}

/**
 * Id mapping between environments: source workflow id -> target workflow id,
 * plus the content hash of each target workflow as of the last push (the
 * baseline for conflict detection on the target instance).
 * @typedef {{version: number, workflows: Record<string, string>, pushed: Record<string, string>}} IdMap
 */

/**
 * @param {string|null} file
 * @returns {Promise<IdMap>}
 */
export async function readIdMap(file) {
  if (!file || !(await pathExists(file))) return { version: 1, workflows: {}, pushed: {} };
  const raw = await readJsonFile(file);
  if (!isPlainObject(raw)) throw new SyntaxError(`${file} is not a valid id map`);
  /** @param {unknown} source */
  const strings = (source) => {
    /** @type {Record<string, string>} */
    const out = {};
    if (!isPlainObject(source)) return out;
    for (const [from, to] of Object.entries(source)) {
      if (typeof to === 'string' || typeof to === 'number') out[from] = String(to);
    }
    return out;
  };
  return { version: 1, workflows: strings(raw.workflows), pushed: strings(raw.pushed) };
}

/**
 * @param {string} file
 * @param {IdMap} map
 */
export async function writeIdMap(file, map) {
  return writeIfChanged(file, stableStringify(map, { priority: ['version', 'workflows', 'pushed'] }));
}
