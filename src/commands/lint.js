import { readFile } from 'node:fs/promises';
import { loadConfig, loadTargets } from './common.js';
import { EXIT, UsageError } from '../errors.js';
import { lintWorkflow, resolveRules, shouldFail } from '../lint/engine.js';
import { FORMATS, formatFindings } from '../lint/formatters.js';
import { RULES } from '../lint/rules/index.js';
import { writeFileAtomic } from '../util/fs.js';
import path from 'node:path';

/**
 * Merge `--rule id=severity` overrides into a lint config.
 * @param {import('../lint/engine.js').LintConfig} config
 * @param {string[]} overrides
 */
export function applyRuleOverrides(config, overrides) {
  /** @type {Record<string, any>} */
  const rules = { ...(config.rules ?? {}) };
  for (const entry of overrides) {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new UsageError(`Invalid --rule "${entry}" (expected <rule-id>=<off|info|warning|error>)`);
    const id = entry.slice(0, eq).trim();
    const severity = entry.slice(eq + 1).trim();
    const existing = rules[id];
    if (Array.isArray(existing)) rules[id] = [severity, existing[1]];
    else if (existing && typeof existing === 'object') rules[id] = { ...existing, severity };
    else rules[id] = severity;
  }
  return { ...config, rules };
}

/** Table of all rules with their default and effective severity. */
function describeRules(/** @type {import('../lint/engine.js').LintConfig} */ config) {
  const resolved = resolveRules(config, RULES);
  const lines = [];
  for (const rule of RULES) {
    const effective = resolved.get(rule.id)?.severity ?? rule.defaultSeverity;
    lines.push(`${rule.id.padEnd(28)} ${String(effective).padEnd(8)} ${rule.description}`);
  }
  return lines.join('\n');
}

/** @type {import('./common.js').Command} */
export const lintCommand = {
  name: 'lint',
  summary: 'Check workflow files against the rule set',
  usage: 'n8n-sync lint [options] [file-or-dir...]',
  options: {
    dir: { type: 'string', short: 'd', placeholder: 'path', description: 'Workflow directory when no paths are given' },
    format: { type: 'string', short: 'f', choices: [...FORMATS], default: 'text', description: 'Output format' },
    'fail-on': { type: 'string', choices: ['error', 'warning', 'info', 'none'], default: 'error', description: 'Lowest severity that makes the command exit with 1' },
    rule: { type: 'list', placeholder: 'id=severity', description: 'Override the severity of a rule (repeatable)' },
    output: { type: 'string', short: 'o', placeholder: 'file', description: 'Write the report to a file instead of stdout' },
    'list-rules': { type: 'boolean', description: 'Print the rules with their effective severity and exit' },
  },
  examples: [
    'n8n-sync lint',
    'n8n-sync lint workflows/ --format github --fail-on warning',
    'n8n-sync lint --format sarif --output n8n-lint.sarif',
    'n8n-sync lint --rule no-disabled-nodes=off --rule naming-convention=warning',
  ],
  async run(context) {
    const { options, positionals, logger, cwd } = context;
    const config = await loadConfig(context);
    const lintConfig = applyRuleOverrides(config.lint ?? {}, options.rule ?? []);
    resolveRules(lintConfig, RULES); // fail fast on unknown rules or severities
    if (options.listRules) {
      logger.out(describeRules(lintConfig));
      return EXIT.OK;
    }
    const workflows = await loadTargets(context, positionals.length > 0 ? positionals : [config.dir]);
    /** @type {import('../lint/engine.js').LintFinding[]} */
    const findings = [];
    for (const wf of workflows) {
      const text = await readFile(wf.absolute, 'utf8');
      findings.push(...lintWorkflow(wf.workflow, { config: lintConfig, file: wf.display, text }));
    }
    const report = formatFindings(options.format, findings, { filesChecked: workflows.length, version: context.version });
    if (options.output) {
      await writeFileAtomic(path.resolve(cwd, options.output), `${report}\n`);
      logger.info(`Wrote ${options.format} report to ${options.output}`);
    } else {
      logger.out(report);
    }
    return shouldFail(findings, options.failOn) ? EXIT.FINDINGS : EXIT.OK;
  },
};
