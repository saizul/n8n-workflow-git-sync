import test from 'node:test';
import assert from 'node:assert/strict';
import { lintWorkflow } from '../src/lint/engine.js';
import { RULES, getRule } from '../src/lint/rules/index.js';
import { connect, fakeSecret, node, scheduledWorkflow, workflow } from './helpers/fixtures.js';

/**
 * Findings of one rule only.
 * @param {Record<string, any>} wf
 * @param {string} ruleId
 * @param {Record<string, any>} [options]
 */
function run(wf, ruleId, options) {
  const config = options ? { rules: { [ruleId]: { options } } } : {};
  return lintWorkflow(wf, { config }).filter((finding) => finding.ruleId === ruleId);
}

test('the registry has 14 uniquely named rules with descriptions and severities', () => {
  assert.equal(RULES.length, 14);
  assert.equal(new Set(RULES.map((rule) => rule.id)).size, 14);
  for (const rule of RULES) {
    assert.match(rule.id, /^[a-z]+(-[a-z]+)+$/);
    assert.ok(rule.description.length > 20);
    assert.ok(['error', 'warning', 'info'].includes(rule.severity));
  }
  assert.equal(getRule('no-cycles')?.id, 'no-cycles');
  assert.equal(getRule('nope'), undefined);
});

test('the fixture workflows are lint-clean', () => {
  assert.deepEqual(lintWorkflow(workflow()), []);
  assert.deepEqual(lintWorkflow(scheduledWorkflow()), []);
});

test('no-hardcoded-secrets reports a masked finding and never the secret', () => {
  const secret = fakeSecret('github');
  const wf = workflow();
  wf.nodes[1].parameters.token = secret;
  const findings = run(wf, 'no-hardcoded-secrets');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].node, 'Look up customer');
  assert.equal(findings[0].path, '$.nodes[1].parameters.token');
  assert.ok(!JSON.stringify(findings).includes(secret));
});

test('no-hardcoded-secrets honours minConfidence and allowPatterns', () => {
  const wf = workflow();
  wf.nodes[1].parameters.reference = fakeSecret('random');
  assert.equal(run(wf, 'no-hardcoded-secrets').length, 1);
  assert.equal(run(wf, 'no-hardcoded-secrets', { minConfidence: 'medium' }).length, 0);
  assert.equal(run(wf, 'no-hardcoded-secrets', { entropy: false }).length, 0);
  wf.nodes[1].parameters.key = fakeSecret('aws');
  assert.equal(run(wf, 'no-hardcoded-secrets', { allowPatterns: ['^AKIA'], entropy: false }).length, 0);
});

test('webhook-authentication flags open webhooks', () => {
  const wf = workflow();
  wf.nodes[0].parameters.authentication = 'none';
  assert.deepEqual(run(wf, 'webhook-authentication').map((f) => f.node), ['Receive order']);
  delete wf.nodes[0].parameters.authentication;
  assert.equal(run(wf, 'webhook-authentication').length, 1);
});

test('webhook-authentication skips disabled nodes and allow-listed paths', () => {
  const wf = workflow();
  wf.nodes[0].parameters.authentication = 'none';
  wf.nodes[0].parameters.path = 'public-health';
  assert.equal(run(wf, 'webhook-authentication', { allowPaths: ['public-health'] }).length, 0);
  wf.nodes[0].disabled = true;
  assert.equal(run(wf, 'webhook-authentication').length, 0);
});

test('no-pinned-data flags non-empty pinned data per node', () => {
  const wf = workflow({ pinData: { 'Shape response': [{ json: { a: 1 } }], 'Receive order': [] } });
  const findings = run(wf, 'no-pinned-data');
  assert.deepEqual(findings.map((f) => f.node), ['Shape response']);
  assert.equal(findings[0].severity, 'warning');
});

test('node-error-handling applies only when no error workflow covers the node', () => {
  const wf = workflow({ settings: {} });
  wf.nodes[1].retryOnFail = false;
  assert.deepEqual(run(wf, 'node-error-handling').map((f) => f.node), ['Look up customer']);
  wf.nodes[1].onError = 'continueRegularOutput';
  assert.equal(run(wf, 'node-error-handling').length, 0);
  const covered = workflow();
  covered.nodes[1].retryOnFail = false;
  assert.equal(run(covered, 'node-error-handling').length, 0);
  assert.equal(run(covered, 'node-error-handling', { evenWithErrorWorkflow: true }).length, 1);
});

