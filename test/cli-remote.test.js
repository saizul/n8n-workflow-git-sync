import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { writeFileAtomic, pathExists } from '../src/util/fs.js';
import { stableStringify } from '../src/util/json.js';
import { cli } from './helpers/cli.js';
import { BASE_URL, TEST_API_KEY, createMockN8n } from './helpers/mock-n8n.js';
import { scheduledWorkflow, tempDir, workflow } from './helpers/fixtures.js';

const now = () => new Date('2026-03-01T10:00:00Z');

/** A temp project plus a mock instance holding the two fixture workflows. */
async function setup(t, { pulled = true } = {}) {
  const cwd = await tempDir(t);
  const mock = createMockN8n({ workflows: [workflow(), scheduledWorkflow()] });
  if (pulled) assert.equal((await cli(['pull'], { cwd, mock, now })).code, 0);
  return { cwd, mock };
}
/** @param {string} file */
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('pull writes workflow files into ./workflows and reports what changed', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  const first = await cli(['pull'], { cwd, mock, now });
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /\+ order-intake--101\.json {2}\(Order intake\)/);
  assert.match(first.out, /Pulled 2 workflows: 2 added, 0 updated, 0 renamed, 0 deleted, 0 unchanged/);
  assert.deepEqual((await readdir(path.join(cwd, 'workflows'))).sort(), ['n8n-sync.manifest.json', 'nightly-report--102.json', 'order-intake--101.json']);
  const second = await cli(['pull'], { cwd, mock, now });
  assert.match(second.out, /0 added, 0 updated, 0 renamed, 0 deleted, 2 unchanged/);
  assert.equal(mock.writes().length, 0);
});

test('pull --fail-on-change exits 1 only when something changed', async (t) => {
  const { cwd, mock } = await setup(t);
  assert.equal((await cli(['pull', '--fail-on-change'], { cwd, mock, now })).code, 0);
  mock.edit('102', (wf) => { wf.name = 'Nightly report (EU)'; });
  const changed = await cli(['pull', '--fail-on-change'], { cwd, mock, now });
  assert.equal(changed.code, 1);
  assert.ok(await pathExists(path.join(cwd, 'workflows/nightly-report-eu--102.json')));
});

test('pull --dry-run --json reports without touching the disk', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  const result = await cli(['pull', '--dry-run', '--json', '--dir', 'flows'], { cwd, mock, now });
  assert.equal(result.code, 0);
  const report = JSON.parse(result.out);
  assert.equal(report.dryRun, true);
  assert.equal(report.added.length, 2);
  assert.equal(await pathExists(path.join(cwd, 'flows')), false);
});

test('pull honours the directory from .n8nsyncrc.json and from --dir', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  await writeFile(path.join(cwd, '.n8nsyncrc.json'), JSON.stringify({ dir: 'automation' }));
  assert.equal((await cli(['pull'], { cwd, mock, now })).code, 0);
  assert.ok(await pathExists(path.join(cwd, 'automation/order-intake--101.json')));
  assert.equal((await cli(['pull', '--dir', 'elsewhere'], { cwd, mock, now })).code, 0);
  assert.ok(await pathExists(path.join(cwd, 'elsewhere/order-intake--101.json')));
});

test('named environments select the base URL and the API key variable', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  await writeFile(path.join(cwd, '.n8nsyncrc.json'), JSON.stringify({
    environments: { prod: { baseUrl: BASE_URL, apiKeyEnv: 'PROD_KEY', dir: 'prod-flows' } },
  }));
  const ok = await cli(['pull', '--env', 'prod'], { cwd, mock, now, env: { PROD_KEY: TEST_API_KEY } });
  assert.equal(ok.code, 0, ok.err);
  assert.ok(await pathExists(path.join(cwd, 'prod-flows/order-intake--101.json')));
  const unknown = await cli(['pull', '--env', 'staging'], { cwd, mock, now, env: { PROD_KEY: TEST_API_KEY } });
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /staging/);
});

