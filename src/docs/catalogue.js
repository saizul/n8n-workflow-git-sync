import { isPlainObject } from '../util/json.js';
import { buildGraph, isStickyNote, isTrigger, shortType } from '../workflow/graph.js';
import { tagNames } from '../workflow/normalize.js';
import { toMermaid } from '../workflow/render.js';

/**
 * @typedef {object} WorkflowSummary
 * @property {string|null} id
 * @property {string} name
 * @property {string} file
 * @property {boolean} active
 * @property {string[]} tags
 * @property {Array<{name: string, type: string, detail: string}>} triggers
 * @property {string[]} schedules              schedule expressions, human readable
 * @property {Array<{type: string, count: number}>} nodeTypes
 * @property {Array<{name: string, type: string, nodes: string[]}>} credentials
 * @property {number} nodeCount                excluding sticky notes
 * @property {string[]} notes                  sticky note contents
 * @property {string|null} errorWorkflow
 * @property {string[]} calledWorkflows        ids of sub-workflows executed
 */

/**
 * Describe one schedule rule of a Schedule Trigger node.
 * @param {Record<string, any>} rule
 */
function describeInterval(rule) {
  const field = rule.field ?? 'days';
  const at = (/** @type {unknown} */ h, /** @type {unknown} */ m) => `${String(h ?? 0).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
  switch (field) {
    case 'cronExpression': return `cron ${rule.expression ?? ''}`.trim();
    case 'seconds': return `every ${rule.secondsInterval ?? 30} seconds`;
    case 'minutes': return `every ${rule.minutesInterval ?? 5} minutes`;
    case 'hours': return `every ${rule.hoursInterval ?? 1} hours at minute ${rule.triggerAtMinute ?? 0}`;
    case 'days': return `every ${rule.daysInterval ?? 1} days at ${at(rule.triggerAtHour, rule.triggerAtMinute)}`;
    case 'weeks': {
      const days = Array.isArray(rule.triggerAtDay) ? rule.triggerAtDay.join(',') : '0';
      return `every ${rule.weeksInterval ?? 1} weeks on weekday ${days} at ${at(rule.triggerAtHour, rule.triggerAtMinute)}`;
    }
    case 'months': return `every ${rule.monthsInterval ?? 1} months on day ${rule.triggerAtDayOfMonth ?? 1} at ${at(rule.triggerAtHour, rule.triggerAtMinute)}`;
    default: return String(field);
  }
}

/**
 * Extract schedule expressions from schedule / cron / interval trigger nodes.
 * @param {Record<string, any>} node
 * @returns {string[]}
 */
export function scheduleExpressions(node) {
  const params = isPlainObject(node.parameters) ? node.parameters : {};
  if (node.type === 'n8n-nodes-base.scheduleTrigger') {
    const intervals = params.rule?.interval;
    if (!Array.isArray(intervals) || intervals.length === 0) return ['every 1 days at 00:00'];
    return intervals.filter(isPlainObject).map(describeInterval);
  }
  if (node.type === 'n8n-nodes-base.cron') {
    const items = params.triggerTimes?.item;
    if (!Array.isArray(items)) return [];
    return items.filter(isPlainObject).map((item) => {
      if (item.mode === 'custom') return `cron ${item.cronExpression ?? ''}`.trim();
      if (item.mode === 'everyX') return `every ${item.value ?? 1} ${item.unit ?? 'hours'}`;
      const hour = item.hour ?? 0;
      const minute = item.minute ?? 0;
      return `${item.mode ?? 'everyDay'} at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    });
  }
  if (node.type === 'n8n-nodes-base.interval') {
    return [`every ${params.interval ?? 1} ${params.unit ?? 'seconds'}`];
  }
  return [];
}

/**
 * One-line description of how a trigger fires.
 * @param {Record<string, any>} node
 */
function triggerDetail(node) {
  const params = isPlainObject(node.parameters) ? node.parameters : {};
  if (node.type === 'n8n-nodes-base.webhook') {
    return `${params.httpMethod ?? 'GET'} /${String(params.path ?? '').replace(/^\//, '')}`;
  }
  const schedules = scheduleExpressions(node);
  if (schedules.length > 0) return schedules.join('; ');
  if (node.type === 'n8n-nodes-base.formTrigger') return `form ${params.path ?? params.formTitle ?? ''}`.trim();
  return '';
}

/**
 * @param {Record<string, any>} workflow
 * @param {string} [file]
 * @returns {WorkflowSummary}
 */
