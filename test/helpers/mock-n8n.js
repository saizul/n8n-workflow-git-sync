/**
 * In-memory stand-in for the n8n public REST API (v1), exposed as a
 * fetch-compatible function. It models the parts of the API the client uses:
 * API-key authentication, cursor pagination, workflow CRUD, activation,
 * tags and credential metadata. Failures can be injected per request.
 */

/** Placeholder key used by every test; deliberately not key-shaped. */
export const TEST_API_KEY = 'test-api-key';
export const BASE_URL = 'https://n8n.example.com';

const READ_ONLY_FIELDS = ['id', 'active', 'createdAt', 'updatedAt', 'tags', 'versionId', 'isArchived', 'pinData', 'meta', 'shared', 'triggerCount'];

/** @param {unknown} value */
const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function respond(status, body, headers = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (/** @type {string} */ name) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/**
 * @typedef {object} MockOptions
 * @property {string} [apiKey]
 * @property {Record<string, any>[]} [workflows]
 * @property {Array<{id?: string, name: string}>} [tags]
 * @property {Array<{id: string, name: string, type: string}>|null} [credentials]  null: endpoint answers 403
 * @property {boolean} [strict]  reject read-only fields on write, like n8n does
 * @property {number} [startId]
 */

/** @param {MockOptions} [options] */
export function createMockN8n(options = {}) {
  const apiKey = options.apiKey ?? TEST_API_KEY;
  const strict = options.strict ?? true;
  let nextId = options.startId ?? 1000;
  let nextTagId = 1;
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const tick = () => new Date((clock += 1000)).toISOString();

  /** @type {Map<string, Record<string, any>>} */
  const workflows = new Map();
  /** @type {Map<string, {id: string, name: string, createdAt: string, updatedAt: string}>} */
  const tags = new Map();
  /** @type {Array<{id: string, name: string, type: string}>|null} */
  let credentials = options.credentials === undefined ? [] : copy(options.credentials);
  /** @type {Array<{method: string, path: string, query: Record<string, string>, body: any, headers: Record<string, string>}>} */
  const requests = [];
  /** @type {Array<{match: (req: {method: string, path: string}) => boolean, times: number, response?: {status: number, body?: unknown, headers?: Record<string, string>}, error?: Error, hang?: boolean}>} */
  const failures = [];

  /** @param {string} name */
  const addTag = (name, id) => {
    let tagId = id === undefined || id === null ? '' : String(id);
    while (tagId === '' || tags.has(tagId)) tagId = `tag${nextTagId++}`;
    const tag = { id: tagId, name, createdAt: tick(), updatedAt: tick() };
    tags.set(tag.id, tag);
    return tag;
  };
  /** @param {string} name */
  const tagByName = (name) => [...tags.values()].find((tag) => tag.name === name);

  /** @param {Record<string, any>} wf */
  const addWorkflow = (wf) => {
    const id = String(wf.id ?? nextId++);
    const stored = {
      id,
      name: wf.name ?? 'Untitled',
      active: wf.active ?? false,
      createdAt: wf.createdAt ?? tick(),
      updatedAt: wf.updatedAt ?? tick(),
      versionId: wf.versionId ?? `v-${id}-1`,
      nodes: copy(wf.nodes ?? []),
      connections: copy(wf.connections ?? {}),
      settings: copy(wf.settings ?? {}),
      staticData: wf.staticData ?? null,
      tags: (wf.tags ?? []).map((tag) => {
        const name = typeof tag === 'string' ? tag : tag.name;
        return copy(tagByName(name) ?? addTag(name, typeof tag === 'string' ? undefined : tag.id));
      }),
    };
    for (const key of ['pinData', 'meta', 'isArchived', 'shared']) if (wf[key] !== undefined) stored[key] = copy(wf[key]);
    workflows.set(id, stored);
    return stored;
  };

  for (const tag of options.tags ?? []) addTag(tag.name, tag.id);
  for (const wf of options.workflows ?? []) addWorkflow(wf);

  /**
   * @param {Record<string, any>[]} items
   * @param {Record<string, string>} query
   */
  const page = (items, query) => {
    const limit = Math.min(Number(query.limit ?? 100) || 100, 250);
    const start = query.cursor ? Number(Buffer.from(query.cursor, 'base64url').toString('utf8')) : 0;
    if (!Number.isInteger(start) || start < 0) return respond(400, { message: 'Invalid cursor' });
    const slice = items.slice(start, start + limit);
    const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
    return respond(200, { data: copy(slice), nextCursor: next });
  };

  /** @param {any} body */
  const checkWritable = (body) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'request body must be an object';
    if (typeof body.name !== 'string' || body.name === '') return 'request/body must have required property \'name\'';
    if (!Array.isArray(body.nodes)) return 'request/body must have required property \'nodes\'';
    if (body.connections === null || typeof body.connections !== 'object') return 'request/body must have required property \'connections\'';
    if (body.settings === null || typeof body.settings !== 'object') return 'request/body must have required property \'settings\'';
    if (strict) {
      for (const key of READ_ONLY_FIELDS) if (key in body) return `request/body/${key} is read-only`;
    }
    return null;
  };

  /**
   * @param {string} method
   * @param {string} path
   * @param {Record<string, string>} query
   * @param {any} body
   */
  const route = (method, path, query, body) => {
    /** @type {RegExpExecArray|null} */
    let m;
    if (path === '/workflows' && method === 'GET') {
      let items = [...workflows.values()];
      if (query.active !== undefined) items = items.filter((wf) => String(wf.active) === query.active);
      if (query.tags) {
        const wanted = query.tags.split(',');
        items = items.filter((wf) => wanted.every((name) => wf.tags.some((tag) => tag.name === name)));
      }
      if (query.name) items = items.filter((wf) => wf.name === query.name);
      return page(items, query);
    }
    if (path === '/workflows' && method === 'POST') {
      const problem = checkWritable(body);
      if (problem) return respond(400, { message: problem });
      return respond(200, copy(addWorkflow({ ...body, id: undefined, active: false })));
    }
    if ((m = /^\/workflows\/([^/]+)$/.exec(path))) {
      const wf = workflows.get(decodeURIComponent(m[1]));
      if (!wf) return respond(404, { message: 'Not Found' });
      if (method === 'GET') return respond(200, copy(wf));
      if (method === 'DELETE') {
        workflows.delete(wf.id);
        return respond(200, copy(wf));
      }
      if (method === 'PUT') {
        const problem = checkWritable(body);
        if (problem) return respond(400, { message: problem });
        const version = Number(String(wf.versionId).split('-').pop()) + 1;
        Object.assign(wf, {
          name: body.name,
          nodes: copy(body.nodes),
          connections: copy(body.connections),
          settings: copy(body.settings),
          staticData: body.staticData ?? wf.staticData,
          updatedAt: tick(),
          versionId: `v-${wf.id}-${version}`,
        });
        return respond(200, copy(wf));
      }
    }
    if ((m = /^\/workflows\/([^/]+)\/(activate|deactivate)$/.exec(path)) && method === 'POST') {
      const wf = workflows.get(decodeURIComponent(m[1]));
      if (!wf) return respond(404, { message: 'Not Found' });
      if (m[2] === 'activate' && !wf.nodes.some((node) => /trigger|webhook/i.test(String(node.type)))) {
        return respond(400, { message: 'Workflow has no node to start the workflow - at least one trigger, poller or webhook node is required' });
      }
      wf.active = m[2] === 'activate';
      wf.updatedAt = tick();
      return respond(200, copy(wf));
    }
    if ((m = /^\/workflows\/([^/]+)\/tags$/.exec(path))) {
      const wf = workflows.get(decodeURIComponent(m[1]));
      if (!wf) return respond(404, { message: 'Not Found' });
      if (method === 'GET') return respond(200, copy(wf.tags));
      if (method === 'PUT') {
        if (!Array.isArray(body)) return respond(400, { message: 'request/body must be array' });
        const resolved = [];
        for (const ref of body) {
          const tag = tags.get(String(ref?.id));
          if (!tag) return respond(404, { message: 'Some tags not found' });
          resolved.push(copy(tag));
        }
        wf.tags = resolved;
        return respond(200, copy(resolved));
      }
    }
    if (path === '/tags' && method === 'GET') return page([...tags.values()], query);
    if (path === '/tags' && method === 'POST') {
      if (typeof body?.name !== 'string' || body.name === '') return respond(400, { message: 'request/body must have required property \'name\'' });
      if (tagByName(body.name)) return respond(409, { message: 'Tag already exists' });
      return respond(201, copy(addTag(body.name)));
    }
    if (path === '/credentials' && method === 'GET') {
      if (credentials === null) return respond(403, { message: 'Forbidden' });
      return page(credentials, query);
    }
    if (path === '/projects' && method === 'GET') return respond(403, { message: 'Your license does not allow for feat:projectRole:admin' });
    return respond(404, { message: `Cannot ${method} /api/v1${path}` });
  };

  /**
   * fetch-compatible entry point.
   * @param {string|URL} input
   * @param {{method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal}} [init]
   */
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const prefix = '/api/v1';
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());
    let body;
    if (typeof init.body === 'string' && init.body !== '') {
      try {
        body = JSON.parse(init.body);
      } catch {
        requests.push({ method, path, query, body: init.body, headers });
        return respond(400, { message: 'Malformed JSON' });
      }
    }
    requests.push({ method, path, query, body, headers });

    const failure = failures.find((f) => f.times > 0 && f.match({ method, path }));
    if (failure) {
      failure.times -= 1;
      if (failure.hang) {
        return new Promise((_, reject) => {
          const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      if (failure.error) throw failure.error;
      if (failure.response) return respond(failure.response.status, failure.response.body ?? { message: 'injected failure' }, failure.response.headers);
    }
    if (!url.pathname.startsWith(prefix)) return respond(404, '<html><body>Not Found</body></html>');
    if (headers['x-n8n-api-key'] !== apiKey) return respond(401, { message: 'unauthorized' });
    return route(method, path, query, body);
  };

  /**
   * @param {{method?: string, path?: string|RegExp}} where
   */
  const matcher = (where) => (/** @type {{method: string, path: string}} */ req) => {
    if (where.method && where.method.toUpperCase() !== req.method) return false;
    if (where.path instanceof RegExp) return where.path.test(req.path);
    if (typeof where.path === 'string') return where.path === req.path;
    return true;
  };

  return {
    fetch: /** @type {any} */ (fetch),
    baseUrl: BASE_URL,
    apiKey,
    requests,
    workflows,
    tags,
    addWorkflow,
    addTag,
    /** @param {string} id */
    get: (id) => workflows.get(String(id)),
    /** @param {Array<{id: string, name: string, type: string}>|null} list */
    setCredentials: (list) => { credentials = copy(list); },
    /**
     * Edit a stored workflow as if somebody changed it in the n8n editor.
     * @param {string} id
     * @param {(wf: Record<string, any>) => void} mutate
     */
    edit: (id, mutate) => {
      const wf = workflows.get(String(id));
      if (!wf) throw new Error(`mock: no workflow ${id}`);
      mutate(wf);
      wf.updatedAt = tick();
      return wf;
    },
    /** Answer the next `times` matching requests with an HTTP status. */
    failWith: (status, where = {}, times = 1, extra = {}) => {
      failures.push({ match: matcher(where), times, response: { status, body: extra.body, headers: extra.headers } });
    },
    /** Make the next `times` matching requests throw a network error. */
    failNetwork: (where = {}, times = 1, message = 'fetch failed') => {
      failures.push({ match: matcher(where), times, error: Object.assign(new TypeError(message), { cause: { code: 'ECONNRESET' } }) });
    },
    /** Make the next `times` matching requests hang until aborted. */
    hang: (where = {}, times = 1) => {
      failures.push({ match: matcher(where), times, hang: true });
    },
    /** @param {string} [method] @param {string|RegExp} [path] */
    count: (method, path) => requests.filter(matcher({ method, path })).length,
    /** Requests that modify state. */
    writes: () => requests.filter((req) => req.method !== 'GET'),
  };
}
