import { scanString } from '../secrets/detector.js';
import { shortType } from '../workflow/graph.js';

const MAX_VALUE_LENGTH = 100;

/**
 * Render a value for display. Strings are scanned with the secret detector
 * so that a diff printed in CI never reveals a credential that was just
 * added to (or removed from) a workflow.
 * @param {unknown} value
 * @returns {string}
 */
export function previewValue(value) {
  if (value === undefined) return '(absent)';
  let text;
  if (typeof value === 'string') {
    let masked = value;
    for (const hit of scanString(value).sort((a, b) => b.start - a.start)) {
      masked = `${masked.slice(0, hit.start)}***${masked.slice(hit.end)}`;
    }
    text = JSON.stringify(masked);
  } else {
    text = JSON.stringify(sanitizeDeep(value));
  }
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 3)}...` : text;
}

/**
 * Mask secrets in every string of a JSON value.
 * @param {unknown} value
 * @param {string} [key]
 * @returns {unknown}
 */
export function sanitizeDeep(value, key = '') {
  if (typeof value === 'string') {
    let masked = value;
    for (const hit of scanString(value, { key }).sort((a, b) => b.start - a.start)) {
      masked = `${masked.slice(0, hit.start)}***${masked.slice(hit.end)}`;
    }
    return masked;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, key));
  if (value !== null && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const pairName = typeof obj.name === 'string' ? obj.name : '';
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sanitizeDeep(v, k === 'value' && pairName ? pairName : k)]));
  }
  return value;
}

/** @param {import('./semantic.js').ValueChange} change */
function changeLine(change) {
  if (change.op === 'add') return `+ ${change.path}: ${previewValue(change.after)}`;
  if (change.op === 'remove') return `- ${change.path}: ${previewValue(change.before)}`;
  return `~ ${change.path}: ${previewValue(change.before)} -> ${previewValue(change.after)}`;
}

/** @param {import('../workflow/graph.js').Edge} edge */
export function edgeLabel(edge) {
  const input = edge.inputIndex > 0 ? ` (input ${edge.inputIndex})` : '';
  return `"${edge.from}" -[${edge.type}:${edge.outputIndex}]-> "${edge.to}"${input}`;
}

/**
 * @param {import('./semantic.js').WorkflowDiff} diff
 * @param {string} [indent]
 * @returns {string[]}
 */
export function formatWorkflowDiffLines(diff, indent = '    ') {
  /** @type {string[]} */
  const lines = [];
  if (diff.name) lines.push(`${indent}~ name: ${previewValue(diff.name.before)} -> ${previewValue(diff.name.after)}`);
  if (diff.active) lines.push(`${indent}~ active: ${diff.active.before} -> ${diff.active.after}`);
  for (const tag of diff.tags.added) lines.push(`${indent}+ tag "${tag}"`);
  for (const tag of diff.tags.removed) lines.push(`${indent}- tag "${tag}"`);
  for (const node of diff.nodes.added) lines.push(`${indent}+ node "${node.name}" (${shortType(node.type)})`);
  for (const node of diff.nodes.removed) lines.push(`${indent}- node "${node.name}" (${shortType(node.type)})`);
  for (const rename of diff.nodes.renamed) lines.push(`${indent}> node renamed "${rename.from}" -> "${rename.to}"`);
  for (const node of diff.nodes.changed) {
    lines.push(`${indent}~ node "${node.name}" (${shortType(node.type)})`);
    for (const change of node.changes) lines.push(`${indent}    ${changeLine(change)}`);
  }
  for (const edge of diff.connections.added) lines.push(`${indent}+ connection ${edgeLabel(edge)}`);
  for (const edge of diff.connections.removed) lines.push(`${indent}- connection ${edgeLabel(edge)}`);
  for (const change of diff.settings) lines.push(`${indent}${changeLine({ ...change, path: change.path.replace(/^\$/, '$.settings') })}`);
  return lines;
}

/**
 * Human-readable report for a set diff.
 * @param {import('./semantic.js').SetDiff} set
 * @param {{beforeLabel?: string, afterLabel?: string}} [labels]
 */
export function formatSetDiffText(set, labels = {}) {
  /** @type {string[]} */
  const lines = [];
  if (labels.beforeLabel || labels.afterLabel) {
    lines.push(`--- ${labels.beforeLabel ?? 'before'}`, `+++ ${labels.afterLabel ?? 'after'}`, '');
  }
  const idOf = (/** @type {{id: string|null}} */ wf) => (wf.id ? ` (${wf.id})` : '');
  for (const wf of set.added) lines.push(`+ workflow "${wf.name}"${idOf(wf)}`);
  for (const wf of set.removed) lines.push(`- workflow "${wf.name}"${idOf(wf)}`);
  for (const wf of set.changed) {
    lines.push(`~ workflow "${wf.name}"${idOf(wf)}`);
    lines.push(...formatWorkflowDiffLines(wf.diff));
  }
  if (set.hasChanges) lines.push('');
  lines.push(`${set.added.length} added, ${set.removed.length} removed, ${set.changed.length} changed, ${set.unchanged} unchanged`);
  return lines.join('\n');
}

/**
 * JSON report with secrets masked.
 * @param {import('./semantic.js').SetDiff} set
 */
export function formatSetDiffJson(set) {
  return JSON.stringify(sanitizeDeep({
    summary: { added: set.added.length, removed: set.removed.length, changed: set.changed.length, unchanged: set.unchanged },
    added: set.added,
    removed: set.removed,
    changed: set.changed,
  }), null, 2);
}
