import { formatPath, isPlainObject } from '../util/json.js';
import { shannonEntropy } from '../util/hash.js';

/**
 * @typedef {object} SecretFinding
 * @property {string} kind                  detector id, e.g. "bearer-token"
 * @property {string} description
 * @property {'high'|'medium'|'low'} confidence
 * @property {Array<string|number>} path    path to the string that contains the secret
 * @property {string} pathText              JSON-path form of `path`
 * @property {string} match                 the secret itself (never print this)
 * @property {string} masked                safe preview
 * @property {number} start                 offset of the match inside the string
 * @property {number} end
 */

/**
 * @typedef {object} DetectorOptions
 * @property {number} [entropyThreshold]   bits/char for the generic detector (default 4.0)
 * @property {number} [minEntropyLength]   minimum token length for the generic detector (default 24)
 * @property {boolean} [entropy]           enable the generic entropy detector (default true)
 * @property {string[]} [allowPatterns]    regex sources; matching values are never reported
 * @property {string[]} [ignoreKeys]       extra key names whose values are never scanned
 */

const DASHES = '-'.repeat(5);

/**
 * Value patterns. Group 1, when present, is the secret part of the match.
 * @type {ReadonlyArray<{kind: string, description: string, confidence: 'high'|'medium', regex: RegExp}>}
 */
const VALUE_PATTERNS = Object.freeze([
  { kind: 'private-key', description: 'PEM private key block', confidence: 'high', regex: new RegExp(`${DASHES}BEGIN [A-Z ]*PRIVATE KEY${DASHES}[\\s\\S]*?(?:${DASHES}END [A-Z ]*PRIVATE KEY${DASHES}|$)`, 'g') },
  { kind: 'aws-access-key-id', description: 'AWS access key id', confidence: 'high', regex: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g },
  { kind: 'github-token', description: 'GitHub token', confidence: 'high', regex: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { kind: 'slack-token', description: 'Slack token', confidence: 'high', regex: /\b(xox[abeoprs]-[A-Za-z0-9-]{10,})\b/g },
  { kind: 'stripe-key', description: 'Stripe API key', confidence: 'high', regex: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g },
  { kind: 'google-api-key', description: 'Google API key', confidence: 'high', regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g },
  { kind: 'jwt', description: 'JSON Web Token', confidence: 'high', regex: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g },
  { kind: 'bearer-token', description: 'Bearer token', confidence: 'high', regex: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}={0,2})/gi },
  { kind: 'basic-auth', description: 'HTTP Basic credentials', confidence: 'medium', regex: /\bBasic\s+([A-Za-z0-9+/]{16,}={0,2})/g },
  { kind: 'url-credentials', description: 'URL with embedded password', confidence: 'high', regex: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s:@]{3,})@/gi },
  { kind: 'slack-webhook', description: 'Slack incoming webhook URL', confidence: 'high', regex: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/([A-Za-z0-9/_-]{20,})/g },
  { kind: 'discord-webhook', description: 'Discord webhook URL', confidence: 'high', regex: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/([A-Za-z0-9_-]{20,})/g },
  { kind: 'teams-webhook', description: 'Microsoft Teams webhook URL', confidence: 'high', regex: /https:\/\/[a-z0-9-]+\.webhook\.office\.com\/webhookb2\/([A-Za-z0-9@/_-]{20,})/g },
  { kind: 'url-token', description: 'URL query parameter carrying a credential', confidence: 'medium', regex: /[?&](?:access_token|api_key|apikey|api-key|token|key|secret|client_secret|signature|sig|auth|password|passwd|pwd)=([^&#\s"']{8,})/gi },
]);

/** Key names that suggest the value is a credential. */
const SENSITIVE_KEY = /(pass(?:word|wd|phrase)?|secret|token|api[-_ ]?key|apikey|authorization|private[-_ ]?key|access[-_ ]?key|client[-_ ]?secret|x-api-key|signing[-_ ]?key)/i;

/** Keys for which any literal value counts, however weak it looks. */
const PASSWORD_KEY = /^(pass(?:word|wd|phrase)?|secret|client[-_ ]?secret)$/i;

/** Keys that match SENSITIVE_KEY but hold configuration, not credentials. */
const NON_SECRET_KEYS = new Set([
  'authentication', 'genericauthtype', 'nodecredentialtype', 'tokentype', 'authtype', 'passwordless',
  'tokenendpoint', 'tokenurl', 'accesstokenurl', 'secretname', 'tokenfield', 'passwordfield', 'apikeyname',
  'keytype', 'tokenexpiry', 'maxtokens', 'tokens', 'tokenlimit', 'authentication_method',
]);

/** Keys whose values are identifiers and must not be entropy-scanned. */
const ID_LIKE_KEY = /(^id$|id$|Id$|ID$|^cachedResult|^webhookId$|^path$|^__rl$|^mode$|hash$|checksum$|^versionId$|^instanceId$)/;

const PLACEHOLDER = /(YOUR[_-]|<[^<>]+>|x{4,}|\*{3,}|\bexample\b|placeholder|changeme|change[_-]me|redacted|dummy|sample|\bfake\b|\btodo\b|insert[_-]|\$\{[^}]*\}|^\s*$)/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replace n8n expression bodies (`{{ ... }}`) with spaces so that references
 * such as `{{ $env.API_TOKEN }}` or `{{ $credentials.token }}` are not treated
 * as literals. Offsets are preserved.
 * @param {string} text
 */
