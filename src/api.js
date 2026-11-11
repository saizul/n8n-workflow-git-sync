import { HttpClient } from './http.js';
import { ApiError } from './errors.js';

/**
 * Fields the public API accepts when creating or updating a workflow. Sending
 * anything else (id, active, tags, timestamps ...) is rejected by n8n with
 * "request/body must NOT have additional properties".
 */
export const WRITABLE_WORKFLOW_FIELDS = Object.freeze(['name', 'nodes', 'connections', 'settings', 'staticData']);

/** Settings keys accepted by the public API schema. */
export const WRITABLE_SETTINGS_FIELDS = Object.freeze([
  'saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution', 'saveDataSuccessExecution',
  'executionTimeout', 'errorWorkflow', 'timezone', 'executionOrder', 'callerPolicy', 'callerIds',
  'timeSavedPerExecution', 'availableInMCP',
]);

/**
 * Reduce a workflow to the body accepted by POST/PUT `/workflows`.
 * @param {Record<string, any>} workflow
 * @param {{strictSettings?: boolean}} [options]
 */
export function toWritableWorkflow(workflow, options = {}) {
  /** @type {Record<string, any>} */
  const body = {
    name: workflow.name,
    nodes: workflow.nodes ?? [],
    connections: workflow.connections ?? {},
    settings: { ...(workflow.settings ?? {}) },
  };
  if (options.strictSettings !== false) {
    for (const key of Object.keys(body.settings)) {
      if (!WRITABLE_SETTINGS_FIELDS.includes(key)) delete body.settings[key];
    }
  }
  if (workflow.staticData !== undefined && workflow.staticData !== null) body.staticData = workflow.staticData;
  return body;
}

/**
 * Typed wrapper around the subset of the n8n public API v1 this tool uses.
 */
export class N8nClient {
  /**
   * @param {import('./http.js').HttpClientOptions & {pageSize?: number}} options
   */
  constructor(options) {
    this.http = new HttpClient(options);
    this.pageSize = options.pageSize ?? 100;
  }

  /**
   * List every workflow, following cursor pagination.
   * @param {{active?: boolean, tags?: string[], name?: string, projectId?: string, excludePinnedData?: boolean}} [filter]
   * @returns {Promise<Record<string, any>[]>}
   */
  async listWorkflows(filter = {}) {
    /** @type {Record<string, any>[]} */
    const out = [];
    const query = {
      active: filter.active,
      tags: filter.tags?.length ? filter.tags.join(',') : undefined,
      name: filter.name,
      projectId: filter.projectId,
      excludePinnedData: filter.excludePinnedData,
    };
    for await (const wf of this.http.paginate('/workflows', { query, pageSize: this.pageSize })) out.push(wf);
    return out;
  }

  /** @param {string} id @returns {Promise<Record<string, any>>} */
  getWorkflow(id) {
    return this.http.get(`/workflows/${encodeURIComponent(id)}`);
  }

  /**
   * Like getWorkflow but resolves to null on 404.
   * @param {string} id
   * @returns {Promise<Record<string, any>|null>}
   */
  async findWorkflow(id) {
    try {
      return await this.getWorkflow(id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** @param {Record<string, any>} workflow */
  createWorkflow(workflow) {
    return this.http.post('/workflows', toWritableWorkflow(workflow));
  }

  /** @param {string} id @param {Record<string, any>} workflow */
  updateWorkflow(id, workflow) {
    return this.http.put(`/workflows/${encodeURIComponent(id)}`, toWritableWorkflow(workflow));
  }

  /** @param {string} id */
  deleteWorkflow(id) {
    return this.http.delete(`/workflows/${encodeURIComponent(id)}`);
  }

  /** @param {string} id */
  activateWorkflow(id) {
    return this.http.post(`/workflows/${encodeURIComponent(id)}/activate`);
  }

  /** @param {string} id */
  deactivateWorkflow(id) {
    return this.http.post(`/workflows/${encodeURIComponent(id)}/deactivate`);
  }

  /** @returns {Promise<Array<{id: string, name: string}>>} */
  async listTags() {
    const out = [];
    for await (const tag of this.http.paginate('/tags', { pageSize: this.pageSize })) out.push(tag);
    return out;
  }

  /** @param {string} name */
  createTag(name) {
    return this.http.post('/tags', { name });
  }

  /** @param {string} id @returns {Promise<Array<{id: string, name: string}>>} */
  getWorkflowTags(id) {
    return this.http.get(`/workflows/${encodeURIComponent(id)}/tags`);
  }

  /**
   * @param {string} id
   * @param {string[]} tagIds
   */
  setWorkflowTags(id, tagIds) {
    return this.http.put(`/workflows/${encodeURIComponent(id)}/tags`, tagIds.map((tagId) => ({ id: tagId })));
  }

  /**
   * List credential metadata (id, name, type). Secret values are never
   * returned by the public API. Older n8n versions do not expose this
   * endpoint; in that case `null` is returned so callers can degrade.
   * @returns {Promise<Array<{id: string, name: string, type: string}>|null>}
   */
  async listCredentials() {
    const out = [];
    try {
      for await (const cred of this.http.paginate('/credentials', { pageSize: this.pageSize })) {
        out.push({ id: String(cred.id), name: cred.name, type: cred.type });
      }
    } catch (err) {
      if (err instanceof ApiError && [403, 404, 405].includes(err.status)) return null;
      throw err;
    }
    return out;
  }

  /**
   * List projects (enterprise feature). Resolves to null when unavailable.
   * @returns {Promise<Array<{id: string, name: string, type?: string}>|null>}
   */
  async listProjects() {
    const out = [];
    try {
      for await (const project of this.http.paginate('/projects', { pageSize: this.pageSize })) out.push(project);
    } catch (err) {
      if (err instanceof ApiError && [400, 403, 404, 405].includes(err.status)) return null;
      throw err;
    }
    return out;
  }
}

/**
 * Build a client from resolved configuration.
 * @param {import('./config.js').ResolvedConfig} config
 * @param {{fetch?: typeof fetch, logger?: import('./util/logger.js').Logger, sleep?: (ms: number) => Promise<void>}} [deps]
 */
export function createClient(config, deps = {}) {
  deps.logger?.addSecret(config.apiKey);
  return new N8nClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.http.timeoutMs,
    retries: config.http.retries,
    retryDelayMs: config.http.retryDelayMs,
    pageSize: config.http.pageSize,
    fetch: deps.fetch,
    sleep: deps.sleep,
    logger: deps.logger,
  });
}
