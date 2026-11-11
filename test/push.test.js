import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { N8nClient } from '../src/api.js';
import { ConflictError, ValidationError } from '../src/errors.js';
import { pullWorkflows } from '../src/sync/pull.js';
import { formatPushResult, planActivation, pushWorkflows } from '../src/sync/push.js';
import { readIdMap, readManifest } from '../src/workflow/store.js';
import { listFiles, writeFileAtomic } from '../src/util/fs.js';
import { createMemoryLogger } from '../src/util/logger.js';
import { BASE_URL, TEST_API_KEY, createMockN8n } from './helpers/mock-n8n.js';
import { scheduledWorkflow, tempDir, workflow } from './helpers/fixtures.js';

/** @param {ReturnType<typeof createMockN8n>} mock */
const clientFor = (mock) => new N8nClient({ baseUrl: BASE_URL, apiKey: TEST_API_KEY, fetch: mock.fetch, sleep: async () => {} });
const DEV_CREDENTIALS = [
  { id: 'cred-1', name: 'Webhook header', type: 'httpHeaderAuth' },
  { id: 'cred-2', name: 'CRM API', type: 'httpHeaderAuth' },
];
const ORDER_FILE = 'order-intake--101.json';

/** A dev instance pulled into a fresh directory. */
async function pulled(t) {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow(), scheduledWorkflow()], credentials: DEV_CREDENTIALS });
  await pullWorkflows({ client: clientFor(mock), dir });
  return { dir, mock };
}

/** Edit a workflow file on disk. @param {string} dir @param {string} file @param {(wf: any) => void} mutate */
async function editLocal(dir, file, mutate) {
  const full = path.join(dir, file);
  const wf = JSON.parse(await readFile(full, 'utf8'));
  mutate(wf);
  await writeFile(full, JSON.stringify(wf, null, 2));
}
const bumpUrl = (/** @type {any} */ wf) => {
  wf.nodes.find((/** @type {any} */ n) => n.name === 'Look up customer').parameters.url = 'https://api.example.com/v2/customers';
};

test('planActivation covers keep, never and always', () => {
  assert.equal(planActivation('keep', true, null), 'activate');
  assert.equal(planActivation('keep', false, true), 'deactivate');
  assert.equal(planActivation('keep', true, true), null);
  assert.equal(planActivation('keep', false, null), null);
  assert.equal(planActivation('never', true, true), null);
  assert.equal(planActivation('never', true, null), null);
  assert.equal(planActivation('always', false, false), 'activate');
  assert.equal(planActivation('always', true, true), null);
});

test('pushing right after a pull changes nothing', async (t) => {
  const { dir, mock } = await pulled(t);
  const result = await pushWorkflows({ client: clientFor(mock), dir });
  assert.deepEqual(result.summary, { create: 0, update: 0, unchanged: 2, conflict: 0, failed: 0 });
  assert.equal(mock.writes().length, 0);
});

test('a local edit is sent as a single update', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, bumpUrl);
  const result = await pushWorkflows({ client: clientFor(mock), dir });
  assert.deepEqual(result.summary, { create: 0, update: 1, unchanged: 1, conflict: 0, failed: 0 });
  assert.deepEqual(mock.writes().map((w) => `${w.method} ${w.path}`), ['PUT /workflows/101']);
  assert.equal(mock.get('101').nodes.find((/** @type {any} */ n) => n.name === 'Look up customer').parameters.url, 'https://api.example.com/v2/customers');
  const again = await pushWorkflows({ client: clientFor(mock), dir });
  assert.equal(again.summary.unchanged, 2, 'the manifest is refreshed, so a second push is a no-op');
});

test('the update body only contains fields the API accepts', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, bumpUrl);
  await pushWorkflows({ client: clientFor(mock), dir });
  const [put] = mock.writes();
  assert.deepEqual(Object.keys(put.body).sort(), ['connections', 'name', 'nodes', 'settings']);
});

