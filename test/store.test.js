import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { writeFileAtomic } from '../src/util/fs.js';
import {
  MANIFEST_FILE, emptyManifest, findDuplicateIds, loadWorkflows, looksLikeWorkflow, readIdMap, readManifest,
  workflowRelativePath, writeIdMap, writeManifest,
} from '../src/workflow/store.js';
import { scheduledWorkflow, tempDir, workflow } from './helpers/fixtures.js';

test('workflowRelativePath is flat by default', () => {
  assert.equal(workflowRelativePath(workflow()), 'order-intake--101.json');
});

test('workflowRelativePath groups by first tag (alphabetically) or _untagged', () => {
  assert.equal(workflowRelativePath(workflow({ tags: [{ name: 'sales ops' }, { name: 'billing' }] }), 'tag'), 'billing/order-intake--101.json');
  assert.equal(workflowRelativePath(scheduledWorkflow(), 'tag'), '_untagged/nightly-report--102.json');
});

test('workflowRelativePath groups by project or _no-project', () => {
  assert.equal(workflowRelativePath(workflow({ homeProject: { id: 'p', name: 'Finance Team' } }), 'project'), 'finance-team/order-intake--101.json');
  assert.equal(workflowRelativePath(workflow(), 'project'), '_no-project/order-intake--101.json');
});

test('looksLikeWorkflow needs a nodes array', () => {
  assert.equal(looksLikeWorkflow(workflow()), true);
  assert.equal(looksLikeWorkflow({ name: 'x' }), false);
  assert.equal(looksLikeWorkflow([]), false);
  assert.equal(looksLikeWorkflow(null), false);
});

test('manifest round-trips and a missing manifest is empty', async (t) => {
  const dir = await tempDir(t);
  assert.deepEqual(await readManifest(dir), emptyManifest());
  const manifest = emptyManifest('https://n8n.example.com');
  manifest.workflows['101'] = { name: 'Order intake', file: 'order-intake--101.json', hash: 'abc', active: true, tags: ['orders'], project: null, nodeCount: 3 };
  assert.equal(await writeManifest(dir, manifest), true);
  assert.equal(await writeManifest(dir, manifest), false, 'unchanged manifest is not rewritten');
  assert.deepEqual(await readManifest(dir), manifest);
});

test('readManifest rejects malformed files and newer versions', async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, MANIFEST_FILE), '[]');
  await assert.rejects(readManifest(dir), /not a valid manifest/);
  await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify({ version: 99, workflows: {} }));
  await assert.rejects(readManifest(dir), /manifest version 99/);
});

test('loadWorkflows reads nested files, skips the manifest and non-workflow JSON, reports broken files', async (t) => {
  const dir = await tempDir(t);
  await writeFileAtomic(path.join(dir, 'order-intake--101.json'), JSON.stringify(workflow()));
  await writeFileAtomic(path.join(dir, 'ops/nightly-report--102.json'), JSON.stringify(scheduledWorkflow()));
  await writeFileAtomic(path.join(dir, MANIFEST_FILE), JSON.stringify(emptyManifest()));
  await writeFileAtomic(path.join(dir, 'package.json'), '{"name":"not-a-workflow"}');
  await writeFileAtomic(path.join(dir, 'broken.json'), '{ nope');
  await writeFileAtomic(path.join(dir, 'README.md'), '# hi');
  const loaded = await loadWorkflows(dir);
  assert.deepEqual(loaded.workflows.map((wf) => wf.file), ['ops/nightly-report--102.json', 'order-intake--101.json']);
  assert.deepEqual(loaded.workflows.map((wf) => wf.id), ['102', '101']);
  assert.deepEqual(loaded.skipped, ['package.json']);
  assert.equal(loaded.errors.length, 1);
  assert.equal(loaded.errors[0].file, 'broken.json');
});

test('loadWorkflows accepts a single file and derives a missing id from the file name', async (t) => {
  const dir = await tempDir(t);
  const { id, ...withoutId } = workflow();
  assert.equal(id, '101');
  const file = path.join(dir, 'order-intake--77.json');
  await writeFileAtomic(file, JSON.stringify(withoutId));
  const loaded = await loadWorkflows(file);
  assert.equal(loaded.workflows.length, 1);
  assert.equal(loaded.workflows[0].id, '77');
  assert.equal(loaded.workflows[0].absolute, file);
});

test('loadWorkflows reports no id for hand-written files without one', async (t) => {
  const dir = await tempDir(t);
  const { id, ...withoutId } = workflow();
  assert.ok(id);
  await writeFileAtomic(path.join(dir, 'new-flow.json'), JSON.stringify(withoutId));
  await writeFileAtomic(path.join(dir, 'draft--noid.json'), JSON.stringify(withoutId));
  assert.deepEqual((await loadWorkflows(dir)).workflows.map((wf) => wf.id), [null, null]);
});

test('findDuplicateIds lists ids used by more than one file', () => {
  const dupes = findDuplicateIds([
    { id: '1', file: 'a.json' }, { id: '2', file: 'b.json' }, { id: '1', file: 'copy/a.json' }, { id: null, file: 'c.json' }, { id: null, file: 'd.json' },
  ].map((entry) => ({ ...entry, absolute: entry.file, workflow: {} })));
  assert.deepEqual(dupes, [{ id: '1', files: ['a.json', 'copy/a.json'] }]);
});

test('id map round-trips, tolerates a missing file and coerces numeric ids', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'env', 'prod.idmap.json');
  assert.deepEqual(await readIdMap(file), { version: 1, workflows: {}, pushed: {} });
  assert.deepEqual(await readIdMap(''), { version: 1, workflows: {}, pushed: {} });
  await writeIdMap(file, { version: 1, workflows: { 101: '5001' }, pushed: { 5001: 'hash' } });
  assert.deepEqual(await readIdMap(file), { version: 1, workflows: { 101: '5001' }, pushed: { 5001: 'hash' } });
  await writeFile(file, JSON.stringify({ workflows: { 101: 5001, bad: { nested: true } } }));
  assert.deepEqual((await readIdMap(file)).workflows, { 101: '5001' });
  await writeFile(file, '"text"');
  await assert.rejects(readIdMap(file), /not a valid id map/);
});
