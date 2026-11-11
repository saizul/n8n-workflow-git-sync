import { DIR_OPTION, connect, loadTargets } from './common.js';
import { diffWorkflowSets } from '../diff/semantic.js';
import { formatSetDiffJson, formatSetDiffText } from '../diff/format.js';
import { EXIT, UsageError } from '../errors.js';
import { normalizeWorkflow } from '../workflow/normalize.js';

/** @type {import('./common.js').Command} */
export const diffCommand = {
  name: 'diff',
  summary: 'Semantic diff between local files and an instance, or between two directories',
  usage: 'n8n-sync diff [options] [<before-dir> <after-dir>]',
  options: {
    ...DIR_OPTION,
    format: { type: 'string', choices: ['text', 'json'], default: 'text', description: 'Output format' },
    'match-by': { type: 'string', choices: ['id', 'name'], default: 'id', description: 'How workflows are paired' },
    position: { type: 'boolean', description: 'Report node position changes (ignored by default)' },
    'ignore-credential-ids': { type: 'boolean', description: 'Compare credentials by name only (useful across environments)' },
    'ignore-active': { type: 'boolean', description: 'Do not report activation differences' },
    'ignore-tags': { type: 'boolean', description: 'Do not report tag differences' },
    'exit-code': { type: 'boolean', default: true, description: 'Exit with 1 when differences are found (--no-exit-code to always exit 0)' },
  },
  examples: [
    'n8n-sync diff',
    'n8n-sync diff --env prod --match-by name --ignore-credential-ids',
    'n8n-sync diff exports/dev exports/prod --format json',
  ],
  async run(context) {
    const { options, positionals, logger } = context;
    if (positionals.length !== 0 && positionals.length !== 2) {
      throw new UsageError('diff takes either no arguments (local vs remote) or two paths (before, after)');
    }
    const normalize = (/** @type {Record<string, any>} */ wf) => normalizeWorkflow(wf, { stripVolatile: true });
    /** @type {Record<string, any>[]} */
    let before;
    /** @type {Record<string, any>[]} */
    let after;
    let beforeLabel;
    let afterLabel;
    if (positionals.length === 2) {
      before = (await loadTargets(context, [positionals[0]])).map((wf) => normalize(wf.workflow));
      after = (await loadTargets(context, [positionals[1]])).map((wf) => normalize(wf.workflow));
      [beforeLabel, afterLabel] = positionals;
    } else {
      const { config, client } = await connect(context);
      const remote = await client.listWorkflows();
      before = remote.filter((wf) => config.pull.includeArchived || wf.isArchived !== true).map(normalize);
      after = (await loadTargets(context, [config.dir])).map((wf) => normalize(wf.workflow));
      beforeLabel = `remote (${config.baseUrl})`;
      afterLabel = `local (${config.dir})`;
    }
    const set = diffWorkflowSets(before, after, {
      matchBy: options.matchBy,
      includePosition: options.position === true,
      includeActive: options.ignoreActive !== true,
      includeTags: options.ignoreTags !== true,
      ignoreCredentialIds: options.ignoreCredentialIds === true,
    });
    logger.out(options.format === 'json' ? formatSetDiffJson(set) : formatSetDiffText(set, { beforeLabel, afterLabel }));
    return set.hasChanges && options.exitCode !== false ? EXIT.FINDINGS : EXIT.OK;
  },
};
