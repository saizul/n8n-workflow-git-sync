import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { ApiError } from '../src/errors.js';
import { HttpClient, RETRYABLE_STATUS, backoffDelay, parseRetryAfter } from '../src/http.js';
import { createMemoryLogger } from '../src/util/logger.js';
import { BASE_URL, TEST_API_KEY, createMockN8n } from './helpers/mock-n8n.js';
import { workflow } from './helpers/fixtures.js';

/**
 * @param {ReturnType<typeof createMockN8n>} mock
 * @param {Partial<import('../src/http.js').HttpClientOptions>} [extra]
 */
function clientFor(mock, extra = {}) {
  /** @type {number[]} */
  const sleeps = [];
  const client = new HttpClient({
    baseUrl: BASE_URL,
    apiKey: TEST_API_KEY,
    fetch: mock.fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0,
    retryDelayMs: 100,
    ...extra,
  });
  return { client, sleeps };
}

test('parseRetryAfter understands seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('0.5'), 500);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10000);
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now), 0);
});

test('backoffDelay doubles per attempt, is capped and jitters within the upper half', () => {
  assert.equal(backoffDelay(0, 100, 10000, () => 0), 50);
  assert.equal(backoffDelay(0, 100, 10000, () => 1), 100);
  assert.equal(backoffDelay(3, 100, 10000, () => 1), 800);
  assert.equal(backoffDelay(10, 100, 1000, () => 1), 1000);
});

test('constructor requires a base URL and an API key', () => {
  assert.throws(() => new HttpClient({ baseUrl: '', apiKey: 'k' }), TypeError);
  assert.throws(() => new HttpClient({ baseUrl: BASE_URL, apiKey: '' }), TypeError);
});

test('buildUrl joins base, API path and query, skipping empty values', () => {
  const { client } = clientFor(createMockN8n());
  assert.equal(
    client.buildUrl('/workflows', { limit: 10, cursor: undefined, active: false, name: '' }),
    `${BASE_URL}/api/v1/workflows?limit=10&active=false`,
  );
  assert.equal(client.buildUrl('tags'), `${BASE_URL}/api/v1/tags`);
});

test('requests carry the API key header and JSON bodies', async () => {
  const mock = createMockN8n();
  const { client } = clientFor(mock);
  await client.post('/tags', { name: 'ops' });
  const request = mock.requests[0];
  assert.equal(request.headers['x-n8n-api-key'], TEST_API_KEY);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.body, { name: 'ops' });
});

test('a wrong API key yields an ApiError with status 401 and a hint, without the key', async () => {
  const mock = createMockN8n();
  const wrong = ['wrong', 'key', 'value'].join('-');
  const { client } = clientFor(mock, { apiKey: wrong });
  await assert.rejects(client.get('/workflows'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 401);
    assert.equal(err.exitCode, 3);
    assert.match(err.message, /401/);
    assert.match(err.message, /API key/i);
    assert.ok(!err.message.includes(wrong));
    return true;
  });
  assert.equal(mock.requests.length, 1, '401 is not retried');
});

test('GET is retried on 429 and honours Retry-After', async () => {
  const mock = createMockN8n({ workflows: [workflow()] });
  mock.failWith(429, { path: '/workflows' }, 2, { headers: { 'Retry-After': '3' } });
  const { client, sleeps } = clientFor(mock);
  const body = await client.get('/workflows');
  assert.equal(body.data.length, 1);
  assert.deepEqual(sleeps, [3000, 3000]);
  assert.equal(client.requestCount, 3);
});

test('GET is retried on every retryable status with exponential backoff', async () => {
  for (const status of RETRYABLE_STATUS) {
    const mock = createMockN8n();
    mock.failWith(status, {}, 2);
    const { client, sleeps } = clientFor(mock);
    await client.get('/tags');
    assert.deepEqual(sleeps, [50, 100], `status ${status}`);
  }
});

test('retries stop after the configured number and the error reports the attempts', async () => {
  const mock = createMockN8n();
  mock.failWith(503, {}, 10);
  const { client, sleeps } = clientFor(mock, { retries: 2 });
  await assert.rejects(client.get('/tags'), (err) => err instanceof ApiError && err.status === 503 && err.attempts === 3);
  assert.equal(sleeps.length, 2);
  assert.equal(mock.requests.length, 3);
});

test('client errors such as 400 and 404 are not retried', async () => {
  const mock = createMockN8n();
  const { client, sleeps } = clientFor(mock);
  await assert.rejects(client.get('/workflows/nope'), (err) => err instanceof ApiError && err.status === 404);
  await assert.rejects(client.post('/tags', {}), (err) => err instanceof ApiError && err.status === 400 && /name/.test(err.message));
  assert.equal(sleeps.length, 0);
});

