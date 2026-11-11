import { ConfigError } from '../errors.js';
import { isPlainObject } from '../util/json.js';
import { buildGraph, isStickyNote } from '../workflow/graph.js';
import { RULES } from './rules/index.js';

/** @typedef {'error'|'warning'|'info'} Severity */

/**
 * @typedef {object} RuleFinding
 * @property {string} message
 * @property {string|null} [node]   node name the finding is about
 * @property {string} [path]        JSON-path into the workflow
 */

/**
 * @typedef {object} RuleContext
 * @property {Record<string, any>} workflow
 * @property {import('../workflow/graph.js').WorkflowGraph} graph
 * @property {Record<string, any>} options     rule options from configuration
 * @property {Record<string, any>[]} nodes     well-formed nodes only
 */

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} description
 * @property {Severity} severity   default severity
 * @property {(context: RuleContext) => RuleFinding[]} check
 */

/**
 * @typedef {object} LintConfig
 * @property {Record<string, 'off'|'info'|'warn'|'warning'|'error'|[string, Record<string, any>]|{severity?: string, options?: Record<string, any>}>} [rules]
 * @property {string[]} [ignoreWorkflows]   workflow names or `*` globs to skip entirely
 */

/**
 * @typedef {object} LintFinding
 * @property {string} ruleId
 * @property {Severity} severity
 * @property {string} message
 * @property {string} file
 * @property {string|null} workflowId
 * @property {string} workflowName
 * @property {string|null} node
 * @property {string|null} path
 * @property {number} line   1-based line in the file, best effort
 */

const SEVERITY_ALIASES = Object.freeze({ warn: 'warning', warning: 'warning', error: 'error', info: 'info', off: 'off' });
export const SEVERITY_RANK = Object.freeze({ info: 0, warning: 1, error: 2 });

export const IGNORE_DIRECTIVE = 'n8n-sync-ignore';
export const IGNORE_WORKFLOW_DIRECTIVE = 'n8n-sync-ignore-workflow';

/**
 * Resolve the effective severity and options of every rule.
 * @param {LintConfig} [config]
 * @param {Rule[]} [rules]
 * @returns {Map<string, {rule: Rule, severity: Severity|'off', options: Record<string, any>}>}
 */
export function resolveRules(config = {}, rules = RULES) {
  /** @type {Map<string, {rule: Rule, severity: Severity|'off', options: Record<string, any>}>} */
  const resolved = new Map();
  for (const rule of rules) resolved.set(rule.id, { rule, severity: rule.severity, options: {} });
  for (const [id, setting] of Object.entries(config.rules ?? {})) {
    const entry = resolved.get(id);
    if (!entry) {
      throw new ConfigError(`Unknown lint rule "${id}". Known rules: ${[...resolved.keys()].join(', ')}`);
    }
    /** @type {unknown} */
    let severity;
    /** @type {unknown} */
    let options;
    if (typeof setting === 'string') severity = setting;
    else if (Array.isArray(setting)) [severity, options] = setting;
    else if (isPlainObject(setting)) ({ severity, options } = setting);
    else throw new ConfigError(`Lint rule "${id}": expected a severity string, [severity, options] or {severity, options}`);
    if (severity !== undefined) {
      const normal = SEVERITY_ALIASES[/** @type {keyof typeof SEVERITY_ALIASES} */ (String(severity))];
      if (!normal) throw new ConfigError(`Lint rule "${id}": unknown severity "${severity}" (use off, info, warning or error)`);
      entry.severity = /** @type {Severity|'off'} */ (normal);
    }
    if (options !== undefined) {
      if (!isPlainObject(options)) throw new ConfigError(`Lint rule "${id}": options must be an object`);
      entry.options = options;
    }
  }
  return resolved;
}

/**
 * Parse an ignore directive out of free text.
 * `n8n-sync-ignore` alone ignores every rule; `n8n-sync-ignore: a, b` ignores
 * the listed rules.
 * @param {unknown} text
 * @param {string} directive
 * @returns {{all: boolean, rules: Set<string>}|null}
 */
export function parseIgnoreDirective(text, directive = IGNORE_DIRECTIVE) {
  if (typeof text !== 'string' || !text.includes(directive)) return null;
  const re = new RegExp(`${directive}(?![-\\w])(?:\\s*:\\s*([A-Za-z0-9_,\\s-]+))?`, 'g');
  let all = false;
  /** @type {Set<string>} */
  const rules = new Set();
  let matched = false;
  for (const m of text.matchAll(re)) {
    matched = true;
    const list = (m[1] ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) all = true;
    for (const id of list) rules.add(id);
  }
  return matched ? { all, rules } : null;
}

