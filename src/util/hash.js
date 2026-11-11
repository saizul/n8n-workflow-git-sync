import { createHash } from 'node:crypto';
import { canonicalJson } from './json.js';

/**
 * @param {string|Uint8Array} data
 * @returns {string} lowercase hex sha256
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hash of the canonical JSON form of a value. Key order does not affect the
 * result.
 * @param {unknown} value
 */
export function hashJson(value) {
  return sha256(canonicalJson(value));
}

/**
 * Shannon entropy in bits per character.
 * @param {string} text
 */
export function shannonEntropy(text) {
  if (text.length === 0) return 0;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
