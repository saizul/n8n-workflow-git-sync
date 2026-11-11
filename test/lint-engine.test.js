import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectIgnores, lintWorkflow, locateLine, matchesGlob, parseIgnoreDirective, resolveRules, shouldFail, summarize,
} from '../src/lint/engine.js';
import { FORMATS, formatFindings, formatGithub, formatJson, formatSarif, formatText } from '../src/lint/formatters.js';
import { applyRuleOverrides } from '../src/commands/lint.js';
import { stableStringify } from '../src/util/json.js';
import { node, workflow } from './helpers/fixtures.js';

/** A workflow with one error (open webhook) and one warning (disabled node). */
function flawed() {
  const wf = workflow();
  wf.nodes[0].parameters.authentication = 'none';
  wf.nodes[2].disabled = true;
  return wf;
}

test('resolveRules applies string, tuple and object settings', () => {
  const resolved = resolveRules({
    rules: {
      'no-cycles': 'off',
      'no-disabled-nodes': ['error', { any: 1 }],
      'naming-convention': { severity: 'warn', options: { nodePattern: '^[A-Z]' } },
      'no-pinned-data': { options: { x: true } },
    },
  });
  assert.equal(resolved.get('no-cycles')?.severity, 'off');
  assert.equal(resolved.get('no-disabled-nodes')?.severity, 'error');
  assert.deepEqual(resolved.get('no-disabled-nodes')?.options, { any: 1 });
  assert.equal(resolved.get('naming-convention')?.severity, 'warning');
  assert.equal(resolved.get('no-pinned-data')?.severity, 'warning', 'default severity kept when only options are given');
  assert.equal(resolved.get('webhook-authentication')?.severity, 'error');
});

test('resolveRules rejects unknown rules, severities and option shapes', () => {
  assert.throws(() => resolveRules({ rules: { 'no-such-rule': 'error' } }), /Unknown lint rule "no-such-rule"/);
  assert.throws(() => resolveRules({ rules: { 'no-cycles': 'fatal' } }), /unknown severity "fatal"/);
  assert.throws(() => resolveRules({ rules: { 'no-cycles': ['error', 'nope'] } }), /options must be an object/);
  assert.throws(() => resolveRules({ rules: { 'no-cycles': /** @type {any} */ (5) } }), /expected a severity string/);
});

test('findings carry file, workflow and node context and are sorted by severity', () => {
  const findings = lintWorkflow(flawed(), { file: 'flows/order-intake--101.json' });
  assert.deepEqual(findings.map((f) => [f.severity, f.ruleId, f.node]), [
    ['error', 'webhook-authentication', 'Receive order'],
    ['warning', 'no-disabled-nodes', 'Shape response'],
  ]);
  assert.equal(findings[0].file, 'flows/order-intake--101.json');
  assert.equal(findings[0].workflowId, '101');
  assert.equal(findings[0].workflowName, 'Order intake');
});

test('severity overrides and "off" change the outcome', () => {
  const config = { rules: { 'webhook-authentication': 'off', 'no-disabled-nodes': 'error' } };
  assert.deepEqual(lintWorkflow(flawed(), { config }).map((f) => [f.severity, f.ruleId]), [['error', 'no-disabled-nodes']]);
});

test('ignoreWorkflows globs skip whole workflows by name', () => {
  assert.deepEqual(lintWorkflow(flawed(), { config: { ignoreWorkflows: ['order *'] } }), []);
  assert.equal(lintWorkflow(flawed(), { config: { ignoreWorkflows: ['invoice*'] } }).length, 2);
  assert.equal(matchesGlob('[WIP]*', '[WIP] draft'), true);
  assert.equal(matchesGlob('a.b', 'axb'), false);
});

test('parseIgnoreDirective understands bare and listed forms', () => {
  assert.equal(parseIgnoreDirective('nothing here'), null);
  assert.equal(parseIgnoreDirective(undefined), null);
  assert.deepEqual(parseIgnoreDirective('n8n-sync-ignore'), { all: true, rules: new Set() });
  assert.deepEqual(parseIgnoreDirective('legacy. n8n-sync-ignore: no-cycles, no-disabled-nodes'), { all: false, rules: new Set(['no-cycles', 'no-disabled-nodes']) });
  assert.equal(parseIgnoreDirective('n8n-sync-ignore-workflow'), null, 'the workflow directive is not a node directive');
});

test('a node note silences listed rules for that node only', () => {
  const wf = flawed();
  wf.nodes[2].notes = 'Kept for the audit. n8n-sync-ignore: no-disabled-nodes';
  assert.deepEqual(lintWorkflow(wf).map((f) => f.ruleId), ['webhook-authentication']);
  wf.nodes[0].notes = 'n8n-sync-ignore';
  assert.deepEqual(lintWorkflow(wf), []);
});

test('a node ignore for a different rule has no effect', () => {
  const wf = flawed();
  wf.nodes[2].notes = 'n8n-sync-ignore: no-cycles';
  assert.equal(lintWorkflow(wf).length, 2);
});

