import { isPlainObject } from '../util/json.js';

/**
 * Point every credential reference of a workflow at the credential with the
 * same name (and type) on the target instance. Credential ids differ between
 * environments; names are the stable handle.
 *
 * The workflow is modified in place.
 * @param {Record<string, any>} workflow
 * @param {Array<{id: string, name: string, type: string}>|null} credentials  target credentials, null when unknown
 * @param {Record<string, string>} [nameMap]   source credential name -> target credential name
 * @returns {{remapped: number, warnings: string[]}}
 */
export function remapCredentials(workflow, credentials, nameMap = {}) {
  /** @type {string[]} */
  const warnings = [];
  let remapped = 0;
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  for (const node of nodes) {
    if (!isPlainObject(node) || !isPlainObject(node.credentials)) continue;
    for (const [type, ref] of Object.entries(node.credentials)) {
      if (!isPlainObject(ref)) continue;
      const sourceName = typeof ref.name === 'string' ? ref.name : '';
      const targetName = nameMap[sourceName] ?? sourceName;
      if (targetName !== sourceName) ref.name = targetName;
      if (credentials === null) continue;
      if (targetName === '') {
        warnings.push(`Node "${node.name}": credential of type ${type} has no name and cannot be remapped`);
        continue;
      }
      const sameName = credentials.filter((cred) => cred.name === targetName);
      const matches = sameName.filter((cred) => cred.type === type);
      const candidates = matches.length > 0 ? matches : sameName.filter((cred) => !cred.type);
      if (candidates.length === 0) {
        warnings.push(`Node "${node.name}": no credential named "${targetName}" of type ${type} on the target instance`);
        continue;
      }
      if (candidates.length > 1) {
        warnings.push(`Node "${node.name}": ${candidates.length} credentials named "${targetName}" of type ${type}; using the first`);
      }
      if (String(ref.id ?? '') !== candidates[0].id) {
        ref.id = candidates[0].id;
        remapped += 1;
      }
    }
  }
  return { remapped, warnings };
}

/**
 * Does any node of the workflow reference a credential?
 * @param {Record<string, any>} workflow
 */
export function usesCredentials(workflow) {
  return (Array.isArray(workflow.nodes) ? workflow.nodes : []).some(
    (node) => isPlainObject(node) && isPlainObject(node.credentials) && Object.keys(node.credentials).length > 0,
  );
}

/**
 * Rewrite references to other workflows (sub-workflow calls and the error
 * workflow setting) through an id map. Modifies the workflow in place.
 * @param {Record<string, any>} workflow
 * @param {Record<string, string>} idMap   source id -> target id
 * @returns {{remapped: number, warnings: string[]}}
 */
export function remapWorkflowReferences(workflow, idMap) {
  /** @type {string[]} */
  const warnings = [];
  let remapped = 0;
  /**
   * @param {string} id
   * @param {string} where
   * @returns {string}
   */
  const translate = (id, where) => {
    if (id === '' || id.startsWith('=')) return id; // expressions are left alone
    const target = idMap[id];
    if (target === undefined) {
      warnings.push(`${where}: referenced workflow ${id} has no entry in the id map yet (push again after it is created)`);
      return id;
    }
    if (target !== id) remapped += 1;
    return target;
  };
  if (isPlainObject(workflow.settings) && typeof workflow.settings.errorWorkflow === 'string') {
    workflow.settings.errorWorkflow = translate(workflow.settings.errorWorkflow, 'settings.errorWorkflow');
  }
  for (const node of Array.isArray(workflow.nodes) ? workflow.nodes : []) {
    if (!isPlainObject(node) || node.type !== 'n8n-nodes-base.executeWorkflow' || !isPlainObject(node.parameters)) continue;
    const ref = node.parameters.workflowId;
    if (typeof ref === 'string') {
      node.parameters.workflowId = translate(ref, `Node "${node.name}"`);
    } else if (isPlainObject(ref) && typeof ref.value === 'string' && ref.mode !== 'url') {
      ref.value = translate(ref.value, `Node "${node.name}"`);
      delete ref.cachedResultName;
      delete ref.cachedResultUrl;
    }
  }
  return { remapped, warnings };
}
