import { isPlainObject } from '../../util/json.js';
import { findWorkflowSecrets } from '../../secrets/detector.js';

const WEBHOOK_TYPES = new Set(['n8n-nodes-base.webhook', 'n8n-nodes-base.formTrigger']);

/** @type {import('../engine.js').Rule} */
export const noHardcodedSecrets = {
  id: 'no-hardcoded-secrets',
  description: 'Node parameters must not contain literal credentials; use n8n credentials or environment variables.',
  severity: 'error',
  check({ workflow, options }) {
    const rank = { low: 0, medium: 1, high: 2 };
    const min = /** @type {'low'|'medium'|'high'} */ (options.minConfidence ?? 'low');
    return findWorkflowSecrets(workflow, {
      entropy: options.entropy,
      entropyThreshold: options.entropyThreshold,
      minEntropyLength: options.minEntropyLength,
      allowPatterns: options.allowPatterns,
      ignoreKeys: options.ignoreKeys,
    })
      .filter((finding) => rank[finding.confidence] >= (rank[min] ?? 0))
      .map((finding) => ({
        // The secret itself is never included, only a masked preview.
        message: `${finding.description} hard-coded at ${finding.pathText}: ${finding.masked}`,
        node: finding.node,
        path: finding.pathText,
      }));
  },
};

/** @type {import('../engine.js').Rule} */
export const webhookAuthentication = {
  id: 'webhook-authentication',
  description: 'Webhook and form trigger nodes should require authentication.',
  severity: 'error',
  check({ nodes, options }) {
    const allowPaths = Array.isArray(options.allowPaths) ? options.allowPaths.map(String) : [];
    /** @type {import('../engine.js').RuleFinding[]} */
    const out = [];
    nodes.forEach((node) => {
      if (!WEBHOOK_TYPES.has(node.type) || node.disabled === true) return;
      const params = isPlainObject(node.parameters) ? node.parameters : {};
      const auth = params.authentication;
      if (typeof params.path === 'string' && allowPaths.includes(params.path)) return;
      if (auth === undefined || auth === null || auth === '' || auth === 'none') {
        out.push({
          message: `Node "${node.name}" accepts unauthenticated requests; set authentication (header, basic or JWT) or validate a signature`,
          node: node.name,
          path: '$.parameters.authentication',
        });
      }
    });
    return out;
  },
};

/** @type {import('../engine.js').Rule} */
export const noPinnedData = {
  id: 'no-pinned-data',
  description: 'Pinned test data should not be committed; it can contain production records.',
  severity: 'warning',
  check({ workflow }) {
    if (!isPlainObject(workflow.pinData)) return [];
    return Object.keys(workflow.pinData)
      .filter((name) => {
        const value = workflow.pinData[name];
        return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
      })
      .sort()
      .map((name) => ({
        message: `Node "${name}" has pinned data left in the workflow`,
        node: name,
        path: `$.pinData[${JSON.stringify(name)}]`,
      }));
  },
};
