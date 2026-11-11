import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, loadConfig } from './common.js';
import { readSnapshotFiles, resolveSnapshot, verifySnapshot } from '../backup/snapshot.js';
import { CliError, EXIT } from '../errors.js';
import { formatPushResult, pushWorkflows } from '../sync/push.js';
import { writeFileAtomic } from '../util/fs.js';
import { MANIFEST_FILE } from '../workflow/store.js';

/** @type {import('./common.js').Command} */
export const restoreCommand = {
  name: 'restore',
  summary: 'Restore a snapshot into a directory or back onto an instance',
  usage: 'n8n-sync restore [options] [snapshot]',
  options: {
    'backup-dir': { type: 'string', short: 'b', placeholder: 'path', description: 'Where snapshots are kept [default: backups]' },
    'to-dir': { type: 'string', short: 't', placeholder: 'path', description: 'Extract the snapshot into this directory instead of pushing it' },
    activate: { type: 'string', choices: ['keep', 'never', 'always'], description: 'Activation handling when restoring to an instance [default: never]' },
    'id-map': { type: 'string', placeholder: 'file', description: 'Id mapping file when restoring onto a different instance' },
    verify: { type: 'boolean', default: true, description: 'Verify checksums first (--no-verify to skip)' },
    'dry-run': { type: 'boolean', short: 'n', description: 'Show what would be restored' },
    json: { type: 'boolean', description: 'Print the result as JSON' },
  },
  examples: [
    'n8n-sync restore latest --to-dir restored/',
    'n8n-sync restore 20260131T020000Z --dry-run',
    'n8n-sync restore backups/20260131T020000Z-pre-upgrade --env staging --id-map env/staging.idmap.json',
  ],
  async run(context) {
    const { options, positionals, logger, cwd } = context;
    const ref = positionals[0] ?? 'latest';
    const toDir = options.toDir ? path.resolve(cwd, options.toDir) : null;
    const { config, client } = toDir ? { config: await loadConfig(context), client: null } : await connect(context);
    const snapshotDir = await resolveSnapshot(config.backup.dir, ref);
    const name = path.basename(snapshotDir);

    if (options.verify !== false) {
      const check = await verifySnapshot(snapshotDir);
      if (!check.ok) {
        const detail = [
          ...check.missing.map((f) => `missing ${f}`),
          ...check.mismatched.map((f) => `checksum mismatch ${f}`),
          ...check.extra.map((f) => `unexpected ${f}`),
        ];
        throw new CliError(`Snapshot ${name} failed verification; nothing was restored:\n  ${detail.join('\n  ')}`, EXIT.FINDINGS);
      }
      logger.info(`Verified ${check.checked} file${check.checked === 1 ? '' : 's'} in ${name}`);
    }
    const files = await readSnapshotFiles(snapshotDir);

    if (toDir) {
      if (!options.dryRun) {
        for (const file of files) await writeFileAtomic(path.join(toDir, file.path), file.content);
      }
      const message = `${options.dryRun ? 'Would restore' : 'Restored'} ${files.length} file${files.length === 1 ? '' : 's'} from ${name} to ${options.toDir}`;
      logger.out(options.json ? JSON.stringify({ snapshot: name, files: files.map((f) => f.path), target: options.toDir, dryRun: options.dryRun === true }, null, 2) : message);
      return EXIT.OK;
    }

    // Restore onto an instance: stage the snapshot in a scratch directory and
    // push it. The sync manifest is left out so that the snapshot always wins.
    const staging = await mkdtemp(path.join(os.tmpdir(), 'n8n-sync-restore-'));
    try {
      for (const file of files) {
        if (path.basename(file.path) === MANIFEST_FILE) continue;
        await writeFileAtomic(path.join(staging, file.path), file.content);
      }
      const result = await pushWorkflows({
        client: /** @type {import('../api.js').N8nClient} */ (client),
        dir: staging,
        logger,
        options: {
          dryRun: options.dryRun === true,
          force: true,
          activate: options.activate ?? 'never',
          idMapFile: config.idMap,
          credentialMap: config.credentialMap,
          syncTags: true,
        },
      });
      logger.out(options.json ? JSON.stringify({ snapshot: name, ...result }, null, 2) : `Restoring ${name}\n${formatPushResult(result)}`);
      return result.summary.failed > 0 ? EXIT.API : EXIT.OK;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  },
};