test('an HTTP 401 becomes exit code 3 with a hint, and the key is never printed', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  mock.failWith(401, { method: 'GET', path: '/workflows' }, 5, { body: { message: 'unauthorized' } });
  const result = await cli(['pull', '-v'], { cwd, mock, now });
  assert.equal(result.code, 3);
  assert.match(result.err, /HTTP 401/);
  assert.match(result.err, /check the API key/);
  assert.ok(!(result.out + result.err).includes(TEST_API_KEY));
});

test('verbose output never contains the API key, even when passed as a flag', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  const result = await cli(['pull', '-v', '--base-url', BASE_URL, '--api-key', TEST_API_KEY], { cwd, mock, now, env: {} });
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /debug: GET https:\/\/n8n\.example\.com\/api\/v1\/workflows/);
  assert.ok(!(result.out + result.err).includes(TEST_API_KEY));
});

test('--quiet suppresses informational output', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  const result = await cli(['pull', '--quiet'], { cwd, mock, now });
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
});

test('diff reports no changes right after a pull', async (t) => {
  const { cwd, mock } = await setup(t);
  const result = await cli(['diff', '--exit-code'], { cwd, mock, now });
  assert.equal(result.code, 0);
  assert.match(result.out, /0 added, 0 removed, 0 changed, 2 unchanged/);
});

test('diff shows remote drift and --exit-code turns it into exit 1', async (t) => {
  const { cwd, mock } = await setup(t);
  mock.edit('101', (wf) => { wf.name = 'Order intake v2'; });
  const result = await cli(['diff', '--exit-code'], { cwd, mock, now });
  assert.equal(result.code, 1);
  assert.match(result.out, /~ workflow "Order intake" \(101\)/);
  assert.match(result.out, /name: "Order intake v2" -> "Order intake"/);
  const json = JSON.parse((await cli(['diff', '--format', 'json'], { cwd, mock, now })).out);
  assert.deepEqual(json.summary, { added: 0, removed: 0, changed: 1, unchanged: 1 });
  assert.equal(json.changed[0].diff.name.before, 'Order intake v2');
});

test('diff compares two local paths without any API configuration', async (t) => {
  const cwd = await tempDir(t);
  const before = workflow();
  const after = structuredClone(before);
  after.nodes[1].parameters.url = 'https://api.example.com/v2/customers';
  await writeFileAtomic(path.join(cwd, 'a/order.json'), stableStringify(before));
  await writeFileAtomic(path.join(cwd, 'b/order.json'), stableStringify(after));
  const result = await cli(['diff', 'a', 'b', '--exit-code'], { cwd, env: {} });
  assert.equal(result.code, 1, result.err);
  assert.match(result.out, /Look up customer/);
  assert.match(result.out, /parameters\.url/);
  assert.equal((await cli(['diff', 'a', 'a', '--exit-code'], { cwd, env: {} })).code, 0);
  assert.equal((await cli(['diff', 'a'], { cwd, env: {} })).code, 2);
});

test('push --dry-run plans updates without writing to the instance', async (t) => {
  const { cwd, mock } = await setup(t);
  const file = path.join(cwd, 'workflows/order-intake--101.json');
  const local = await readJson(file);
  local.nodes.find((/** @type {any} */ n) => n.name === 'Look up customer').parameters.url = 'https://api.example.com/v2/customers';
  await writeFile(file, stableStringify(local));
  const result = await cli(['push', '--dry-run'], { cwd, mock, now });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Dry run: would push: 0 created, 1 updated, 1 unchanged/);
  assert.equal(mock.writes().length, 0);
});

test('push applies local edits and a second push is a no-op', async (t) => {
  const { cwd, mock } = await setup(t);
  const file = path.join(cwd, 'workflows/order-intake--101.json');
  const local = await readJson(file);
  local.nodes.find((/** @type {any} */ n) => n.name === 'Look up customer').parameters.url = 'https://api.example.com/v2/customers';
  await writeFile(file, stableStringify(local));
  const first = await cli(['push', '--json'], { cwd, mock, now });
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(JSON.parse(first.out).summary, { create: 0, update: 1, unchanged: 1, conflict: 0, failed: 0 });
  assert.equal(mock.get('101').nodes.find((/** @type {any} */ n) => n.name === 'Look up customer').parameters.url, 'https://api.example.com/v2/customers');
  const writes = mock.writes().length;
  const second = await cli(['push', '--json'], { cwd, mock, now });
  assert.equal(JSON.parse(second.out).summary.unchanged, 2);
  assert.equal(mock.writes().length, writes);
});

