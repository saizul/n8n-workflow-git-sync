import { isStickyNote } from '../../workflow/graph.js';

/** Names n8n assigns automatically when a node is dropped on the canvas. */
const DEFAULT_NODE_NAMES = [
  'HTTP Request', 'Code', 'Set', 'Edit Fields', 'If', 'Switch', 'Merge', 'Function', 'Function Item', 'Webhook',
  'Wait', 'Filter', 'Loop Over Items', 'Split In Batches', 'Execute Workflow', 'Respond to Webhook', 'No Operation, do nothing',
  'Schedule Trigger', 'Split Out', 'Aggregate', 'Sort', 'Limit', 'Remove Duplicates', 'Date & Time', 'Crypto', 'HTML', 'XML',
];

const DEFAULT_NAME_RE = new RegExp(`^(?:${DEFAULT_NODE_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s?\\d*$`);

const DEFAULT_WORKFLOW_NAME_RE = /^(my workflow|untitled|new workflow|workflow)(\s*\d+)?$/i;

/**
 * @param {unknown} source
 * @param {string} label
 * @returns {RegExp|null}
 */
function compile(source, label) {
  if (typeof source !== 'string' || source === '') return null;
  try {
    return new RegExp(source);
  } catch {
    throw new TypeError(`naming-convention: option "${label}" is not a valid regular expression: ${source}`);
  }
}

/** @type {import('../engine.js').Rule} */
export const namingConvention = {
  id: 'naming-convention',
  description: 'Workflows and nodes should have meaningful names (optionally matching configured patterns).',
  severity: 'info',
  check({ workflow, nodes, options }) {
    /** @type {import('../engine.js').RuleFinding[]} */
    const out = [];
    const workflowPattern = compile(options.workflowPattern, 'workflowPattern');
    const nodePattern = compile(options.nodePattern, 'nodePattern');
    const name = typeof workflow.name === 'string' ? workflow.name : '';
    if (name.trim() !== name) {
      out.push({ message: 'Workflow name has leading or trailing whitespace', path: '$.name' });
    }
    if (DEFAULT_WORKFLOW_NAME_RE.test(name.trim())) {
      out.push({ message: `Workflow still has a default name ("${name}")`, path: '$.name' });
    } else if (workflowPattern && !workflowPattern.test(name)) {
      out.push({ message: `Workflow name "${name}" does not match ${workflowPattern}`, path: '$.name' });
    }
    if (/\b(copy|backup|old|test)\s*\d*$/i.test(name.trim()) && options.forbidCopySuffix !== false) {
      out.push({ message: `Workflow name "${name}" looks like a leftover copy`, path: '$.name' });
    }
    for (const node of nodes) {
      if (isStickyNote(node)) continue;
      if (options.forbidDefaultNames !== false && DEFAULT_NAME_RE.test(node.name)) {
        out.push({ message: `Node "${node.name}" still has its default name; describe what it does`, node: node.name, path: '$.name' });
      } else if (nodePattern && !nodePattern.test(node.name)) {
        out.push({ message: `Node name "${node.name}" does not match ${nodePattern}`, node: node.name, path: '$.name' });
      }
    }
    return out;
  },
};

/** @type {import('../engine.js').Rule} */
export const stickyNoteDocumentation = {
  id: 'sticky-note-documentation',
  description: 'Large workflows should be documented with at least one sticky note.',
  severity: 'info',
  check({ nodes, options }) {
    const threshold = typeof options.minNodes === 'number' ? options.minNodes : 10;
    const minLength = typeof options.minLength === 'number' ? options.minLength : 20;
    const real = nodes.filter((node) => !isStickyNote(node));
    if (real.length < threshold) return [];
    const documented = nodes.some((node) => isStickyNote(node)
      && typeof node.parameters?.content === 'string' && node.parameters.content.trim().length >= minLength);
    if (documented) return [];
    return [{
      message: `Workflow has ${real.length} nodes but no sticky note describing it (threshold: ${threshold})`,
    }];
  },
};