test('dry run plans without writing to the instance or the disk', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, bumpUrl);
  const manifestBefore = JSON.stringify(await readManifest(dir));
  const result = await pushWorkflows({ client: clientFor(mock), dir, options: { dryRun: true } });
  assert.equal(result.dryRun, true);
  assert.equal(result.summary.update, 1);
  assert.equal(mock.writes().length, 0);
  assert.equal(JSON.stringify(await readManifest(dir)), manifestBefore);
  assert.equal(formatPushResult(result), '~ update    Order intake -> 101\nDry run: would push: 0 created, 1 updated, 1 unchanged');
});

test('a remote change since the last sync is a conflict and nothing is written', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, bumpUrl);
  await editLocal(dir, 'nightly-report--102.json', (wf) => { wf.nodes[0].notes = 'local note'; });
  mock.edit('101', (wf) => { wf.name = 'Changed remotely'; });
  await assert.rejects(pushWorkflows({ client: clientFor(mock), dir }), (err) => {
    assert.ok(err instanceof ConflictError);
    assert.equal(err.exitCode, 4);
    assert.match(err.message, /Order intake \(101\)/);
    assert.match(err.message, /--force/);
    return true;
  });
  assert.equal(mock.writes().length, 0, 'the unrelated update is not applied either');
});

test('dry run reports conflicts instead of throwing', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, bumpUrl);
  mock.edit('101', (wf) => { wf.name = 'Changed remotely'; });
  const result = await pushWorkflows({ client: clientFor(mock), dir, options: { dryRun: true } });
  assert.equal(result.summary.conflict, 1);
  const item = result.items.find((i) => i.action === 'conflict');
  assert.match(item?.reason ?? '', /changed since the last sync/);
});

test('--force overwrites the remote change', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, bumpUrl);
  mock.edit('101', (wf) => { wf.name = 'Changed remotely'; });
  const result = await pushWorkflows({ client: clientFor(mock), dir, options: { force: true } });
  assert.equal(result.summary.update, 1);
  assert.equal(result.items.find((i) => i.targetId === '101')?.forced, true);
  assert.equal(mock.get('101').name, 'Order intake');
});

test('a remote change without a local change is not overwritten', async (t) => {
  const { dir, mock } = await pulled(t);
  mock.edit('101', (wf) => { wf.name = 'Changed remotely'; });
  const result = await pushWorkflows({ client: clientFor(mock), dir, options: { dryRun: true } });
  assert.equal(result.summary.update, 0);
  assert.equal(mock.get('101').name, 'Changed remotely');
});

test('invalid workflow files abort the push before any request is sent', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, (wf) => { wf.connections['Receive order'].main[0][0].node = 'Ghost'; });
  const requestsBefore = mock.requests.length;
  await assert.rejects(pushWorkflows({ client: clientFor(mock), dir }), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.match(err.message, /order-intake--101\.json/);
    return true;
  });
  assert.equal(mock.writes().length, 0);
  assert.ok(mock.requests.length >= requestsBefore);
});

test('a new local file is created remotely and adopted under its new id', async (t) => {
  const { dir, mock } = await pulled(t);
  const { id, ...fresh } = workflow({ name: 'Refund handler', active: false, tags: [] });
  assert.ok(id);
  await writeFileAtomic(path.join(dir, 'refund-handler.json'), JSON.stringify(fresh));
  const result = await pushWorkflows({ client: clientFor(mock), dir });
  assert.equal(result.summary.create, 1);
  const created = result.items.find((i) => i.action === 'create');
  assert.equal(created?.targetId, '1000');
  assert.equal(mock.get('1000').name, 'Refund handler');
  const files = await listFiles(dir);
  assert.ok(files.includes('refund-handler--1000.json'), files.join(', '));
  assert.ok(!files.includes('refund-handler.json'));
  assert.equal((await readManifest(dir)).workflows['1000'].file, 'refund-handler--1000.json');
  assert.equal((await pushWorkflows({ client: clientFor(mock), dir })).summary.unchanged, 3);
});

