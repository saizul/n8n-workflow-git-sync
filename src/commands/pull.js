import { DIR_OPTION, connect } from './common.js';
import { formatPullResult, pullWorkflows } from '../sync/pull.js';
import { EXIT } from '../errors.js';

/** @type {import('./common.js').Command} */
export const pullCommand = {
  name: 'pull',
  summary: 'Export all workflows from an instance into the workflow directory',
  usage: 'n8n-sync pull [options]',
  options: {
    ...DIR_OPTION,
    'strip-volatile': { type: 'boolean', description: 'Remove updatedAt, versionId, staticData and similar fields (default: on; --no-strip-volatile to keep them)' },
    'keep-pin-data': { type: 'boolean', description: 'Keep pinned test data in the exported files' },
    'group-by': { type: 'string', choices: ['none', 'tag', 'project'], description: 'Put files in a folder per first tag or per project' },
    prune: { type: 'boolean', default: true, description: 'Delete local files of workflows that no longer exist remotely (--no-prune to keep them)' },
    'include-archived': { type: 'boolean', description: 'Also export archived workflows' },
    tag: { type: 'list', placeholder: 'name', description: 'Only workflows with this tag (repeatable)' },
    'active-only': { type: 'boolean', description: 'Only active workflows' },
    'page-size': { type: 'number', placeholder: 'n', description: 'Page size for listing' },
    'dry-run': { type: 'boolean', short: 'n', description: 'Show what would change without writing' },
    json: { type: 'boolean', description: 'Print the result as JSON' },
    'fail-on-change': { type: 'boolean', description: 'Exit with code 1 when anything changed (drift detection in CI)' },
  },
  examples: [
    'n8n-sync pull',
    'n8n-sync pull --env prod --group-by tag',
    'n8n-sync pull --dry-run --fail-on-change',
  ],
  async run(context) {
    const { config, client } = await connect(context);
    const { options, logger } = context;
    const result = await pullWorkflows({
      client,
      dir: config.dir,
      logger,
      options: {
        stripVolatile: config.pull.stripVolatile,
        keepPinData: config.pull.keepPinData,
        groupBy: config.pull.groupBy,
        includeArchived: config.pull.includeArchived,
        prune: options.prune !== false,
        dryRun: options.dryRun === true,
        tags: options.tag ?? [],
        activeOnly: options.activeOnly === true,
      },
    });
    logger.out(options.json ? JSON.stringify(result, null, 2) : formatPullResult(result));
    const changed = result.added.length + result.updated.length + result.renamed.length + result.deleted.length;
    return options.failOnChange && changed > 0 ? EXIT.FINDINGS : EXIT.OK;
  },
};
