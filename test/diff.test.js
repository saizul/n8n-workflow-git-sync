import test from 'node:test';
import assert from 'node:assert/strict';
import { diffWorkflowSets, diffWorkflows } from '../src/diff/semantic.js';
import { formatSetDiffJson, formatSetDiffText, formatWorkflowDiffLines, previewValue, sanitizeDeep } from '../src/diff/format.js';
import { connect, fakeSecret, node, scheduledWorkflow, workflow } from './helpers/fixtures.js';

/** A copy of the fixture with one of every kind of change. */
function edited() {
  const wf = workflow();
  wf.name = 'Order intake v2';
  wf.active = false;
  wf.nodes[1].parameters.url = 'https://api.example.com/v2/customers';
  wf.nodes[2].name = 'Format response';
  wf.nodes.push(node('Notify', 'noOp'));
  wf.connections = connect([['Receive order', 'Look up customer'], ['Look up customer', 'Format response'], ['Format response', 'Notify']]);
  wf.settings = { ...wf.settings, timezone: 'UTC' };
  wf.tags = [{ name: 'orders' }, { name: 'new' }];
  return wf;
}

test('identical workflows do not differ, whatever the key order', () => {
  const a = workflow();
  const b = Object.fromEntries(Object.entries(workflow()).reverse());
  assert.equal(diffWorkflows(a, b).changed, false);
});

test('volatile metadata and node positions are ignored by default', () => {
  const a = workflow();
  const b = { ...structuredClone(a), updatedAt: '2030-01-01T00:00:00.000Z', versionId: 'other' };
  b.nodes[0].position = [5, 5];
  assert.equal(diffWorkflows(a, b).changed, false);
  const withPosition = diffWorkflows(a, b, { includePosition: true });
  assert.equal(withPosition.changed, true);
  assert.deepEqual(withPosition.nodes.changed.map((n) => n.name), ['Receive order']);
});

test('node order in the file does not matter', () => {
  const b = workflow();
  b.nodes.reverse();
  assert.equal(diffWorkflows(workflow(), b).changed, false);
});

test('a full edit is broken down semantically', () => {
  const diff = diffWorkflows(workflow(), edited());
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.name, { before: 'Order intake', after: 'Order intake v2' });
  assert.deepEqual(diff.active, { before: true, after: false });
  assert.deepEqual(diff.nodes.added, [{ name: 'Notify', type: 'n8n-nodes-base.noOp' }]);
  assert.deepEqual(diff.nodes.removed, []);
  assert.deepEqual(diff.nodes.renamed, [{ from: 'Shape response', to: 'Format response' }]);
  assert.deepEqual(diff.nodes.changed.map((n) => n.name), ['Look up customer']);
  assert.deepEqual(diff.nodes.changed[0].changes, [{
    op: 'replace', path: '$.parameters.url', before: 'https://api.example.com/customers', after: 'https://api.example.com/v2/customers',
  }]);
  assert.deepEqual(diff.connections.added.map((e) => `${e.from}>${e.to}`), ['Format response>Notify']);
  assert.deepEqual(diff.connections.removed, [], 'a rename does not show up as rewired connections');
  assert.deepEqual(diff.settings, [{ op: 'add', path: '$.timezone', after: 'UTC' }]);
  assert.deepEqual(diff.tags, { added: ['new'], removed: [] });
});

test('removed nodes and connections are reported', () => {
  const b = workflow();
  b.nodes.pop();
  b.connections = connect([['Receive order', 'Look up customer']]);
  const diff = diffWorkflows(workflow(), b);
  assert.deepEqual(diff.nodes.removed, [{ name: 'Shape response', type: 'n8n-nodes-base.set' }]);
  assert.deepEqual(diff.connections.removed.map((e) => `${e.from}>${e.to}`), ['Look up customer>Shape response']);
});

test('rewiring an output is a connection change, not a node change', () => {
  const a = workflow({
    nodes: [node('Start', 'manualTrigger'), node('Check', 'if'), node('Yes', 'noOp'), node('No', 'noOp')],
    connections: connect([['Start', 'Check'], ['Check', 'Yes', 0], ['Check', 'No', 1]]),
  });
  const b = workflow({ nodes: a.nodes, connections: connect([['Start', 'Check'], ['Check', 'Yes', 1], ['Check', 'No', 0]]) });
  const diff = diffWorkflows(a, b);
  assert.equal(diff.nodes.changed.length, 0);
  assert.equal(diff.connections.added.length, 2);
  assert.equal(diff.connections.removed.length, 2);
});

test('options can ignore active state, tags and credential ids', () => {
  const b = workflow({ active: false, tags: [] });
  assert.equal(diffWorkflows(workflow(), b).changed, true);
  assert.equal(diffWorkflows(workflow(), b, { includeActive: false, includeTags: false }).changed, false);
  const c = workflow();
  c.nodes[1].credentials = { httpHeaderAuth: { id: '999', name: 'CRM API' } };
  assert.equal(diffWorkflows(workflow(), c).changed, true);
  assert.equal(diffWorkflows(workflow(), c, { ignoreCredentialIds: true }).changed, false);
});

