import { isPlainObject } from '../util/json.js';

export const STICKY_NOTE_TYPE = 'n8n-nodes-base.stickyNote';

const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook', 'n8n-nodes-base.cron', 'n8n-nodes-base.interval', 'n8n-nodes-base.start',
  'n8n-nodes-base.emailReadImap', 'n8n-nodes-base.sseTrigger',
]);

/** Node types that legitimately create loops in the connection graph. */
const LOOP_TYPES = new Set(['n8n-nodes-base.splitInBatches']);

/** @param {unknown} node */
export function isStickyNote(node) {
  return isPlainObject(node) && node.type === STICKY_NOTE_TYPE;
}

/**
 * A node is a trigger when its type name ends in "Trigger" or it is one of
 * the classic trigger nodes that predate that naming convention.
 * @param {unknown} node
 */
export function isTrigger(node) {
  if (!isPlainObject(node) || typeof node.type !== 'string') return false;
  return TRIGGER_TYPES.has(node.type) || /trigger$/i.test(node.type);
}

/** @param {unknown} node */
export function isLoopNode(node) {
  return isPlainObject(node) && typeof node.type === 'string' && LOOP_TYPES.has(node.type);
}

/**
 * Short display form of a node type: `n8n-nodes-base.httpRequest` -> `httpRequest`.
 * @param {string} type
 */
export function shortType(type) {
  const text = String(type ?? '');
  const dot = text.lastIndexOf('.');
  return dot === -1 ? text : text.slice(dot + 1);
}

/**
 * @typedef {object} Edge
 * @property {string} from
 * @property {string} to
 * @property {string} type         connection type, usually "main"
 * @property {number} outputIndex
 * @property {number} inputIndex
 */

/**
 * @typedef {object} WorkflowGraph
 * @property {Map<string, Record<string, any>>} nodes   by name
 * @property {Edge[]} edges        edges whose endpoints both exist
 * @property {Edge[]} dangling     edges with a missing endpoint
 * @property {Map<string, Edge[]>} outgoing
 * @property {Map<string, Edge[]>} incoming
 */

/**
 * Flatten the n8n connection map into an edge list.
 * @param {unknown} connections
 * @returns {Edge[]}
 */
export function listEdges(connections) {
  /** @type {Edge[]} */
  const edges = [];
  if (!isPlainObject(connections)) return edges;
  for (const [from, byType] of Object.entries(connections)) {
    if (!isPlainObject(byType)) continue;
    for (const [type, slots] of Object.entries(byType)) {
      if (!Array.isArray(slots)) continue;
      slots.forEach((slot, outputIndex) => {
        if (!Array.isArray(slot)) return;
        for (const target of slot) {
          if (!isPlainObject(target) || typeof target.node !== 'string') continue;
          edges.push({
            from, to: target.node, type, outputIndex,
            inputIndex: Number.isInteger(target.index) ? /** @type {number} */ (target.index) : 0,
          });
        }
      });
    }
  }
  return edges;
}

/**
 * @param {Edge} edge
 * @returns {string} stable identity of an edge
 */
export function edgeKey(edge) {
  return `${edge.from}\u0000${edge.type}\u0000${edge.outputIndex}\u0000${edge.to}\u0000${edge.inputIndex}`;
}

/**
 * @param {Record<string, any>} workflow
 * @returns {WorkflowGraph}
 */
export function buildGraph(workflow) {
  /** @type {Map<string, Record<string, any>>} */
  const nodes = new Map();
  for (const node of Array.isArray(workflow?.nodes) ? workflow.nodes : []) {
    if (isPlainObject(node) && typeof node.name === 'string' && !nodes.has(node.name)) nodes.set(node.name, node);
  }
  /** @type {Map<string, Edge[]>} */
  const outgoing = new Map();
  /** @type {Map<string, Edge[]>} */
  const incoming = new Map();
  for (const name of nodes.keys()) {
    outgoing.set(name, []);
    incoming.set(name, []);
  }
  /** @type {Edge[]} */
  const edges = [];
  /** @type {Edge[]} */
  const dangling = [];
  for (const edge of listEdges(workflow?.connections)) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      dangling.push(edge);
      continue;
    }
    edges.push(edge);
    /** @type {Edge[]} */ (outgoing.get(edge.from)).push(edge);
    /** @type {Edge[]} */ (incoming.get(edge.to)).push(edge);
  }
  return { nodes, edges, dangling, outgoing, incoming };
}

/**
 * Nodes with no connections at all (sticky notes excluded).
 * @param {WorkflowGraph} graph
 * @returns {string[]}
 */
