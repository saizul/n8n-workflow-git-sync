import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import {
  SNAPSHOT_MANIFEST, createSnapshot, listSnapshots, parseSnapshotName, pruneSnapshots, readSnapshotFiles, resolveSnapshot,
  selectPrunable, snapshotName, verifySnapshot,
} from '../src/backup/snapshot.js';
import { sha256 } from '../src/util/hash.js';
import { pathExists } from '../src/util/fs.js';
import { tempDir } from './helpers/fixtures.js';

const FILES = [
  { path: 'order-intake--101.json', content: '{"name":"Order intake"}\n' },
  { path: 'ops/nightly-report--102.json', content: '{"name":"Nightly report"}\n' },
];
const day = (n) => new Date(Date.UTC(2026, 0, n, 3, 0, 0));

/** @param {string} backupDir @param {number[]} days */
async function seed(backupDir, days) {
  for (const n of days) await createSnapshot({ backupDir, files: FILES, source: 'https://n8n.example.com', now: day(n) });
}

test('snapshot names are sortable timestamps with an optional label', () => {
  assert.equal(snapshotName(day(5)), '20260105T030000Z');
  assert.equal(snapshotName(day(5), 'Before Upgrade!'), '20260105T030000Z-before-upgrade');
  assert.deepEqual(parseSnapshotName('20260105T030000Z-before-upgrade'), { createdAt: day(5), label: 'before-upgrade' });
  assert.deepEqual(parseSnapshotName('20260105T030000Z'), { createdAt: day(5), label: null });
  assert.equal(parseSnapshotName('notes'), null);
  assert.equal(parseSnapshotName('20261399T030000Z'), null);
});

test('createSnapshot writes files and a sha256 manifest', async (t) => {
  const backupDir = await tempDir(t);
  const { dir, name, manifest } = await createSnapshot({ backupDir, files: FILES, source: 'https://n8n.example.com', now: day(5), label: 'pre' });
  assert.equal(name, '20260105T030000Z-pre');
  assert.equal(dir, path.join(backupDir, name));
  assert.equal(await readFile(path.join(dir, 'workflows', 'ops', 'nightly-report--102.json'), 'utf8'), FILES[1].content);
  assert.equal(manifest.files.length, 2);
  const entry = manifest.files.find((file) => file.path === 'order-intake--101.json');
  assert.equal(entry?.sha256, sha256(FILES[0].content));
  assert.equal(manifest.source, 'https://n8n.example.com');
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, SNAPSHOT_MANIFEST), 'utf8')), manifest);
});

test('createSnapshot refuses to overwrite and rejects unsafe paths', async (t) => {
  const backupDir = await tempDir(t);
  await seed(backupDir, [5]);
  await assert.rejects(createSnapshot({ backupDir, files: FILES, source: 's', now: day(5) }), /already exists/);
  await assert.rejects(createSnapshot({ backupDir, files: [{ path: '../escape.json', content: '{}' }], source: 's', now: day(6) }));
  assert.equal(await pathExists(path.join(backupDir, '..', 'escape.json')), false);
});

test('verifySnapshot passes on an intact snapshot', async (t) => {
  const backupDir = await tempDir(t);
  const { dir } = await createSnapshot({ backupDir, files: FILES, source: 's', now: day(5) });
  const report = await verifySnapshot(dir);
  assert.equal(report.ok, true);
  assert.equal(report.checked, 2);
  assert.deepEqual([report.missing, report.mismatched, report.extra], [[], [], []]);
});

test('verifySnapshot detects modified, missing and extra files', async (t) => {
  const backupDir = await tempDir(t);
  const { dir } = await createSnapshot({ backupDir, files: FILES, source: 's', now: day(5) });
  await writeFile(path.join(dir, 'workflows', 'order-intake--101.json'), '{"name":"tampered"}\n');
  await rm(path.join(dir, 'workflows', 'ops', 'nightly-report--102.json'));
  await writeFile(path.join(dir, 'workflows', 'stray.json'), '{}');
  const report = await verifySnapshot(dir);
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatched, ['order-intake--101.json']);
  assert.deepEqual(report.missing, ['ops/nightly-report--102.json']);
  assert.deepEqual(report.extra, ['stray.json']);
});

