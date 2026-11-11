import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT, UsageError } from '../errors.js';
import { isDirectory, listFiles, pathExists, readJsonFile, writeFileAtomic } from '../util/fs.js';
import { isPlainObject, stableStringify } from '../util/json.js';
import { sha256 } from '../util/hash.js';
import { compactTimestamp, parseCompactTimestamp, slugify } from '../util/slug.js';

export const SNAPSHOT_MANIFEST = 'snapshot.json';
export const SNAPSHOT_VERSION = 1;
const DATA_DIR = 'workflows';

/**
 * @typedef {object} SnapshotManifest
 * @property {number} version
 * @property {string} createdAt   ISO timestamp
 * @property {string} source      where the data came from (instance origin or directory)
 * @property {string} [label]
 * @property {Array<{path: string, sha256: string, bytes: number}>} files
 */

/**
 * @typedef {object} SnapshotInfo
 * @property {string} name        directory name
 * @property {string} dir         absolute path
 * @property {Date} createdAt
 * @property {string|null} label
 */

/**
 * Snapshot directory name: `<timestamp>` or `<timestamp>-<label>`.
 * @param {Date} date
 * @param {string} [label]
 */
export function snapshotName(date, label) {
  const stamp = compactTimestamp(date);
  return label ? `${stamp}-${slugify(label, { maxLength: 40 })}` : stamp;
}

/**
 * @param {string} name
 * @returns {{createdAt: Date, label: string|null}|null}
 */
export function parseSnapshotName(name) {
  const m = /^(\d{8}T\d{6}Z)(?:-([a-z0-9-]+))?$/.exec(name);
  if (!m) return null;
  const createdAt = parseCompactTimestamp(m[1]);
  return createdAt ? { createdAt, label: m[2] ?? null } : null;
}

/**
 * Write a snapshot directory containing the given files and a checksum
 * manifest. Refuses to overwrite an existing snapshot.
 * @param {object} input
 * @param {string} input.backupDir
 * @param {Array<{path: string, content: string}>} input.files   POSIX relative paths
 * @param {string} input.source
 * @param {Date} [input.now]
 * @param {string} [input.label]
 * @returns {Promise<{dir: string, name: string, manifest: SnapshotManifest}>}
 */
export async function createSnapshot({ backupDir, files, source, now = new Date(), label }) {
  const name = snapshotName(now, label);
  const dir = path.join(backupDir, name);
  if (await pathExists(dir)) {
    throw new CliError(`Snapshot ${dir} already exists; refusing to overwrite it`, EXIT.USAGE);
  }
  /** @type {SnapshotManifest['files']} */
  const entries = [];
  const seen = new Set();
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const rel = file.path.split('\\').join('/');
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new UsageError(`Unsafe path in snapshot input: ${file.path}`);
    }
    if (seen.has(rel)) throw new UsageError(`Duplicate path in snapshot input: ${rel}`);
    seen.add(rel);
    const bytes = Buffer.from(file.content, 'utf8');
    await writeFileAtomic(path.join(dir, DATA_DIR, rel), bytes);
    entries.push({ path: rel, sha256: sha256(bytes), bytes: bytes.length });
  }
  /** @type {SnapshotManifest} */
  const manifest = { version: SNAPSHOT_VERSION, createdAt: now.toISOString(), source, files: entries };
  if (label) manifest.label = label;
  await writeFileAtomic(
    path.join(dir, SNAPSHOT_MANIFEST),
    stableStringify(manifest, { priority: ['version', 'createdAt', 'source', 'label', 'files'] }),
  );
  return { dir, name, manifest };
}

/**
 * @param {string} dir snapshot directory
 * @returns {Promise<SnapshotManifest>}
 */
export async function readSnapshotManifest(dir) {
  const file = path.join(dir, SNAPSHOT_MANIFEST);
  if (!(await pathExists(file))) throw new CliError(`${dir} is not a snapshot (missing ${SNAPSHOT_MANIFEST})`, EXIT.USAGE);
  const raw = await readJsonFile(file);
  if (!isPlainObject(raw) || !Array.isArray(raw.files)) {
    throw new CliError(`${file} is not a valid snapshot manifest`, EXIT.USAGE);
  }
  if (typeof raw.version === 'number' && raw.version > SNAPSHOT_VERSION) {
    throw new CliError(`${file} has snapshot version ${raw.version}; this tool understands up to ${SNAPSHOT_VERSION}`, EXIT.USAGE);
  }
  return /** @type {SnapshotManifest} */ (/** @type {unknown} */ (raw));
}

/**
 * Verify every file of a snapshot against its recorded checksum.
 * @param {string} dir
 * @returns {Promise<{ok: boolean, checked: number, missing: string[], mismatched: string[], extra: string[], manifest: SnapshotManifest}>}
 */