test('push stops with exit 4 on a remote conflict and --force overrides it', async (t) => {
  const { cwd, mock } = await setup(t);
  mock.edit('101', (wf) => { wf.name = 'Edited in the UI'; });
  const conflict = await cli(['push'], { cwd, mock, now });
  assert.equal(conflict.code, 4);
  assert.match(conflict.err, /changed on the instance since the last sync/);
  assert.match(conflict.err, /--force/);
  assert.equal(mock.writes().length, 0);
  assert.equal(mock.get('101').name, 'Edited in the UI');
  const forced = await cli(['push', '--force'], { cwd, mock, now });
  assert.equal(forced.code, 0, forced.err);
  assert.equal(mock.get('101').name, 'Order intake');
});

test('push creates workflows that do not exist remotely', async (t) => {
  const { cwd, mock } = await setup(t);
  const fresh = workflow({ name: 'Brand new flow' });
  delete (/** @type {any} */ (fresh)).id;
  await writeFile(path.join(cwd, 'workflows/brand-new-flow.json'), stableStringify(fresh));
  const result = await cli(['push', '--json'], { cwd, mock, now });
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).summary.create, 1);
  assert.equal(mock.workflows.size, 3);
});

test('push --id-map promotes into another instance without touching the source directory', async (t) => {
  const { cwd, mock } = await setup(t);
  const before = (await readdir(path.join(cwd, 'workflows'))).sort();
  const prod = createMockN8n({ workflows: [] });
  const first = await cli(['push', '--id-map', 'prod.idmap.json', '--json'], { cwd, mock: prod, now });
  assert.equal(first.code, 0, first.err);
  assert.equal(JSON.parse(first.out).summary.create, 2);
  const map = await readJson(path.join(cwd, 'prod.idmap.json'));
  assert.deepEqual(Object.keys(map.workflows).sort(), ['101', '102']);
  assert.deepEqual((await readdir(path.join(cwd, 'workflows'))).sort(), before);
  const second = await cli(['push', '--id-map', 'prod.idmap.json', '--json'], { cwd, mock: prod, now });
  assert.equal(JSON.parse(second.out).summary.unchanged, 2);
  assert.equal(prod.workflows.size, 2);
});

test('push reports API failures with exit code 3', async (t) => {
  const { cwd, mock } = await setup(t);
  const file = path.join(cwd, 'workflows/order-intake--101.json');
  const local = await readJson(file);
  local.name = 'Order intake renamed';
  await writeFile(file, stableStringify(local));
  mock.failWith(400, { method: 'PUT', path: '/workflows/101' }, 1, { body: { message: 'request/body must NOT have additional properties' } });
  const result = await cli(['push'], { cwd, mock, now });
  assert.equal(result.code, 3);
  assert.match(result.out + result.err, /additional properties/);
});

test('backup creates a timestamped snapshot, lists it and verifies it', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  const created = await cli(['backup'], { cwd, mock, now });
  assert.equal(created.code, 0, created.err);
  assert.match(created.out, /Created snapshot 20260301T100000Z \(2 files\)/);
  const snapshot = await readJson(path.join(cwd, 'backups/20260301T100000Z/snapshot.json'));
  assert.equal(snapshot.files.length, 2);
  assert.match(snapshot.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.match((await cli(['backup', '--list'], { cwd, env: {} })).out, /20260301T100000Z/);
  const verified = await cli(['backup', '--verify', 'latest'], { cwd, env: {} });
  assert.equal(verified.code, 0, verified.err);
  assert.equal(mock.writes().length, 0);
});

