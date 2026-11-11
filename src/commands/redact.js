import path from 'node:path';
import { loadConfig, loadTargets } from './common.js';
import { EXIT, UsageError } from '../errors.js';
import { redactWorkflow } from '../secrets/redact.js';
import { writeFileAtomic } from '../util/fs.js';
import { stableStringify } from '../util/json.js';
import { WORKFLOW_KEY_PRIORITY } from '../workflow/normalize.js';

/** @type {import('./common.js').Command} */
export const redactCommand = {
  name: 'redact',
  summary: 'Strip or mask hard-coded secrets in workflow files',
  usage: 'n8n-sync redact [options] [file-or-dir...]',
  options: {
    dir: { type: 'string', short: 'd', placeholder: 'path', description: 'Workflow directory when no paths are given' },
    mode: { type: 'string', choices: ['mask', 'strip'], default: 'mask', description: 'mask: replace the secret with a marker; strip: empty the whole value' },
    marker: { type: 'string', placeholder: 'text', description: 'Replacement text for mask mode' },
    'min-confidence': { type: 'string', choices: ['low', 'medium', 'high'], default: 'low', description: 'Ignore detections below this confidence' },
    write: { type: 'boolean', short: 'w', description: 'Rewrite the files in place' },
    'out-dir': { type: 'string', short: 'o', placeholder: 'path', description: 'Write redacted copies to this directory' },
    check: { type: 'boolean', description: 'Change nothing; exit with 1 when secrets are present' },
    json: { type: 'boolean', description: 'Print the list of redactions as JSON' },
  },
  examples: [
    'n8n-sync redact --check',
    'n8n-sync redact --write',
    'n8n-sync redact workflows/ --mode strip --out-dir public-export/',
    'n8n-sync redact workflows/billing--7.json > billing.redacted.json',
  ],
  async run(context) {
    const { options, positionals, logger, cwd } = context;
    if (options.write && options.outDir) throw new UsageError('Use either --write or --out-dir, not both');
    const config = await loadConfig(context);
    const workflows = await loadTargets(context, positionals.length > 0 ? positionals : [config.dir]);
    const ruleSetting = config.lint?.rules?.['no-hardcoded-secrets'];
    const detector = Array.isArray(ruleSetting) ? ruleSetting[1] : ruleSetting && typeof ruleSetting === 'object' ? ruleSetting.options : undefined;
    /** @type {Array<{file: string, changes: import('../secrets/redact.js').RedactionResult['changes']}>} */
    const report = [];
    /** @type {string[]} */
    const outputs = [];
    let total = 0;
    for (const wf of workflows) {
      const result = redactWorkflow(wf.workflow, {
        mode: options.mode,
        marker: options.marker,
        minConfidence: options.minConfidence,
        detector,
      });
      total += result.changes.length;
      if (result.changes.length > 0) report.push({ file: wf.display, changes: result.changes });
      const text = stableStringify(result.workflow, { priority: WORKFLOW_KEY_PRIORITY });
      if (options.check) continue;
      if (options.write) {
        if (result.changes.length > 0) await writeFileAtomic(wf.absolute, text);
      } else if (options.outDir) {
        await writeFileAtomic(path.resolve(cwd, options.outDir, wf.file), text);
      } else {
        outputs.push(text.trimEnd());
      }
    }
    const toStdout = !options.check && !options.write && !options.outDir;
    if (toStdout && !options.json) {
      if (workflows.length > 1) throw new UsageError('Printing to stdout works for a single workflow; use --write, --out-dir or --check for several');
      for (const text of outputs) logger.out(text);
    }
    const summary = `${total} secret${total === 1 ? '' : 's'} ${options.check ? 'found' : 'redacted'} in ${report.length} of ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`;
    if (options.json) {
      logger.out(JSON.stringify({ summary: { secrets: total, files: workflows.length, mode: options.mode, changed: !options.check }, files: report }, null, 2));
    } else {
      const print = toStdout ? logger.info : logger.out;
      for (const entry of report) {
        print(entry.file);
        for (const change of entry.changes) print(`  ${change.action.padEnd(6)} ${change.kind.padEnd(18)} ${change.node ? `[${change.node}] ` : ''}${change.path}`);
      }
      print(summary);
    }
    return options.check && total > 0 ? EXIT.FINDINGS : EXIT.OK;
  },
};
