import { noHardcodedSecrets, noPinnedData, webhookAuthentication } from './security.js';
import { deprecatedNodeVersions, httpTimeoutRetry, missingErrorWorkflow, nodeErrorHandling } from './reliability.js';
import { duplicateNodeNames, noCycles, noDisabledNodes, noOrphanNodes, validStructure } from './structure.js';
import { namingConvention, stickyNoteDocumentation } from './style.js';

/**
 * Every built-in rule, in the order they are documented.
 * @type {import('../engine.js').Rule[]}
 */
export const RULES = [
  validStructure,
  noHardcodedSecrets,
  webhookAuthentication,
  noPinnedData,
  nodeErrorHandling,
  missingErrorWorkflow,
  httpTimeoutRetry,
  deprecatedNodeVersions,
  duplicateNodeNames,
  noOrphanNodes,
  noCycles,
  noDisabledNodes,
  namingConvention,
  stickyNoteDocumentation,
];

/** @param {string} id */
export function getRule(id) {
  return RULES.find((rule) => rule.id === id);
}
