import path from 'node:path';
import { ApiError, ConflictError, ValidationError } from '../errors.js';
import { removeFileAndEmptyParents, writeFileAtomic } from '../util/fs.js';
import { clone } from '../util/json.js';
import { contentHash, projectName, serializeWorkflow, tagNames } from '../workflow/normalize.js';
import {
  findDuplicateIds, loadWorkflows, readIdMap, readManifest, workflowRelativePath, writeIdMap, writeManifest,
} from '../workflow/store.js';
import { isStickyNote } from '../workflow/graph.js';
import { isValid, validateWorkflow } from '../workflow/validate.js';
import { remapCredentials, remapWorkflowReferences, usesCredentials } from './remap.js';

/**
 * @typedef {object} PushOptions
 * @property {boolean} [dryRun]
 * @property {boolean} [force]                 overwrite remote changes made since the last sync
 * @property {'keep'|'never'|'always'} [activate]
 * @property {string|null} [idMapFile]         enables promotion mode (directory came from another instance)
 * @property {Record<string, string>} [credentialMap]
 * @property {string[]} [only]                 ids, names or file paths to push
 * @property {boolean} [syncTags]              default true
 * @property {'none'|'tag'|'project'} [groupBy] layout used when a created workflow's file is renamed
 */

/**
 * @typedef {object} PushItem
 * @property {string} file
 * @property {string} name
 * @property {string|null} localId
 * @property {string|null} targetId
 * @property {'create'|'update'|'unchanged'|'conflict'|'invalid'} action
 * @property {'activate'|'deactivate'|null} activation
 * @property {boolean} tags                   whether tags will be / were updated
 * @property {string[]} warnings
 * @property {string} [reason]                why the item is a conflict or invalid
 * @property {string} [error]                 API failure while applying
 * @property {boolean} [forced]
 */

/**
 * @typedef {object} PushResult
 * @property {PushItem[]} items
 * @property {boolean} dryRun
 * @property {{create: number, update: number, unchanged: number, conflict: number, failed: number}} summary
 */

/**
 * Decide whether a workflow must be activated or deactivated after a push.
 * @param {'keep'|'never'|'always'} mode
 * @param {boolean} localActive
 * @param {boolean|null} remoteActive  null when the workflow does not exist yet
 * @returns {'activate'|'deactivate'|null}
 */
