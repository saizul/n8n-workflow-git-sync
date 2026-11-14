import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  buildDependencyGraph, dependenciesToMermaid, extractReferences, reachable, subgraph, workflowIdFromUrl,
} from '../src/workflow/dependencies.js';
import { writeFileAtomic } from '../src/util/fs.js';
import { stableStringify } from '../src/util/json.js';
import { cli } from './helpers/cli.js';
import { connect, node, tempDir } from './helpers/fixtures.js';

/**
 * A workflow with a single trigger and optional Execute Workflow calls.
 * @param {string} id
 * @param {string} name
 * @param {{trigger?: string, calls?: Array<unknown>, errorWorkflow?: string, extraNodes?: any[]}} [spec]
 */
function wf(id, name, spec = {}) {
  const trigger = node('Start', spec.trigger ?? 'scheduleTrigger');
  const callers = (spec.calls ?? []).map((ref, i) => node(`Call ${i + 1}`, 'executeWorkflow', { parameters: { workflowId: ref } }));
  const nodes = [trigger, ...callers, ...(spec.extraNodes ?? [])];
  return {
    id,
    name,
    nodes,
    connections: connect(callers.map((c) => ['Start', c.name])),
    settings: spec.errorWorkflow ? { errorWorkflow: spec.errorWorkflow } : {},
  };
}

/** @param {Record<string, any>} workflow */
const local = (workflow) => ({ id: workflow.id ?? null, file: `${workflow.name}.json`, workflow });

test('extractReferences reads plain ids, resource locators, URLs and the error workflow', () => {
  const workflow = wf('1', 'Main', {
    errorWorkflow: '900',
    calls: [
      '10',
      { __rl: true, mode: 'list', value: '11', cachedResultName: 'Eleven' },
      { __rl: true, mode: 'url', value: 'https://n8n.example.com/workflow/12?x=1' },
      '={{ $json.target }}',
      '',
      42,
    ],
  });
  const refs = extractReferences(workflow);
  assert.deepEqual(refs.map((r) => [r.kind, r.target, r.dynamic]), [
    ['error-workflow', '900', false],
    ['call', '10', false],
    ['call', '11', false],
    ['call', '12', false],
    ['call', null, true],
    ['call', '42', false],
  ]);
  assert.equal(refs[1].node, 'Call 1');
});

test('extractReferences ignores non-database sources and flags disabled callers', () => {
  const workflow = wf('1', 'Main', {
    extraNodes: [
      node('From file', 'executeWorkflow', { parameters: { source: 'localFile', workflowPath: '/tmp/x.json' } }),
      node('From param', 'executeWorkflow', { parameters: { source: 'parameter', workflowJson: '{}' } }),
      node('Explicit db', 'executeWorkflow', { parameters: { source: 'database', workflowId: '5' }, disabled: true }),
      node('Tool', '@n8n/n8n-nodes-langchain.toolWorkflow', { parameters: { workflowId: { __rl: true, mode: 'id', value: '6' } } }),
    ],
  });
  const refs = extractReferences(workflow);
  assert.deepEqual(refs.map((r) => [r.node, r.target, r.disabled]), [['Explicit db', '5', true], ['Tool', '6', false]]);
});

test('workflowIdFromUrl', () => {
  assert.equal(workflowIdFromUrl('https://n8n.example.com/workflow/abc123'), 'abc123');
  assert.equal(workflowIdFromUrl('/workflow/7/executions'), '7');
  assert.equal(workflowIdFromUrl('https://n8n.example.com/home'), null);
});

test('buildDependencyGraph: edges, missing targets, dynamic refs and push order', () => {
  const graph = buildDependencyGraph([
    local(wf('1', 'Order intake', { calls: ['2', '404', '={{ $json.id }}'], errorWorkflow: '9' })),
    local(wf('2', 'Enrich customer', { trigger: 'executeWorkflowTrigger', calls: ['3'] })),
    local(wf('3', 'Normalise address', { trigger: 'executeWorkflowTrigger' })),
    local(wf('9', 'Error notifier', { trigger: 'errorTrigger' })),
  ]);
  assert.deepEqual(graph.nodes.map((n) => n.key), ['2', '9', '3', '1']);
  assert.deepEqual(graph.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort(), ['1>2:call', '1>9:error-workflow', '2>3:call']);
  assert.deepEqual(graph.missing.map((m) => [m.from, m.target, m.node]), [['1', '404', 'Call 2']]);
  assert.equal(graph.dynamic.length, 1);
  assert.deepEqual(graph.cycles, []);
  assert.deepEqual(graph.unused, []);
  const position = (key) => graph.order.indexOf(key);
  assert.equal(graph.order.length, 4);
  assert.ok(position('3') < position('2'));
  assert.ok(position('2') < position('1'));
  assert.ok(position('9') < position('1'));
});

