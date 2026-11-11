import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

/**
 * Create a scratch directory that is removed when the test finishes.
 * @param {import('node:test').TestContext} t
 */
export async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'n8n-sync-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

let counter = 0;

/**
 * @param {string} name
 * @param {string} type  short type, expanded to n8n-nodes-base.<type>
 * @param {Record<string, any>} [extra]
 */
export function node(name, type, extra = {}) {
  counter += 1;
  return {
    id: extra.id ?? `node-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    type: type.includes('.') ? type : `n8n-nodes-base.${type}`,
    typeVersion: 1,
    position: [counter * 20, 0],
    parameters: {},
    ...extra,
  };
}

/**
 * Build a `connections` object from `[from, to]` or `[from, to, outputIndex]` tuples.
 * @param {Array<[string, string, number?]>} links
 */
export function connect(links) {
  /** @type {Record<string, any>} */
  const connections = {};
  for (const [from, to, output = 0] of links) {
    connections[from] ??= { main: [] };
    const main = connections[from].main;
    while (main.length <= output) main.push([]);
    main[output].push({ node: to, type: 'main', index: 0 });
  }
  return connections;
}

/**
 * A small, lint-clean workflow: webhook with header auth, an HTTP request
 * with timeout and retry, and an error workflow.
 * @param {Record<string, any>} [overrides]
 */
export function workflow(overrides = {}) {
  return {
    id: '101',
    name: 'Order intake',
    active: true,
    nodes: [
      node('Receive order', 'webhook', {
        typeVersion: 2,
        parameters: { path: 'orders', httpMethod: 'POST', authentication: 'headerAuth' },
        credentials: { httpHeaderAuth: { id: 'cred-1', name: 'Webhook header' } },
      }),
      node('Look up customer', 'httpRequest', {
        typeVersion: 4.2,
        parameters: { url: 'https://api.example.com/customers', options: { timeout: 10000 } },
        retryOnFail: true,
        maxTries: 3,
        credentials: { httpHeaderAuth: { id: 'cred-2', name: 'CRM API' } },
      }),
      node('Shape response', 'set', { typeVersion: 3.4, parameters: { assignments: { assignments: [] } } }),
    ],
    connections: connect([['Receive order', 'Look up customer'], ['Look up customer', 'Shape response']]),
    settings: { executionOrder: 'v1', errorWorkflow: '900' },
    tags: [{ id: 'tag1', name: 'orders' }],
    ...overrides,
  };
}

/** A scheduled workflow without credentials. */
export function scheduledWorkflow(overrides = {}) {
  return {
    id: '102',
    name: 'Nightly report',
    active: false,
    nodes: [
      node('Every night', 'scheduleTrigger', {
        typeVersion: 1.2,
        parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 2 * * *' }] } },
      }),
      node('Build report', 'code', { typeVersion: 2, parameters: { jsCode: 'return items;' } }),
    ],
    connections: connect([['Every night', 'Build report']]),
    settings: { executionOrder: 'v1', errorWorkflow: '900' },
    tags: [],
    ...overrides,
  };
}

/**
 * Assemble a string that looks like a credential at runtime, so that no
 * secret-shaped literal exists in the repository.
 * @param {'bearer'|'aws'|'github'|'slack'|'random'|'jwt'|'stripe'} kind
 */
export function fakeSecret(kind) {
  const alphabet = 'Qw3rTy7UiOp9AsDf2GhJk5LzXc8VbNm4';
  const body = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
  switch (kind) {
    case 'bearer': return ['Bearer', body(32)].join(' ');
    case 'aws': return ['AK', 'IA', 'Q7RT2UZ9XPLM4N8V'].join('');
    case 'github': return ['gh', 'p_', body(36)].join('');
    case 'slack': return ['xo', 'xb-', '1234567890', '-', body(24)].join('');
    case 'stripe': return ['sk', '_live_', body(24)].join('');
    case 'jwt': {
      const part = (/** @type {string} */ text) => Buffer.from(text).toString('base64url');
      return [part('{"alg":"HS256","typ":"JWT"}'), part('{"sub":"1234567890","name":"Test"}'), body(43)].join('.');
    }
    default: return body(40);
  }
}