test('readSnapshotFiles returns the stored files', async (t) => {
  const backupDir = await tempDir(t);
  const { dir } = await createSnapshot({ backupDir, files: FILES, source: 's', now: day(5) });
  const files = await readSnapshotFiles(dir);
  assert.deepEqual(files.map((file) => file.path).sort(), ['ops/nightly-report--102.json', 'order-intake--101.json']);
  assert.equal(files.find((file) => file.path === FILES[0].path)?.content, FILES[0].content);
});

test('listSnapshots is oldest first and ignores foreign directories', async (t) => {
  const backupDir = await tempDir(t);
  await seed(backupDir, [7, 5, 6]);
  await writeFile(path.join(backupDir, 'README.txt'), 'not a snapshot');
  const list = await listSnapshots(backupDir);
  assert.deepEqual(list.map((s) => s.name), ['20260105T030000Z', '20260106T030000Z', '20260107T030000Z']);
  assert.deepEqual(await listSnapshots(path.join(backupDir, 'missing')), []);
});

test('resolveSnapshot accepts latest, a name or a path', async (t) => {
  const backupDir = await tempDir(t);
  await seed(backupDir, [5, 6]);
  assert.equal(path.basename(await resolveSnapshot(backupDir, 'latest')), '20260106T030000Z');
  assert.equal(path.basename(await resolveSnapshot(backupDir, '20260105T030000Z')), '20260105T030000Z');
  assert.equal(await resolveSnapshot(backupDir, path.join(backupDir, '20260105T030000Z')), path.join(backupDir, '20260105T030000Z'));
  await assert.rejects(resolveSnapshot(backupDir, '20200101T000000Z'), /not found|No snapshot/i);
  await assert.rejects(resolveSnapshot(await tempDir(t), 'latest'), /No snapshot/i);
});

test('selectPrunable keeps the newest N', () => {
  const snapshots = [1, 2, 3, 4, 5].map((n) => ({ name: snapshotName(day(n)), dir: '', createdAt: day(n), label: null }));
  assert.deepEqual(selectPrunable(snapshots, { keep: 2 }).map((s) => s.createdAt.getUTCDate()), [1, 2, 3]);
  assert.deepEqual(selectPrunable(snapshots, { keep: 10 }), []);
  assert.deepEqual(selectPrunable(snapshots, {}), [], 'no policy prunes nothing');
});

test('selectPrunable applies a maximum age but never removes the newest snapshot', () => {
  const snapshots = [1, 2, 3, 4, 5].map((n) => ({ name: snapshotName(day(n)), dir: '', createdAt: day(n), label: null }));
  assert.deepEqual(selectPrunable(snapshots, { maxAgeDays: 2, now: day(6) }).map((s) => s.createdAt.getUTCDate()), [1, 2, 3]);
  assert.deepEqual(selectPrunable(snapshots, { maxAgeDays: 1, now: day(60) }).map((s) => s.createdAt.getUTCDate()), [1, 2, 3, 4]);
  assert.deepEqual(selectPrunable(snapshots, { keep: 4, maxAgeDays: 3, now: day(6) }).map((s) => s.createdAt.getUTCDate()), [1, 2]);
});

test('pruneSnapshots deletes directories, or only reports them in a dry run', async (t) => {
  const backupDir = await tempDir(t);
  await seed(backupDir, [1, 2, 3, 4]);
  const preview = await pruneSnapshots(backupDir, { keep: 2, dryRun: true });
  assert.equal(preview.length, 2);
  assert.equal((await listSnapshots(backupDir)).length, 4);
  const removed = await pruneSnapshots(backupDir, { keep: 2 });
  assert.deepEqual(removed.map((s) => s.name), ['20260101T030000Z', '20260102T030000Z']);
  assert.deepEqual((await listSnapshots(backupDir)).map((s) => s.name), ['20260103T030000Z', '20260104T030000Z']);
});
