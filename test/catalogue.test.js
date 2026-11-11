import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCatalogue, scheduleExpressions, summarizeWorkflow } from '../src/docs/catalogue.js';
import { connect, node, scheduledWorkflow, workflow } from './helpers/fixtures.js';

const entries = () => [
  { workflow: workflow(), file: 'order-intake--101.json' },
  { workflow: scheduledWorkflow(), file: 'ops/nightly-report--102.json' },
];

test('summarizeWorkflow extracts triggers, node types and credentials', () => {
  const summary = summarizeWorkflow(workflow(), 'order-intake--101.json');
  assert.equal(summary.id, '101');
  assert.equal(summary.active, true);
  assert.deepEqual(summary.tags, ['orders']);
  assert.deepEqual(summary.triggers, [{ name: 'Receive order', type: 'n8n-nodes-base.webhook', detail: 'POST /orders' }]);
  assert.equal(summary.nodeCount, 3);
  assert.deepEqual(summary.nodeTypes.map((t) => t.type), ['n8n-nodes-base.httpRequest', 'n8n-nodes-base.set', 'n8n-nodes-base.webhook']);
  assert.deepEqual(summary.credentials.map((c) => [c.name, c.type, c.nodes]), [
    ['CRM API', 'httpHeaderAuth', ['Look up customer']], ['Webhook header', 'httpHeaderAuth', ['Receive order']],
  ]);
  assert.equal(summary.errorWorkflow, '900');
});

test('summarizeWorkflow reports schedules and skips sticky notes in counts', () => {
  const wf = scheduledWorkflow();
  wf.nodes.push(node('About', 'stickyNote', { parameters: { content: 'Builds the nightly sales report.' } }));
  const summary = summarizeWorkflow(wf);
  assert.deepEqual(summary.schedules, ['cron 0 2 * * *']);
  assert.equal(summary.nodeCount, 2);
  assert.deepEqual(summary.notes, ['Builds the nightly sales report.']);
});

test('summarizeWorkflow lists called sub-workflows', () => {
  const wf = workflow({
    nodes: [node('Start', 'manualTrigger'), node('Run billing', 'executeWorkflow', { parameters: { workflowId: { value: '555', mode: 'id' } } })],
    connections: connect([['Start', 'Run billing']]),
  });
  assert.deepEqual(summarizeWorkflow(wf).calledWorkflows, ['555']);
});

test('scheduleExpressions describes interval rules', () => {
  assert.deepEqual(scheduleExpressions(node('S', 'scheduleTrigger', { parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 2 }] } } })), ['every 2 hours at minute 0']);
  assert.deepEqual(scheduleExpressions(node('S', 'scheduleTrigger')), ['every 1 days at 00:00']);
  assert.deepEqual(scheduleExpressions(node('S', 'set')), []);
});

test('generateCatalogue renders an index table sorted by name', () => {
  const md = generateCatalogue(entries());
  const lines = md.split('\n');
  assert.equal(lines[0], '# Workflow catalogue');
  assert.ok(lines.includes('2 workflows, 1 active.'));
  const nightly = lines.indexOf('| [Nightly report](#nightly-report) | no | scheduleTrigger | 2 |  |');
  const orders = lines.indexOf('| [Order intake](#order-intake) | yes | webhook | 3 | orders |');
  assert.ok(nightly > 0 && orders > nightly);
});

test('generateCatalogue lists credentials by name only and per-workflow details', () => {
  const md = generateCatalogue(entries());
  assert.ok(md.includes('| CRM API (httpHeaderAuth) | Order intake |'));
  assert.ok(md.includes('- **File:** `ops/nightly-report--102.json`'));
  assert.ok(md.includes('- **Trigger:** Receive order (`webhook`): POST /orders'));
  assert.ok(md.includes('- **Schedule:** cron 0 2 * * *'));
  assert.ok(!md.includes('cred-2'), 'credential ids are not published');
  assert.ok(!md.includes('```mermaid'));
});

test('generateCatalogue options: title and graphs; output is deterministic', () => {
  const md = generateCatalogue(entries(), { title: 'Automation inventory', includeGraphs: true });
  assert.ok(md.startsWith('# Automation inventory\n'));
  assert.equal(md.match(/```mermaid/g)?.length, 2);
  assert.equal(md, generateCatalogue(entries().reverse(), { title: 'Automation inventory', includeGraphs: true }));
});

test('generateCatalogue handles an empty set and escapes table cells', () => {
  assert.match(generateCatalogue([]), /0 workflows/);
  const md = generateCatalogue([{ workflow: workflow({ name: 'Orders | EU' }) }]);
  assert.ok(md.includes('Orders \\| EU'));
});
