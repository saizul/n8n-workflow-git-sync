import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { N8nClient } from '../src/api.js';
import { formatPullResult, pullWorkflows } from '../src/sync/pull.js';
import { MANIFEST_FILE, readManifest } from '../src/workflow/store.js';
import { listFiles, pathExists } from '../src/util/fs.js';
import { BASE_URL, TEST_API_KEY, createMockN8n } from './helpers/mock-n8n.js';
import { scheduledWorkflow, tempDir, workflow } from './helpers/fixtures.js';

/** @param {ReturnType<typeof createMockN8n>} mock */
const clientFor = (mock) => new N8nClient({ baseUrl: BASE_URL, apiKey: TEST_API_KEY, fetch: mock.fetch, sleep: async () => {} });

/** @param {string} dir */
const jsonFiles = async (dir) => (await listFiles(dir)).filter((file) => file !== MANIFEST_FILE).sort();

test('first pull writes one file per workflow plus a manifest', async (t) => {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow(), scheduledWorkflow()] });
  const result = await pullWorkflows({ client: clientFor(mock), dir });
  assert.deepEqual(result.added.map((wf) => wf.file), ['order-intake--101.json', 'nightly-report--102.json']);
  assert.equal(result.total, 2);
  assert.deepEqual(await jsonFiles(dir), ['nightly-report--102.json', 'order-intake--101.json']);
  const manifest = await readManifest(dir);
  assert.equal(manifest.workflows['101'].file, 'order-intake--101.json');
  assert.equal(manifest.workflows['101'].name, 'Order intake');
  assert.equal(mock.writes().length, 0, 'pull never writes to the instance');
});

test('pulled files are deterministic and free of volatile fields', async (t) => {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow()] });
  await pullWorkflows({ client: clientFor(mock), dir });
  const text = await readFile(path.join(dir, 'order-intake--101.json'), 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.updatedAt, undefined);
  assert.equal(parsed.versionId, undefined);
  assert.equal(text.endsWith('\n'), true);
  assert.deepEqual(Object.keys(parsed).slice(0, 3), ['id', 'name', 'active']);
});

test('a second pull with no remote changes rewrites nothing', async (t) => {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow(), scheduledWorkflow()] });
  await pullWorkflows({ client: clientFor(mock), dir });
  const before = await readFile(path.join(dir, 'order-intake--101.json'), 'utf8');
  mock.edit('101', (wf) => { wf.updatedAt = '2031-01-01T00:00:00.000Z'; });
  const result = await pullWorkflows({ client: clientFor(mock), dir });
  assert.equal(result.unchanged, 2);
  assert.deepEqual([result.added, result.updated, result.renamed, result.deleted], [[], [], [], []]);
  assert.equal(await readFile(path.join(dir, 'order-intake--101.json'), 'utf8'), before);
});

test('remote edits show up as updates', async (t) => {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow(), scheduledWorkflow()] });
  await pullWorkflows({ client: clientFor(mock), dir });
  mock.edit('101', (wf) => { wf.nodes[1].parameters.url = 'https://api.example.com/v2/customers'; });
  const result = await pullWorkflows({ client: clientFor(mock), dir });
  assert.deepEqual(result.updated.map((wf) => wf.id), ['101']);
  assert.equal(result.unchanged, 1);
  assert.match(await readFile(path.join(dir, 'order-intake--101.json'), 'utf8'), /v2\/customers/);
});

test('a remote rename moves the file and removes the old one', async (t) => {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow()] });
  await pullWorkflows({ client: clientFor(mock), dir });
  mock.edit('101', (wf) => { wf.name = 'Order intake EU'; });
  const result = await pullWorkflows({ client: clientFor(mock), dir });
  assert.deepEqual(result.renamed.map((r) => [r.from, r.to]), [['order-intake--101.json', 'order-intake-eu--101.json']]);
  assert.deepEqual(await jsonFiles(dir), ['order-intake-eu--101.json']);
  assert.equal((await readManifest(dir)).workflows['101'].file, 'order-intake-eu--101.json');
});

