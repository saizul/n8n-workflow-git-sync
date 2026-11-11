import { buildGraph, isStickyNote, isTrigger, orderNodes, shortType } from './graph.js';

/**
 * @typedef {object} RenderOptions
 * @property {'LR'|'TB'|'TD'|'RL'|'BT'} [direction]
 * @property {boolean} [includeStickyNotes]   default false
 * @property {boolean} [showTypes]            append the node type to labels, default true
 */

/**
 * Stable node identifiers: n0, n1, ... in display order.
 * @param {Record<string, any>} workflow
 * @param {RenderOptions} options
 */
function layout(workflow, options) {
  const graph = buildGraph(workflow);
  const names = orderNodes(graph).filter((name) => options.includeStickyNotes || !isStickyNote(graph.nodes.get(name)));
  const ids = new Map(names.map((name, index) => [name, `n${index}`]));
  return { graph, names, ids };
}

/** @param {string} text */
function mermaidEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');
}

/** @param {string} text */
function dotEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

/**
 * @param {import('./graph.js').Edge} edge
 * @param {import('./graph.js').WorkflowGraph} graph
 * @returns {string} label, empty for the plain main:0 case
 */
function edgeLabel(edge, graph) {
  if (edge.type !== 'main') return edge.type;
  const outputs = new Set((graph.outgoing.get(edge.from) ?? []).filter((e) => e.type === 'main').map((e) => e.outputIndex));
  const source = graph.nodes.get(edge.from);
  if (source?.type === 'n8n-nodes-base.if') return edge.outputIndex === 0 ? 'true' : 'false';
  if (outputs.size > 1 || edge.outputIndex > 0) return `out ${edge.outputIndex}`;
  return '';
}

/**
 * Render a workflow as a Mermaid flowchart.
 * @param {Record<string, any>} workflow
 * @param {RenderOptions} [options]
 * @returns {string}
 */
export function toMermaid(workflow, options = {}) {
  const { direction = 'LR', showTypes = true } = options;
  const { graph, names, ids } = layout(workflow, options);
  /** @type {string[]} */
  const lines = [`flowchart ${direction}`];
  for (const name of names) {
    const node = /** @type {Record<string, any>} */ (graph.nodes.get(name));
    const label = showTypes ? `${mermaidEscape(name)}<br/><i>${mermaidEscape(shortType(node.type))}</i>` : mermaidEscape(name);
    const id = ids.get(name);
    if (isTrigger(node)) lines.push(`  ${id}(["${label}"])`);
    else if (isStickyNote(node)) lines.push(`  ${id}>"${label}"]`);
    else if (node.type === 'n8n-nodes-base.if' || node.type === 'n8n-nodes-base.switch') lines.push(`  ${id}{"${label}"}`);
    else lines.push(`  ${id}["${label}"]`);
  }
  for (const edge of graph.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    const label = edgeLabel(edge, graph);
    const arrow = edge.type === 'main' ? '-->' : '-.->';
    lines.push(label ? `  ${from} ${arrow}|${mermaidEscape(label)}| ${to}` : `  ${from} ${arrow} ${to}`);
  }
  const disabled = names.filter((name) => graph.nodes.get(name)?.disabled === true).map((name) => ids.get(name));
  if (disabled.length > 0) {
    lines.push('  classDef disabled stroke-dasharray: 5 5,opacity:0.6;');
    lines.push(`  class ${disabled.join(',')} disabled;`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render a workflow as Graphviz DOT.
 * @param {Record<string, any>} workflow
 * @param {RenderOptions} [options]
 * @returns {string}
 */
export function toDot(workflow, options = {}) {
  const { direction = 'LR', showTypes = true } = options;
  const { graph, names, ids } = layout(workflow, options);
  const rankdir = direction === 'TD' ? 'TB' : direction;
  /** @type {string[]} */
  const lines = [
    `digraph "${dotEscape(workflow?.name ?? 'workflow')}" {`,
    `  rankdir=${rankdir};`,
    '  node [shape=box, style=rounded, fontname="Helvetica"];',
    '  edge [fontname="Helvetica", fontsize=10];',
  ];
  for (const name of names) {
    const node = /** @type {Record<string, any>} */ (graph.nodes.get(name));
    const label = showTypes ? `${dotEscape(name)}\\n(${dotEscape(shortType(node.type))})` : dotEscape(name);
    /** @type {string[]} */
    const attrs = [`label="${label}"`];
    if (isTrigger(node)) attrs.push('shape=oval');
    else if (isStickyNote(node)) attrs.push('shape=note');
    else if (node.type === 'n8n-nodes-base.if' || node.type === 'n8n-nodes-base.switch') attrs.push('shape=diamond', 'style=solid');
    if (node.disabled === true) attrs.push('style="rounded,dashed"', 'fontcolor=gray50');
    lines.push(`  ${ids.get(name)} [${attrs.join(', ')}];`);
  }
  for (const edge of graph.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    const label = edgeLabel(edge, graph);
    /** @type {string[]} */
    const attrs = [];
    if (label) attrs.push(`label="${dotEscape(label)}"`);
    if (edge.type !== 'main') attrs.push('style=dashed');
    lines.push(`  ${from} -> ${to}${attrs.length ? ` [${attrs.join(', ')}]` : ''};`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