test('buildDependencyGraph detects call cycles, including self-calls, but not error-workflow loops', () => {
  const graph = buildDependencyGraph([
    local(wf('1', 'A', { trigger: 'executeWorkflowTrigger', calls: ['2'] })),
    local(wf('2', 'B', { trigger: 'executeWorkflowTrigger', calls: ['1'] })),
    local(wf('3', 'Recursive', { calls: ['3'] })),
    local(wf('4', 'E1', { trigger: 'errorTrigger', errorWorkflow: '5' })),
    local(wf('5', 'E2', { trigger: 'errorTrigger', errorWorkflow: '4' })),
  ]);
  assert.deepEqual(graph.cycles, [['1', '2'], ['3']]);
  assert.equal(graph.order.length, 5);
  assert.deepEqual(new Set(graph.order), new Set(['1', '2', '3', '4', '5']));
});

test('buildDependencyGraph reports sub-workflows and error workflows nobody references', () => {
  const graph = buildDependencyGraph([
    local(wf('1', 'Main', { calls: ['2'] })),
    local(wf('2', 'Used helper', { trigger: 'executeWorkflowTrigger' })),
    local(wf('3', 'Orphan helper', { trigger: 'executeWorkflowTrigger' })),
    local(wf('4', 'Lonely error handler', { trigger: 'errorTrigger' })),
    local(wf('5', 'Scheduled', {})),
  ]);
  assert.deepEqual(graph.unused, [
    { key: '4', reason: 'never-used-as-error-workflow' },
    { key: '3', reason: 'never-called' },
  ]);
});

test('workflows without an id are keyed by file and cannot be referenced', () => {
  const noId = wf('x', 'Draft', { calls: ['1'] });
  delete noId.id;
  const graph = buildDependencyGraph([{ id: null, file: 'draft.json', workflow: noId }, local(wf('1', 'Target', { trigger: 'executeWorkflowTrigger' }))]);
  assert.ok(graph.nodes.some((n) => n.key === 'file:draft.json'));
  assert.deepEqual(graph.edges.map((e) => [e.from, e.to]), [['file:draft.json', '1']]);
});

test('reachable follows dependencies and dependents transitively; subgraph restricts the view', () => {
  const graph = buildDependencyGraph([
    local(wf('1', 'Top', { calls: ['2'] })),
    local(wf('2', 'Middle', { trigger: 'executeWorkflowTrigger', calls: ['3'] })),
    local(wf('3', 'Bottom', { trigger: 'executeWorkflowTrigger' })),
    local(wf('4', 'Unrelated', {})),
  ]);
  assert.deepEqual(reachable(graph, '1', 'dependencies'), ['3', '2']);
  assert.deepEqual(reachable(graph, '3', 'dependents'), ['2', '1']);
  assert.deepEqual(reachable(graph, '4', 'dependents'), []);
  const view = subgraph(graph, new Set(['2', '3']));
  assert.deepEqual(view.nodes.map((n) => n.key), ['3', '2']);
  assert.deepEqual(view.edges.map((e) => [e.from, e.to]), [['2', '3']]);
  assert.deepEqual(view.order, ['3', '2']);
});

test('dependenciesToMermaid draws calls, error workflows and missing targets', () => {
  const graph = buildDependencyGraph([
    local(wf('1', 'Main "quoted"', { calls: ['2', '77'], errorWorkflow: '9' })),
    local(wf('2', 'Helper', { trigger: 'executeWorkflowTrigger' })),
    local(wf('9', 'Errors', { trigger: 'errorTrigger' })),
  ]);
  const text = dependenciesToMermaid(graph, { direction: 'TB' });
  assert.match(text, /^flowchart TB/);
  assert.match(text, /Main &quot;quoted&quot;/);
  assert.match(text, /w\d+ --> w\d+/);
  assert.match(text, /-\.->\|on error\|/);
  assert.match(text, /m0\["missing: 77"\]:::missing/);
  assert.match(text, /classDef missing/);
});