export function findOrphans(graph) {
  /** @type {string[]} */
  const out = [];
  for (const [name, node] of graph.nodes) {
    if (isStickyNote(node)) continue;
    const degree = /** @type {Edge[]} */ (graph.outgoing.get(name)).length + /** @type {Edge[]} */ (graph.incoming.get(name)).length;
    if (degree === 0 && !(isTrigger(node) && graph.nodes.size === 1)) out.push(name);
  }
  return out.sort();
}

/**
 * Names of nodes reachable from the given start nodes.
 * @param {WorkflowGraph} graph
 * @param {string[]} starts
 * @returns {Set<string>}
 */
export function reachableFrom(graph, starts) {
  const seen = new Set(starts.filter((s) => graph.nodes.has(s)));
  const queue = [...seen];
  while (queue.length > 0) {
    const current = /** @type {string} */ (queue.pop());
    for (const edge of graph.outgoing.get(current) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return seen;
}

/**
 * Connected nodes that cannot be reached from any trigger. Sub-nodes attached
 * through non-"main" connections point *into* their
 * parent, so reachability is computed on the undirected non-main edges too.
 * @param {WorkflowGraph} graph
 * @returns {string[]}
 */
export function findUnreachable(graph) {
  const triggers = [...graph.nodes.entries()].filter(([, node]) => isTrigger(node)).map(([name]) => name);
  if (triggers.length === 0) return [];
  const seen = reachableFrom(graph, triggers);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of graph.edges) {
      if (edge.type !== 'main' && seen.has(edge.to) && !seen.has(edge.from)) {
        for (const name of reachableFrom(graph, [edge.from])) seen.add(name);
        grew = true;
      }
    }
  }
  /** @type {string[]} */
  const out = [];
  for (const [name, node] of graph.nodes) {
    if (isStickyNote(node) || seen.has(name)) continue;
    const degree = /** @type {Edge[]} */ (graph.outgoing.get(name)).length + /** @type {Edge[]} */ (graph.incoming.get(name)).length;
    if (degree > 0) out.push(name);
  }
  return out.sort();
}

/**
 * Strongly connected components with more than one node, or a single node
 * with a self-loop (Tarjan's algorithm, iterative to survive deep graphs).
 * @param {WorkflowGraph} graph
 * @param {{ignoreLoopNodes?: boolean}} [options]  skip cycles that pass through a loop node
 * @returns {string[][]} each cycle as a sorted list of node names
 */
export function findCycles(graph, options = {}) {
  const { ignoreLoopNodes = true } = options;
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

  for (const root of graph.nodes.keys()) {
    if (index.has(root)) continue;
    /** @type {Array<{name: string, next: number}>} */
    const work = [{ name: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const edges = graph.outgoing.get(frame.name) ?? [];
      if (frame.next < edges.length) {
        const to = edges[frame.next].to;
        frame.next += 1;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter);
          counter += 1;
          stack.push(to);
          onStack.add(to);
          work.push({ name: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.name, Math.min(/** @type {number} */ (low.get(frame.name)), /** @type {number} */ (index.get(to))));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].name;
          low.set(parent, Math.min(/** @type {number} */ (low.get(parent)), /** @type {number} */ (low.get(frame.name))));
        }
        if (low.get(frame.name) === index.get(frame.name)) {
          /** @type {string[]} */
          const component = [];
          for (;;) {
            const member = /** @type {string} */ (stack.pop());
            onStack.delete(member);
            component.push(member);
            if (member === frame.name) break;
          }
          components.push(component);
        }
      }
    }
  }

  return components
    .filter((component) => component.length > 1
      || (graph.outgoing.get(component[0]) ?? []).some((edge) => edge.to === component[0]))
    .filter((component) => !ignoreLoopNodes || !component.some((name) => isLoopNode(graph.nodes.get(name))))
    .map((component) => [...component].sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Deterministic topological-ish ordering: triggers first, then breadth-first
 * by connection, then whatever is left alphabetically.
 * @param {WorkflowGraph} graph
 * @returns {string[]}
 */
export function orderNodes(graph) {
  const names = [...graph.nodes.keys()].sort();
  const triggers = names.filter((name) => isTrigger(graph.nodes.get(name)));
  /** @type {string[]} */
  const order = [];
  const seen = new Set();
  /** @param {string[]} starts */
  const bfs = (starts) => {
    const queue = [...starts];
    while (queue.length > 0) {
      const current = /** @type {string} */ (queue.shift());
      if (seen.has(current)) continue;
      seen.add(current);
      order.push(current);
      const next = (graph.outgoing.get(current) ?? []).map((edge) => edge.to);
      queue.push(...next);
    }
  };
  bfs(triggers);
  for (const name of names) {
    if (!seen.has(name) && (graph.incoming.get(name) ?? []).length === 0) bfs([name]);
  }
  for (const name of names) if (!seen.has(name)) bfs([name]);
  return order;
}
