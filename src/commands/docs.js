import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadTargets } from './common.js';
import { EXIT } from '../errors.js';
import { generateCatalogue } from '../docs/catalogue.js';
import { pathExists, writeFileAtomic } from '../util/fs.js';

/** @type {import('./common.js').Command} */
export const docsCommand = {
  name: 'docs',
  summary: 'Generate a Markdown catalogue of the workflows',
  usage: 'n8n-sync docs [options] [file-or-dir...]',
  options: {
    dir: { type: 'string', short: 'd', placeholder: 'path', description: 'Workflow directory when no paths are given' },
    output: { type: 'string', short: 'o', placeholder: 'file', description: 'Write to a file instead of stdout' },
    title: { type: 'string', placeholder: 'text', description: 'Document title' },
    graphs: { type: 'boolean', description: 'Embed a Mermaid graph per workflow' },
    check: { type: 'boolean', description: 'With --output: exit with 1 when the file is out of date instead of writing it' },
  },
  examples: [
    'n8n-sync docs --output docs/WORKFLOWS.md',
    'n8n-sync docs --graphs --title "Automation catalogue" > CATALOGUE.md',
    'n8n-sync docs --output docs/WORKFLOWS.md --check',
  ],
  async run(context) {
    const { options, positionals, logger, cwd } = context;
    const workflows = await loadTargets(context, positionals);
    const markdown = generateCatalogue(
      workflows.map((wf) => ({ workflow: wf.workflow, file: wf.display })),
      { title: options.title, includeGraphs: options.graphs === true },
    );
    const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
    if (!options.output) {
      logger.out(text.trimEnd());
      return EXIT.OK;
    }
    const target = path.resolve(cwd, options.output);
    if (options.check) {
      const current = (await pathExists(target)) ? await readFile(target, 'utf8') : null;
      if (current === text) {
        logger.out(`${options.output} is up to date`);
        return EXIT.OK;
      }
      logger.out(`${options.output} is out of date; run "n8n-sync docs --output ${options.output}"`);
      return EXIT.FINDINGS;
    }
    await writeFileAtomic(target, text);
    logger.out(`Wrote ${options.output} (${workflows.length} workflow${workflows.length === 1 ? '' : 's'})`);
    return EXIT.OK;
  },
};