/** Write workflows into `<cwd>/workflows`. */
async function project(t, workflows) {
  const cwd = await tempDir(t);
  for (const workflow of workflows) {
    await writeFileAtomic(path.join(cwd, 'workflows', `${workflow.name.toLowerCase().replace(/\W+/g, '-')}--${workflow.id}.json`), stableStringify(workflow));
  }
  return cwd;
}

test('deps command: text output and exit codes with --check', async (t) => {
  const cwd = await project(t, [
    wf('1', 'Order intake', { calls: ['2'], errorWorkflow: '9' }),
    wf('2', 'Enrich customer', { trigger: 'executeWorkflowTrigger' }),
    wf('9', 'Error notifier', { trigger: 'errorTrigger' }),
  ]);
  const clean = await cli(['deps'], { cwd });
  assert.equal(clean.code, 0, clean.err);
  assert.match(clean.out, /Order intake \(1\)\n {4}error workflow Error notifier \(9\)\n {4}calls Enrich customer \(2\) via node "Call 1"/);
  assert.match(clean.out, /Push order \(referenced workflows first\):/);
  assert.match(clean.out, /3 workflows, 2 references, 0 missing, 0 cycles, 0 dynamic, 0 unreferenced/);
  assert.equal((await cli(['deps', '--check'], { cwd })).code, 0);

  const broken = await project(t, [wf('1', 'Order intake', { calls: ['2', '555'] }), wf('2', 'Loop', { trigger: 'executeWorkflowTrigger', calls: ['2'] })]);
  const unchecked = await cli(['deps', 'workflows'], { cwd: broken });
  assert.equal(unchecked.code, 0);
  const checked = await cli(['deps', 'workflows', '--check'], { cwd: broken });
  assert.equal(checked.code, 1);
  assert.match(checked.out, /node "Call 2" calls workflow 555, which is not in the set/);
  assert.match(checked.out, /Sub-workflow call cycles:\n {2}Loop \(2\) -> Loop \(2\)/);
});

test('deps command: --fail-on-unused, --workflow focus, json and mermaid output to a file', async (t) => {
  const cwd = await project(t, [
    wf('1', 'Top', { calls: ['2'] }),
    wf('2', 'Middle', { trigger: 'executeWorkflowTrigger', calls: ['3'] }),
    wf('3', 'Bottom', { trigger: 'executeWorkflowTrigger' }),
    wf('4', 'Orphan', { trigger: 'executeWorkflowTrigger' }),
  ]);
  assert.equal((await cli(['deps', '--check'], { cwd })).code, 0);
  const unused = await cli(['deps', '--fail-on-unused', '--format', 'json'], { cwd });
  assert.equal(unused.code, 1);
  assert.match(unused.err, /1 unreferenced/);
  assert.deepEqual(JSON.parse(unused.out).unused, [{ key: '4', reason: 'never-called' }]);

  const focus = await cli(['deps', '--workflow', 'Middle'], { cwd });
  assert.equal(focus.code, 0, focus.err);
  assert.match(focus.out, /Workflow Middle \(2\)\n {2}depends on \(1\):\n {4}Bottom \(3\)\n {2}used by \(1\):\n {4}Top \(1\)/);
  assert.doesNotMatch(focus.out, /Orphan/);

  const json = JSON.parse((await cli(['deps', '-w', '3', '--format', 'json'], { cwd })).out);
  assert.deepEqual(json.focus, { key: '3', dependencies: [], dependents: ['2', '1'] });
  assert.equal(json.summary.workflows, 3);

  const written = await cli(['deps', '--format', 'mermaid', '--output', 'docs/deps.mmd'], { cwd });
  assert.equal(written.code, 0, written.err);
  const mermaid = await readFile(path.join(cwd, 'docs/deps.mmd'), 'utf8');
  assert.match(mermaid, /^flowchart LR\n/);
  assert.ok(mermaid.endsWith('\n'));

  const ambiguous = await cli(['deps', '--workflow', 'Nope'], { cwd });
  assert.equal(ambiguous.code, 2);
});
