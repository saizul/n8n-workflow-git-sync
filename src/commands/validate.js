import { loadTargets } from './common.js';
import { EXIT } from '../errors.js';
import { findDuplicateIds } from '../workflow/store.js';
import { validateWorkflow } from '../workflow/validate.js';

/** @type {import('./common.js').Command} */
export const validateCommand = {
  name: 'validate',
  summary: 'Check that workflow files are structurally sound',
  usage: 'n8n-sync validate [options] [file-or-dir...]',
  options: {
    dir: { type: 'string', short: 'd', placeholder: 'path', description: 'Workflow directory when no paths are given' },
    strict: { type: 'boolean', description: 'Treat warnings as errors' },
    json: { type: 'boolean', description: 'Print the result as JSON' },
  },
  examples: ['n8n-sync validate', 'n8n-sync validate workflows/order-intake--12.json --strict'],
  async run(context) {
    const { options, positionals, logger } = context;
    const workflows = await loadTargets(context, positionals);
    /** @type {Array<{file: string, name: string, issues: import('../workflow/validate.js').ValidationIssue[]}>} */
    const results = [];
    let errors = 0;
    let warnings = 0;
    for (const wf of workflows) {
      const issues = validateWorkflow(wf.workflow);
      errors += issues.filter((i) => i.severity === 'error').length;
      warnings += issues.filter((i) => i.severity === 'warning').length;
      results.push({ file: wf.display, name: String(wf.workflow.name ?? ''), issues });
    }
    const duplicates = findDuplicateIds(workflows);
    for (const dup of duplicates) {
      errors += 1;
      results.push({
        file: dup.files[0],
        name: '',
        issues: [{ code: 'workflow-id-duplicate', severity: 'error', message: `Workflow id ${dup.id} is used by ${dup.files.join(', ')}`, path: '$.id' }],
      });
    }
    if (options.json) {
      logger.out(JSON.stringify({ summary: { files: workflows.length, errors, warnings }, results: results.filter((r) => r.issues.length > 0) }, null, 2));
    } else {
      const lines = [];
      for (const result of results) {
        if (result.issues.length === 0) continue;
        lines.push(result.file);
        for (const issue of result.issues) lines.push(`  ${issue.severity.padEnd(7)} ${issue.code.padEnd(26)} ${issue.message} (${issue.path})`);
        lines.push('');
      }
      lines.push(`${workflows.length} file${workflows.length === 1 ? '' : 's'} checked: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
      logger.out(lines.join('\n'));
    }
    return errors > 0 || (options.strict && warnings > 0) ? EXIT.FINDINGS : EXIT.OK;
  },
};
