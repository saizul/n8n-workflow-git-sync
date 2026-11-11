import test from 'node:test';
import assert from 'node:assert/strict';
import { blankExpressions, findSecrets, findWorkflowSecrets, isPlaceholder, maskSecret, scanString } from '../src/secrets/detector.js';
import { REDACTION_MARKER, redactWorkflow } from '../src/secrets/redact.js';
import { fakeSecret, workflow } from './helpers/fixtures.js';

/** A workflow with three planted secrets, all built at runtime. */
function leaky() {
  const wf = workflow();
  wf.nodes[1].parameters.headerParameters = {
    parameters: [{ name: 'Authorization', value: fakeSecret('bearer') }, { name: 'X-Api-Key', value: 'plainvalue12345' }],
  };
  wf.nodes[2].parameters.token = fakeSecret('github');
  wf.nodes[2].parameters.note = 'hello world';
  return wf;
}

for (const [kind, expected] of /** @type {const} */ ([
  ['bearer', 'bearer-token'], ['aws', 'aws-access-key-id'], ['github', 'github-token'], ['slack', 'slack-token'], ['stripe', 'stripe-key'], ['jwt', 'jwt'],
])) {
  test(`scanString recognises a ${kind} credential with high confidence`, () => {
    const findings = scanString(fakeSecret(kind));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, expected);
    assert.equal(findings[0].confidence, 'high');
  });
}

test('high-entropy strings are low confidence unless the key name is sensitive', () => {
  const value = fakeSecret('random');
  assert.deepEqual(scanString(value).map((f) => [f.kind, f.confidence]), [['high-entropy', 'low']]);
  assert.deepEqual(scanString(value, { key: 'apiKey' }).map((f) => [f.kind, f.confidence]), [['sensitive-key', 'medium']]);
  assert.deepEqual(scanString(value, { options: { entropy: false } }), []);
});

test('sensitive key names flag literal values but not expressions or placeholders', () => {
  assert.equal(scanString('hunter2pass', { key: 'password' }).length, 1);
  assert.deepEqual(scanString('={{ $env.DB_PASSWORD }}', { key: 'password' }), []);
  assert.deepEqual(scanString('YOUR_API_KEY', { key: 'token' }), []);
  assert.deepEqual(scanString('', { key: 'password' }), []);
});

test('name/value pairs use the sibling name as the key', () => {
  const findings = scanString('s3cr3t-value-xyz', { siblingName: 'X-Api-Key' });
  assert.deepEqual(findings.map((f) => f.kind), ['sensitive-key']);
  assert.deepEqual(scanString('s3cr3t-value-xyz', { siblingName: 'Accept' }), []);
});

test('credentials and tokens inside URLs are found with offsets', () => {
  const url = 'https://user:hunter2pass@api.example.com/v1?api_key=abc123def456ghi789&page=2';
  const findings = scanString(url);
  assert.deepEqual(findings.map((f) => f.kind), ['url-credentials', 'url-token']);
  assert.equal(url.slice(findings[0].start, findings[0].end), 'hunter2pass');
  assert.equal(url.slice(findings[1].start, findings[1].end), 'abc123def456ghi789');
});

test('ordinary text and URLs are not flagged', () => {
  for (const value of ['hello world', 'https://api.example.com/v1/customers?page=2', 'Order intake', '0 2 * * *', 'n8n-nodes-base.httpRequest']) {
    assert.deepEqual(scanString(value), [], value);
  }
});

test('isPlaceholder, maskSecret and blankExpressions', () => {
  assert.equal(isPlaceholder('YOUR_API_KEY'), true);
  assert.equal(isPlaceholder('changeme'), true);
  assert.equal(isPlaceholder('<token>'), true);
  assert.equal(isPlaceholder(fakeSecret('random')), false);
  assert.equal(maskSecret('abcdefghijklmnop'), 'ab******** (16 chars)');
  assert.ok(!maskSecret('abc').includes('abc'));
  const blanked = blankExpressions('a {{ $env.X }} b');
  assert.equal(blanked.length, 'a {{ $env.X }} b'.length, 'offsets are preserved');
  assert.ok(!blanked.includes('$env'));
});

test('masked previews never contain the full secret', () => {
  const secret = fakeSecret('github');
  const [finding] = scanString(secret);
  assert.equal(finding.match, secret);
  assert.ok(!finding.masked.includes(secret.slice(4)));
});

test('findSecrets walks nested values and honours detector options', () => {
  const value = { a: [{ password: 'hunter2pass' }] };
  assert.deepEqual(findSecrets(value).map((f) => f.pathText), ['$.a[0].password']);
  assert.deepEqual(findSecrets(value, { ignoreKeys: ['password'] }), []);
  assert.deepEqual(findSecrets({ k: fakeSecret('aws') }, { allowPatterns: ['^AKIA'] }), []);
  assert.deepEqual(findSecrets({ k: fakeSecret('random') }, { entropy: false }), []);
});

test('findWorkflowSecrets attributes findings to nodes', () => {
  const findings = findWorkflowSecrets(leaky());
  assert.deepEqual(findings.map((f) => [f.node, f.kind]), [
    ['Look up customer', 'bearer-token'], ['Look up customer', 'sensitive-key'], ['Shape response', 'github-token'],
  ]);
  assert.equal(findings[0].pathText, '$.nodes[1].parameters.headerParameters.parameters[0].value');
  assert.deepEqual(findWorkflowSecrets(workflow()), []);
});

test('redactWorkflow masks secrets in place of the value and keeps the scheme prefix', () => {
  const original = leaky();
  const { workflow: redacted, changes } = redactWorkflow(original);
  assert.equal(changes.length, 3);
  assert.ok(changes.every((change) => change.action === 'mask'));
  const headers = redacted.nodes[1].parameters.headerParameters.parameters;
  assert.equal(headers[0].value, `Bearer ${REDACTION_MARKER}`);
  assert.equal(headers[1].value, REDACTION_MARKER);
  assert.equal(redacted.nodes[2].parameters.token, REDACTION_MARKER);
  assert.equal(redacted.nodes[2].parameters.note, 'hello world');
});

test('redactWorkflow does not mutate its input and its output is clean', () => {
  const original = leaky();
  const before = JSON.stringify(original);
  const { workflow: redacted } = redactWorkflow(original);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(findWorkflowSecrets(redacted), []);
  assert.deepEqual(redactWorkflow(redacted).changes, []);
});

test('redactWorkflow strip mode empties values; marker and minConfidence are configurable', () => {
  const stripped = redactWorkflow(leaky(), { mode: 'strip' });
  assert.equal(stripped.workflow.nodes[2].parameters.token, '');
  assert.ok(stripped.changes.every((change) => change.action === 'strip'));
  const custom = redactWorkflow(leaky(), { marker: '<removed>' });
  assert.equal(custom.workflow.nodes[2].parameters.token, '<removed>');
  const strict = redactWorkflow(leaky(), { minConfidence: 'high' });
  assert.deepEqual(strict.changes.map((change) => change.kind), ['bearer-token', 'github-token']);
  assert.equal(strict.workflow.nodes[1].parameters.headerParameters.parameters[1].value, 'plainvalue12345');
});

test('redactWorkflow leaves a clean workflow byte-identical', () => {
  const wf = workflow();
  const result = redactWorkflow(wf);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.workflow, wf);
});
