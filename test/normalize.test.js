import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOLATILE_FIELDS, contentHash, normalizeConnections, normalizeTags, normalizeWorkflow, projectName,
  serializeWorkflow, tagNames,
} from '../src/workflow/normalize.js';
import { connect, node, workflow } from './helpers/fixtures.js';

const remoteShape = () => ({
  ...workflow(),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  versionId: 'abc',
  triggerCount: 3,
  staticData: { lastRun: 1 },
  shared: [{ role: 'workflow:owner', project: { id: 'p1', name: 'Operations', type: 'team' } }],
  meta: { instanceId: 'instance-1', templateCredsSetupCompleted: true },
  pinData: { 'Receive order': [{ json: { customer: 'someone@example.com' } }] },
});

test('normalizeWorkflow strips volatile fields and the instance id', () => {
  const normal = normalizeWorkflow(remoteShape());
  for (const field of VOLATILE_FIELDS) assert.equal(field in normal, false, field);
  assert.deepEqual(normal.meta, { templateCredsSetupCompleted: true });
  assert.equal('pinData' in normal, false);
});

test('normalizeWorkflow keeps volatile fields and pin data on request', () => {
  const normal = normalizeWorkflow(remoteShape(), { stripVolatile: false, keepPinData: true });
  assert.equal(normal.versionId, 'abc');
  assert.equal(normal.meta.instanceId, 'instance-1');
  assert.ok(normal.pinData['Receive order']);
});

test('normalizeWorkflow does not modify its input', () => {
  const input = remoteShape();
  const snapshot = JSON.stringify(input);
  normalizeWorkflow(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('normalizeWorkflow puts identifying keys first and sorts node keys alphabetically', () => {
  const normal = normalizeWorkflow(remoteShape());
  assert.deepEqual(Object.keys(normal).slice(0, 7), ['id', 'name', 'active', 'tags', 'settings', 'nodes', 'connections']);
  const nodeKeys = Object.keys(normal.nodes[0]);
  assert.deepEqual(nodeKeys, [...nodeKeys].sort());
});

test('normalizeWorkflow sorts nodes by name so that editor reordering is not a diff', () => {
  const wf = workflow();
  const shuffled = { ...wf, nodes: [...wf.nodes].reverse() };
  assert.equal(serializeWorkflow(wf), serializeWorkflow(shuffled));
  assert.deepEqual(normalizeWorkflow(shuffled).nodes.map((n) => n.name), ['Look up customer', 'Receive order', 'Shape response']);
  assert.deepEqual(normalizeWorkflow(shuffled, { sortNodes: false }).nodes.map((n) => n.name), ['Shape response', 'Look up customer', 'Receive order']);
});

test('normalizeWorkflow coerces ids to strings and fills in missing collections', () => {
  const normal = normalizeWorkflow({ id: 12, name: 'Bare' });
  assert.equal(normal.id, '12');
  assert.equal(normal.active, false);
  assert.deepEqual(normal.nodes, []);
  assert.deepEqual(normal.connections, {});
  assert.deepEqual(normal.settings, {});
  assert.deepEqual(normal.tags, []);
});

test('serializeWorkflow output is byte-identical regardless of key order', () => {
  const a = workflow();
  const b = JSON.parse(JSON.stringify(a, Object.keys(a).reverse().concat(['id', 'name', 'type', 'typeVersion', 'position', 'parameters', 'credentials', 'main', 'node', 'index', 'path', 'httpMethod', 'authentication', 'url', 'options', 'timeout', 'retryOnFail', 'maxTries', 'assignments', 'executionOrder', 'errorWorkflow', 'httpHeaderAuth'])));
  assert.equal(serializeWorkflow(a), serializeWorkflow({ ...b, nodes: a.nodes, connections: a.connections, settings: a.settings, tags: a.tags }));
  assert.ok(serializeWorkflow(a).endsWith('}\n'));
});

test('normalizeTags accepts strings and objects, sorts by name and drops junk', () => {
  assert.deepEqual(normalizeTags(['zeta', { id: 5, name: 'alpha' }, 42, { nope: true }]), [{ id: '5', name: 'alpha' }, { name: 'zeta' }]);
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(tagNames({ tags: [{ name: 'b' }, { name: 'a' }] }), ['a', 'b']);
});

test('normalizeConnections sorts sources, keeps output slot order and drops malformed entries', () => {
  const connections = {
    Zed: { main: [[{ index: 0, type: 'main', node: 'A' }], null] },
    Alpha: { main: [[{ node: 'Zed', type: 'main', index: 0 }]] },
    Broken: 'nope',
  };
  const normal = normalizeConnections(connections);
  assert.deepEqual(Object.keys(normal), ['Alpha', 'Zed']);
  assert.deepEqual(Object.keys(normal.Zed.main[0][0]), ['node', 'type', 'index']);
  assert.deepEqual(normal.Zed.main[1], []);
  assert.deepEqual(normalizeConnections(null), {});
});

test('contentHash ignores volatile fields, activation, tags and node order', () => {
  const base = workflow();
  const noisy = { ...remoteShape(), active: false, tags: [], nodes: [...base.nodes].reverse() };
  assert.equal(contentHash(base), contentHash(noisy));
});

test('contentHash changes with name, parameters, connections and settings', () => {
  const base = workflow();
  const hash = contentHash(base);
  assert.notEqual(contentHash({ ...base, name: 'Other' }), hash);
  assert.notEqual(contentHash({ ...base, settings: { ...base.settings, timezone: 'Europe/Berlin' } }), hash);
  assert.notEqual(contentHash({ ...base, connections: connect([['Receive order', 'Shape response']]) }), hash);
  const edited = workflow();
  edited.nodes[1].parameters.url = 'https://api.example.com/v2/customers';
  assert.notEqual(contentHash(edited), hash);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('projectName reads the home project from either API shape', () => {
  assert.equal(projectName(remoteShape()), 'Operations');
  assert.equal(projectName({ homeProject: { id: 'p', name: 'Finance' } }), 'Finance');
  assert.equal(projectName(workflow()), null);
  assert.equal(projectName({ nodes: [node('A', 'noOp')] }), null);
});
