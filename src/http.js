import { ApiError } from './errors.js';
import { createRedactor } from './util/logger.js';

/** HTTP status codes that are worth retrying. */
export const RETRYABLE_STATUS = Object.freeze([408, 425, 429, 500, 502, 503, 504]);

/**
 * @typedef {object} HttpClientOptions
 * @property {string} baseUrl                 instance root, without `/api/v1`
 * @property {string} apiKey
 * @property {typeof fetch} [fetch]           injectable fetch implementation
 * @property {number} [timeoutMs]             per-attempt timeout
 * @property {number} [retries]               retries after the first attempt
 * @property {number} [retryDelayMs]          base delay for exponential backoff
 * @property {number} [maxRetryDelayMs]
 * @property {(ms: number) => Promise<void>} [sleep]  injectable for tests
 * @property {() => number} [random]          injectable jitter source, 0..1
 * @property {import('./util/logger.js').Logger} [logger]
 * @property {string} [apiPath]
 * @property {string} [userAgent]
 */

/**
 * Parse a Retry-After header (delta seconds or HTTP date) into milliseconds.
 * @param {string|null|undefined} value
 * @param {number} [now]
 * @returns {number|null}
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * Exponential backoff with full jitter in the upper half of the window.
 * @param {number} attempt zero-based retry number
 * @param {number} baseMs
 * @param {number} maxMs
 * @param {() => number} random
 */
export function backoffDelay(attempt, baseMs, maxMs, random = Math.random) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

/**
 * Thin JSON-over-HTTP client for the n8n public API with timeout, retry and
 * strict secret hygiene: the API key is only ever placed in the request
 * header and is scrubbed from every error message and log line.
 */
export class HttpClient {
  /** @param {HttpClientOptions} options */
  constructor(options) {
    if (!options.baseUrl) throw new TypeError('HttpClient requires a baseUrl');
    if (!options.apiKey) throw new TypeError('HttpClient requires an apiKey');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiPath = options.apiPath ?? '/api/v1';
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.retries = options.retries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 15000;
    this.userAgent = options.userAgent ?? 'n8n-workflow-git-sync';
    this.logger = options.logger;
    this.requestCount = 0;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new TypeError('No fetch implementation available');
    this.redact = createRedactor([options.apiKey]);
    // Keep the key and transport out of enumerable properties so that
    // accidentally serialising or inspecting the client cannot leak them.
    Object.defineProperty(this, 'secret', { value: options.apiKey, enumerable: false });
    Object.defineProperty(this, 'fetchImpl', { value: fetchImpl, enumerable: false });
    Object.defineProperty(this, 'sleep', {
      value: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      enumerable: false,
    });
    Object.defineProperty(this, 'random', { value: options.random ?? Math.random, enumerable: false });
  }