export function blankExpressions(text) {
  return text.replace(/\{\{[\s\S]*?\}\}/g, (m) => ' '.repeat(m.length));
}

/**
 * @param {string} value
 * @returns {boolean} true when the value is obviously a placeholder
 */
export function isPlaceholder(value) {
  return PLACEHOLDER.test(value);
}

/**
 * Mask a secret for display: keep at most the first two characters.
 * @param {string} secret
 */
export function maskSecret(secret) {
  const visible = secret.length >= 12 ? secret.slice(0, 2) : '';
  return `${visible}${'*'.repeat(Math.min(8, Math.max(4, secret.length - visible.length)))} (${secret.length} chars)`;
}

/**
 * Does a literal look like a machine credential rather than a word?
 * @param {string} value
 */
function looksRandom(value) {
  if (value.length < 8 || /\s/.test(value)) return false;
  const hasDigit = /\d/.test(value);
  const hasLetter = /[A-Za-z]/.test(value);
  const hasSpecial = /[^A-Za-z0-9]/.test(value);
  if (hasDigit && hasLetter) return true;
  if (hasSpecial && (hasDigit || hasLetter) && shannonEntropy(value) >= 3) return true;
  return value.length >= 32 && shannonEntropy(value) >= 4;
}

/**
 * Scan one string for secrets.
 * @param {string} raw
 * @param {{key?: string, siblingName?: string, options?: DetectorOptions, allow?: RegExp[]}} [context]
 * @returns {Array<Omit<SecretFinding, 'path'|'pathText'>>}
 */