test('a remote deletion removes the local file, unless pruning is off', async (t) => {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow(), scheduledWorkflow()] });
  await pullWorkflows({ client: clientFor(mock), dir });
  mock.workflows.delete('102');
  const kept = await pullWorkflows({ client: clientFor(mock), dir, options: { prune: false } });
  assert.deepEqual(kept.deleted, []);
  assert.equal(await pathExists(path.join(dir, 'nightly-report--102.json')), true);
  const result = await pullWorkflows({ client: clientFor(mock), dir });
  assert.deepEqual(result.deleted.map((wf) => wf.file), ['nightly-report--102.json']);
  assert.deepEqual(await jsonFiles(dir), ['order-intake--101.json']);
  assert.equal((await readManifest(dir)).workflows['102'], undefined);
});

test('dry run reports changes without touching the disk', async (t) => {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow()] });
  const result = await pullWorkflows({ client: clientFor(mock), dir, options: { dryRun: true } });
  assert.equal(result.dryRun, true);
  assert.equal(result.added.length, 1);
  assert.deepEqual(await listFiles(dir), []);
  assert.match(formatPullResult(result), /^\+ order-intake--101\.json {2}\(Order intake\)\nDry run: would pull 1 workflow: 1 added/);
});

test('groupBy tag lays files out in tag folders and regrouping moves them', async (t) => {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow(), scheduledWorkflow()] });
  await pullWorkflows({ client: clientFor(mock), dir, options: { groupBy: 'tag' } });
  assert.deepEqual(await jsonFiles(dir), ['_untagged/nightly-report--102.json', 'orders/order-intake--101.json']);
  const flat = await pullWorkflows({ client: clientFor(mock), dir });
  assert.equal(flat.renamed.length, 2);
  assert.deepEqual(await jsonFiles(dir), ['nightly-report--102.json', 'order-intake--101.json']);
  assert.equal(await pathExists(path.join(dir, 'orders')), false, 'empty folders are cleaned up');
});

test('pinned data is dropped unless asked for', async (t) => {
  const mock = createMockN8n({ workflows: [workflow({ pinData: { 'Receive order': [{ json: { customer: 'someone' } }] } })] });
  const plain = await tempDir(t);
  await pullWorkflows({ client: clientFor(mock), dir: plain });
  assert.equal(JSON.parse(await readFile(path.join(plain, 'order-intake--101.json'), 'utf8')).pinData, undefined);
  const withPins = await tempDir(t);
  await pullWorkflows({ client: clientFor(mock), dir: withPins, options: { keepPinData: true } });
  assert.ok(JSON.parse(await readFile(path.join(withPins, 'order-intake--101.json'), 'utf8')).pinData['Receive order']);
});

test('filters limit the pull and never prune what they did not fetch', async (t) => {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow(), scheduledWorkflow()] });
  await pullWorkflows({ client: clientFor(mock), dir });
  const result = await pullWorkflows({ client: clientFor(mock), dir, options: { activeOnly: true } });
  assert.equal(result.total, 1);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(await jsonFiles(dir), ['nightly-report--102.json', 'order-intake--101.json']);
  assert.ok((await readManifest(dir)).workflows['102'], 'unfetched workflows stay in the manifest');
});

test('archived workflows are skipped by default', async (t) => {
  const dir = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow(), scheduledWorkflow({ isArchived: true })] });
  assert.equal((await pullWorkflows({ client: clientFor(mock), dir })).total, 1);
  assert.equal((await pullWorkflows({ client: clientFor(mock), dir, options: { includeArchived: true } })).total, 2);
});

test('formatPullResult summarises every category', () => {
  const text = formatPullResult({
    added: [{ id: '1', name: 'A', file: 'a--1.json' }], updated: [{ id: '2', name: 'B', file: 'b--2.json' }],
    renamed: [{ id: '3', name: 'C', from: 'old--3.json', to: 'c--3.json', contentChanged: true }],
    deleted: [{ id: '4', name: 'D', file: 'd--4.json' }], unchanged: 5, total: 8, dryRun: false,
  });
  assert.deepEqual(text.split('\n'), [
    '+ a--1.json  (A)', '~ b--2.json  (B)', '> old--3.json -> c--3.json  (content changed)', '- d--4.json  (D)',
    'Pulled 8 workflows: 1 added, 1 updated, 1 renamed, 1 deleted, 5 unchanged',
  ]);
});