test('activation follows the file by default and can be suppressed or forced', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, (wf) => { wf.active = false; });
  const result = await pushWorkflows({ client: clientFor(mock), dir });
  assert.equal(result.items.find((i) => i.targetId === '101')?.activation, 'deactivate');
  assert.equal(mock.get('101').active, false);
  assert.equal(mock.count('POST', '/workflows/101/deactivate'), 1);

  await editLocal(dir, ORDER_FILE, (wf) => { wf.active = true; });
  await pushWorkflows({ client: clientFor(mock), dir, options: { activate: 'never' } });
  assert.equal(mock.get('101').active, false, '"never" leaves the remote state alone');

  await pushWorkflows({ client: clientFor(mock), dir, options: { activate: 'always' } });
  assert.equal(mock.get('101').active, true);
  assert.equal(mock.get('102').active, true, '"always" activates workflows that are inactive in the file too');
});

test('tag changes are synced, creating missing tags', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, (wf) => { wf.tags = [{ name: 'orders' }, { name: 'priority' }]; });
  const result = await pushWorkflows({ client: clientFor(mock), dir });
  assert.equal(result.items.find((i) => i.targetId === '101')?.tags, true);
  assert.deepEqual(mock.get('101').tags.map((/** @type {any} */ tag) => tag.name).sort(), ['orders', 'priority']);
  assert.equal(mock.count('POST', '/tags'), 1, 'only the missing tag is created');
});

test('syncTags false leaves remote tags alone', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, (wf) => { wf.tags = [{ name: 'priority' }]; bumpUrl(wf); });
  await pushWorkflows({ client: clientFor(mock), dir, options: { syncTags: false } });
  assert.deepEqual(mock.get('101').tags.map((/** @type {any} */ tag) => tag.name), ['orders']);
  assert.equal(mock.count('POST', '/tags'), 0);
});

test('"only" restricts the push to the selected workflows', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, bumpUrl);
  await editLocal(dir, 'nightly-report--102.json', (wf) => { wf.nodes[0].notes = 'local note'; });
  const result = await pushWorkflows({ client: clientFor(mock), dir, options: { only: ['Nightly report'] } });
  assert.deepEqual(result.items.map((i) => i.targetId), ['102']);
  assert.deepEqual(mock.writes().map((w) => w.path), ['/workflows/102']);
});

test('an API failure on one workflow is reported and the others still go through', async (t) => {
  const { dir, mock } = await pulled(t);
  await editLocal(dir, ORDER_FILE, bumpUrl);
  await editLocal(dir, 'nightly-report--102.json', (wf) => { wf.nodes[0].notes = 'local note'; });
  mock.failWith(400, { method: 'PUT', path: '/workflows/101' }, 1, { body: { message: 'request/body must NOT have additional properties' } });
  const result = await pushWorkflows({ client: clientFor(mock), dir });
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.update, 1);
  assert.match(result.items.find((i) => i.targetId === '101')?.error ?? '', /additional properties/);
  assert.equal(mock.get('102').nodes[0].notes, 'local note');
  assert.match(formatPushResult(result), /1 failed/);
});

test('promotion creates workflows on a second instance and records an id map', async (t) => {
  const { dir } = await pulled(t);
  const prod = createMockN8n({ credentials: [{ id: 'p-9', name: 'CRM API', type: 'httpHeaderAuth' }, { id: 'p-3', name: 'Webhook header', type: 'httpHeaderAuth' }], startId: 5000 });
  const idMapFile = path.join(await tempDir(t), 'prod.idmap.json');
  const filesBefore = await listFiles(dir);
  const result = await pushWorkflows({ client: clientFor(prod), dir, options: { idMapFile } });
  assert.equal(result.summary.create, 2);
  assert.deepEqual((await readIdMap(idMapFile)).workflows, { 101: '5001', 102: '5000' });
  assert.deepEqual(await listFiles(dir), filesBefore, 'the source directory is left untouched');
  assert.equal(prod.get('5001').name, 'Order intake');
  assert.equal(prod.get('5001').active, true);
  assert.deepEqual(prod.get('5001').tags.map((/** @type {any} */ tag) => tag.name), ['orders']);
});

