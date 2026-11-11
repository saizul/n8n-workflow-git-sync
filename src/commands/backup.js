import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { connect, loadConfig } from './common.js';
import { createSnapshot, listSnapshots, pruneSnapshots, resolveSnapshot, verifySnapshot } from '../backup/snapshot.js';
import { EXIT, UsageError } from '../errors.js';
import { isDirectory, listFiles } from '../util/fs.js';
import { serializeWorkflow } from '../workflow/normalize.js';
import { workflowRelativePath } from '../workflow/store.js';

/**
 * Collect snapshot input from a live instance. Backups keep volatile fields
 * and pinned data so that a snapshot is as complete as the API allows.
 * @param {import('../api.js').N8nClient} client
 * @returns {Promise<Array<{path: string, content: string}>>}
 */
export async function collectRemoteFiles(client) {
  const remote = await client.listWorkflows();
  /** @type {Array<{path: string, content: string}>} */
  const files = [];
  const seen = new Set();
  for (const workflow of remote) {
    let file = workflowRelativePath(workflow, 'none');
    for (let n = 2; seen.has(file); n += 1) file = file.replace(/(-\d+)?\.json$/, `-${n}.json`);
    seen.add(file);
    files.push({ path: file, content: serializeWorkflow(workflow, { stripVolatile: false, keepPinData: true }) });
  }
  return files;
}

/** @type {import('./common.js').Command} */
export const backupCommand = {
  name: 'backup',
  summary: 'Create a timestamped snapshot with sha256 checksums, and prune old ones',
  usage: 'n8n-sync backup [options]',
  options: {
    'backup-dir': { type: 'string', short: 'b', placeholder: 'path', description: 'Where snapshots are kept [default: backups]' },
    'from-dir': { type: 'string', placeholder: 'path', description: 'Snapshot a local directory instead of the instance' },
    label: { type: 'string', short: 'l', placeholder: 'text', description: 'Label appended to the snapshot name' },
    keep: { type: 'number', placeholder: 'n', description: 'After the backup, keep only the newest n snapshots' },
    'max-age-days': { type: 'number', placeholder: 'days', description: 'After the backup, delete snapshots older than this' },
    'prune-only': { type: 'boolean', description: 'Do not create a snapshot, only apply the retention policy' },
    list: { type: 'boolean', description: 'List existing snapshots and exit' },
    verify: { type: 'string', placeholder: 'snapshot', description: 'Verify the checksums of a snapshot ("latest", a name or a path) and exit' },
    'dry-run': { type: 'boolean', short: 'n', description: 'Show what would be created and pruned' },
    json: { type: 'boolean', description: 'Print the result as JSON' },
  },
  examples: [
    'n8n-sync backup --keep 14',
    'n8n-sync backup --env prod --label pre-upgrade',
    'n8n-sync backup --list',
    'n8n-sync backup --verify latest',
  ],
  async run(context) {
    const { options, logger, cwd, now } = context;
    const offline = options.list || options.verify || options.pruneOnly || options.fromDir;
    const { config, client } = offline
      ? { config: await loadConfig(context), client: null }
      : await connect(context);
    const backupDir = config.backup.dir;

    if (options.list) {
      const snapshots = await listSnapshots(backupDir);
      if (options.json) logger.out(JSON.stringify(snapshots, null, 2));
      else if (snapshots.length === 0) logger.out(`No snapshots in ${backupDir}`);
      else for (const s of snapshots) logger.out(`${s.name}  ${s.createdAt.toISOString()}${s.label ? `  ${s.label}` : ''}`);
      return EXIT.OK;
    }
    if (options.verify) {
      const dir = await resolveSnapshot(backupDir, options.verify);
      const result = await verifySnapshot(dir);
      if (options.json) {
        logger.out(JSON.stringify({ dir, ok: result.ok, checked: result.checked, missing: result.missing, mismatched: result.mismatched, extra: result.extra }, null, 2));
      } else {
        for (const file of result.missing) logger.out(`missing     ${file}`);
        for (const file of result.mismatched) logger.out(`mismatched  ${file}`);
        for (const file of result.extra) logger.out(`unexpected  ${file}`);
        logger.out(result.ok ? `OK: ${result.checked} files verified in ${path.basename(dir)}` : `FAILED: ${path.basename(dir)} does not match its manifest`);
      }
      return result.ok ? EXIT.OK : EXIT.FINDINGS;
    }

    /** @type {Record<string, any>} */
    const output = { snapshot: null, files: 0, pruned: [], dryRun: options.dryRun === true };
    /** @type {string[]} */
    const lines = [];
    if (!options.pruneOnly) {
      /** @type {Array<{path: string, content: string}>} */
      let files;
      let source;
      if (options.fromDir) {
        const from = path.resolve(cwd, options.fromDir);
        if (!(await isDirectory(from))) throw new UsageError(`--from-dir ${options.fromDir} is not a directory`);
        files = [];
        for (const rel of await listFiles(from, (name) => name.endsWith('.json'))) {
          files.push({ path: rel, content: await readFile(path.join(from, rel), 'utf8') });
        }
        source = `dir:${options.fromDir}`;
      } else {
        files = await collectRemoteFiles(/** @type {import('../api.js').N8nClient} */ (client));
        source = config.baseUrl;
      }
      output.files = files.length;
      if (options.dryRun) {
        lines.push(`Would snapshot ${files.length} file${files.length === 1 ? '' : 's'} from ${source} into ${backupDir}`);
      } else {
        const snapshot = await createSnapshot({ backupDir, files, source, now: now(), label: options.label });
        output.snapshot = snapshot.name;
        lines.push(`Created snapshot ${snapshot.name} (${files.length} file${files.length === 1 ? '' : 's'}) in ${backupDir}`);
      }
    }
    const { keep, maxAgeDays } = config.backup;
    if (keep > 0 || maxAgeDays > 0) {
      const pruned = await pruneSnapshots(backupDir, { keep, maxAgeDays, now: now(), dryRun: options.dryRun === true });
      output.pruned = pruned.map((s) => s.name);
      for (const s of pruned) lines.push(`${options.dryRun ? 'Would prune' : 'Pruned'} ${s.name}`);
    } else if (options.pruneOnly) {
      throw new UsageError('--prune-only needs a retention policy: --keep and/or --max-age-days (or backup.keep in the config file)');
    }
    logger.out(options.json ? JSON.stringify(output, null, 2) : lines.join('\n'));
    return EXIT.OK;
  },
};