export function planActivation(mode, localActive, remoteActive) {
  if (mode === 'never') return null;
  const desired = mode === 'always' ? true : localActive;
  const current = remoteActive === null ? false : remoteActive;
  if (desired === current) return null;
  return desired ? 'activate' : 'deactivate';
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function sameSet(a, b) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/**
 * Create or update workflows on an instance from a local directory.
 *
 * The push is planned completely before anything is written. If any workflow
 * is structurally invalid, or any remote workflow changed since the last sync
 * (and `force` is not set), nothing is written at all.
 *
 * @param {object} input
 * @param {import('../api.js').N8nClient} input.client
 * @param {string} input.dir
 * @param {PushOptions} [input.options]
 * @param {import('../util/logger.js').Logger} [input.logger]
 * @returns {Promise<PushResult>}
 */
export async function pushWorkflows({ client, dir, options = {}, logger }) {
  const {
    dryRun = false, force = false, activate = 'keep', idMapFile = null, credentialMap = {}, only = [],
    syncTags = true, groupBy = 'none',
  } = options;
  const promotion = idMapFile !== null;

  const loaded = await loadWorkflows(dir);
  if (loaded.errors.length > 0) {
    throw new ValidationError(
      `Cannot push: ${loaded.errors.length} file(s) are not valid JSON\n${loaded.errors.map((e) => `  ${e.file}: ${e.message}`).join('\n')}`,
      loaded.errors,
    );
  }
  const duplicates = findDuplicateIds(loaded.workflows);
  if (duplicates.length > 0) {
    throw new ValidationError(
      `Cannot push: duplicate workflow ids in ${dir}\n${duplicates.map((d) => `  ${d.id}: ${d.files.join(', ')}`).join('\n')}`,
      duplicates,
    );
  }
  let selected = loaded.workflows;
  if (only.length > 0) {
    selected = selected.filter((wf) => only.includes(wf.id ?? '') || only.includes(String(wf.workflow.name)) || only.includes(wf.file));
    const matched = new Set(selected.flatMap((wf) => [wf.id, String(wf.workflow.name), wf.file]));
    const unknown = only.filter((ref) => !matched.has(ref));
    if (unknown.length > 0) throw new ValidationError(`No local workflow matches: ${unknown.join(', ')}`);
  }

  const manifest = await readManifest(dir);
  const idMap = await readIdMap(idMapFile);
  const credentials = selected.some((wf) => usesCredentials(wf.workflow)) ? await client.listCredentials() : [];
  if (credentials === null) {
    logger?.warn('The instance does not expose GET /credentials; credential ids are pushed unchanged');
  }

  // ---- plan -------------------------------------------------------------
  /** @type {Array<{item: PushItem, prepared: Record<string, any>, local: import('../workflow/store.js').LocalWorkflow, localHash: string, remote: Record<string, any>|null}>} */
  const plan = [];
  for (const local of selected) {
    /** @type {PushItem} */
    const item = {
      file: local.file, name: String(local.workflow.name ?? ''), localId: local.id, targetId: null,
      action: 'unchanged', activation: null, tags: false, warnings: [],
    };
    const prepared = clone(local.workflow);
    const issues = validateWorkflow(prepared);
    if (!isValid(issues)) {
      item.action = 'invalid';
      item.reason = issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`).join('; ');
      plan.push({ item, prepared, local, localHash: '', remote: null });
      continue;
    }
    item.warnings.push(...remapCredentials(prepared, credentials, credentialMap).warnings);
    if (promotion) item.warnings.push(...remapWorkflowReferences(prepared, idMap.workflows).warnings);

    const targetId = promotion ? (local.id ? idMap.workflows[local.id] ?? null : null) : local.id;
    const remote = targetId ? await client.findWorkflow(targetId) : null;
    if (promotion && targetId && !remote) {
      item.warnings.push(`Mapped target workflow ${targetId} no longer exists; it will be created again`);
    }
    const localHash = contentHash(prepared);
    const localActive = prepared.active === true;
    if (!remote) {
      item.action = 'create';
      item.activation = planActivation(activate, localActive, null);
      item.tags = syncTags && tagNames(prepared).length > 0;
    } else {
      item.targetId = String(remote.id);
      const remoteHash = contentHash(remote);
      const baseline = promotion ? idMap.pushed[item.targetId] : (local.id ? manifest.workflows[local.id]?.hash : undefined);
      if (remoteHash === localHash) {
        item.action = 'unchanged';
      } else if (baseline !== undefined && remoteHash !== baseline) {
        if (force) {
          item.action = 'update';
          item.forced = true;
        } else {
          item.action = 'conflict';
          item.reason = 'remote workflow changed since the last sync';
        }
      } else {
        item.action = 'update';
        if (baseline === undefined) item.warnings.push('No sync baseline recorded for this workflow; remote changes cannot be detected');
      }
      item.activation = planActivation(activate, localActive, remote.active === true);
      item.tags = syncTags && Array.isArray(remote.tags) && !sameSet(tagNames(prepared), tagNames(remote));
    }
    plan.push({ item, prepared, local, localHash, remote });
  }

  /** @returns {PushResult} */
  const finish = () => {
    const items = plan.map((p) => p.item);
    const count = (/** @type {PushItem['action']} */ action) => items.filter((i) => i.action === action && !i.error).length;
    return {
      items,
      dryRun,
      summary: {
        create: count('create'), update: count('update'), unchanged: count('unchanged'), conflict: count('conflict'),
        failed: items.filter((i) => i.error).length,
      },
    };
  };

  const invalid = plan.filter((p) => p.item.action === 'invalid');
  if (invalid.length > 0) {
    throw new ValidationError(
      `Cannot push: ${invalid.length} workflow(s) are structurally invalid\n${invalid.map((p) => `  ${p.item.file}: ${p.item.reason}`).join('\n')}`,
      invalid.map((p) => p.item),
    );
  }
  const conflicts = plan.filter((p) => p.item.action === 'conflict');
  if (dryRun) return finish();
  if (conflicts.length > 0) {
    throw new ConflictError(
      `Push aborted: ${conflicts.length} workflow(s) changed on the instance since the last sync. Pull and merge, or re-run with --force to overwrite.\n${conflicts.map((p) => `  ${p.item.name} (${p.item.targetId})`).join('\n')}`,
      conflicts.map((p) => ({ id: String(p.item.targetId), name: p.item.name, reason: String(p.item.reason) })),
    );
  }

  // ---- apply ------------------------------------------------------------
  /** @type {Map<string, string>|null|undefined} */
  let tagIds;
  /** @param {string[]} names */
  const resolveTagIds = async (names) => {
    if (tagIds === undefined) {
      try {
        tagIds = new Map((await client.listTags()).map((tag) => [tag.name, String(tag.id)]));
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        logger?.warn(`Tags cannot be synchronised: ${err.message}`);
        tagIds = null;
      }
    }
    if (tagIds === null || tagIds === undefined) return null;
    /** @type {string[]} */
    const ids = [];
    for (const name of names) {
      let id = tagIds.get(name);
      if (id === undefined) {
        id = String((await client.createTag(name)).id);
        tagIds.set(name, id);
      }
      ids.push(id);
    }
    return ids;
  };

  let manifestDirty = false;
  let idMapDirty = false;
  for (const entry of plan) {
    const { item, prepared, local } = entry;
    try {
      /** @type {Record<string, any>|null} */
      let saved = null;
      if (item.action === 'create') {
        saved = await client.createWorkflow(prepared);
        item.targetId = String(saved?.id ?? '');
        if (item.targetId === '') throw new ApiError('The API did not return an id for the created workflow');
      } else if (item.action === 'update') {
        saved = await client.updateWorkflow(/** @type {string} */ (item.targetId), prepared);
      }
      const targetId = /** @type {string} */ (item.targetId);
      if (item.tags) {
        const ids = await resolveTagIds(tagNames(prepared));
        if (ids === null) item.tags = false;
        else await client.setWorkflowTags(targetId, ids);
      }
      if (item.activation === 'activate') await client.activateWorkflow(targetId);
      else if (item.activation === 'deactivate') await client.deactivateWorkflow(targetId);

      const hash = saved && Array.isArray(saved.nodes) ? contentHash(saved) : entry.localHash;
      if (promotion) {
        if (local.id && idMap.workflows[local.id] !== targetId) {
          idMap.workflows[local.id] = targetId;
          idMapDirty = true;
        }
        if (idMap.pushed[targetId] !== hash) {
          idMap.pushed[targetId] = hash;
          idMapDirty = true;
        }
      } else {
        let file = local.file;
        if (item.action === 'create' && local.id !== targetId) {
          // The instance assigned a new id: carry it in the local file so the
          // next push updates instead of creating a duplicate.
          const rewritten = { ...local.workflow, id: targetId };
          file = path.posix.join(path.posix.dirname(local.file), path.posix.basename(workflowRelativePath(rewritten, 'none')));
          if (groupBy !== 'none' && path.posix.dirname(local.file) === '.') file = workflowRelativePath(rewritten, groupBy);
          await writeFileAtomic(path.join(dir, file), serializeWorkflow(rewritten, { stripVolatile: false, keepPinData: true }));
          if (file !== local.file) await removeFileAndEmptyParents(dir, local.file);
          if (local.id) delete manifest.workflows[local.id];
          item.warnings.push(`Created with new id ${targetId}; local file is now ${file}`);
        }
        const activeNow = item.activation === 'activate' ? true
          : item.activation === 'deactivate' ? false
            : entry.remote ? entry.remote.active === true : false;
        manifest.workflows[targetId] = {
          name: item.name,
          file,
          hash,
          active: activeNow,
          tags: tagNames(prepared),
          project: manifest.workflows[targetId]?.project ?? projectName(prepared),
          nodeCount: prepared.nodes.filter((/** @type {unknown} */ n) => !isStickyNote(n)).length,
        };
        if (!manifest.source) manifest.source = client.http.baseUrl;
        manifestDirty = true;
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      item.error = err.message;
      logger?.error(`${item.name}: ${err.message}`);
    }
  }
  if (manifestDirty) await writeManifest(dir, manifest);
  if (idMapDirty && idMapFile) await writeIdMap(idMapFile, idMap);
  return finish();
}

/**
 * @param {PushResult} result
 * @returns {string}
 */
export function formatPushResult(result) {
  const symbols = { create: '+', update: '~', unchanged: '=', conflict: '!', invalid: 'x' };
  /** @type {string[]} */
  const lines = [];
  for (const item of result.items) {
    if (item.action === 'unchanged' && !item.activation && !item.tags && item.warnings.length === 0 && !item.error) continue;
    const extras = [
      item.forced ? 'forced' : '',
      item.activation ?? '',
      item.tags ? 'tags' : '',
      item.reason ?? '',
    ].filter(Boolean);
    const target = item.targetId ? ` -> ${item.targetId}` : '';
    lines.push(`${item.error ? 'E' : symbols[item.action]} ${item.action.padEnd(9)} ${item.name}${target}${extras.length ? `  [${extras.join(', ')}]` : ''}`);
    for (const warning of item.warnings) lines.push(`    warning: ${warning}`);
    if (item.error) lines.push(`    error: ${item.error}`);
  }
  const s = result.summary;
  const prefix = result.dryRun ? 'Dry run: would push' : 'Pushed';
  lines.push(`${prefix}: ${s.create} created, ${s.update} updated, ${s.unchanged} unchanged${s.conflict ? `, ${s.conflict} conflict${s.conflict === 1 ? '' : 's'}` : ''}${s.failed ? `, ${s.failed} failed` : ''}`);
  return lines.join('\n');
}