test('promotion remaps credentials by name to the target ids', async (t) => {
  const { dir } = await pulled(t);
  const prod = createMockN8n({ credentials: [{ id: 'p-9', name: 'CRM API', type: 'httpHeaderAuth' }], startId: 5000 });
  const idMapFile = path.join(await tempDir(t), 'prod.idmap.json');
  const result = await pushWorkflows({ client: clientFor(prod), dir, options: { idMapFile } });
  const nodes = prod.get('5001').nodes;
  assert.deepEqual(nodes.find((/** @type {any} */ n) => n.name === 'Look up customer').credentials, { httpHeaderAuth: { id: 'p-9', name: 'CRM API' } });
  const item = result.items.find((i) => i.localId === '101');
  assert.ok(item?.warnings.some((w) => /no credential named "Webhook header"/.test(w)));
});

test('promotion honours an explicit credential name map', async (t) => {
  const { dir } = await pulled(t);
  const prod = createMockN8n({ credentials: [{ id: 'p-1', name: 'CRM API (prod)', type: 'httpHeaderAuth' }, { id: 'p-2', name: 'Webhook header', type: 'httpHeaderAuth' }], startId: 5000 });
  const idMapFile = path.join(await tempDir(t), 'prod.idmap.json');
  await pushWorkflows({ client: clientFor(prod), dir, options: { idMapFile, credentialMap: { 'CRM API': 'CRM API (prod)' } } });
  const ref = prod.get('5001').nodes.find((/** @type {any} */ n) => n.name === 'Look up customer').credentials.httpHeaderAuth;
  assert.deepEqual(ref, { id: 'p-1', name: 'CRM API (prod)' });
});

test('a second promotion is a no-op and later edits become updates', async (t) => {
  const { dir } = await pulled(t);
  const prod = createMockN8n({ credentials: DEV_CREDENTIALS, startId: 5000 });
  const idMapFile = path.join(await tempDir(t), 'prod.idmap.json');
  await pushWorkflows({ client: clientFor(prod), dir, options: { idMapFile } });
  const writes = prod.writes().length;
  const second = await pushWorkflows({ client: clientFor(prod), dir, options: { idMapFile } });
  assert.equal(second.summary.unchanged, 2);
  assert.equal(prod.writes().length, writes);
  await editLocal(dir, ORDER_FILE, bumpUrl);
  const third = await pushWorkflows({ client: clientFor(prod), dir, options: { idMapFile } });
  assert.deepEqual([third.summary.create, third.summary.update], [0, 1]);
  assert.equal(prod.workflows.size, 2);
});

test('promotion detects edits made directly on the target', async (t) => {
  const { dir } = await pulled(t);
  const prod = createMockN8n({ credentials: DEV_CREDENTIALS, startId: 5000 });
  const idMapFile = path.join(await tempDir(t), 'prod.idmap.json');
  await pushWorkflows({ client: clientFor(prod), dir, options: { idMapFile } });
  prod.edit('5001', (wf) => { wf.nodes[0].notes = 'hotfix on prod'; });
  await editLocal(dir, ORDER_FILE, bumpUrl);
  await assert.rejects(pushWorkflows({ client: clientFor(prod), dir, options: { idMapFile } }), ConflictError);
  const forced = await pushWorkflows({ client: clientFor(prod), dir, options: { idMapFile, force: true } });
  assert.equal(forced.summary.update, 1);
});

test('promotion works when the credentials endpoint is forbidden, with a warning', async (t) => {
  const { dir } = await pulled(t);
  const prod = createMockN8n({ credentials: null, startId: 5000 });
  const idMapFile = path.join(await tempDir(t), 'prod.idmap.json');
  const logger = createMemoryLogger();
  const result = await pushWorkflows({ client: clientFor(prod), dir, options: { idMapFile }, logger });
  assert.equal(result.summary.create, 2);
  assert.match(logger.errText(), /does not expose GET \/credentials/);
  const ref = prod.get('5001').nodes.find((/** @type {any} */ n) => n.name === 'Look up customer').credentials.httpHeaderAuth;
  assert.equal(ref.id, 'cred-2', 'ids are pushed unchanged');
});