/**
 * Collect inline ignores: per node (from the node's notes) and for the whole
 * workflow (from any sticky note).
 * @param {Record<string, any>} workflow
 */
export function collectIgnores(workflow) {
  /** @type {Map<string, {all: boolean, rules: Set<string>}>} */
  const byNode = new Map();
  /** @type {{all: boolean, rules: Set<string>}} */
  const workflowLevel = { all: false, rules: new Set() };
  for (const node of Array.isArray(workflow?.nodes) ? workflow.nodes : []) {
    if (!isPlainObject(node)) continue;
    const own = parseIgnoreDirective(node.notes);
    if (own && typeof node.name === 'string') byNode.set(node.name, own);
    if (isStickyNote(node)) {
      const wide = parseIgnoreDirective(node.parameters?.content, IGNORE_WORKFLOW_DIRECTIVE);
      if (wide) {
        workflowLevel.all = workflowLevel.all || wide.all;
        for (const id of wide.rules) workflowLevel.rules.add(id);
      }
    }
  }
  return { byNode, workflowLevel };
}

/**
 * @param {string} pattern  literal name or glob with `*`
 * @param {string} name
 */
export function matchesGlob(pattern, name) {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(name);
}

/**
 * Best-effort line lookup so findings can be anchored in editors and code
 * scanning UIs.
 * @param {string|undefined} text   file content
 * @param {string|null} node
 * @returns {number}
 */
export function locateLine(text, node) {
  if (!text || !node) return 1;
  const needle = `"name": ${JSON.stringify(node)}`;
  const at = text.indexOf(needle);
  if (at === -1) return 1;
  let line = 1;
  for (let i = 0; i < at; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Lint a single workflow.
 * @param {Record<string, any>} workflow
 * @param {{config?: LintConfig, file?: string, text?: string, rules?: Rule[]}} [options]
 * @returns {LintFinding[]}
 */
export function lintWorkflow(workflow, options = {}) {
  const { config = {}, file = '', text } = options;
  const resolved = resolveRules(config, options.rules ?? RULES);
  const name = typeof workflow?.name === 'string' ? workflow.name : '';
  if ((config.ignoreWorkflows ?? []).some((pattern) => matchesGlob(pattern, name))) return [];
  const safe = isPlainObject(workflow) ? workflow : {};
  const nodes = (Array.isArray(safe.nodes) ? safe.nodes : []).filter(
    (node) => isPlainObject(node) && typeof node.name === 'string' && typeof node.type === 'string',
  );
  const graph = buildGraph(safe);
  const ignores = collectIgnores(safe);
  /** @type {LintFinding[]} */
  const findings = [];
  for (const { rule, severity, options: ruleOptions } of resolved.values()) {
    if (severity === 'off') continue;
    if (ignores.workflowLevel.all || ignores.workflowLevel.rules.has(rule.id)) continue;
    for (const finding of rule.check({ workflow: safe, graph, options: ruleOptions, nodes })) {
      const node = finding.node ?? null;
      const nodeIgnore = node ? ignores.byNode.get(node) : undefined;
      if (nodeIgnore && (nodeIgnore.all || nodeIgnore.rules.has(rule.id))) continue;
      findings.push({
        ruleId: rule.id,
        severity,
        message: finding.message,
        file,
        workflowId: safe.id !== undefined && safe.id !== null ? String(safe.id) : null,
        workflowName: name,
        node,
        path: finding.path ?? null,
        line: locateLine(text, node),
      });
    }
  }
  return findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || a.ruleId.localeCompare(b.ruleId)
    || String(a.node ?? '').localeCompare(String(b.node ?? ''))
    || a.message.localeCompare(b.message));
}

/**
 * @param {LintFinding[]} findings
 * @returns {{error: number, warning: number, info: number, total: number}}
 */
export function summarize(findings) {
  const summary = { error: 0, warning: 0, info: 0, total: findings.length };
  for (const finding of findings) summary[finding.severity] += 1;
  return summary;
}

/**
 * Should the process fail given the findings and a threshold?
 * @param {LintFinding[]} findings
 * @param {Severity|'none'} failOn
 */
export function shouldFail(findings, failOn = 'error') {
  if (failOn === 'none') return false;
  return findings.some((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[failOn]);
}
