import test from 'node:test';
import assert from 'node:assert/strict';
import { N8nClient, WRITABLE_WORKFLOW_FIELDS, createClient, toWritableWorkflow } from '../src/api.js';
import { resolveConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { createMemoryLogger } from '../src/util/logger.js';
import { BASE_URL, TEST_API_KEY, createMockN8n } from './helpers/mock-n8n.js';
import { scheduledWorkflow, workflow } from './helpers/fixtures.js';

/** @param {ReturnType<typeof createMockN8n>} mock */
const clientFor = (mock, extra = {}) => new N8nClient({
  baseUrl: BASE_URL, apiKey: TEST_API_KEY, fetch: mock.fetch, sleep: async () => {}, ...extra,
});

test('toWritableWorkflow keeps only the fields the API accepts', () => {
  const body = toWritableWorkflow({ ...workflow(), updatedAt: 'x', versionId: 'y', pinData: {}, staticData: null });
  assert.deepEqual(Object.keys(body).sort(), ['connections', 'name', 'nodes', 'settings']);
  for (const key of Object.keys(body)) assert.ok(WRITABLE_WORKFLOW_FIELDS.includes(key));
});

test('toWritableWorkflow drops unknown settings unless told otherwise, and keeps staticData when set', () => {
  const source = { name: 'x', nodes: [], connections: {}, settings: { executionOrder: 'v1', somethingNew: true }, staticData: { n: 1 } };
  assert.deepEqual(toWritableWorkflow(source).settings, { executionOrder: 'v1' });
  assert.deepEqual(toWritableWorkflow(source, { strictSettings: false }).settings, { executionOrder: 'v1', somethingNew: true });
  assert.deepEqual(toWritableWorkflow(source).staticData, { n: 1 });
  assert.deepEqual(toWritableWorkflow({ name: 'bare' }), { name: 'bare', nodes: [], connections: {}, settings: {} });
});

test('listWorkflows pages through everything with the configured page size', async () => {
  const mock = createMockN8n({ workflows: Array.from({ length: 5 }, (_, i) => workflow({ id: String(i + 1), name: `Flow ${i + 1}` })) });
  const all = await clientFor(mock, { pageSize: 2 }).listWorkflows();
  assert.deepEqual(all.map((wf) => wf.id), ['1', '2', '3', '4', '5']);
  assert.equal(mock.count('GET', '/workflows'), 3);
});

test('listWorkflows forwards active and tag filters', async () => {
  const mock = createMockN8n({ workflows: [workflow(), scheduledWorkflow()] });
  const client = clientFor(mock);
  assert.deepEqual((await client.listWorkflows({ active: true })).map((wf) => wf.name), ['Order intake']);
  assert.deepEqual((await client.listWorkflows({ tags: ['orders'] })).map((wf) => wf.name), ['Order intake']);
  assert.equal(mock.requests[0].query.active, 'true');
  assert.equal(mock.requests[1].query.tags, 'orders');
});

test('getWorkflow fetches one workflow and findWorkflow maps 404 to null', async () => {
  const mock = createMockN8n({ workflows: [workflow()] });
  const client = clientFor(mock);
  assert.equal((await client.getWorkflow('101')).name, 'Order intake');
  assert.equal(await client.findWorkflow('nope'), null);
  await assert.rejects(client.getWorkflow('nope'), (err) => err instanceof ApiError && err.status === 404);
});

test('findWorkflow propagates errors other than 404', async () => {
  const mock = createMockN8n({ workflows: [workflow()] });
  mock.failWith(403, {}, 1);
  await assert.rejects(clientFor(mock).findWorkflow('101'), (err) => err instanceof ApiError && err.status === 403);
});

test('createWorkflow sends a body the strict mock accepts and returns the new id', async () => {
  const mock = createMockN8n();
  const created = await clientFor(mock).createWorkflow(workflow());
  assert.equal(created.id, '1000');
  assert.equal(created.active, false, 'new workflows start inactive');
  assert.deepEqual(Object.keys(mock.requests[0].body).sort(), ['connections', 'name', 'nodes', 'settings']);
});

test('updateWorkflow replaces content and bumps the version', async () => {
  const mock = createMockN8n({ workflows: [workflow()] });
  const before = mock.get('101')?.versionId;
  const updated = await clientFor(mock).updateWorkflow('101', { ...workflow(), name: 'Order intake v2' });
  assert.equal(updated.name, 'Order intake v2');
  assert.notEqual(updated.versionId, before);
  assert.equal(mock.requests[0].method, 'PUT');
});

test('deleteWorkflow removes the workflow', async () => {
  const mock = createMockN8n({ workflows: [workflow()] });
  await clientFor(mock).deleteWorkflow('101');
  assert.equal(mock.workflows.size, 0);
});

test('activate and deactivate use the dedicated endpoints', async () => {
  const mock = createMockN8n({ workflows: [workflow({ active: false })] });
  const client = clientFor(mock);
  assert.equal((await client.activateWorkflow('101')).active, true);
  assert.equal((await client.deactivateWorkflow('101')).active, false);
  assert.deepEqual(mock.requests.map((r) => `${r.method} ${r.path}`), ['POST /workflows/101/activate', 'POST /workflows/101/deactivate']);
});

test('ids are URL-encoded in paths', async () => {
  const mock = createMockN8n();
  await assert.rejects(clientFor(mock).getWorkflow('a/b?c'), ApiError);
  assert.equal(mock.requests[0].path, '/workflows/a%2Fb%3Fc');
});

test('tags can be listed, created and assigned to a workflow', async () => {
  const mock = createMockN8n({ workflows: [workflow({ tags: [] })] });
  const client = clientFor(mock);
  const tag = await client.createTag('finance');
  await client.setWorkflowTags('101', [tag.id]);
  assert.deepEqual((await client.getWorkflowTags('101')).map((t) => t.name), ['finance']);
  assert.deepEqual((await client.listTags()).map((t) => t.name), ['finance']);
  assert.deepEqual(mock.requests[1].body, [{ id: tag.id }]);
});

test('listCredentials returns metadata only', async () => {
  const mock = createMockN8n({ credentials: [{ id: 'c1', name: 'CRM API', type: 'httpHeaderAuth' }] });
  assert.deepEqual(await clientFor(mock).listCredentials(), [{ id: 'c1', name: 'CRM API', type: 'httpHeaderAuth' }]);
});

test('listCredentials degrades to null when the endpoint is forbidden or missing', async () => {
  const forbidden = createMockN8n({ credentials: null });
  assert.equal(await clientFor(forbidden).listCredentials(), null);
  const missing = createMockN8n();
  missing.failWith(404, { path: '/credentials' }, 1);
  assert.equal(await clientFor(missing).listCredentials(), null);
});

test('listCredentials still fails loudly on server errors', async () => {
  const mock = createMockN8n();
  mock.failWith(500, { path: '/credentials' }, 10);
  await assert.rejects(clientFor(mock, { retries: 0 }).listCredentials(), (err) => err instanceof ApiError && err.status === 500);
});

test('listProjects resolves to null when the feature is not licensed', async () => {
  assert.equal(await clientFor(createMockN8n()).listProjects(), null);
});

test('createClient wires config into the client and registers the key with the logger', async () => {
  const mock = createMockN8n({ workflows: [workflow()] });
  const logger = createMemoryLogger();
  const config = resolveConfig({ env: { N8N_BASE_URL: `${BASE_URL}/api/v1/`, N8N_API_KEY: TEST_API_KEY }, flags: { pageSize: 7, retries: 0 } });
  const client = createClient(config, { fetch: mock.fetch, logger });
  assert.equal(client.pageSize, 7);
  assert.equal(client.http.retries, 0);
  await client.listWorkflows();
  assert.equal(mock.requests[0].query.limit, '7');
  assert.equal(logger.redact(`key=${TEST_API_KEY}`), 'key=***');
});
