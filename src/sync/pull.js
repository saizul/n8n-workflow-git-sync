import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists, removeFileAndEmptyParents, writeFileAtomic } from '../util/fs.js';
import { contentHash, projectName, serializeWorkflow, tagNames } from '../workflow/normalize.js';
import { emptyManifest, readManifest, workflowRelativePath, writeManifest } from '../workflow/store.js';
import { isStickyNote } from '../workflow/graph.js';

/**
 * @typedef {object} PullOptions
 * @property {boolean} [stripVolatile]
 * @property {boolean} [keepPinData]
 * @property {'none'|'tag'|'project'} [groupBy]
 * @property {boolean} [prune]            delete local files of workflows removed remotely (default true)
 * @property {boolean} [dryRun]
 * @property {boolean} [includeArchived]
 * @property {string[]} [tags]            only workflows carrying all of these tags
 * @property {boolean} [activeOnly]
 */

/**
 * @typedef {object} PullResult
 * @property {Array<{id: string, name: string, file: string}>} added
 * @property {Array<{id: string, name: string, file: string}>} updated
 * @property {Array<{id: string, name: string, from: string, to: string, contentChanged: boolean}>} renamed
 * @property {Array<{id: string, name: string, file: string}>} deleted
 * @property {number} unchanged
 * @property {number} total
 * @property {boolean} dryRun
 */

/**
 * Export every workflow of an instance into `dir`, one deterministic JSON
 * file per workflow, and maintain the manifest. Detects renames (same id,
 * different file path) and deletions (id in the manifest but gone remotely).
 *
 * @param {object} input
 * @param {import('../api.js').N8nClient} input.client
 * @param {string} input.dir
 * @param {PullOptions} [input.options]
 * @param {import('../util/logger.js').Logger} [input.logger]
 * @returns {Promise<PullResult>}
 */
export async function pullWorkflows({ client, dir, options = {}, logger }) {
  const {
    stripVolatile = true, keepPinData = false, groupBy = 'none', prune = true, dryRun = false,
    includeArchived = false, tags = [], activeOnly = false,
  } = options;
  const filtered = tags.length > 0 || activeOnly;
  let remote = await client.listWorkflows({
    tags: tags.length > 0 ? tags : undefined,
    active: activeOnly ? true : undefined,
  });
  if (!includeArchived) remote = remote.filter((wf) => wf.isArchived !== true);
  remote.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const previous = await readManifest(dir);
  const manifest = emptyManifest(client.http.baseUrl);
  /** @type {PullResult} */
  const result = { added: [], updated: [], renamed: [], deleted: [], unchanged: 0, total: remote.length, dryRun };
  const seenIds = new Set();

  if (!dryRun) await ensureDir(dir);
  for (const workflow of remote) {
    if (workflow.id === undefined || workflow.id === null) {
      logger?.warn(`Skipping a workflow without an id (name: ${workflow.name ?? 'unknown'})`);
      continue;
    }
    const id = String(workflow.id);
    if (seenIds.has(id)) continue; // defensive: a page boundary shifted during listing
    seenIds.add(id);
    const name = String(workflow.name ?? '');
    const file = workflowRelativePath(workflow, groupBy);
    const text = serializeWorkflow(workflow, { stripVolatile, keepPinData });
    const absolute = path.join(dir, file);
    const prior = previous.workflows[id];

    let existing = null;
    if (await pathExists(absolute)) existing = await readFile(absolute, 'utf8');
    else if (prior && prior.file !== file && (await pathExists(path.join(dir, prior.file)))) {
      existing = await readFile(path.join(dir, prior.file), 'utf8');
    }
    const contentChanged = existing !== text;

    if (prior && prior.file !== file) {
      result.renamed.push({ id, name, from: prior.file, to: file, contentChanged });
      if (!dryRun) await removeFileAndEmptyParents(dir, prior.file);
    } else if (existing === null) {
      result.added.push({ id, name, file });
    } else if (contentChanged) {
      result.updated.push({ id, name, file });
    } else {
      result.unchanged += 1;
    }
    if (!dryRun && (contentChanged || !(await pathExists(absolute)))) await writeFileAtomic(absolute, text);

    manifest.workflows[id] = {
      name,
      file,
      hash: contentHash(workflow),
      active: workflow.active === true,
      tags: tagNames(workflow),
      project: projectName(workflow),
      nodeCount: Array.isArray(workflow.nodes) ? workflow.nodes.filter((n) => !isStickyNote(n)).length : 0,
    };
  }

  for (const [id, entry] of Object.entries(previous.workflows)) {
    if (seenIds.has(id)) continue;
    if (filtered || !prune) {
      // A filtered pull says nothing about workflows outside the filter.
      manifest.workflows[id] = entry;
      continue;
    }
    result.deleted.push({ id, name: entry.name, file: entry.file });
    if (!dryRun) await removeFileAndEmptyParents(dir, entry.file);
  }

  if (!dryRun) await writeManifest(dir, manifest);
  logger?.debug(`pull: ${result.total} remote workflows processed`);
  return result;
}

/**
 * One-line-per-change report.
 * @param {PullResult} result
 * @returns {string}
 */
export function formatPullResult(result) {
  /** @type {string[]} */
  const lines = [];
  for (const wf of result.added) lines.push(`+ ${wf.file}  (${wf.name})`);
  for (const wf of result.updated) lines.push(`~ ${wf.file}  (${wf.name})`);
  for (const wf of result.renamed) lines.push(`> ${wf.from} -> ${wf.to}${wf.contentChanged ? '  (content changed)' : ''}`);
  for (const wf of result.deleted) lines.push(`- ${wf.file}  (${wf.name})`);
  const prefix = result.dryRun ? 'Dry run: would pull' : 'Pulled';
  lines.push(`${prefix} ${result.total} workflow${result.total === 1 ? '' : 's'}: ${result.added.length} added, ${result.updated.length} updated, ${result.renamed.length} renamed, ${result.deleted.length} deleted, ${result.unchanged} unchanged`);
  return lines.join('\n');
}