test('POST is retried on 429 and 503 but not on 500 or network errors', async () => {
  const mock = createMockN8n();
  mock.failWith(429, { method: 'POST' }, 1);
  mock.failWith(503, { method: 'POST' }, 1);
  const { client } = clientFor(mock);
  await client.post('/tags', { name: 'a' });
  assert.equal(mock.count('POST', '/tags'), 3);

  mock.failWith(500, { method: 'POST' }, 1);
  await assert.rejects(client.post('/tags', { name: 'b' }), (err) => err instanceof ApiError && err.status === 500);
  assert.equal(mock.count('POST', '/tags'), 4);

  mock.failNetwork({ method: 'POST' }, 1);
  await assert.rejects(client.post('/tags', { name: 'c' }), /fetch failed/);
  assert.equal(mock.count('POST', '/tags'), 5);
  assert.equal(mock.tags.size, 1, 'no duplicate tag was created');
});

test('network errors on GET are retried and then succeed', async () => {
  const mock = createMockN8n();
  mock.failNetwork({}, 2);
  const { client, sleeps } = clientFor(mock);
  assert.deepEqual(await client.get('/tags'), { data: [], nextCursor: null });
  assert.equal(sleeps.length, 2);
});

test('a hanging request is aborted after the timeout and reported as such', async () => {
  const mock = createMockN8n();
  mock.hang({}, 5);
  const { client } = clientFor(mock, { timeoutMs: 20, retries: 1 });
  await assert.rejects(client.get('/tags'), (err) => err instanceof ApiError && /timed out after 20 ms/.test(err.message) && err.attempts === 2);
});

test('retry: false disables retries for a single request', async () => {
  const mock = createMockN8n();
  mock.failWith(503, {}, 1);
  const { client } = clientFor(mock);
  await assert.rejects(client.request('GET', '/tags', { retry: false }), ApiError);
  assert.equal(mock.requests.length, 1);
});

test('an HTML response on a 2xx status points at a wrong base URL', async () => {
  const fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '<html>login</html>' });
  const client = new HttpClient({ baseUrl: BASE_URL, apiKey: TEST_API_KEY, fetch: /** @type {any} */ (fetch) });
  await assert.rejects(client.get('/workflows'), /non-JSON response/);
});

test('an empty 2xx body resolves to null', async () => {
  const fetch = async () => ({ ok: true, status: 204, headers: { get: () => null }, text: async () => '' });
  const client = new HttpClient({ baseUrl: BASE_URL, apiKey: TEST_API_KEY, fetch: /** @type {any} */ (fetch) });
  assert.equal(await client.delete('/workflows/1'), null);
});

test('paginate follows cursors until the last page', async () => {
  const mock = createMockN8n({ workflows: Array.from({ length: 7 }, (_, i) => workflow({ id: String(i + 1), name: `Flow ${i + 1}` })) });
  const { client } = clientFor(mock);
  const names = [];
  for await (const wf of client.paginate('/workflows', { pageSize: 3 })) names.push(wf.name);
  assert.equal(names.length, 7);
  assert.equal(mock.count('GET', '/workflows'), 3);
  assert.equal(mock.requests[0].query.limit, '3');
  assert.equal(mock.requests[0].query.cursor, undefined);
  assert.ok(mock.requests[1].query.cursor);
});

test('paginate detects a repeating cursor instead of looping forever', async () => {
  const fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{}], nextCursor: 'same' }) });
  const client = new HttpClient({ baseUrl: BASE_URL, apiKey: TEST_API_KEY, fetch: /** @type {any} */ (fetch) });
  await assert.rejects(async () => {
    for await (const item of client.paginate('/workflows')) assert.ok(item);
  }, /Pagination loop detected/);
});

test('paginate rejects a payload without a data array', async () => {
  const fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{"items":[]}' });
  const client = new HttpClient({ baseUrl: BASE_URL, apiKey: TEST_API_KEY, fetch: /** @type {any} */ (fetch) });
  await assert.rejects(async () => {
    for await (const item of client.paginate('/workflows')) assert.ok(item);
  }, /unexpected payload/);
});

test('the API key never appears in logs, serialisation or inspection', async () => {
  const mock = createMockN8n();
  const logger = createMemoryLogger({ level: 'debug' });
  mock.failWith(500, {}, 1, { body: { message: `echoing ${TEST_API_KEY} back` } });
  const { client } = clientFor(mock, { logger });
  await client.get('/tags');
  assert.ok(logger.errText().includes('GET https://n8n.example.com/api/v1/tags'));
  assert.ok(!logger.errText().includes(TEST_API_KEY));
  assert.ok(!JSON.stringify(client).includes(TEST_API_KEY));
  assert.ok(!util.inspect(client, { depth: 5 }).includes(TEST_API_KEY));
  assert.ok(!Object.keys(client).includes('secret'));
});

test('an error body that echoes the API key is scrubbed from the message', async () => {
  const mock = createMockN8n();
  mock.failWith(400, {}, 1, { body: { message: `bad header ${TEST_API_KEY}` } });
  const { client } = clientFor(mock);
  await assert.rejects(client.get('/tags'), (err) => err instanceof ApiError && !err.message.includes(TEST_API_KEY) && /bad header \*\*\*/.test(err.message));
});
