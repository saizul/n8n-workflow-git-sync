import { summarize } from './engine.js';
import { RULES } from './rules/index.js';

const SARIF_LEVEL = Object.freeze({ error: 'error', warning: 'warning', info: 'note' });
const GITHUB_COMMAND = Object.freeze({ error: 'error', warning: 'warning', info: 'notice' });

/**
 * Human-readable report grouped by file.
 * @param {import('./engine.js').LintFinding[]} findings
 * @param {{filesChecked?: number}} [meta]
 */
export function formatText(findings, meta = {}) {
  /** @type {string[]} */
  const lines = [];
  /** @type {Map<string, import('./engine.js').LintFinding[]>} */
  const byFile = new Map();
  for (const finding of findings) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  for (const [file, group] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${file || '<workflow>'} (${group[0].workflowName || 'unnamed'})`);
    for (const finding of group) {
      const where = finding.node ? ` [${finding.node}]` : '';
      lines.push(`  ${finding.severity.padEnd(7)} ${finding.ruleId.padEnd(26)} ${finding.message}${where && !finding.message.includes(`"${finding.node}"`) ? where : ''}`);
    }
    lines.push('');
  }
  const s = summarize(findings);
  const checked = meta.filesChecked !== undefined ? ` in ${meta.filesChecked} workflow${meta.filesChecked === 1 ? '' : 's'}` : '';
  lines.push(s.total === 0
    ? `No problems found${checked}.`
    : `${s.total} problem${s.total === 1 ? '' : 's'}${checked}: ${s.error} error${s.error === 1 ? '' : 's'}, ${s.warning} warning${s.warning === 1 ? '' : 's'}, ${s.info} info`);
  return lines.join('\n');
}

/**
 * @param {import('./engine.js').LintFinding[]} findings
 * @param {{filesChecked?: number}} [meta]
 */
export function formatJson(findings, meta = {}) {
  return JSON.stringify({ summary: { ...summarize(findings), filesChecked: meta.filesChecked ?? null }, findings }, null, 2);
}

/**
 * SARIF 2.1.0, suitable for GitHub code scanning upload.
 * @param {import('./engine.js').LintFinding[]} findings
 * @param {{version?: string, rules?: import('./engine.js').Rule[]}} [meta]
 */
export function formatSarif(findings, meta = {}) {
  const rules = meta.rules ?? RULES;
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'n8n-workflow-git-sync',
          informationUri: 'https://github.com/saizul/n8n-workflow-git-sync',
          version: meta.version ?? '0.0.0',
          rules: rules.map((rule) => ({
            id: rule.id,
            shortDescription: { text: rule.description },
            defaultConfiguration: { level: SARIF_LEVEL[rule.severity] },
          })),
        },
      },
      results: findings.map((finding) => ({
        ruleId: finding.ruleId,
        ruleIndex: Math.max(0, rules.findIndex((rule) => rule.id === finding.ruleId)),
        level: SARIF_LEVEL[finding.severity],
        message: { text: finding.message },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: finding.file.split('\\').join('/') },
            region: { startLine: Math.max(1, finding.line) },
          },
          logicalLocations: finding.node ? [{ name: finding.node, kind: 'member' }] : [],
        }],
        properties: { workflowId: finding.workflowId, workflowName: finding.workflowName, path: finding.path },
      })),
    }],
  };
  return JSON.stringify(sarif, null, 2);
}

/**
 * Escape data for a GitHub Actions workflow command.
 * @param {string} text
 * @param {boolean} property
 */
function escapeGithub(text, property) {
  let out = String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  if (property) out = out.replace(/:/g, '%3A').replace(/,/g, '%2C');
  return out;
}

/**
 * GitHub Actions annotations (`::error file=...::message`).
 * @param {import('./engine.js').LintFinding[]} findings
 */
export function formatGithub(findings) {
  return findings.map((finding) => {
    const props = [`file=${escapeGithub(finding.file, true)}`, `line=${Math.max(1, finding.line)}`, `title=${escapeGithub(finding.ruleId, true)}`];
    return `::${GITHUB_COMMAND[finding.severity]} ${props.join(',')}::${escapeGithub(finding.message, false)}`;
  }).join('\n');
}

export const FORMATS = Object.freeze(['text', 'json', 'sarif', 'github']);

/**
 * @param {string} format
 * @param {import('./engine.js').LintFinding[]} findings
 * @param {{filesChecked?: number, version?: string}} [meta]
 */
export function formatFindings(format, findings, meta = {}) {
  switch (format) {
    case 'json': return formatJson(findings, meta);
    case 'sarif': return formatSarif(findings, meta);
    case 'github': return formatGithub(findings);
    default: return formatText(findings, meta);
  }
}
