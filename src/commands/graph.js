import path from 'node:path';
import { loadTargets, selectWorkflow } from './common.js';
import { EXIT, UsageError } from '../errors.js';
import { writeFileAtomic } from '../util/fs.js';
import { toDot, toMermaid } from '../workflow/render.js';

/** @type {import('./common.js').Command} */
export const graphCommand = {
  name: 'graph',
  summary: 'Render a workflow as a Mermaid or Graphviz DOT graph',
  usage: 'n8n-sync graph [options] <file | id | name>',
  options: {
    dir: { type: 'string', short: 'd', placeholder: 'path', description: 'Workflow directory used to look up ids and names' },
    format: { type: 'string', short: 'f', choices: ['mermaid', 'dot'], default: 'mermaid', description: 'Output format' },
    direction: { type: 'string', choices: ['LR', 'TB', 'RL', 'BT'], default: 'LR', description: 'Layout direction' },
    types: { type: 'boolean', description: 'Show the node type under each node name' },
    'sticky-notes': { type: 'boolean', description: 'Include sticky notes' },
    markdown: { type: 'boolean', description: 'Wrap Mermaid output in a fenced code block' },
    output: { type: 'string', short: 'o', placeholder: 'file', description: 'Write to a file instead of stdout' },
  },
  examples: [
    'n8n-sync graph workflows/order-intake--12.json',
    'n8n-sync graph "Order intake" --format dot | dot -Tsvg > order-intake.svg',
    'n8n-sync graph 12 --markdown --types',
  ],
  async run(context) {
    const { options, positionals, logger, cwd } = context;
    if (positionals.length !== 1) throw new UsageError('graph takes exactly one workflow (file path, id or name)');
    const ref = positionals[0];
    let selected;
    if (ref.endsWith('.json')) {
      [selected] = await loadTargets(context, [ref]);
    } else {
      selected = selectWorkflow(await loadTargets(context, []), ref);
    }
    const renderOptions = { direction: options.direction, showTypes: options.types === true, includeStickyNotes: options.stickyNotes === true };
    let text = options.format === 'dot' ? toDot(selected.workflow, renderOptions) : toMermaid(selected.workflow, renderOptions);
    if (options.markdown && options.format !== 'dot') text = `\`\`\`mermaid\n${text}\n\`\`\``;
    if (options.output) {
      await writeFileAtomic(path.resolve(cwd, options.output), `${text}\n`);
      logger.info(`Wrote ${options.output}`);
    } else {
      logger.out(text);
    }
    return EXIT.OK;
  },
};
