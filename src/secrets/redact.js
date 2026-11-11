import { clone, getAtPath, setAtPath } from '../util/json.js';
import { findWorkflowSecrets } from './detector.js';

export const REDACTION_MARKER = '***REDACTED***';

/**
 * @typedef {object} RedactionResult
 * @property {Record<string, any>} workflow   redacted copy
 * @property {Array<{node: string|null, path: string, kind: string, action: 'mask'|'strip'}>} changes
 */

/**
 * Remove secrets found by the detector from a workflow.
 *
 * - `mask` replaces only the secret substring with a marker, keeping the
 *   surrounding text (for example `Bearer ***REDACTED***`).
 * - `strip` replaces the whole value with an empty string.
 *
 * The input is not modified.
 * @param {Record<string, any>} workflow
 * @param {{mode?: 'mask'|'strip', marker?: string, detector?: import('./detector.js').DetectorOptions, minConfidence?: 'low'|'medium'|'high'}} [options]
 * @returns {RedactionResult}
 */
export function redactWorkflow(workflow, options = {}) {
  const { mode = 'mask', marker = REDACTION_MARKER, minConfidence = 'low' } = options;
  const rank = { low: 0, medium: 1, high: 2 };
  const copy = clone(workflow);
  const findings = findWorkflowSecrets(copy, options.detector).filter((f) => rank[f.confidence] >= rank[minConfidence]);
  /** @type {Map<string, typeof findings>} */
  const byPath = new Map();
  for (const finding of findings) {
    byPath.set(finding.pathText, [...(byPath.get(finding.pathText) ?? []), finding]);
  }
  /** @type {RedactionResult['changes']} */
  const changes = [];
  for (const group of byPath.values()) {
    const { path } = group[0];
    const current = getAtPath(copy, path);
    if (typeof current !== 'string') continue;
    let next = current;
    if (mode === 'strip') {
      next = '';
    } else {
      // replace from the end so earlier offsets stay valid
      for (const finding of [...group].sort((a, b) => b.start - a.start)) {
        next = `${next.slice(0, finding.start)}${marker}${next.slice(finding.end)}`;
      }
    }
    setAtPath(copy, path, next);
    for (const finding of group) {
      changes.push({ node: finding.node, path: finding.pathText, kind: finding.kind, action: mode });
    }
  }
  return { workflow: copy, changes };
}
