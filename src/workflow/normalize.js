import { clone, compareKeys, isPlainObject, sortKeysDeep, stableStringify } from '../util/json.js';
import { hashJson } from '../util/hash.js';

/**
 * Top-level fields that change on every save or are instance-specific
 * bookkeeping. They are removed by default so that a pull that changed
 * nothing produces no git diff.
 */
export const VOLATILE_FIELDS = Object.freeze([
  'updatedAt', 'createdAt', 'versionId', 'activeVersionId', 'versionCounter', 'triggerCount',
  'staticData', 'shared', 'homeProject', 'sharedWithProjects', 'usedCredentials', 'scopes',
  'parentFolder', 'activeVersion',
]);

/** Key order used at the top of every workflow file. */
export const WORKFLOW_KEY_PRIORITY = Object.freeze(['id', 'name', 'active', 'tags', 'settings', 'nodes', 'connections']);

/**
 * @typedef {object} NormalizeOptions
 * @property {boolean} [stripVolatile]  remove volatile fields (default true)
 * @property {boolean} [keepPinData]    keep pinned test data (default false)
 * @property {boolean} [sortNodes]      sort nodes by name (default true)
 */

/**
 * @param {unknown} tags
 * @returns {Array<{id?: string, name: string}>}
 */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  /** @type {Array<{id?: string, name: string}>} */
  const out = [];
  for (const tag of tags) {
    if (typeof tag === 'string') out.push({ name: tag });
    else if (isPlainObject(tag) && typeof tag.name === 'string') {
      out.push(tag.id !== undefined ? { id: String(tag.id), name: tag.name } : { name: tag.name });
    }
  }
  return out.sort((a, b) => compareKeys(a.name, b.name));
}

/**
 * @param {unknown} workflow
 * @returns {string[]} sorted tag names
 */
export function tagNames(workflow) {
  return normalizeTags(/** @type {any} */ (workflow)?.tags).map((t) => t.name);
}

/**
 * Sort the connection map: source node names alphabetically, connection types
 * alphabetically. Output slot order and target order inside a slot are
 * semantically meaningful and are preserved.
 * @param {unknown} connections
 */
export function normalizeConnections(connections) {
  if (!isPlainObject(connections)) return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const source of Object.keys(connections).sort(compareKeys)) {
    const byType = connections[source];
    if (!isPlainObject(byType)) continue;
    /** @type {Record<string, any>} */
    const types = {};
    for (const type of Object.keys(byType).sort(compareKeys)) {
      const slots = byType[type];
      if (!Array.isArray(slots)) continue;
      types[type] = slots.map((slot) => (Array.isArray(slot)
        ? slot.map((target) => sortKeysDeep(target, ['node', 'type', 'index']))
        : []));
    }
    if (Object.keys(types).length > 0) out[source] = types;
  }
  return out;
}

/**
 * Produce the deterministic on-disk representation of a workflow.
 * The input is not modified.
 * @param {Record<string, any>} workflow
 * @param {NormalizeOptions} [options]
 * @returns {Record<string, any>}
 */
export function normalizeWorkflow(workflow, options = {}) {
  const { stripVolatile = true, keepPinData = false, sortNodes = true } = options;
  /** @type {Record<string, any>} */
  const wf = clone(workflow);
  if (stripVolatile) {
    for (const field of VOLATILE_FIELDS) delete wf[field];
    if (isPlainObject(wf.meta)) {
      delete wf.meta.instanceId;
      if (Object.keys(wf.meta).length === 0) delete wf.meta;
    }
    if (wf.meta === null) delete wf.meta;
  }
  if (!keepPinData || wf.pinData === null || (isPlainObject(wf.pinData) && Object.keys(wf.pinData).length === 0)) {
    delete wf.pinData;
  }
  if (wf.id !== undefined && wf.id !== null) wf.id = String(wf.id);
  wf.active = Boolean(wf.active);
  wf.tags = normalizeTags(wf.tags);
  wf.settings = isPlainObject(wf.settings) ? wf.settings : {};
  let nodes = Array.isArray(wf.nodes) ? wf.nodes.filter(isPlainObject) : [];
  if (sortNodes) {
    nodes = [...nodes].sort((a, b) => compareKeys(String(a.name ?? ''), String(b.name ?? ''))
      || compareKeys(String(a.id ?? ''), String(b.id ?? '')));
  }
  wf.nodes = nodes;
  wf.connections = normalizeConnections(wf.connections);
  return sortKeysDeep(wf, [...WORKFLOW_KEY_PRIORITY]);
}

/**
 * Serialise a normalised workflow to the exact text written to disk.
 * @param {Record<string, any>} workflow
 * @param {NormalizeOptions} [options]
 */
export function serializeWorkflow(workflow, options = {}) {
  return stableStringify(normalizeWorkflow(workflow, options), { priority: [...WORKFLOW_KEY_PRIORITY] });
}

/**
 * The part of a workflow that defines its behaviour. Used for hashing and
 * for deciding whether a push is needed. Independent of normalisation
 * options, activation state, tags and ids so the same logical workflow has
 * the same hash on every instance.
 * @param {Record<string, any>} workflow
 */
export function semanticContent(workflow) {
  const normal = normalizeWorkflow(workflow, { stripVolatile: true, keepPinData: false, sortNodes: true });
  return {
    name: normal.name ?? '',
    nodes: normal.nodes,
    connections: normal.connections,
    settings: normal.settings,
  };
}

/**
 * Stable sha256 of {@link semanticContent}.
 * @param {Record<string, any>} workflow
 */
export function contentHash(workflow) {
  return hashJson(semanticContent(workflow));
}

/**
 * Best-effort project name from the fields different n8n versions expose.
 * @param {Record<string, any>} workflow
 * @returns {string|null}
 */
export function projectName(workflow) {
  if (isPlainObject(workflow.homeProject) && typeof workflow.homeProject.name === 'string') {
    return workflow.homeProject.name;
  }
  if (Array.isArray(workflow.shared)) {
    const owner = workflow.shared.find((s) => isPlainObject(s) && s.role === 'workflow:owner') ?? workflow.shared[0];
    if (isPlainObject(owner) && isPlainObject(owner.project) && typeof owner.project.name === 'string') {
      return owner.project.name;
    }
  }
  return null;
}
