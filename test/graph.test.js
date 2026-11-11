import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph, findCycles, findOrphans, findUnreachable, isLoopNode, isStickyNote, isTrigger, listEdges, orderNodes, reachableFrom, shortType,
} from '../src/workflow/graph.js';
import { toDot, toMermaid } from '../src/workflow/render.js';
import { connect, node, workflow } from './helpers/fixtures.js';

function sample() {
  return {
    name: 'G',
    nodes: [
      node('Start', 'manualTrigger'), node('Check', 'if'), node('Yes', 'noOp'), node('No', 'noOp'), node('Lonely', 'noOp'),
      node('Island A', 'noOp'), node('Island B', 'noOp'), node('Note', 'stickyNote', { parameters: { content: 'hello "world"' } }),
    ],
    connections: connect([['Start', 'Check'], ['Check', 'Yes', 0], ['Check', 'No', 1], ['Island A', 'Island B'], ['Island B', 'Island A']]),
  };
}

test('node classification helpers', () => {
  assert.equal(shortType('n8n-nodes-base.httpRequest'), 'httpRequest');
  assert.equal(isTrigger(node('T', 'manualTrigger')), true);
  assert.equal(isTrigger(node('W', 'webhook')), true);
  assert.equal(isTrigger(node('S', 'set')), false);
  assert.equal(isStickyNote(node('N', 'stickyNote')), true);
  assert.equal(isLoopNode(node('L', 'splitInBatches')), true);
  assert.equal(isLoopNode(node('S', 'set')), false);
});

test('listEdges flattens the n8n connection map with output indexes', () => {
  const edges = listEdges(sample().connections);
  assert.equal(edges.length, 5);
  const toNo = edges.find((edge) => edge.to === 'No');
  assert.deepEqual(toNo, { from: 'Check', to: 'No', type: 'main', outputIndex: 1, inputIndex: 0 });
  assert.deepEqual(listEdges(undefined), []);
});

test('buildGraph records dangling edges instead of throwing', () => {
  const graph = buildGraph({ nodes: [node('A', 'noOp')], connections: connect([['A', 'Ghost'], ['Phantom', 'A']]) });
  assert.equal(graph.dangling.length, 2);
  assert.deepEqual(graph.dangling.map((edge) => `${edge.from}>${edge.to}`).sort(), ['A>Ghost', 'Phantom>A']);
});

test('findOrphans reports unconnected non-trigger nodes and ignores sticky notes', () => {
  assert.deepEqual(findOrphans(buildGraph(sample())), ['Lonely']);
  assert.deepEqual(findOrphans(buildGraph(workflow())), []);
});

test('findUnreachable reports connected nodes no trigger leads to', () => {
  assert.deepEqual(findUnreachable(buildGraph(sample())), ['Island A', 'Island B']);
  assert.deepEqual(findUnreachable(buildGraph(workflow())), []);
});

test('reachableFrom follows edges transitively', () => {
  const reached = [...reachableFrom(buildGraph(sample()), ['Start'])].sort();
  assert.deepEqual(reached, ['Check', 'No', 'Start', 'Yes']);
});

test('findCycles finds loops and tolerates intentional batch loops', () => {
  assert.deepEqual(findCycles(buildGraph(sample())), [['Island A', 'Island B']]);
  const loop = {
    name: 'L',
    nodes: [node('T', 'manualTrigger'), node('Loop', 'splitInBatches'), node('Work', 'noOp')],
    connections: connect([['T', 'Loop'], ['Loop', 'Work', 1], ['Work', 'Loop']]),
  };
  assert.deepEqual(findCycles(buildGraph(loop)), []);
  assert.deepEqual(findCycles(buildGraph(loop), { ignoreLoopNodes: false }), [['Loop', 'Work']]);
  assert.deepEqual(findCycles(buildGraph(workflow())), []);
});

test('orderNodes starts with triggers and covers every node once', () => {
  const ordered = orderNodes(buildGraph(sample())).map((entry) => (typeof entry === 'string' ? entry : entry.name));
  assert.equal(ordered[0], 'Start');
  assert.equal(new Set(ordered).size, ordered.length);
  assert.ok(ordered.indexOf('Check') < ordered.indexOf('Yes'));
});

test('toMermaid renders shapes, branch labels and escapes quotes', () => {
  const text = toMermaid(sample());
  const lines = text.split('\n');
  assert.equal(lines[0], 'flowchart LR');
  assert.ok(text.includes('(["Start'), 'trigger uses a stadium shape');
  assert.ok(text.includes('{"Check'), 'if node uses a diamond');
  assert.match(text, /n1 -->\|true\| n2/);
  assert.match(text, /n1 -->\|false\| n3/);
  assert.ok(!text.includes('stickyNote'), 'sticky notes are excluded by default');
});

test('toMermaid options: direction and sticky notes', () => {
  const text = toMermaid(sample(), { direction: 'TB', includeStickyNotes: true });
  assert.equal(text.split('\n')[0], 'flowchart TB');
  assert.ok(text.includes('>"Note<br/><i>stickyNote</i>"]'));
  const plain = toMermaid(sample(), { showTypes: false });
  assert.ok(plain.includes('n0(["Start"])'));
  const quoted = toMermaid({ name: 'Q', nodes: [node('Say "hi" <now>', 'noOp')], connections: {} }, { showTypes: false });
  assert.ok(quoted.includes('Say &quot;hi&quot; &lt;now&gt;'), 'labels are escaped');
});

test('toDot renders a digraph with shapes and labelled edges', () => {
  const text = toDot(sample());
  assert.match(text, /^digraph "G" \{/);
  assert.match(text, /rankdir=LR;/);
  assert.match(text, /shape=oval/);
  assert.match(text, /shape=diamond/);
  assert.match(text, /n1 -> n2 \[label="true"\];/);
  assert.equal(text.trimEnd().endsWith('}'), true);
});

test('renderers are deterministic', () => {
  assert.equal(toMermaid(workflow()), toMermaid(workflow()));
  assert.equal(toDot(workflow()), toDot(workflow()));
});