  /**
   * Build the absolute URL for an API path and query.
   * @param {string} apiPath e.g. `/workflows`
   * @param {Record<string, string|number|boolean|undefined|null>} [query]
   */
  buildUrl(apiPath, query = {}) {
    const url = new URL(`${this.baseUrl}${this.apiPath}${apiPath.startsWith('/') ? '' : '/'}${apiPath}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * @param {string} method
   * @param {string} apiPath
   * @param {{query?: Record<string, string|number|boolean|undefined|null>, body?: unknown, retry?: boolean}} [options]
   * @returns {Promise<any>} parsed JSON body (or null for empty responses)
   */
  async request(method, apiPath, options = {}) {
    const url = this.buildUrl(apiPath, options.query);
    const verb = method.toUpperCase();
    // Non-idempotent requests are only retried when the server told us it did
    // not process them (429 / 503); never after a timeout or network error.
    const idempotent = verb === 'GET' || verb === 'PUT' || verb === 'DELETE' || verb === 'HEAD';
    const maxAttempts = options.retry === false ? 1 : this.retries + 1;
    /** @type {ApiError|null} */
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      /** @type {Response|undefined} */
      let response;
      this.requestCount += 1;
      try {
        /** @type {Record<string, string>} */
        const headers = {
          accept: 'application/json',
          'user-agent': this.userAgent,
          'X-N8N-API-KEY': /** @type {any} */ (this).secret,
        };
        /** @type {RequestInit} */
        const init = { method: verb, headers, signal: controller.signal };
        if (options.body !== undefined) {
          headers['content-type'] = 'application/json';
          init.body = JSON.stringify(options.body);
        }
        this.logger?.debug(`${verb} ${url} (attempt ${attempt + 1}/${maxAttempts})`);
        response = await /** @type {any} */ (this).fetchImpl(url, init);
      } catch (err) {
        clearTimeout(timer);
        const aborted = controller.signal.aborted;
        const reason = aborted
          ? `timed out after ${this.timeoutMs} ms`
          : this.redact(err instanceof Error ? err.message : String(err));
        lastError = new ApiError(`${verb} ${url} failed: ${reason}`, {
          method: verb, url, attempts: attempt + 1, cause: aborted ? undefined : err,
        });
        if (idempotent && attempt + 1 < maxAttempts) {
          const delay = backoffDelay(attempt, this.retryDelayMs, this.maxRetryDelayMs, /** @type {any} */ (this).random);
          this.logger?.debug(`retrying in ${delay} ms: ${reason}`);
          await /** @type {any} */ (this).sleep(delay);
          continue;
        }
        throw lastError;
      }
      clearTimeout(timer);

      const text = await response.text();
      /** @type {unknown} */
      let parsed = null;
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (response.ok) {
        if (typeof parsed === 'string') {
          throw new ApiError(`${verb} ${url} returned a non-JSON response (is the base URL correct?)`, {
            status: response.status, method: verb, url, attempts: attempt + 1,
          });
        }
        return parsed;
      }

      const detail = this.redact(describeErrorBody(parsed));
      lastError = new ApiError(
        `${verb} ${url} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}${hintForStatus(response.status)}`,
        { status: response.status, method: verb, url, body: parsed, attempts: attempt + 1 },
      );
      const retryable = RETRYABLE_STATUS.includes(response.status)
        && (idempotent || response.status === 429 || response.status === 503);
      if (!retryable || attempt + 1 >= maxAttempts) throw lastError;
      const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'));
      const delay = retryAfter !== null
        ? Math.min(retryAfter, this.maxRetryDelayMs)
        : backoffDelay(attempt, this.retryDelayMs, this.maxRetryDelayMs, /** @type {any} */ (this).random);
      this.logger?.debug(`HTTP ${response.status}, retrying in ${delay} ms`);
      await /** @type {any} */ (this).sleep(delay);
    }
    /* c8 ignore next */
    throw lastError ?? new ApiError(`${verb} ${url} failed`, { method: verb, url });
  }

  /** @param {string} apiPath @param {Record<string, any>} [query] */
  get(apiPath, query) {
    return this.request('GET', apiPath, { query });
  }

  /** @param {string} apiPath @param {unknown} [body] */
  post(apiPath, body) {
    return this.request('POST', apiPath, { body });
  }

  /** @param {string} apiPath @param {unknown} [body] */
  put(apiPath, body) {
    return this.request('PUT', apiPath, { body });
  }

  /** @param {string} apiPath */
  delete(apiPath) {
    return this.request('DELETE', apiPath);
  }

  /**
   * Iterate a cursor-paginated collection (`{data: [...], nextCursor}`).
   * @param {string} apiPath
   * @param {{query?: Record<string, any>, pageSize?: number, maxPages?: number}} [options]
   * @returns {AsyncGenerator<any, void, void>}
   */
  async *paginate(apiPath, options = {}) {
    const { query = {}, pageSize = 100, maxPages = 10000 } = options;
    /** @type {string|undefined} */
    let cursor;
    /** @type {Set<string>} */
    const seen = new Set();
    for (let page = 0; page < maxPages; page += 1) {
      const body = await this.get(apiPath, { ...query, limit: pageSize, cursor });
      const items = Array.isArray(body) ? body : body?.data;
      if (!Array.isArray(items)) {
        throw new ApiError(`GET ${this.buildUrl(apiPath)} returned an unexpected payload (no data array)`, {
          method: 'GET', url: this.buildUrl(apiPath), body,
        });
      }
      for (const item of items) yield item;
      const next = Array.isArray(body) ? null : body.nextCursor;
      if (!next) return;
      if (seen.has(next)) {
        throw new ApiError(`Pagination loop detected on ${apiPath}: cursor repeated`, { method: 'GET', url: this.buildUrl(apiPath) });
      }
      seen.add(next);
      cursor = next;
    }
    throw new ApiError(`Pagination on ${apiPath} exceeded ${maxPages} pages`, { method: 'GET', url: this.buildUrl(apiPath) });
  }

  /** Never expose the key through inspection or serialisation. */
  toJSON() {
    return { baseUrl: this.baseUrl, apiPath: this.apiPath, timeoutMs: this.timeoutMs, retries: this.retries };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `HttpClient(${this.baseUrl})`;
  }
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function describeErrorBody(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (typeof body === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (body);
    const message = obj.message ?? obj.error ?? obj.hint;
    if (typeof message === 'string') return message.slice(0, 300);
    return JSON.stringify(body).slice(0, 300);
  }
  return String(body);
}

/** @param {number} status */
function hintForStatus(status) {
  if (status === 401) return ' (check the API key)';
  if (status === 403) return ' (the API key lacks the required scope, or the feature is not licensed)';
  if (status === 404) return ' (not found; check the base URL and that the public API is enabled)';
  return '';
}
