import { isPlainObject } from '../../util/json.js';
import { isStickyNote, isTrigger } from '../../workflow/graph.js';

const HTTP_TYPE = 'n8n-nodes-base.httpRequest';

/** Trigger types for which an error workflow adds little value. */
const PASSIVE_TRIGGERS = new Set([
  'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.start',
]);

/**
 * Has the node any explicit failure behaviour configured?
 * @param {Record<string, any>} node
 */
export function hasErrorHandling(node) {
  if (node.continueOnFail === true || node.retryOnFail === true) return true;
  return typeof node.onError === 'string' && node.onError !== '' && node.onError !== 'stopWorkflow';
}

/**
 * Does the node talk to something outside the workflow engine?
 * @param {Record<string, any>} node
 * @param {string[]} extraTypes
 */
function isExternalCall(node, extraTypes) {
  if (node.type === HTTP_TYPE || extraTypes.includes(node.type)) return true;
  return isPlainObject(node.credentials) && Object.keys(node.credentials).length > 0;
}

/** @type {import('../engine.js').Rule} */
export const nodeErrorHandling = {
  id: 'node-error-handling',
  description: 'Nodes that call external systems should retry, continue on failure, or be covered by an error workflow.',
  severity: 'warning',
  check({ workflow, nodes, options }) {
    const coveredByWorkflow = typeof workflow.settings?.errorWorkflow === 'string' && workflow.settings.errorWorkflow !== '';
    if (coveredByWorkflow && options.evenWithErrorWorkflow !== true) return [];
    const extra = Array.isArray(options.types) ? options.types.map(String) : [];
    return nodes
      .filter((node) => !isTrigger(node) && !isStickyNote(node) && node.disabled !== true)
      .filter((node) => isExternalCall(node, extra) && !hasErrorHandling(node))
      .map((node) => ({
        message: `Node "${node.name}" calls an external system without retry, on-error behaviour or an error workflow`,
        node: node.name,
      }));
  },
};

/** @type {import('../engine.js').Rule} */
export const missingErrorWorkflow = {
  id: 'missing-error-workflow',
  description: 'Workflows that run unattended should set settings.errorWorkflow.',
  severity: 'warning',
  check({ workflow, nodes, options }) {
    const configured = workflow.settings?.errorWorkflow;
    if (typeof configured === 'string' && configured !== '') return [];
    const triggers = nodes.filter((node) => isTrigger(node) && node.disabled !== true);
    // A workflow that *is* an error handler, or that only runs on demand, is exempt.
    if (nodes.some((node) => node.type === 'n8n-nodes-base.errorTrigger')) return [];
    const unattended = triggers.filter((node) => !PASSIVE_TRIGGERS.has(node.type));
    if (unattended.length === 0) return [];
    if (options.onlyActive === true && workflow.active !== true) return [];
    return [{
      message: `Workflow has no error workflow configured (triggered by ${unattended.map((n) => `"${n.name}"`).join(', ')})`,
      path: '$.settings.errorWorkflow',
    }];
  },
};

/** @type {import('../engine.js').Rule} */
export const httpTimeoutRetry = {
  id: 'http-timeout-retry',
  description: 'HTTP Request nodes should set a timeout and retry on failure.',
  severity: 'warning',
  check({ nodes, options }) {
    const requireTimeout = options.requireTimeout !== false;
    const requireRetry = options.requireRetry !== false;
    const maxTimeout = typeof options.maxTimeoutMs === 'number' ? options.maxTimeoutMs : 0;
    /** @type {import('../engine.js').RuleFinding[]} */
    const out = [];
    for (const node of nodes) {
      if (node.type !== HTTP_TYPE || node.disabled === true) continue;
      const timeout = node.parameters?.options?.timeout;
      const hasTimeout = (typeof timeout === 'number' && timeout > 0) || (typeof timeout === 'string' && timeout.trim() !== '');
      if (requireTimeout && !hasTimeout) {
        out.push({
          message: `HTTP node "${node.name}" has no timeout (parameters.options.timeout)`,
          node: node.name,
          path: '$.parameters.options.timeout',
        });
      } else if (maxTimeout > 0 && typeof timeout === 'number' && timeout > maxTimeout) {
        out.push({
          message: `HTTP node "${node.name}" has a timeout of ${timeout} ms, above the allowed ${maxTimeout} ms`,
          node: node.name,
          path: '$.parameters.options.timeout',
        });
      }
      if (requireRetry && node.retryOnFail !== true) {
        out.push({ message: `HTTP node "${node.name}" does not retry on failure (retryOnFail)`, node: node.name, path: '$.retryOnFail' });
      }
    }
    return out;
  },
};

/**
 * Built-in list of node types that are deprecated outright or below a given
 * type version. Extend or override it with the rule's `nodes` option.
 * @type {Readonly<Record<string, {below?: number, replacement?: string}>>}
 */
export const DEFAULT_DEPRECATED_NODES = Object.freeze({
  'n8n-nodes-base.function': { replacement: 'n8n-nodes-base.code' },
  'n8n-nodes-base.functionItem': { replacement: 'n8n-nodes-base.code' },
  'n8n-nodes-base.start': { replacement: 'n8n-nodes-base.manualTrigger' },
  'n8n-nodes-base.cron': { replacement: 'n8n-nodes-base.scheduleTrigger' },
  'n8n-nodes-base.interval': { replacement: 'n8n-nodes-base.scheduleTrigger' },
  'n8n-nodes-base.httpRequest': { below: 3 },
  'n8n-nodes-base.set': { below: 3 },
  'n8n-nodes-base.if': { below: 2 },
  'n8n-nodes-base.switch': { below: 2 },
  'n8n-nodes-base.merge': { below: 2 },
  'n8n-nodes-base.itemLists': { replacement: 'the dedicated list nodes (splitOut, aggregate, sort, limit)' },
});

/** @type {import('../engine.js').Rule} */
export const deprecatedNodeVersions = {
  id: 'deprecated-node-versions',
  description: 'Flags deprecated node types and outdated node type versions (list is configurable).',
  severity: 'warning',
  check({ nodes, options }) {
    /** @type {Record<string, {below?: number, replacement?: string}|null|false>} */
    const table = { ...(options.useDefaults === false ? {} : DEFAULT_DEPRECATED_NODES), ...(isPlainObject(options.nodes) ? options.nodes : {}) };
    /** @type {import('../engine.js').RuleFinding[]} */
    const out = [];
    for (const node of nodes) {
      const entry = table[node.type];
      if (!isPlainObject(entry)) continue;
      const suffix = entry.replacement ? `; use ${entry.replacement}` : '';
      if (typeof entry.below === 'number') {
        if (typeof node.typeVersion === 'number' && node.typeVersion < entry.below) {
          out.push({
            message: `Node "${node.name}" uses ${node.type} v${node.typeVersion}; versions below ${entry.below} are deprecated${suffix}`,
            node: node.name,
            path: '$.typeVersion',
          });
        }
      } else {
        out.push({ message: `Node "${node.name}" uses deprecated node type ${node.type}${suffix}`, node: node.name, path: '$.type' });
      }
    }
    return out;
  },
};