export function scanString(raw, context = {}) {
  const options = context.options ?? {};
  const allow = context.allow ?? [];
  if (typeof raw !== 'string' || raw.length < 6) return [];
  if (allow.some((re) => re.test(raw))) return [];
  const isExpression = raw.startsWith('=');
  const text = isExpression ? blankExpressions(raw) : raw;
  /** @type {Array<Omit<SecretFinding, 'path'|'pathText'>>} */
  const found = [];
  /** @type {Array<[number, number]>} */
  const taken = [];
  /** @param {number} s @param {number} e */
  const overlaps = (s, e) => taken.some(([ts, te]) => s < te && e > ts);
  /**
   * @param {string} kind @param {string} description @param {'high'|'medium'|'low'} confidence
   * @param {string} match @param {number} start
   */
  const add = (kind, description, confidence, match, start) => {
    const end = start + match.length;
    if (match.trim() === '' || isPlaceholder(match) || overlaps(start, end)) return;
    taken.push([start, end]);
    found.push({ kind, description, confidence, match, masked: maskSecret(match), start, end });
  };

  for (const pattern of VALUE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const m of text.matchAll(pattern.regex)) {
      const secret = m[1] ?? m[0];
      const start = (m.index ?? 0) + m[0].indexOf(secret);
      add(pattern.kind, pattern.description, pattern.confidence, secret, start);
    }
  }

  const key = context.key ?? '';
  const names = [key, context.siblingName ?? ''].filter(Boolean);
  const sensitiveName = names.find((n) => SENSITIVE_KEY.test(n) && !NON_SECRET_KEYS.has(n.toLowerCase().replace(/[\s]/g, '')));
  if (sensitiveName && found.length === 0) {
    const literal = (isExpression ? text.slice(1) : text).trim();
    const offset = text.indexOf(literal);
    const bare = sensitiveName.toLowerCase();
    const qualifies = PASSWORD_KEY.test(bare) ? literal.length >= 4 && !/\s{2,}/.test(literal) : looksRandom(literal);
    if (literal !== '' && qualifies) {
      add('sensitive-key', `Literal value for sensitive field "${sensitiveName}"`, 'medium', literal, Math.max(0, offset));
    }
  }

  if (options.entropy !== false && !ID_LIKE_KEY.test(key)) {
    const threshold = options.entropyThreshold ?? 4.0;
    const minLength = options.minEntropyLength ?? 24;
    const tokenRe = /[A-Za-z0-9+/_=-]{16,}/g;
    for (const m of text.matchAll(tokenRe)) {
      const token = m[0];
      if (token.length < minLength || UUID.test(token)) continue;
      if (!/\d/.test(token) || !/[A-Za-z]/.test(token)) continue;
      // Paths, slugs and identifiers contain long runs of dictionary words.
      if (/^[a-z]+(?:[-_/][a-z0-9]+)+$/.test(token) && !/\d{3,}/.test(token)) continue;
      const isHex = /^[0-9a-fA-F]+$/.test(token);
      const entropy = shannonEntropy(token);
      if (entropy >= (isHex ? Math.min(threshold, 3.5) : threshold)) {
        add('high-entropy', `High-entropy string (${entropy.toFixed(1)} bits/char)`, 'low', token, m.index ?? 0);
      }
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Recursively scan a JSON value.
 * @param {unknown} value
 * @param {DetectorOptions} [options]
 * @param {Array<string|number>} [basePath]
 * @returns {SecretFinding[]}
 */
export function findSecrets(value, options = {}, basePath = []) {
  /** @type {SecretFinding[]} */
  const findings = [];
  const allow = (options.allowPatterns ?? []).map((source) => new RegExp(source));
  const ignoreKeys = new Set(options.ignoreKeys ?? []);

  /**
   * @param {unknown} node
   * @param {Array<string|number>} path
   * @param {string} key
   * @param {string} siblingName
   */
  const visit = (node, path, key, siblingName) => {
    if (typeof node === 'string') {
      for (const hit of scanString(node, { key, siblingName, options, allow })) {
        findings.push({ ...hit, path, pathText: formatPath(path) });
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...path, index], key, siblingName));
    } else if (isPlainObject(node)) {
      // n8n stores header/query/body pairs as {name, value}: the name tells us
      // what the value is.
      const pairName = typeof node.name === 'string' ? node.name : typeof node.key === 'string' ? node.key : '';
      for (const [childKey, child] of Object.entries(node)) {
        if (ignoreKeys.has(childKey)) continue;
        visit(child, [...path, childKey], childKey, childKey === 'value' ? pairName : '');
      }
    }
  };
  visit(value, basePath, typeof basePath[basePath.length - 1] === 'string' ? String(basePath[basePath.length - 1]) : '', '');
  return findings;
}

/**
 * Scan the parts of a workflow where users type values: node parameters,
 * pinned data and static data. Structural fields (ids, types, positions,
 * credential references) are not scanned.
 * @param {Record<string, any>} workflow
 * @param {DetectorOptions} [options]
 * @returns {Array<SecretFinding & {node: string|null}>}
 */
export function findWorkflowSecrets(workflow, options = {}) {
  /** @type {Array<SecretFinding & {node: string|null}>} */
  const out = [];
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  nodes.forEach((node, index) => {
    if (!isPlainObject(node)) return;
    for (const field of ['parameters', 'notes']) {
      if (node[field] === undefined) continue;
      for (const finding of findSecrets(node[field], options, ['nodes', index, field])) {
        out.push({ ...finding, node: typeof node.name === 'string' ? node.name : null });
      }
    }
  });
  for (const field of ['pinData', 'staticData']) {
    if (isPlainObject(workflow?.[field])) {
      for (const finding of findSecrets(workflow[field], options, [field])) out.push({ ...finding, node: null });
    }
  }
  return out;
}