test('node-error-handling treats nodes with credentials and configured types as external calls', () => {
  const wf = workflow({
    settings: {},
    nodes: [
      node('Start', 'manualTrigger'),
      node('Post message', 'slack', { credentials: { slackApi: { id: '5', name: 'Team chat' } } }),
      node('Run script', 'executeCommand'),
    ],
    connections: connect([['Start', 'Post message'], ['Post message', 'Run script']]),
  });
  assert.deepEqual(run(wf, 'node-error-handling').map((f) => f.node), ['Post message']);
  assert.deepEqual(
    run(wf, 'node-error-handling', { types: ['n8n-nodes-base.executeCommand'] }).map((f) => f.node).sort(),
    ['Post message', 'Run script'],
  );
});

test('missing-error-workflow flags unattended workflows only', () => {
  assert.equal(run(scheduledWorkflow({ settings: {} }), 'missing-error-workflow').length, 1);
  assert.equal(run(scheduledWorkflow({ settings: {}, active: false }), 'missing-error-workflow', { onlyActive: true }).length, 0);
  const manual = workflow({ settings: {}, nodes: [node('Start', 'manualTrigger'), node('Done', 'noOp')], connections: connect([['Start', 'Done']]) });
  assert.equal(run(manual, 'missing-error-workflow').length, 0);
});

test('http-timeout-retry checks timeout, retry and an optional ceiling', () => {
  const wf = workflow();
  delete wf.nodes[1].parameters.options.timeout;
  wf.nodes[1].retryOnFail = false;
  const findings = run(wf, 'http-timeout-retry');
  assert.equal(findings.length, 2);
  assert.ok(findings.some((f) => /no timeout/.test(f.message)));
  assert.ok(findings.some((f) => /does not retry/.test(f.message)));
  assert.equal(run(wf, 'http-timeout-retry', { requireTimeout: false, requireRetry: false }).length, 0);
  const slow = workflow();
  slow.nodes[1].parameters.options.timeout = 600000;
  assert.equal(run(slow, 'http-timeout-retry').length, 0);
  assert.match(run(slow, 'http-timeout-retry', { maxTimeoutMs: 60000 })[0].message, /above the allowed 60000 ms/);
});

test('deprecated-node-versions flags removed types and old versions', () => {
  const wf = workflow({
    nodes: [node('Start', 'manualTrigger'), node('Legacy script', 'function'), node('Old branch', 'if', { typeVersion: 1 }), node('New branch', 'if', { typeVersion: 2 })],
    connections: connect([['Start', 'Legacy script'], ['Legacy script', 'Old branch'], ['Old branch', 'New branch']]),
  });
  const findings = run(wf, 'deprecated-node-versions');
  assert.deepEqual(findings.map((f) => f.node).sort(), ['Legacy script', 'Old branch']);
  assert.match(findings.find((f) => f.node === 'Legacy script')?.message ?? '', /n8n-nodes-base\.code/);
});

test('deprecated-node-versions accepts a custom table', () => {
  const wf = workflow({ nodes: [node('Start', 'manualTrigger'), node('Legacy script', 'function')], connections: connect([['Start', 'Legacy script']]) });
  assert.equal(run(wf, 'deprecated-node-versions', { useDefaults: false }).length, 0);
  const custom = run(wf, 'deprecated-node-versions', { useDefaults: false, nodes: { 'n8n-nodes-base.manualTrigger': { below: 5 } } });
  assert.deepEqual(custom.map((f) => f.node), ['Start']);
});

test('valid-structure surfaces validation errors', () => {
  const wf = workflow({ connections: connect([['Receive order', 'Ghost']]) });
  const findings = run(wf, 'valid-structure');
  assert.ok(findings.length >= 1);
  assert.ok(findings.every((f) => f.severity === 'error'));
  assert.ok(findings.some((f) => /Ghost/.test(f.message)));
});

test('duplicate-node-names reports each duplicated name once', () => {
  const wf = workflow({
    nodes: [node('Start', 'manualTrigger'), node('Twin', 'noOp'), node('Twin', 'noOp'), node('Twin', 'noOp')],
    connections: connect([['Start', 'Twin']]),
  });
  const findings = run(wf, 'duplicate-node-names');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Twin/);
});

