import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJson, stableStringify } from './json.js';

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} dir */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/**
 * Write a file atomically (write to a sibling temp file, then rename) so an
 * interrupted run never leaves a half-written workflow behind.
 * @param {string} file
 * @param {string|Uint8Array} content
 */
export async function writeFileAtomic(file, content) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmp, content);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Write only when the content differs. Returns true when the file changed.
 * @param {string} file
 * @param {string} content
 */
export async function writeIfChanged(file, content) {
  try {
    const current = await readFile(file, 'utf8');
    if (current === content) return false;
  } catch {
    // missing file: fall through and write
  }
  await writeFileAtomic(file, content);
  return true;
}

/**
 * @param {string} file
 * @returns {Promise<any>}
 */
export async function readJsonFile(file) {
  const text = await readFile(file, 'utf8');
  return parseJson(text, file);
}

/**
 * @param {string} file
 * @param {any} fallback
 * @returns {Promise<any>}
 */
export async function readJsonFileOr(file, fallback) {
  if (!(await pathExists(file))) return fallback;
  return readJsonFile(file);
}

/**
 * @param {string} file
 * @param {unknown} value
 * @param {{priority?: string[]}} [options]
 */
export async function writeJsonFile(file, value, options = {}) {
  return writeIfChanged(file, stableStringify(value, options));
}

/**
 * Recursively list files below `dir` as POSIX-style relative paths, sorted.
 * Dot-directories and `node_modules` are skipped.
 * @param {string} dir
 * @param {(relative: string) => boolean} [filter]
 * @returns {Promise<string[]>}
 */
export async function listFiles(dir, filter = () => true) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  async function visit(rel) {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await visit(child);
      } else if (entry.isFile() && filter(child)) {
        out.push(child);
      }
    }
  }
  if (await isDirectory(dir)) await visit('');
  return out.sort();
}

/**
 * Remove a file and then any directories left empty, up to (not including)
 * `root`.
 * @param {string} root
 * @param {string} relative
 */
export async function removeFileAndEmptyParents(root, relative) {
  await rm(path.join(root, relative), { force: true });
  let dir = path.dirname(relative);
  while (dir !== '.' && dir !== '' && dir !== '/') {
    const abs = path.join(root, dir);
    try {
      const remaining = await readdir(abs);
      if (remaining.length > 0) break;
      await rm(abs, { recursive: true, force: true });
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Convert a platform path to a POSIX-style relative path.
 * @param {string} p
 */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}