test('a sticky note silences rules for the whole workflow', () => {
  const wf = flawed();
  wf.nodes.push(node('Lint note', 'stickyNote', { parameters: { content: 'n8n-sync-ignore-workflow: webhook-authentication' } }));
  assert.deepEqual(lintWorkflow(wf).map((f) => f.ruleId), ['no-disabled-nodes']);
  wf.nodes.push(node('Lint note 2', 'stickyNote', { parameters: { content: 'n8n-sync-ignore-workflow' } }));
  assert.deepEqual(lintWorkflow(wf), []);
  const ignores = collectIgnores(wf);
  assert.equal(ignores.workflowLevel.all, true);
  assert.ok(ignores.workflowLevel.rules.has('webhook-authentication'));
});

test('line numbers point at the node inside the serialised file', () => {
  const wf = flawed();
  const text = stableStringify(wf);
  const findings = lintWorkflow(wf, { text });
  const line = findings[0].line;
  assert.ok(line > 1);
  assert.ok(text.split('\n')[line - 1].includes('"name": "Receive order"'));
  assert.equal(locateLine(text, 'No such node'), 1);
  assert.equal(locateLine(undefined, 'Receive order'), 1);
});

test('lintWorkflow survives garbage input', () => {
  for (const bad of [null, 'text', [], { nodes: 'x' }, { nodes: [null, 5, {}] }]) {
    const findings = lintWorkflow(/** @type {any} */ (bad));
    assert.ok(findings.some((f) => f.ruleId === 'valid-structure'));
  }
});

test('summarize and shouldFail', () => {
  const findings = lintWorkflow(flawed());
  assert.deepEqual(summarize(findings), { error: 1, warning: 1, info: 0, total: 2 });
  assert.equal(shouldFail(findings), true);
  assert.equal(shouldFail(findings, 'none'), false);
  const warningsOnly = findings.filter((f) => f.severity === 'warning');
  assert.equal(shouldFail(warningsOnly, 'error'), false);
  assert.equal(shouldFail(warningsOnly, 'warning'), true);
  assert.equal(shouldFail(warningsOnly, 'info'), true);
  assert.equal(shouldFail([], 'info'), false);
});

test('applyRuleOverrides merges --rule flags over the config', () => {
  const merged = applyRuleOverrides(
    { rules: { 'no-cycles': ['warning', { a: 1 }], 'naming-convention': { severity: 'info', options: { b: 2 } } } },
    ['no-cycles=error', 'naming-convention=off', 'no-pinned-data=error'],
  );
  assert.deepEqual(merged.rules, {
    'no-cycles': ['error', { a: 1 }],
    'naming-convention': { severity: 'off', options: { b: 2 } },
    'no-pinned-data': 'error',
  });
  assert.throws(() => applyRuleOverrides({}, ['no-cycles']), /Invalid --rule/);
});

test('formatText groups by file and prints a summary', () => {
  const findings = lintWorkflow(flawed(), { file: 'a.json' });
  const text = formatText(findings, { filesChecked: 3 });
  assert.match(text, /^a\.json \(Order intake\)/);
  assert.match(text, /error\s+webhook-authentication/);
  assert.match(text, /2 problems in 3 workflows: 1 error, 1 warning, 0 info$/);
  assert.equal(formatText([], { filesChecked: 1 }), 'No problems found in 1 workflow.');
});

test('formatJson is machine readable', () => {
  const parsed = JSON.parse(formatJson(lintWorkflow(flawed(), { file: 'a.json' }), { filesChecked: 1 }));
  assert.deepEqual(parsed.summary, { error: 1, warning: 1, info: 0, total: 2, filesChecked: 1 });
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].ruleId, 'webhook-authentication');
});

test('formatSarif produces a SARIF 2.1.0 log with rule metadata', () => {
  const findings = lintWorkflow(flawed(), { file: 'flows\\a.json' });
  const sarif = JSON.parse(formatSarif(findings, { version: '9.9.9' }));
  assert.equal(sarif.version, '2.1.0');
  const [run] = sarif.runs;
  assert.equal(run.tool.driver.name, 'n8n-workflow-git-sync');
  assert.equal(run.tool.driver.version, '9.9.9');
  assert.equal(run.tool.driver.rules.length, 14);
  assert.equal(run.results.length, 2);
  const [first] = run.results;
  assert.equal(first.level, 'error');
  assert.equal(run.tool.driver.rules[first.ruleIndex].id, first.ruleId);
  assert.equal(first.locations[0].physicalLocation.artifactLocation.uri, 'flows/a.json');
  assert.deepEqual(first.locations[0].logicalLocations, [{ name: 'Receive order', kind: 'member' }]);
});

test('formatGithub emits escaped workflow commands', () => {
  const findings = lintWorkflow(flawed(), { file: 'flows/a,b.json' });
  findings[1].message = '50% done\nsecond line';
  const lines = formatGithub(findings).split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^::error file=flows\/a%2Cb\.json,line=1,title=webhook-authentication::/);
  assert.match(lines[1], /^::warning .*::50%25 done%0Asecond line$/);
  assert.equal(formatGithub([]), '');
});

test('formatFindings dispatches on the format name', () => {
  const findings = lintWorkflow(flawed(), { file: 'a.json' });
  assert.deepEqual([...FORMATS], ['text', 'json', 'sarif', 'github']);
  assert.equal(formatFindings('json', findings), formatJson(findings));
  assert.equal(formatFindings('github', findings), formatGithub(findings));
  assert.equal(formatFindings('text', findings), formatText(findings));
  assert.equal(JSON.parse(formatFindings('sarif', findings)).version, '2.1.0');
});