test('no-orphan-nodes reports unconnected, unreachable and dangling references', () => {
  const wf = workflow({
    nodes: [node('Start', 'manualTrigger'), node('Work', 'noOp'), node('Lonely', 'noOp'), node('Island A', 'noOp'), node('Island B', 'noOp')],
    connections: connect([['Start', 'Work'], ['Island A', 'Island B'], ['Work', 'Ghost']]),
  });
  const findings = run(wf, 'no-orphan-nodes');
  assert.ok(findings.some((f) => f.node === 'Lonely' && /not connected/.test(f.message)));
  assert.ok(findings.some((f) => f.node === 'Island A' && /cannot be reached/.test(f.message)));
  assert.ok(findings.some((f) => /does not exist/.test(f.message)));
  const relaxed = run(wf, 'no-orphan-nodes', { checkReachability: false });
  assert.ok(!relaxed.some((f) => /cannot be reached/.test(f.message)));
});

test('no-cycles reports loops that bypass loop nodes', () => {
  const wf = workflow({
    nodes: [node('Start', 'manualTrigger'), node('Fetch page', 'noOp'), node('Next page', 'noOp')],
    connections: connect([['Start', 'Fetch page'], ['Fetch page', 'Next page'], ['Next page', 'Fetch page']]),
  });
  const findings = run(wf, 'no-cycles');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Fetch page/);
  assert.equal(run(workflow(), 'no-cycles').length, 0);
});

test('no-disabled-nodes flags disabled nodes', () => {
  const wf = workflow();
  wf.nodes[2].disabled = true;
  assert.deepEqual(run(wf, 'no-disabled-nodes').map((f) => f.node), ['Shape response']);
});

test('naming-convention flags default workflow and node names and leftover copies', () => {
  assert.equal(run(workflow({ name: 'My workflow 3' }), 'naming-convention').length, 1);
  assert.match(run(workflow({ name: 'Order intake copy' }), 'naming-convention')[0].message, /leftover copy/);
  assert.match(run(workflow({ name: ' Order intake' }), 'naming-convention')[0].message, /whitespace/);
  const wf = workflow({
    nodes: [node('Start', 'manualTrigger'), node('HTTP Request1', 'noOp'), node('Set', 'noOp')],
    connections: connect([['Start', 'HTTP Request1'], ['HTTP Request1', 'Set']]),
  });
  assert.deepEqual(run(wf, 'naming-convention').map((f) => f.node).sort(), ['HTTP Request1', 'Set']);
  assert.equal(run(wf, 'naming-convention', { forbidDefaultNames: false }).length, 0);
});

test('naming-convention enforces configured patterns and rejects bad ones', () => {
  const options = { workflowPattern: '^\\[[A-Z]+\\] ', nodePattern: '^[A-Z]' };
  assert.match(run(workflow(), 'naming-convention', options)[0].message, /does not match/);
  assert.equal(run(workflow({ name: '[OPS] Order intake' }), 'naming-convention', options).length, 0);
  const wf = workflow({ name: '[OPS] Order intake' });
  wf.nodes[2].name = 'shape response';
  wf.connections = connect([['Receive order', 'Look up customer'], ['Look up customer', 'shape response']]);
  assert.deepEqual(run(wf, 'naming-convention', options).map((f) => f.node), ['shape response']);
  assert.throws(() => run(workflow(), 'naming-convention', { nodePattern: '(' }), /not a valid regular expression/);
});

test('sticky-note-documentation applies to large workflows without a meaningful note', () => {
  const names = Array.from({ length: 11 }, (_, i) => `Step ${String.fromCharCode(65 + i)}`);
  const nodes = [node('Start', 'manualTrigger'), ...names.map((name) => node(name, 'noOp'))];
  const pairs = /** @type {Array<[string, string]>} */ (names.map((name, i) => [i === 0 ? 'Start' : names[i - 1], name]));
  const wf = workflow({ nodes, connections: connect(pairs) });
  assert.equal(run(wf, 'sticky-note-documentation').length, 1);
  assert.equal(run(wf, 'sticky-note-documentation', { minNodes: 50 }).length, 0);
  wf.nodes.push(node('Note', 'stickyNote', { parameters: { content: 'todo' } }));
  assert.equal(run(wf, 'sticky-note-documentation').length, 1, 'a trivial note does not count');
  wf.nodes.push(node('Docs', 'stickyNote', { parameters: { content: 'Imports orders from the shop and files them in the CRM.' } }));
  assert.equal(run(wf, 'sticky-note-documentation').length, 0);
  assert.equal(run(workflow(), 'sticky-note-documentation').length, 0);
});
