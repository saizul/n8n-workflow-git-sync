import test from 'node:test';
import assert from 'node:assert/strict';
import { remapCredentials, remapWorkflowReferences, usesCredentials } from '../src/sync/remap.js';
import { connect, node, scheduledWorkflow, workflow } from './helpers/fixtures.js';

const TARGET = [
  { id: 'p-1', name: 'CRM API', type: 'httpHeaderAuth' },
  { id: 'p-2', name: 'Webhook header', type: 'httpHeaderAuth' },
];
/** @param {Record<string, any>} wf @param {string} name */
const cred = (wf, name) => wf.nodes.find((/** @type {any} */ n) => n.name === name).credentials.httpHeaderAuth;

test('usesCredentials', () => {
  assert.equal(usesCredentials(workflow()), true);
  assert.equal(usesCredentials(scheduledWorkflow()), false);
  assert.equal(usesCredentials({}), false);
});

test('credentials are matched by name and type', () => {
  const wf = workflow();
  const result = remapCredentials(wf, TARGET);
  assert.deepEqual(result, { remapped: 2, warnings: [] });
  assert.deepEqual(cred(wf, 'Look up customer'), { id: 'p-1', name: 'CRM API' });
  assert.deepEqual(cred(wf, 'Receive order'), { id: 'p-2', name: 'Webhook header' });
  assert.equal(remapCredentials(wf, TARGET).remapped, 0, 'already pointing at the right ids');
});

test('a credential of the same name but another type is not used', () => {
  const wf = workflow();
  const result = remapCredentials(wf, [{ id: 'p-1', name: 'CRM API', type: 'oAuth2Api' }, TARGET[1]]);
  assert.equal(result.remapped, 1);
  assert.equal(cred(wf, 'Look up customer').id, 'cred-2');
  assert.match(result.warnings[0], /Node "Look up customer": no credential named "CRM API" of type httpHeaderAuth/);
});

test('ambiguous names warn and use the first match', () => {
  const wf = workflow();
  const result = remapCredentials(wf, [...TARGET, { id: 'p-9', name: 'CRM API', type: 'httpHeaderAuth' }]);
  assert.equal(cred(wf, 'Look up customer').id, 'p-1');
  assert.match(result.warnings[0], /2 credentials named "CRM API"/);
});

test('a name map renames references even when the target list is unknown', () => {
  const wf = workflow();
  const result = remapCredentials(wf, null, { 'CRM API': 'CRM API (prod)' });
  assert.deepEqual(result, { remapped: 0, warnings: [] });
  assert.deepEqual(cred(wf, 'Look up customer'), { id: 'cred-2', name: 'CRM API (prod)' });
});

test('unnamed credential references are reported', () => {
  const wf = workflow();
  wf.nodes[1].credentials = { httpHeaderAuth: { id: '7' } };
  assert.match(remapCredentials(wf, TARGET).warnings[0], /has no name and cannot be remapped/);
});

test('workflow references are translated through the id map', () => {
  const wf = workflow({
    nodes: [
      node('Start', 'manualTrigger'),
      node('Run billing', 'executeWorkflow', { parameters: { workflowId: { value: '555', mode: 'id', cachedResultName: 'Billing' } } }),
      node('Run legacy', 'executeWorkflow', { parameters: { workflowId: '556' } }),
      node('Run dynamic', 'executeWorkflow', { parameters: { workflowId: '={{ $json.id }}' } }),
    ],
    connections: connect([['Start', 'Run billing'], ['Run billing', 'Run legacy'], ['Run legacy', 'Run dynamic']]),
  });
  const result = remapWorkflowReferences(wf, { 900: '9900', 555: '9555', 556: '9556' });
  assert.deepEqual(result, { remapped: 3, warnings: [] });
  assert.equal(wf.settings.errorWorkflow, '9900');
  assert.deepEqual(wf.nodes[1].parameters.workflowId, { value: '9555', mode: 'id' });
  assert.equal(wf.nodes[2].parameters.workflowId, '9556');
  assert.equal(wf.nodes[3].parameters.workflowId, '={{ $json.id }}', 'expressions are left alone');
});

test('unknown workflow references are kept and reported', () => {
  const wf = workflow();
  const result = remapWorkflowReferences(wf, {});
  assert.equal(wf.settings.errorWorkflow, '900');
  assert.equal(result.remapped, 0);
  assert.match(result.warnings[0], /settings\.errorWorkflow: referenced workflow 900 has no entry in the id map yet/);
});
