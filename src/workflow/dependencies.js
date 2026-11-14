import { isPlainObject } from '../util/json.js';
import { isStickyNote, isTrigger } from './graph.js';

/** Node types that run another workflow by id. */
export const WORKFLOW_CALLER_TYPES = Object.freeze([
  'n8n-nodes-base.executeWorkflow',
  '@n8n/n8n-nodes-langchain.toolWorkflow',
]);

const SUB_WORKFLOW_TRIGGER = 'n8n-nodes-base.executeWorkflowTrigger';
const ERROR_TRIGGER = 'n8n-nodes-base.errorTrigger';

/**
 * A reference from one workflow to another.
 * @typedef {object} WorkflowReference
 * @property {'call'|'error-workflow'} kind
 * @property {string|null} node        name of the calling node, null for settings.errorWorkflow
 * @property {string|null} target      referenced workflow id, null when it is computed by an expression
 * @property {boolean} dynamic         the id is an n8n expression and cannot be resolved statically
 * @property {boolean} disabled        the calling node is disabled
 */

/**
 * Pull a workflow id out of an n8n workflow URL such as
 * `https://n8n.example.com/workflow/42` or `/workflow/42/executions`.
 * @param {string} url
 * @returns {string|null}
 */
export function workflowIdFromUrl(url) {
  const match = /\/workflow\/([^/?#\s]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Resolve the `workflowId` parameter of a caller node. It is either a plain
 * string or a resource locator (`{__rl: true, mode, value}`).
 * @param {unknown} ref
 * @returns {{target: string|null, dynamic: boolean}|null}  null when no workflow is set
 */
function resolveWorkflowId(ref) {
  /** @type {unknown} */
  let value = ref;
  let mode = 'id';
  if (isPlainObject(ref)) {
    value = ref.value;
    if (typeof ref.mode === 'string') mode = ref.mode;
  }
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (value.startsWith('=')) return { target: null, dynamic: true };
  if (mode === 'url') {
    const id = workflowIdFromUrl(value);
    return id === null ? null : { target: id, dynamic: false };
  }
  return { target: value.trim(), dynamic: false };
}

/**
 * List the references a workflow makes to other workflows: sub-workflow calls
 * (Execute Workflow and workflow tool nodes whose source is the database) and
 * the error workflow setting.
 * @param {Record<string, any>} workflow
 * @returns {WorkflowReference[]}
 */
export function extractReferences(workflow) {
  /** @type {WorkflowReference[]} */
  const refs = [];
  const errorWorkflow = isPlainObject(workflow.settings) ? workflow.settings.errorWorkflow : undefined;
  if ((typeof errorWorkflow === 'string' && errorWorkflow.trim() !== '') || typeof errorWorkflow === 'number') {
    const id = String(errorWorkflow).trim();
    const dynamic = id.startsWith('=');
    refs.push({ kind: 'error-workflow', node: null, target: dynamic ? null : id, dynamic, disabled: false });
  }
  for (const node of Array.isArray(workflow.nodes) ? workflow.nodes : []) {
    if (!isPlainObject(node) || !WORKFLOW_CALLER_TYPES.includes(node.type)) continue;
    const parameters = isPlainObject(node.parameters) ? node.parameters : {};
    // Other sources (localFile, parameter, url) do not point at a stored workflow.
    if (parameters.source !== undefined && parameters.source !== 'database') continue;
    const resolved = resolveWorkflowId(parameters.workflowId);
    if (resolved === null) continue;
    refs.push({ kind: 'call', node: String(node.name ?? ''), ...resolved, disabled: node.disabled === true });
  }
  return refs;
}

/**
 * @typedef {object} DependencyNode
 * @property {string} key             workflow id, or `file:<path>` for a workflow without an id
 * @property {string|null} id
 * @property {string} name
 * @property {string} file
 * @property {boolean} subWorkflow    has an Execute Workflow Trigger
 * @property {boolean} errorHandler   has an Error Trigger
 * @property {boolean} otherTriggers  has any other trigger
 */

/**
 * @typedef {object} DependencyEdge
 * @property {string} from            key of the referencing workflow
 * @property {string} to              key of the referenced workflow
 * @property {'call'|'error-workflow'} kind
 * @property {string|null} node
 * @property {boolean} disabled
 */

/**
 * @typedef {object} MissingReference
 * @property {string} from
 * @property {string} file
 * @property {'call'|'error-workflow'} kind
 * @property {string|null} node
 * @property {string} target
 * @property {boolean} disabled
 */

/**
 * @typedef {object} DependencyGraph
 * @property {DependencyNode[]} nodes                 sorted by name, then key
 * @property {DependencyEdge[]} edges
 * @property {MissingReference[]} missing             references to ids that are not in the set
 * @property {Array<{from: string, file: string, node: string|null, kind: 'call'|'error-workflow'}>} dynamic
 * @property {string[][]} cycles                      sub-workflow call cycles (keys)
 * @property {Array<{key: string, reason: 'never-called'|'never-used-as-error-workflow'}>} unused
 * @property {string[]} order                         keys, every workflow after the workflows it references
 */

/**
 * @param {DependencyNode} a
 * @param {DependencyNode} b
 */
function byName(a, b) {
  return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
}

/**
 * Strongly connected components (Tarjan). Components come out in reverse
 * topological order: a component is emitted after everything it points to.
 * @param {string[]} keys                       vertices, in a stable order
 * @param {Map<string, string[]>} successors    sorted adjacency lists
 * @returns {string[][]}
 */
function stronglyConnected(keys, successors) {
  let counter = 0;
  /** @type {Map<string, number>} */
  const index = new Map();
  /** @type {Map<string, number>} */
  const low = new Map();
  /** @type {string[]} */
  const stack = [];
  const onStack = new Set();
  /** @type {string[][]} */
  const components = [];

  // Iterative to stay safe on deep call chains.
  for (const root of keys) {
    if (index.has(root)) continue;
    /** @type {Array<{key: string, next: number}>} */
    const frames = [{ key: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const out = successors.get(frame.key) ?? [];
      if (frame.next < out.length) {
        const to = out[frame.next];
        frame.next += 1;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter);
          counter += 1;
          stack.push(to);
          onStack.add(to);
          frames.push({ key: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.key, Math.min(/** @type {number} */ (low.get(frame.key)), /** @type {number} */ (index.get(to))));
        }
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].key;
        low.set(parent, Math.min(/** @type {number} */ (low.get(parent)), /** @type {number} */ (low.get(frame.key))));
      }
      if (low.get(frame.key) === index.get(frame.key)) {
        /** @type {string[]} */
        const component = [];
        let member;
        do {
          member = /** @type {string} */ (stack.pop());
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.key);
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * Build the graph of references between a set of workflows.
 * @param {Array<{id: string|null, file: string, display?: string, workflow: Record<string, any>}>} workflows
 * @returns {DependencyGraph}
 */
export function buildDependencyGraph(workflows) {
  /** @type {Map<string, DependencyNode>} */
  const nodes = new Map();
  /** @type {Map<string, WorkflowReference[]>} */
  const refsByKey = new Map();
  for (const wf of workflows) {
    const file = wf.display ?? wf.file;
    const key = wf.id ?? `file:${file}`;
    if (nodes.has(key)) continue; // duplicate ids are reported by validate
    const real = (Array.isArray(wf.workflow.nodes) ? wf.workflow.nodes : []).filter((n) => isPlainObject(n) && !isStickyNote(n));
    const triggers = real.filter((n) => isTrigger(n) && n.disabled !== true);
    nodes.set(key, {
      key,
      id: wf.id,
      name: String(wf.workflow.name ?? ''),
      file,
      subWorkflow: triggers.some((n) => n.type === SUB_WORKFLOW_TRIGGER),
      errorHandler: triggers.some((n) => n.type === ERROR_TRIGGER),
      otherTriggers: triggers.some((n) => n.type !== SUB_WORKFLOW_TRIGGER && n.type !== ERROR_TRIGGER),
    });
    refsByKey.set(key, extractReferences(wf.workflow));
  }

  /** @type {DependencyEdge[]} */
  const edges = [];
  /** @type {MissingReference[]} */
  const missing = [];
  /** @type {DependencyGraph['dynamic']} */
  const dynamic = [];
  for (const [from, refs] of refsByKey) {
    const source = /** @type {DependencyNode} */ (nodes.get(from));
    for (const ref of refs) {
      if (ref.dynamic || ref.target === null) {
        dynamic.push({ from, file: source.file, node: ref.node, kind: ref.kind });
      } else if (nodes.has(ref.target)) {
        edges.push({ from, to: ref.target, kind: ref.kind, node: ref.node, disabled: ref.disabled });
      } else {
        missing.push({ from, file: source.file, kind: ref.kind, node: ref.node, target: ref.target, disabled: ref.disabled });
      }
    }
  }

  const sorted = [...nodes.values()].sort(byName);
  const keys = sorted.map((n) => n.key);
  const rank = new Map(keys.map((key, i) => [key, i]));
  /** @param {(edge: DependencyEdge) => boolean} keep */
  const adjacency = (keep) => {
    /** @type {Map<string, string[]>} */
    const out = new Map();
    for (const edge of edges) {
      if (!keep(edge)) continue;
      const list = out.get(edge.from) ?? [];
      if (!list.includes(edge.to)) list.push(edge.to);
      out.set(edge.from, list);
    }
    for (const list of out.values()) list.sort((a, b) => /** @type {number} */ (rank.get(a)) - /** @type {number} */ (rank.get(b)));
    return out;
  };

  const callAdjacency = adjacency((edge) => edge.kind === 'call');
  const cycles = stronglyConnected(keys, callAdjacency)
    .filter((component) => component.length > 1 || (callAdjacency.get(component[0]) ?? []).includes(component[0]))
    .map((component) => component.sort((a, b) => /** @type {number} */ (rank.get(a)) - /** @type {number} */ (rank.get(b))))
    .sort((a, b) => /** @type {number} */ (rank.get(a[0])) - /** @type {number} */ (rank.get(b[0])));

  // Callees first: Tarjan emits every component after the components it points to.
  const order = stronglyConnected(keys, adjacency(() => true))
    .flatMap((component) => component.sort((a, b) => /** @type {number} */ (rank.get(a)) - /** @type {number} */ (rank.get(b))));

  const called = new Set(edges.filter((e) => e.kind === 'call' && e.from !== e.to).map((e) => e.to));
  const usedAsErrorWorkflow = new Set(edges.filter((e) => e.kind === 'error-workflow').map((e) => e.to));
  /** @type {DependencyGraph['unused']} */
  const unused = [];
  for (const node of sorted) {
    if (node.otherTriggers) continue;
    if (node.subWorkflow && !called.has(node.key)) unused.push({ key: node.key, reason: 'never-called' });
    else if (node.errorHandler && !node.subWorkflow && !usedAsErrorWorkflow.has(node.key)) {
      unused.push({ key: node.key, reason: 'never-used-as-error-workflow' });
    }
  }

  return { nodes: sorted, edges, missing, dynamic, cycles, unused, order };
}

/**
 * Keys of every workflow reachable from `start` by following edges forwards
 * (what it depends on) or backwards (what depends on it). `start` itself is
 * not included.
 * @param {DependencyGraph} graph
 * @param {string} start
 * @param {'dependencies'|'dependents'} direction
 * @returns {string[]}
 */
export function reachable(graph, start, direction) {
  /** @type {Map<string, string[]>} */
  const next = new Map();
  for (const edge of graph.edges) {
    const [a, b] = direction === 'dependencies' ? [edge.from, edge.to] : [edge.to, edge.from];
    next.set(a, [...(next.get(a) ?? []), b]);
  }
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const key = /** @type {string} */ (queue.shift());
    for (const to of next.get(key) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  seen.delete(start);
  const rank = new Map(graph.nodes.map((n, i) => [n.key, i]));
  return [...seen].sort((a, b) => /** @type {number} */ (rank.get(a)) - /** @type {number} */ (rank.get(b)));
}

/**
 * Restrict a graph to the given keys (edges, findings and order included).
 * @param {DependencyGraph} graph
 * @param {Set<string>} keys
 * @returns {DependencyGraph}
 */
export function subgraph(graph, keys) {
  return {
    nodes: graph.nodes.filter((n) => keys.has(n.key)),
    edges: graph.edges.filter((e) => keys.has(e.from) && keys.has(e.to)),
    missing: graph.missing.filter((m) => keys.has(m.from)),
    dynamic: graph.dynamic.filter((d) => keys.has(d.from)),
    cycles: graph.cycles.filter((cycle) => cycle.some((key) => keys.has(key))),
    unused: graph.unused.filter((u) => keys.has(u.key)),
    order: graph.order.filter((key) => keys.has(key)),
  };
}

/** @param {string} text */
function mermaidEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ');
}

/**
 * Render the dependency graph as a Mermaid flowchart. Sub-workflow calls are
 * solid arrows, error workflow settings dashed, missing targets red.
 * @param {DependencyGraph} graph
 * @param {{direction?: string}} [options]
 * @returns {string}
 */
export function dependenciesToMermaid(graph, options = {}) {
  const lines = [`flowchart ${options.direction ?? 'LR'}`];
  const ids = new Map(graph.nodes.map((n, i) => [n.key, `w${i}`]));
  for (const node of graph.nodes) {
    const label = node.id ? `${mermaidEscape(node.name)}<br/><i>${mermaidEscape(node.id)}</i>` : mermaidEscape(node.name);
    lines.push(node.subWorkflow || node.errorHandler ? `  ${ids.get(node.key)}(["${label}"])` : `  ${ids.get(node.key)}["${label}"]`);
  }
  const missingIds = new Map();
  for (const ref of graph.missing) {
    if (!missingIds.has(ref.target)) {
      const id = `m${missingIds.size}`;
      missingIds.set(ref.target, id);
      lines.push(`  ${id}["missing: ${mermaidEscape(ref.target)}"]:::missing`);
    }
  }
  const seen = new Set();
  /**
   * @param {string} from
   * @param {string} to
   * @param {'call'|'error-workflow'} kind
   */
  const edge = (from, to, kind) => {
    const line = kind === 'call' ? `  ${from} --> ${to}` : `  ${from} -.->|on error| ${to}`;
    if (!seen.has(line)) lines.push(line);
    seen.add(line);
  };
  for (const e of graph.edges) edge(/** @type {string} */ (ids.get(e.from)), /** @type {string} */ (ids.get(e.to)), e.kind);
  for (const m of graph.missing) edge(/** @type {string} */ (ids.get(m.from)), missingIds.get(m.target), m.kind);
  if (missingIds.size > 0) lines.push('  classDef missing stroke:#d33,stroke-dasharray:4 2,color:#d33');
  return lines.join('\n');
}