export async function verifySnapshot(dir) {
  const manifest = await readSnapshotManifest(dir);
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const mismatched = [];
  const expected = new Set();
  for (const entry of manifest.files) {
    expected.add(entry.path);
    if (typeof entry.path !== 'string' || entry.path.split('/').includes('..') || path.isAbsolute(entry.path)) {
      mismatched.push(String(entry.path));
      continue;
    }
    let content;
    try {
      content = await readFile(path.join(dir, DATA_DIR, entry.path));
    } catch {
      missing.push(entry.path);
      continue;
    }
    if (sha256(content) !== entry.sha256 || content.length !== entry.bytes) mismatched.push(entry.path);
  }
  const present = await listFiles(path.join(dir, DATA_DIR));
  const extra = present.filter((file) => !expected.has(file));
  return {
    ok: missing.length === 0 && mismatched.length === 0 && extra.length === 0,
    checked: manifest.files.length, missing, mismatched, extra, manifest,
  };
}

/**
 * Read the verified contents of a snapshot.
 * @param {string} dir
 * @returns {Promise<Array<{path: string, content: string}>>}
 */
export async function readSnapshotFiles(dir) {
  const manifest = await readSnapshotManifest(dir);
  /** @type {Array<{path: string, content: string}>} */
  const out = [];
  for (const entry of manifest.files) {
    out.push({ path: entry.path, content: await readFile(path.join(dir, DATA_DIR, entry.path), 'utf8') });
  }
  return out;
}

/**
 * List snapshots in a backup directory, oldest first.
 * @param {string} backupDir
 * @returns {Promise<SnapshotInfo[]>}
 */
export async function listSnapshots(backupDir) {
  if (!(await isDirectory(backupDir))) return [];
  /** @type {SnapshotInfo[]} */
  const out = [];
  for (const entry of await readdir(backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const parsed = parseSnapshotName(entry.name);
    if (!parsed) continue;
    if (!(await pathExists(path.join(backupDir, entry.name, SNAPSHOT_MANIFEST)))) continue;
    out.push({ name: entry.name, dir: path.join(backupDir, entry.name), createdAt: parsed.createdAt, label: parsed.label });
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.name.localeCompare(b.name));
}

/**
 * Resolve a snapshot reference: `latest`, a snapshot name, or a path.
 * @param {string} backupDir
 * @param {string} ref
 * @returns {Promise<string>} absolute snapshot directory
 */
export async function resolveSnapshot(backupDir, ref) {
  if (ref === 'latest') {
    const all = await listSnapshots(backupDir);
    if (all.length === 0) throw new CliError(`No snapshots found in ${backupDir}`, EXIT.USAGE);
    return all[all.length - 1].dir;
  }
  for (const candidate of [path.join(backupDir, ref), path.resolve(ref)]) {
    if (await pathExists(path.join(candidate, SNAPSHOT_MANIFEST))) return candidate;
  }
  throw new CliError(`Snapshot "${ref}" not found in ${backupDir}`, EXIT.USAGE);
}

/**
 * Decide which snapshots a retention policy removes. A snapshot is removed
 * when it falls outside the newest `keep` snapshots OR is older than
 * `maxAgeDays`; the newest snapshot is always kept.
 * @param {SnapshotInfo[]} snapshots   oldest first
 * @param {{keep?: number, maxAgeDays?: number, now?: Date}} policy
 * @returns {SnapshotInfo[]}
 */
export function selectPrunable(snapshots, policy) {
  const { keep = 0, maxAgeDays = 0, now = new Date() } = policy;
  if (keep <= 0 && maxAgeDays <= 0) return [];
  const newestFirst = [...snapshots].reverse();
  const cutoff = maxAgeDays > 0 ? now.getTime() - maxAgeDays * 86400000 : -Infinity;
  return newestFirst
    .filter((snapshot, index) => {
      if (index === 0) return false;
      if (keep > 0 && index >= keep) return true;
      return snapshot.createdAt.getTime() < cutoff;
    })
    .reverse();
}

/**
 * Apply a retention policy.
 * @param {string} backupDir
 * @param {{keep?: number, maxAgeDays?: number, now?: Date, dryRun?: boolean}} policy
 * @returns {Promise<SnapshotInfo[]>} removed (or would-be removed) snapshots
 */
export async function pruneSnapshots(backupDir, policy) {
  const prunable = selectPrunable(await listSnapshots(backupDir), policy);
  if (!policy.dryRun) {
    for (const snapshot of prunable) await rm(snapshot.dir, { recursive: true, force: true });
  }
  return prunable;
}
