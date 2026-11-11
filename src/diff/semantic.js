import { deepEqual, diffJson, formatPath, isPlainObject } from '../util/json.js';
import { edgeKey, listEdges } from '../workflow/graph.js';
import { tagNames } from '../workflow/normalize.js';

/**
 * @typedef {object} ValueChange
 * @property {'add'|'remove'|'replace'} op
 * @property {string} path      JSON-path, relative to the node or settings object
 * @property {unknown} [before]
 * @property {unknown} [after]
 */

/**
 * @typedef {object} WorkflowDiff
 * @property {boolean} changed
 * @property {{before: unknown, after: unknown}|null} name
 * @property {{before: boolean, after: boolean}|null} active
 * @property {{added: Array<{name: string, type: string}>, removed: Array<{name: string, type: string}>, renamed: Array<{from: string, to: string}>, changed: Array<{name: string, type: string, changes: ValueChange[]}>}} nodes
 * @property {{added: import('../workflow/graph.js').Edge[], removed: import('../workflow/graph.js').Edge[]}} connections
 * @property {ValueChange[]} settings
 * @property {{added: string[], removed: string[]}} tags
 */

/**
 * @typedef {object} DiffOptions
 * @property {boolean} [includePosition]   report canvas position changes (default false)
 * @property {boolean} [includeActive]     report activation changes (default true)
 * @property {boolean} [includeTags]       report tag changes (default true)
 * @property {boolean} [ignoreCredentialIds] compare credentials by name only (default false)
 */

/** Node fields that never count as a behavioural change. */
const NODE_IDENTITY_FIELDS = ['name', 'id'];

/**
 * @param {Record<string, any>} node
 * @param {DiffOptions} options
 */
function comparableNode(node, options) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (NODE_IDENTITY_FIELDS.includes(key)) continue;
    if (key === 'position' && !options.includePosition) continue;
    if (key === 'webhookId') continue;
    out[key] = value;
  }
  if (options.ignoreCredentialIds && isPlainObject(out.credentials)) {
    out.credentials = Object.fromEntries(Object.entries(out.credentials).map(
      ([type, ref]) => [type, isPlainObject(ref) ? { name: ref.name } : ref],
    ));
  }
  // An absent "disabled" and an explicit false are the same thing.
  if (out.disabled === false) delete out.disabled;
  if (isPlainObject(out.parameters) && Object.keys(out.parameters).length === 0) delete out.parameters;
  return out;
}

/**
 * @param {unknown} workflow
 * @returns {Map<string, Record<string, any>>}
 */
function nodesByName(workflow) {
  /** @type {Map<string, Record<string, any>>} */
  const map = new Map();
  const nodes = isPlainObject(workflow) && Array.isArray(workflow.nodes) ? workflow.nodes : [];
  for (const node of nodes) {
    if (isPlainObject(node) && typeof node.name === 'string' && !map.has(node.name)) map.set(node.name, node);
  }
  return map;
}

/**
 * Semantic diff between two versions of a workflow.
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @param {DiffOptions} [options]
 * @returns {WorkflowDiff}
 */
