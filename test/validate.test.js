import test from 'node:test';
import assert from 'node:assert/strict';
import { isValid, validateWorkflow } from '../src/workflow/validate.js';
import { connect, node, scheduledWorkflow, workflow } from './helpers/fixtures.js';

/** @param {unknown} wf */
const codes = (wf) => validateWorkflow(/** @type {any} */ (wf)).map((issue) => issue.code);

test('well-formed workflows have no issues', () => {
  assert.deepEqual(validateWorkflow(workflow()), []);
  assert.deepEqual(validateWorkflow(scheduledWorkflow()), []);
  assert.equal(isValid([]), true);
});

test('the root must be an object', () => {
  for (const bad of [null, [], 'text', 42]) assert.deepEqual(codes(bad), ['root-type']);
});

test('name is required and limited in length', () => {
  assert.ok(codes(workflow({ name: '' })).includes('name-missing'));
  assert.ok(codes(workflow({ name: undefined })).includes('name-missing'));
  assert.ok(codes(workflow({ name: 'x'.repeat(200) })).includes('name-too-long'));
});

test('top-level field types are checked', () => {
  assert.ok(codes(workflow({ active: 'yes' })).includes('active-type'));
  assert.ok(codes(workflow({ settings: [] })).includes('settings-type'));
  assert.ok(codes(workflow({ tags: 'orders' })).includes('tags-type'));
  assert.ok(codes(workflow({ nodes: {} })).includes('nodes-type'));
  assert.ok(codes(workflow({ connections: [] })).includes('connections-type'));
});

test('missing connections is only a warning', () => {
  const issues = validateWorkflow(workflow({ connections: undefined }));
  assert.deepEqual(issues.map((i) => [i.code, i.severity]), [['connections-missing', 'warning']]);
  assert.equal(isValid(issues), true);
});

test('each node needs a name, a type, a numeric typeVersion and a position pair', () => {
  const wf = workflow({
    nodes: [
      { id: 'a', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'No type', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'c', name: 'Bad version', type: 'n8n-nodes-base.noOp', typeVersion: 'one', position: [0, 0], parameters: {} },
      { id: 'd', name: 'Bad position', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0], parameters: {} },
      'not a node',
    ],
    connections: {},
  });
  const found = codes(wf);
  for (const code of ['node-name-missing', 'node-type-missing', 'node-type-version', 'node-position', 'node-type']) {
    assert.ok(found.includes(code), `${code} in ${found.join(', ')}`);
  }
});

test('issues carry a JSON path to the offending node', () => {
  const wf = workflow();
  wf.nodes[1].parameters = /** @type {any} */ ('oops');
  const issue = validateWorkflow(wf).find((i) => i.code === 'node-parameters-type');
  assert.equal(issue?.path, '$.nodes[1].parameters');
  assert.equal(issue?.severity, 'error');
});

test('duplicate node names and ids are errors; a missing id is a warning', () => {
  const wf = workflow({
    nodes: [node('Same', 'noOp', { id: 'x' }), node('Same', 'noOp', { id: 'y' }), node('Other', 'noOp', { id: 'x' }), node('No id', 'noOp', { id: undefined })],
    connections: {},
  });
  const issues = validateWorkflow(wf);
  assert.ok(issues.some((i) => i.code === 'node-name-duplicate' && i.severity === 'error'));
  assert.ok(issues.some((i) => i.code === 'node-id-duplicate' && i.severity === 'error'));
  assert.ok(issues.some((i) => i.code === 'node-id-missing' && i.severity === 'warning'));
});

test('node flags and credential references are type-checked', () => {
  const wf = workflow();
  wf.nodes[0].disabled = /** @type {any} */ ('true');
  wf.nodes[1].credentials = /** @type {any} */ ({ httpHeaderAuth: 'CRM API' });
  wf.nodes[2].credentials = /** @type {any} */ ([]);
  const found = codes(wf);
  assert.ok(found.includes('node-disabled-type'));
  assert.ok(found.includes('node-credential-ref'));
  assert.ok(found.includes('node-credentials-type'));
});

test('connections must start and end at existing nodes', () => {
  const wf = workflow({ connections: connect([['Receive order', 'Ghost'], ['Phantom', 'Shape response']]) });
  const issues = validateWorkflow(wf);
  assert.ok(issues.some((i) => i.code === 'connection-target-unknown' && /Ghost/.test(i.message)));
  assert.ok(issues.some((i) => i.code === 'connection-source-unknown' && /Phantom/.test(i.message)));
  assert.equal(isValid(issues), false);
});

test('malformed connection shapes are reported', () => {
  const base = workflow();
  assert.ok(codes({ ...base, connections: { 'Receive order': 'Look up customer' } }).includes('connection-shape'));
  assert.ok(codes({ ...base, connections: { 'Receive order': { main: 'x' } } }).includes('connection-shape'));
  assert.ok(codes({ ...base, connections: { 'Receive order': { main: [['Look up customer']] } } }).includes('connection-target-shape'));
  assert.ok(codes({ ...base, connections: { 'Receive order': { main: [[{ node: 'Look up customer', type: 'main', index: -1 }]] } } }).includes('connection-target-index'));
});

test('empty output slots (null) are accepted, as n8n writes them', () => {
  const wf = workflow({ connections: { 'Receive order': { main: [null, [{ node: 'Shape response', type: 'main', index: 0 }]] } } });
  assert.deepEqual(validateWorkflow(wf).filter((i) => i.severity === 'error'), []);
});

test('pinned data for an unknown node is a warning', () => {
  const issues = validateWorkflow(workflow({ pinData: { Ghost: [] } }));
  assert.deepEqual(issues.map((i) => [i.code, i.severity]), [['pin-data-unknown-node', 'warning']]);
});
