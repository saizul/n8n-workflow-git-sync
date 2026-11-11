import { isPlainObject } from '../util/json.js';

/**
 * @typedef {object} ValidationIssue
 * @property {string} code
 * @property {'error'|'warning'} severity
 * @property {string} message
 * @property {string} path     JSON-path into the workflow
 */

/**
 * Structural validation of a workflow document. This checks that the JSON is
 * something n8n can import, not that the workflow is well designed (that is
 * what `lint` is for).
 * @param {unknown} workflow
 * @returns {ValidationIssue[]}
 */
export function validateWorkflow(workflow) {
  /** @type {ValidationIssue[]} */
  const issues = [];
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} path
   * @param {'error'|'warning'} [severity]
   */
  const add = (code, message, path, severity = 'error') => issues.push({ code, severity, message, path });

  if (!isPlainObject(workflow)) {
    add('root-type', 'Workflow must be a JSON object', '$');
    return issues;
  }
  if (typeof workflow.name !== 'string' || workflow.name.trim() === '') {
    add('name-missing', 'Workflow must have a non-empty string "name"', '$.name');
  } else if (workflow.name.length > 128) {
    add('name-too-long', `Workflow name is ${workflow.name.length} characters; n8n allows at most 128`, '$.name');
  }
  if (workflow.active !== undefined && typeof workflow.active !== 'boolean') {
    add('active-type', '"active" must be a boolean', '$.active');
  }
  if (workflow.settings !== undefined && !isPlainObject(workflow.settings)) {
    add('settings-type', '"settings" must be an object', '$.settings');
  }
  if (workflow.tags !== undefined && !Array.isArray(workflow.tags)) {
    add('tags-type', '"tags" must be an array', '$.tags');
  }
  if (!Array.isArray(workflow.nodes)) {
    add('nodes-type', 'Workflow must have a "nodes" array', '$.nodes');
    return issues;
  }

  /** @type {Map<string, number>} */
  const names = new Map();
  /** @type {Map<string, number>} */
  const ids = new Map();
  workflow.nodes.forEach((node, index) => {
    const at = `$.nodes[${index}]`;
    if (!isPlainObject(node)) {
      add('node-type', 'Node must be an object', at);
      return;
    }
    if (typeof node.name !== 'string' || node.name.trim() === '') {
      add('node-name-missing', 'Node must have a non-empty string "name"', `${at}.name`);
    } else if (names.has(node.name)) {
      add('node-name-duplicate', `Duplicate node name "${node.name}" (also at $.nodes[${names.get(node.name)}])`, `${at}.name`);
    } else {
      names.set(node.name, index);
    }
    if (node.id !== undefined) {
      if (typeof node.id !== 'string' || node.id === '') {
        add('node-id-type', 'Node "id" must be a non-empty string', `${at}.id`);
      } else if (ids.has(node.id)) {
        add('node-id-duplicate', `Duplicate node id "${node.id}" (also at $.nodes[${ids.get(node.id)}])`, `${at}.id`);
      } else {
        ids.set(node.id, index);
      }
    } else {
      add('node-id-missing', `Node "${node.name ?? index}" has no "id"; n8n will generate one on import`, `${at}.id`, 'warning');
    }
    if (typeof node.type !== 'string' || node.type.trim() === '') {
      add('node-type-missing', 'Node must have a non-empty string "type"', `${at}.type`);
    }
    if (typeof node.typeVersion !== 'number' || !Number.isFinite(node.typeVersion) || node.typeVersion <= 0) {
      add('node-type-version', 'Node must have a positive numeric "typeVersion"', `${at}.typeVersion`);
    }
    if (!Array.isArray(node.position) || node.position.length !== 2
      || !node.position.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      add('node-position', 'Node "position" must be an array of two numbers', `${at}.position`);
    }
    if (node.parameters !== undefined && !isPlainObject(node.parameters)) {
      add('node-parameters-type', 'Node "parameters" must be an object', `${at}.parameters`);
    }
    if (node.disabled !== undefined && typeof node.disabled !== 'boolean') {
      add('node-disabled-type', 'Node "disabled" must be a boolean', `${at}.disabled`);
    }
    if (node.credentials !== undefined) {
      if (!isPlainObject(node.credentials)) {
        add('node-credentials-type', 'Node "credentials" must be an object', `${at}.credentials`);
      } else {
        for (const [type, ref] of Object.entries(node.credentials)) {
          if (!isPlainObject(ref) || (typeof ref.name !== 'string' && ref.id === undefined)) {
            add('node-credential-ref', `Credential reference "${type}" must be an object with "id" and/or "name"`, `${at}.credentials.${type}`);
          }
        }
      }
    }
  });

  if (workflow.connections === undefined) {
    if (workflow.nodes.length > 1) add('connections-missing', 'Workflow has no "connections" object', '$.connections', 'warning');
    return issues;
  }
  if (!isPlainObject(workflow.connections)) {
    add('connections-type', '"connections" must be an object', '$.connections');
    return issues;
  }
  for (const [source, byType] of Object.entries(workflow.connections)) {
    const at = `$.connections[${JSON.stringify(source)}]`;
    if (!names.has(source)) {
      add('connection-source-unknown', `Connection source "${source}" is not a node in this workflow`, at);
    }
    if (!isPlainObject(byType)) {
      add('connection-shape', 'Connection entry must be an object keyed by connection type', at);
      continue;
    }
    for (const [type, slots] of Object.entries(byType)) {
      if (!Array.isArray(slots)) {
        add('connection-shape', `Connection type "${type}" must be an array of output slots`, `${at}.${type}`);
        continue;
      }
      slots.forEach((slot, slotIndex) => {
        if (slot === null) return; // n8n writes null for unused outputs
        if (!Array.isArray(slot)) {
          add('connection-shape', 'Output slot must be an array of targets', `${at}.${type}[${slotIndex}]`);
          return;
        }
        slot.forEach((target, targetIndex) => {
          const tat = `${at}.${type}[${slotIndex}][${targetIndex}]`;
          if (!isPlainObject(target) || typeof target.node !== 'string') {
            add('connection-target-shape', 'Connection target must be an object with a string "node"', tat);
            return;
          }
          if (!names.has(target.node)) {
            add('connection-target-unknown', `Connection from "${source}" points to unknown node "${target.node}"`, `${tat}.node`);
          }
          if (target.index !== undefined && (!Number.isInteger(target.index) || target.index < 0)) {
            add('connection-target-index', 'Connection target "index" must be a non-negative integer', `${tat}.index`);
          }
        });
      });
    }
  }

  if (isPlainObject(workflow.pinData)) {
    for (const key of Object.keys(workflow.pinData)) {
      if (!names.has(key)) {
        add('pin-data-unknown-node', `Pinned data references unknown node "${key}"`, `$.pinData[${JSON.stringify(key)}]`, 'warning');
      }
    }
  }
  return issues;
}

/**
 * @param {ValidationIssue[]} issues
 * @returns {boolean} true when there are no error-severity issues
 */
export function isValid(issues) {
  return !issues.some((issue) => issue.severity === 'error');
}