test('diffWorkflowSets classifies added, removed, changed and unchanged', () => {
  const set = diffWorkflowSets(
    [workflow(), scheduledWorkflow(), workflow({ id: '200', name: 'Stable' })],
    [edited(), workflow({ id: '300', name: 'Brand new' }), workflow({ id: '200', name: 'Stable' })],
  );
  assert.deepEqual(set.added, [{ id: '300', name: 'Brand new' }]);
  assert.deepEqual(set.removed, [{ id: '102', name: 'Nightly report' }]);
  assert.deepEqual(set.changed.map((c) => c.id), ['101']);
  assert.equal(set.unchanged, 1);
  assert.equal(set.hasChanges, true);
  assert.equal(diffWorkflowSets([workflow()], [workflow()]).hasChanges, false);
});

test('workflows with different ids are paired by unambiguous name', () => {
  const set = diffWorkflowSets([workflow({ id: '101' })], [workflow({ id: '5001' })]);
  assert.equal(set.hasChanges, false);
  assert.equal(set.unchanged, 1);
  const ambiguous = diffWorkflowSets([workflow({ id: '1' })], [workflow({ id: '2' }), workflow({ id: '3' })]);
  assert.equal(ambiguous.added.length, 2);
  assert.equal(ambiguous.removed.length, 1);
});

test('matchBy name pairs strictly on the name', () => {
  const set = diffWorkflowSets([workflow({ id: '101' })], [workflow({ id: '101', name: 'Renamed' })], { matchBy: 'name' });
  assert.deepEqual(set.added.map((w) => w.name), ['Renamed']);
  assert.deepEqual(set.removed.map((w) => w.name), ['Order intake']);
});

test('formatSetDiffText renders a readable report', () => {
  const set = diffWorkflowSets([workflow(), scheduledWorkflow()], [edited(), workflow({ id: '300', name: 'Brand new' })]);
  const text = formatSetDiffText(set, { beforeLabel: 'remote', afterLabel: 'local' });
  const lines = text.split('\n');
  assert.equal(lines[0], '--- remote');
  assert.equal(lines[1], '+++ local');
  assert.ok(lines.includes('+ workflow "Brand new" (300)'));
  assert.ok(lines.includes('- workflow "Nightly report" (102)'));
  assert.ok(lines.includes('~ workflow "Order intake v2" (101)'));
  assert.ok(lines.includes('    > node renamed "Shape response" -> "Format response"'));
  assert.ok(lines.includes('    + connection "Format response" -[main:0]-> "Notify"'));
  assert.ok(text.trimEnd().endsWith('1 added, 1 removed, 1 changed, 0 unchanged'));
});

test('formatWorkflowDiffLines is empty for an unchanged workflow', () => {
  assert.deepEqual(formatWorkflowDiffLines(diffWorkflows(workflow(), workflow())), []);
});

test('formatSetDiffJson is parseable and carries a summary', () => {
  const set = diffWorkflowSets([workflow()], [edited()]);
  const parsed = JSON.parse(formatSetDiffJson(set));
  assert.deepEqual(parsed.summary, { added: 0, removed: 0, changed: 1, unchanged: 0 });
  assert.equal(parsed.changed[0].diff.nodes.renamed[0].to, 'Format response');
});

test('secrets never appear in text or JSON diffs', () => {
  const secret = fakeSecret('github');
  const b = workflow();
  b.nodes[1].parameters.token = secret;
  const set = diffWorkflowSets([workflow()], [b]);
  const text = formatSetDiffText(set);
  const json = formatSetDiffJson(set);
  assert.match(text, /\$\.parameters\.token/);
  assert.ok(!text.includes(secret));
  assert.ok(!json.includes(secret));
});

test('previewValue masks, truncates and labels absent values', () => {
  assert.equal(previewValue(undefined), '(absent)');
  assert.equal(previewValue(5), '5');
  assert.equal(previewValue('plain'), '"plain"');
  const secret = fakeSecret('aws');
  assert.equal(previewValue(`key ${secret} end`), '"key *** end"');
  const long = previewValue('word '.repeat(200));
  assert.ok(long.length <= 200);
  assert.ok(long.endsWith('...'));
});

test('sanitizeDeep masks by key name and name/value pairs', () => {
  const clean = /** @type {any} */ (sanitizeDeep({ password: 'hunter2pass', list: [{ name: 'X-Api-Key', value: 'plainvalue12345' }], note: 'fine' }));
  assert.equal(clean.password, '***');
  assert.equal(clean.list[0].value, '***');
  assert.equal(clean.note, 'fine');
});
