import path from 'node:path';
import { loadTargets, selectWorkflow } from './common.js';
import { EXIT } from '../errors.js';
import { writeFileAtomic } from '../util/fs.js';
import { buildDependencyGraph, dependenciesToMermaid, reachable, subgraph } from '../workflow/dependencies.js';

/** @param {number} n @param {string} word */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * @param {import('../workflow/dependencies.js').DependencyGraph} graph
 * @param {{focus?: {key: string, dependencies: string[], dependents: string[]}|null}} [extra]
 */
export function formatDependenciesText(graph, extra = {}) {
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
  /** @param {string} key */
  const label = (key) => {
    const node = byKey.get(key);
    if (!node) return key;
    return node.id ? `${node.name} (${node.id})` : `${node.name} [${node.file}]`;
  };
  /** @param {string|null} node */
  const via = (node) => (node ? ` via node "${node}"` : '');
  /** @type {string[]} */
  const lines = [];

  if (extra.focus) {
    const { key, dependencies, dependents } = extra.focus;
    lines.push(`Workflow ${label(key)}`);
    lines.push(`  depends on (${dependencies.length}):${dependencies.length === 0 ? ' nothing' : ''}`);
    for (const dep of dependencies) lines.push(`    ${label(dep)}`);
    lines.push(`  used by (${dependents.length}):${dependents.length === 0 ? ' nothing' : ''}`);
    for (const dep of dependents) lines.push(`    ${label(dep)}`);
    lines.push('');
  }

  const withRefs = graph.nodes.filter((n) => graph.edges.some((e) => e.from === n.key) || graph.missing.some((m) => m.from === n.key));
  if (withRefs.length > 0) {
    lines.push('References:');
    for (const node of withRefs) {
      lines.push(`  ${label(node.key)}`);
      for (const edge of graph.edges.filter((e) => e.from === node.key)) {
        const what = edge.kind === 'call' ? 'calls' : 'error workflow';
        lines.push(`    ${what} ${label(edge.to)}${via(edge.node)}${edge.disabled ? ' (node disabled)' : ''}`);
      }
      for (const ref of graph.missing.filter((m) => m.from === node.key)) {
        const what = ref.kind === 'call' ? 'calls' : 'error workflow';
        lines.push(`    ${what} ${ref.target}${via(ref.node)} - MISSING`);
      }
    }
    lines.push('');
  }

  if (graph.missing.length > 0) {
    lines.push('Missing workflows:');
    for (const ref of graph.missing) {
      const where = ref.kind === 'call' ? `node "${ref.node}" calls` : 'settings.errorWorkflow points at';
      lines.push(`  ${ref.file}: ${where} workflow ${ref.target}, which is not in the set${ref.disabled ? ' (node disabled)' : ''}`);
    }
    lines.push('');
  }
  if (graph.cycles.length > 0) {
    lines.push('Sub-workflow call cycles:');
    for (const cycle of graph.cycles) lines.push(`  ${[...cycle, cycle[0]].map(label).join(' -> ')}`);
    lines.push('');
  }
  if (graph.dynamic.length > 0) {
    lines.push('References computed by expressions (not checked):');
    for (const ref of graph.dynamic) lines.push(`  ${ref.file}: ${ref.kind === 'call' ? `node "${ref.node}"` : 'settings.errorWorkflow'}`);
    lines.push('');
  }
  if (graph.unused.length > 0) {
    lines.push('Not referenced by any workflow in the set:');
    for (const item of graph.unused) {
      lines.push(`  ${label(item.key)}: ${item.reason === 'never-called' ? 'sub-workflow is never called' : 'error workflow is not used by any workflow'}`);
    }
    lines.push('');
  }
  if (graph.order.length > 0) {
    lines.push('Push order (referenced workflows first):');
    graph.order.forEach((key, i) => lines.push(`  ${String(i + 1).padStart(String(graph.order.length).length)}. ${label(key)}`));
    lines.push('');
  }
  lines.push([
    plural(graph.nodes.length, 'workflow'),
    plural(graph.edges.length + graph.missing.length, 'reference'),
    `${graph.missing.length} missing`,
    plural(graph.cycles.length, 'cycle'),
    `${graph.dynamic.length} dynamic`,
    `${graph.unused.length} unreferenced`,
  ].join(', '));
  return lines.join('\n');
}

/** @type {import('./common.js').Command} */
export const depsCommand = {
  name: 'deps',
  summary: 'Map sub-workflow calls and error workflows between workflow files',
  usage: 'n8n-sync deps [options] [file-or-dir...]',
  options: {
    dir: { type: 'string', short: 'd', placeholder: 'path', description: 'Workflow directory when no paths are given' },
    format: { type: 'string', short: 'f', choices: ['text', 'json', 'mermaid'], default: 'text', description: 'Output format' },
    workflow: { type: 'string', short: 'w', placeholder: 'ref', description: 'Focus on one workflow (id, name or file): what it depends on and what uses it' },
    check: { type: 'boolean', description: 'Exit 1 when a referenced workflow is missing or sub-workflow calls form a cycle' },
    'fail-on-unused': { type: 'boolean', description: 'Like --check, and also fail on sub-workflows and error workflows nobody references' },
    direction: { type: 'string', choices: ['LR', 'TB', 'RL', 'BT'], default: 'LR', description: 'Mermaid layout direction' },
    output: { type: 'string', short: 'o', placeholder: 'file', description: 'Write to a file instead of stdout' },
  },
  examples: [
    'n8n-sync deps',
    'n8n-sync deps workflows --check',
    'n8n-sync deps --workflow "Enrich customer"',
    'n8n-sync deps --format mermaid --output docs/dependencies.mmd',
  ],
  async run(context) {
    const { options, positionals, logger, cwd } = context;
    const workflows = await loadTargets(context, positionals);
    let graph = buildDependencyGraph(workflows);
    let focus = null;
    if (options.workflow) {
      const selected = selectWorkflow(workflows, options.workflow);
      const key = selected.id ?? `file:${selected.display}`;
      focus = { key, dependencies: reachable(graph, key, 'dependencies'), dependents: reachable(graph, key, 'dependents') };
      graph = subgraph(graph, new Set([key, ...focus.dependencies, ...focus.dependents]));
    }

    let text;
    if (options.format === 'json') {
      text = JSON.stringify({
        summary: {
          workflows: graph.nodes.length,
          references: graph.edges.length + graph.missing.length,
          missing: graph.missing.length,
          cycles: graph.cycles.length,
          dynamic: graph.dynamic.length,
          unused: graph.unused.length,
        },
        ...(focus ? { focus } : {}),
        ...graph,
      }, null, 2);
    } else if (options.format === 'mermaid') {
      text = dependenciesToMermaid(graph, { direction: options.direction });
    } else {
      text = formatDependenciesText(graph, { focus });
    }
    if (options.output) {
      await writeFileAtomic(path.resolve(cwd, options.output), `${text}\n`);
      logger.info(`Wrote ${options.output}`);
    } else {
      logger.out(text);
    }

    if (!options.check && !options.failOnUnused) return EXIT.OK;
    const problems = graph.missing.length + graph.cycles.length + (options.failOnUnused ? graph.unused.length : 0);
    if (problems > 0 && options.format !== 'text') {
      logger.error(`deps --check: ${graph.missing.length} missing, ${plural(graph.cycles.length, 'cycle')}${options.failOnUnused ? `, ${graph.unused.length} unreferenced` : ''}`);
    }
    return problems > 0 ? EXIT.FINDINGS : EXIT.OK;
  },
};