test('backup --verify detects a tampered snapshot', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  await cli(['backup'], { cwd, mock, now });
  const dir = path.join(cwd, 'backups/20260301T100000Z/workflows');
  const [file] = await readdir(dir);
  await writeFile(path.join(dir, file), '{"tampered": true}\n');
  const result = await cli(['backup', '--verify', 'latest'], { cwd, env: {} });
  assert.equal(result.code, 1);
  assert.ok((result.out + result.err).includes(file));
});

test('backup --label, --keep and --prune-only apply the retention policy', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  const clock = (/** @type {string} */ iso) => () => new Date(iso);
  await cli(['backup'], { cwd, mock, now: clock('2026-03-01T10:00:00Z') });
  await cli(['backup'], { cwd, mock, now: clock('2026-03-02T10:00:00Z') });
  const third = await cli(['backup', '--label', 'pre-release', '--keep', '2', '--json'], { cwd, mock, now: clock('2026-03-03T10:00:00Z') });
  const report = JSON.parse(third.out);
  assert.equal(report.snapshot, '20260303T100000Z-pre-release');
  assert.deepEqual(report.pruned, ['20260301T100000Z']);
  assert.deepEqual((await readdir(path.join(cwd, 'backups'))).sort(), ['20260302T100000Z', '20260303T100000Z-pre-release']);
  const pruned = await cli(['backup', '--prune-only', '--keep', '1'], { cwd, env: {}, now: clock('2026-03-04T10:00:00Z') });
  assert.equal(pruned.code, 0, pruned.err);
  assert.deepEqual(await readdir(path.join(cwd, 'backups')), ['20260303T100000Z-pre-release']);
  assert.equal((await cli(['backup', '--prune-only'], { cwd, env: {} })).code, 2);
});

test('backup --from-dir snapshots local files without calling the API', async (t) => {
  const { cwd, mock } = await setup(t);
  const requests = mock.requests.length;
  const result = await cli(['backup', '--from-dir', 'workflows', '--backup-dir', 'snaps'], { cwd, env: {}, now });
  assert.equal(result.code, 0, result.err);
  assert.equal(mock.requests.length, requests);
  assert.ok(await pathExists(path.join(cwd, 'snaps/20260301T100000Z/snapshot.json')));
});

test('restore --to-dir extracts the latest snapshot after verifying it', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  await cli(['backup'], { cwd, mock, now });
  const result = await cli(['restore', '--to-dir', 'restored'], { cwd, env: {} });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Restored 2 files from 20260301T100000Z to restored/);
  const files = (await readdir(path.join(cwd, 'restored'))).filter((name) => name.endsWith('.json') && name.includes('--'));
  assert.equal(files.length, 2);
});

test('restore pushes a snapshot back to the instance, recreating deleted workflows', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  await cli(['backup'], { cwd, mock, now });
  mock.workflows.delete('102');
  mock.edit('101', (wf) => { wf.name = 'Broken by accident'; });
  const dry = await cli(['restore', '--dry-run', '--json'], { cwd, mock, now });
  assert.equal(dry.code, 0, dry.err);
  assert.deepEqual(JSON.parse(dry.out).summary, { create: 1, update: 1, unchanged: 0, conflict: 0, failed: 0 });
  assert.equal(mock.writes().length, 0);
  const real = await cli(['restore', '20260301T100000Z', '--json'], { cwd, mock, now });
  assert.equal(real.code, 0, real.err);
  assert.equal(mock.get('101').name, 'Order intake');
  assert.equal([...mock.workflows.values()].filter((wf) => wf.name === 'Nightly report').length, 1);
});

test('restore refuses a corrupted snapshot and an unknown snapshot name', async (t) => {
  const { cwd, mock } = await setup(t, { pulled: false });
  await cli(['backup'], { cwd, mock, now });
  assert.equal((await cli(['restore', 'no-such-snapshot', '--to-dir', 'out'], { cwd, env: {} })).code, 2);
  const dir = path.join(cwd, 'backups/20260301T100000Z/workflows');
  const [file] = await readdir(dir);
  await writeFile(path.join(dir, file), '{}\n');
  const result = await cli(['restore', '--to-dir', 'out'], { cwd, env: {} });
  assert.notEqual(result.code, 0);
  assert.equal(await pathExists(path.join(cwd, 'out', file)), false);
});