export function summarizeWorkflow(workflow, file = '') {
  const graph = buildGraph(workflow);
  const nodes = [...graph.nodes.values()];
  const real = nodes.filter((node) => !isStickyNote(node));
  const triggers = real.filter(isTrigger).sort((a, b) => a.name.localeCompare(b.name));
  /** @type {Map<string, number>} */
  const typeCounts = new Map();
  for (const node of real) typeCounts.set(String(node.type), (typeCounts.get(String(node.type)) ?? 0) + 1);
  /** @type {Map<string, {name: string, type: string, nodes: string[]}>} */
  const credentials = new Map();
  /** @type {Set<string>} */
  const called = new Set();
  for (const node of real) {
    if (isPlainObject(node.credentials)) {
      for (const [type, ref] of Object.entries(node.credentials)) {
        const name = isPlainObject(ref) && typeof ref.name === 'string' ? ref.name : '(unnamed)';
        const key = `${type}\u0000${name}`;
        const entry = credentials.get(key) ?? { name, type, nodes: [] };
        entry.nodes.push(node.name);
        credentials.set(key, entry);
      }
    }
    if (node.type === 'n8n-nodes-base.executeWorkflow') {
      const ref = node.parameters?.workflowId;
      const id = isPlainObject(ref) ? ref.value : ref;
      if (typeof id === 'string' && id !== '' && !id.startsWith('=')) called.add(id);
    }
  }
  return {
    id: workflow.id !== undefined && workflow.id !== null ? String(workflow.id) : null,
    name: String(workflow.name ?? ''),
    file,
    active: workflow.active === true,
    tags: tagNames(workflow),
    triggers: triggers.map((node) => ({ name: node.name, type: String(node.type), detail: triggerDetail(node) })),
    schedules: triggers.flatMap(scheduleExpressions),
    nodeTypes: [...typeCounts.entries()].map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    credentials: [...credentials.values()]
      .map((entry) => ({ ...entry, nodes: entry.nodes.sort() }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)),
    nodeCount: real.length,
    notes: nodes.filter(isStickyNote)
      .map((node) => (typeof node.parameters?.content === 'string' ? node.parameters.content.trim() : ''))
      .filter((text) => text !== '' && !/^n8n-sync-ignore/.test(text)),
    errorWorkflow: typeof workflow.settings?.errorWorkflow === 'string' && workflow.settings.errorWorkflow !== ''
      ? workflow.settings.errorWorkflow : null,
    calledWorkflows: [...called].sort(),
  };
}

/** @param {unknown} text */
function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** @param {string} name */
function anchor(name) {
  return name.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
}

/**
 * Generate a Markdown catalogue of workflows.
 * @param {Array<{workflow: Record<string, any>, file?: string}>} entries
 * @param {{title?: string, includeGraphs?: boolean}} [options]
 * @returns {string}
 */
export function generateCatalogue(entries, options = {}) {
  const { title = 'Workflow catalogue', includeGraphs = false } = options;
  const summaries = entries
    .map(({ workflow, file }) => ({ summary: summarizeWorkflow(workflow, file ?? ''), workflow }))
    .sort((a, b) => a.summary.name.localeCompare(b.summary.name) || String(a.summary.id).localeCompare(String(b.summary.id)));
  /** @type {string[]} */
  const out = [`# ${title}`, ''];
  const active = summaries.filter((s) => s.summary.active).length;
  out.push(`${summaries.length} workflow${summaries.length === 1 ? '' : 's'}, ${active} active.`, '');
  if (summaries.length === 0) return `${out.join('\n')}`;

  out.push('| Workflow | Active | Trigger | Nodes | Tags |', '| --- | --- | --- | ---: | --- |');
  for (const { summary: s } of summaries) {
    const trigger = s.triggers.length === 0 ? 'none' : s.triggers.map((t) => shortType(t.type)).join(', ');
    out.push(`| [${cell(s.name)}](#${anchor(s.name)}) | ${s.active ? 'yes' : 'no'} | ${cell(trigger)} | ${s.nodeCount} | ${cell(s.tags.join(', '))} |`);
  }
  out.push('');

  // Credential cross-reference: which workflows depend on which credential.
  /** @type {Map<string, Set<string>>} */
  const credentialUsers = new Map();
  for (const { summary: s } of summaries) {
    for (const cred of s.credentials) {
      const key = `${cred.name} (${cred.type})`;
      credentialUsers.set(key, (credentialUsers.get(key) ?? new Set()).add(s.name));
    }
  }
  if (credentialUsers.size > 0) {
    out.push('## Credentials in use', '', '| Credential | Used by |', '| --- | --- |');
    for (const [key, users] of [...credentialUsers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out.push(`| ${cell(key)} | ${cell([...users].sort().join(', '))} |`);
    }
    out.push('');
  }

  out.push('## Workflows', '');
  for (const { summary: s, workflow } of summaries) {
    out.push(`### ${s.name}`, '');
    out.push(`- **Id:** ${s.id ?? 'n/a'}`);
    if (s.file) out.push(`- **File:** \`${s.file}\``);
    out.push(`- **Active:** ${s.active ? 'yes' : 'no'}`);
    if (s.tags.length > 0) out.push(`- **Tags:** ${s.tags.join(', ')}`);
    if (s.triggers.length === 0) out.push('- **Trigger:** none');
    for (const t of s.triggers) {
      out.push(`- **Trigger:** ${t.name} (\`${shortType(t.type)}\`)${t.detail ? `: ${t.detail}` : ''}`);
    }
    if (s.schedules.length > 0) out.push(`- **Schedule:** ${s.schedules.join('; ')}`);
    if (s.errorWorkflow) out.push(`- **Error workflow:** ${s.errorWorkflow}`);
    if (s.calledWorkflows.length > 0) out.push(`- **Calls workflows:** ${s.calledWorkflows.join(', ')}`);
    out.push(`- **Nodes (${s.nodeCount}):** ${s.nodeTypes.map((n) => `${shortType(n.type)}${n.count > 1 ? ` x${n.count}` : ''}`).join(', ') || 'none'}`);
    if (s.credentials.length > 0) {
      out.push('- **Credentials:**');
      for (const cred of s.credentials) out.push(`  - ${cred.name} (\`${cred.type}\`), used by ${cred.nodes.join(', ')}`);
    }
    if (s.notes.length > 0) {
      out.push('', ...s.notes.map((note) => note.split(/\r?\n/).map((line) => `> ${line}`).join('\n')));
    }
    if (includeGraphs) out.push('', '```mermaid', toMermaid(workflow).trimEnd(), '```');
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
