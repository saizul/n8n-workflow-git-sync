import { isPlainObject } from '../../util/json.js';
import { findCycles, findOrphans, findUnreachable, isStickyNote } from '../../workflow/graph.js';
import { validateWorkflow } from '../../workflow/validate.js';

/** @type {import('../engine.js').Rule} */
export const validStructure = {
  id: 'valid-structure',
  description: 'The workflow JSON must be structurally valid (same checks as the validate command).',
  severity: 'error',
  check({ workflow }) {
    return validateWorkflow(workflow)
      .filter((issue) => issue.severity === 'error' && issue.code !== 'node-name-duplicate')
      .map((issue) => ({ message: issue.message, path: issue.path }));
  },
};

/** @type {import('../engine.js').Rule} */
export const duplicateNodeNames = {
  id: 'duplicate-node-names',
  description: 'Node names must be unique; connections are keyed by name.',
  severity: 'error',
  check({ workflow }) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const node of Array.isArray(workflow.nodes) ? workflow.nodes : []) {
      if (isPlainObject(node) && typeof node.name === 'string') counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ message: `Node name "${name}" is used ${count} times`, node: name }));
  },
};

/** @type {import('../engine.js').Rule} */
export const noOrphanNodes = {
  id: 'no-orphan-nodes',
  description: 'Every node should be connected and reachable from a trigger.',
  severity: 'warning',
  check({ graph, options }) {
    /** @type {import('../engine.js').RuleFinding[]} */
    const out = findOrphans(graph).map((name) => ({ message: `Node "${name}" is not connected to anything`, node: name }));
    if (options.checkReachability !== false) {
      for (const name of findUnreachable(graph)) {
        out.push({ message: `Node "${name}" cannot be reached from any trigger`, node: name });
      }
    }
    for (const edge of graph.dangling) {
      out.push({
        message: `Connection "${edge.from}" -> "${edge.to}" references a node that does not exist`,
        node: graph.nodes.has(edge.from) ? edge.from : null,
      });
    }
    return out;
  },
};

/** @type {import('../engine.js').Rule} */
export const noCycles = {
  id: 'no-cycles',
  description: 'Connection cycles that do not pass through a loop node can run forever.',
  severity: 'warning',
  check({ graph, options }) {
    return findCycles(graph, { ignoreLoopNodes: options.allowLoopNodes !== false }).map((cycle) => ({
      message: `Cycle detected between nodes: ${cycle.map((n) => `"${n}"`).join(' -> ')}`,
      node: cycle[0],
    }));
  },
};

/** @type {import('../engine.js').Rule} */
export const noDisabledNodes = {
  id: 'no-disabled-nodes',
  description: 'Disabled nodes left in a workflow are dead code.',
  severity: 'warning',
  check({ nodes }) {
    return nodes
      .filter((node) => node.disabled === true && !isStickyNote(node))
      .map((node) => ({ message: `Node "${node.name}" is disabled; remove it or re-enable it`, node: node.name, path: '$.disabled' }));
  },
};
