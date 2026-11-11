import { DIR_OPTION, connect } from './common.js';
import { formatPushResult, pushWorkflows } from '../sync/push.js';
import { EXIT } from '../errors.js';

/** @type {import('./common.js').Command} */
export const pushCommand = {
  name: 'push',
  summary: 'Create or update workflows on an instance from the workflow directory',
  usage: 'n8n-sync push [options] [workflow...]',
  options: {
    ...DIR_OPTION,
    'dry-run': { type: 'boolean', short: 'n', description: 'Plan the push and print it without writing to the instance' },
    force: { type: 'boolean', short: 'f', description: 'Overwrite workflows that changed remotely since the last sync' },
    activate: { type: 'string', choices: ['keep', 'never', 'always'], description: 'keep: mirror the "active" flag of each file; never: leave activation alone; always: activate everything' },
    'id-map': { type: 'string', placeholder: 'file', description: 'Id mapping file; enables promotion to a different instance' },
    'credential-map': { type: 'list', placeholder: 'from=to', description: 'Rename a credential on the way (repeatable)' },
    tags: { type: 'boolean', default: true, description: 'Synchronise tags by name (--no-tags to skip)' },
    json: { type: 'boolean', description: 'Print the result as JSON' },
  },
  examples: [
    'n8n-sync push --dry-run',
    'n8n-sync push --env prod --id-map env/prod.idmap.json --activate never',
    'n8n-sync push "Order intake" --force',
  ],
  async run(context) {
    const { config, client } = await connect(context);
    const { options, logger, positionals } = context;
    /** @type {Record<string, string>} */
    const credentialMap = { ...config.credentialMap };
    for (const pair of options.credentialMap ?? []) {
      const eq = String(pair).indexOf('=');
      if (eq <= 0) {
        logger.warn(`Ignoring malformed --credential-map entry "${pair}" (expected from=to)`);
        continue;
      }
      credentialMap[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    const result = await pushWorkflows({
      client,
      dir: config.dir,
      logger,
      options: {
        dryRun: options.dryRun === true,
        force: options.force === true,
        activate: config.push.activate,
        idMapFile: config.idMap,
        credentialMap,
        only: positionals,
        syncTags: options.tags !== false,
        groupBy: config.pull.groupBy,
      },
    });
    logger.out(options.json ? JSON.stringify(result, null, 2) : formatPushResult(result));
    if (result.summary.failed > 0) return EXIT.API;
    if (result.summary.conflict > 0) return EXIT.CONFLICT;
    return EXIT.OK;
  },
};