export function diffWorkflows(before, after, options = {}) {
  const beforeNodes = nodesByName(before);
  const afterNodes = nodesByName(after);
  let removedNames = [...beforeNodes.keys()].filter((name) => !afterNodes.has(name));
  let addedNames = [...afterNodes.keys()].filter((name) => !beforeNodes.has(name));

  // Rename detection: first by stable node id, then by identical content.
  /** @type {Array<{from: string, to: string}>} */
  const renamed = [];
  for (const from of [...removedNames]) {
    const node = /** @type {Record<string, any>} */ (beforeNodes.get(from));
    let to = node.id !== undefined
      ? addedNames.find((name) => afterNodes.get(name)?.id === node.id && afterNodes.get(name)?.type === node.type)
      : undefined;
    if (to === undefined) {
      const candidates = addedNames.filter((name) => deepEqual(
        comparableNode(/** @type {Record<string, any>} */ (afterNodes.get(name)), options),
        comparableNode(node, options),
      ));
      if (candidates.length === 1) [to] = candidates;
    }
    if (to !== undefined) {
      renamed.push({ from, to });
      removedNames = removedNames.filter((name) => name !== from);
      addedNames = addedNames.filter((name) => name !== to);
    }
  }
  const renameMap = new Map(renamed.map((r) => [r.from, r.to]));

  /** @type {WorkflowDiff['nodes']['changed']} */
  const changedNodes = [];
  for (const [name, node] of beforeNodes) {
    const target = afterNodes.get(renameMap.get(name) ?? name);
    if (!target) continue;
    const changes = diffJson(comparableNode(node, options), comparableNode(target, options))
      .map((change) => ({ ...change, path: formatPath(change.path) }));
    if (changes.length > 0) changedNodes.push({ name: target.name, type: String(target.type ?? ''), changes });
  }

  // Connections: translate old names through the rename map so a pure rename
  // does not show up as every edge being removed and re-added.
  const beforeEdges = listEdges(before?.connections).map((edge) => ({
    ...edge, from: renameMap.get(edge.from) ?? edge.from, to: renameMap.get(edge.to) ?? edge.to,
  }));
  const afterEdges = listEdges(after?.connections);
  const beforeKeys = new Set(beforeEdges.map(edgeKey));
  const afterKeys = new Set(afterEdges.map(edgeKey));
  const sortEdges = (/** @type {import('../workflow/graph.js').Edge[]} */ edges) => edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

  const beforeTags = tagNames(before);
  const afterTags = tagNames(after);
  const includeTags = options.includeTags !== false;
  const includeActive = options.includeActive !== false;

  /** @param {string} name @param {Map<string, Record<string, any>>} map */
  const brief = (name, map) => ({ name, type: String(map.get(name)?.type ?? '') });

  /** @type {WorkflowDiff} */
  const diff = {
    changed: false,
    name: (before?.name ?? '') === (after?.name ?? '') ? null : { before: before?.name, after: after?.name },
    active: includeActive && Boolean(before?.active) !== Boolean(after?.active)
      ? { before: Boolean(before?.active), after: Boolean(after?.active) }
      : null,
    nodes: {
      added: addedNames.sort().map((name) => brief(name, afterNodes)),
      removed: removedNames.sort().map((name) => brief(name, beforeNodes)),
      renamed: renamed.sort((a, b) => a.from.localeCompare(b.from)),
      changed: changedNodes.sort((a, b) => a.name.localeCompare(b.name)),
    },
    connections: {
      added: sortEdges(afterEdges.filter((edge) => !beforeKeys.has(edgeKey(edge)))),
      removed: sortEdges(beforeEdges.filter((edge) => !afterKeys.has(edgeKey(edge)))),
    },
    settings: diffJson(
      isPlainObject(before?.settings) ? before.settings : {},
      isPlainObject(after?.settings) ? after.settings : {},
    ).map((change) => ({ ...change, path: formatPath(change.path) })),
    tags: {
      added: includeTags ? afterTags.filter((tag) => !beforeTags.includes(tag)) : [],
      removed: includeTags ? beforeTags.filter((tag) => !afterTags.includes(tag)) : [],
    },
  };
  diff.changed = Boolean(diff.name || diff.active
    || diff.nodes.added.length || diff.nodes.removed.length || diff.nodes.renamed.length || diff.nodes.changed.length
    || diff.connections.added.length || diff.connections.removed.length
    || diff.settings.length || diff.tags.added.length || diff.tags.removed.length);
  return diff;
}

/**
 * @typedef {object} SetDiff
 * @property {Array<{id: string|null, name: string}>} added     only in `after`
 * @property {Array<{id: string|null, name: string}>} removed   only in `before`
 * @property {Array<{id: string|null, name: string, diff: WorkflowDiff}>} changed
 * @property {number} unchanged
 * @property {boolean} hasChanges
 */

/**
 * Diff two collections of workflows. Workflows are matched by id; a workflow
 * without a counterpart by id is matched by exact name when that is
 * unambiguous (useful when comparing exports from different instances).
 * @param {Array<Record<string, any>>} before
 * @param {Array<Record<string, any>>} after
 * @param {DiffOptions & {matchBy?: 'id'|'name'}} [options]
 * @returns {SetDiff}
 */
export function diffWorkflowSets(before, after, options = {}) {
  const matchBy = options.matchBy ?? 'id';
  /** @param {Record<string, any>} wf */
  const keyOf = (wf) => (matchBy === 'name' ? `name:${wf.name}` : wf.id !== undefined && wf.id !== null ? `id:${wf.id}` : `name:${wf.name}`);
  const remaining = new Map(after.map((wf) => [keyOf(wf), wf]));
  /** @type {Array<[Record<string, any>, Record<string, any>]>} */
  const pairs = [];
  /** @type {Array<Record<string, any>>} */
  let unmatched = [];
  for (const wf of before) {
    const key = keyOf(wf);
    const other = remaining.get(key);
    if (other) {
      pairs.push([wf, other]);
      remaining.delete(key);
    } else {
      unmatched.push(wf);
    }
  }
  if (matchBy === 'id') {
    for (const wf of [...unmatched]) {
      const sameName = [...remaining.entries()].filter(([, other]) => other.name === wf.name);
      const sameNameBefore = unmatched.filter((other) => other.name === wf.name);
      if (sameName.length === 1 && sameNameBefore.length === 1) {
        pairs.push([wf, sameName[0][1]]);
        remaining.delete(sameName[0][0]);
        unmatched = unmatched.filter((other) => other !== wf);
      }
    }
  }
  /** @param {Record<string, any>} wf */
  const brief = (wf) => ({ id: wf.id !== undefined && wf.id !== null ? String(wf.id) : null, name: String(wf.name ?? '') });
  /** @type {SetDiff['changed']} */
  const changed = [];
  let unchanged = 0;
  for (const [a, b] of pairs) {
    const diff = diffWorkflows(a, b, options);
    if (diff.changed) changed.push({ ...brief(b), diff });
    else unchanged += 1;
  }
  const byName = (/** @type {{name: string}} */ a, /** @type {{name: string}} */ b) => a.name.localeCompare(b.name);
  const added = [...remaining.values()].map(brief).sort(byName);
  const removed = unmatched.map(brief).sort(byName);
  return {
    added, removed, changed: changed.sort(byName), unchanged,
    hasChanges: added.length + removed.length + changed.length > 0,
  };
}
