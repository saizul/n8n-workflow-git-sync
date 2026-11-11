import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../src/cli.js';
import { writeFileAtomic } from '../src/util/fs.js';
import { stableStringify } from '../src/util/json.js';
import { cli } from './helpers/cli.js';
import { connect, fakeSecret, node, scheduledWorkflow, tempDir, workflow } from './helpers/fixtures.js';

/** A directory with the two clean fixture workflows. */
async function project(t, extra = {}) {
  const cwd = await tempDir(t);
  await writeFileAtomic(path.join(cwd, 'workflows/order-intake--101.json'), stableStringify(workflow()));
  await writeFileAtomic(path.join(cwd, 'workflows/nightly-report--102.json'), stableStringify(scheduledWorkflow()));
  for (const [file, content] of Object.entries(extra)) {
    await writeFileAtomic(path.join(cwd, file), typeof content === 'string' ? content : stableStringify(content));
  }
  return cwd;
}
function openWebhook() {
  const wf = workflow({ id: '103', name: 'Open hook' });
  wf.nodes[0].parameters.authentication = 'none';
  return wf;
}

test('no arguments prints usage and exits 2; --help exits 0', async (t) => {
  const cwd = await tempDir(t);
  const bare = await cli([], { cwd });
  assert.equal(bare.code, 2);
  assert.match(bare.out, /Usage: n8n-sync <command>/);
  const help = await cli(['--help'], { cwd });
  assert.equal(help.code, 0);
  for (const name of ['pull', 'push', 'diff', 'lint', 'validate', 'redact', 'graph', 'docs', 'backup', 'restore']) {
    assert.match(help.out, new RegExp(`\\n\\s+${name}\\s`), name);
  }
});

test('--version, per-command help and unknown commands', async (t) => {
  const cwd = await tempDir(t);
  assert.equal((await cli(['--version'], { cwd })).out.trim(), VERSION);
  const help = await cli(['lint', '--help'], { cwd });
  assert.equal(help.code, 0);
  assert.match(help.out, /--fail-on/);
  assert.match((await cli(['help', 'push'], { cwd })).out, /--id-map/);
  const unknown = await cli(['frobnicate'], { cwd });
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Unknown command "frobnicate"/);
  const badFlag = await cli(['lint', '--no-such-flag'], { cwd });
  assert.equal(badFlag.code, 2);
});

test('lint exits 0 on clean workflows', async (t) => {
  const cwd = await project(t);
  const result = await cli(['lint', 'workflows'], { cwd });
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /No problems found in 2 workflows\./);
});

test('lint exits 1 on errors and names the file, rule and node', async (t) => {
  const cwd = await project(t, { 'workflows/open-hook--103.json': openWebhook() });
  const result = await cli(['lint', 'workflows'], { cwd });
  assert.equal(result.code, 1);
  assert.match(result.out, /workflows\/open-hook--103\.json \(Open hook\)/);
  assert.match(result.out, /error\s+webhook-authentication/);
  assert.match(result.out, /1 problem in 3 workflows: 1 error, 0 warnings, 0 info/);
});

test('lint --rule and --fail-on change the verdict', async (t) => {
  const cwd = await project(t, { 'workflows/open-hook--103.json': openWebhook() });
  assert.equal((await cli(['lint', 'workflows', '--rule', 'webhook-authentication=off'], { cwd })).code, 0);
  assert.equal((await cli(['lint', 'workflows', '--rule', 'webhook-authentication=warning'], { cwd })).code, 0);
  assert.equal((await cli(['lint', 'workflows', '--rule', 'webhook-authentication=warning', '--fail-on', 'warning'], { cwd })).code, 1);
  assert.equal((await cli(['lint', 'workflows', '--fail-on', 'none'], { cwd })).code, 0);
  const bad = await cli(['lint', 'workflows', '--rule', 'no-such-rule=error'], { cwd });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /Unknown lint rule/);
});

test('lint reads severities and options from .n8nsyncrc.json', async (t) => {
  const cwd = await project(t, {
    'workflows/open-hook--103.json': openWebhook(),
    '.n8nsyncrc.json': { lint: { rules: { 'webhook-authentication': 'off', 'naming-convention': ['error', { workflowPattern: '^\\[' }] } } },
  });
  const result = await cli(['lint', 'workflows', '--format', 'json'], { cwd });
  assert.equal(result.code, 1);
  const report = JSON.parse(result.out);
  assert.deepEqual([...new Set(report.findings.map((/** @type {any} */ f) => f.ruleId))], ['naming-convention']);
  assert.equal(report.summary.error, 3);
  assert.equal(report.summary.filesChecked, 3);
});

test('lint --format sarif and github produce machine output with line numbers', async (t) => {
  const cwd = await project(t, { 'workflows/open-hook--103.json': openWebhook() });
  const sarif = JSON.parse((await cli(['lint', 'workflows', '--format', 'sarif'], { cwd })).out);
  const [result] = sarif.runs[0].results;
  assert.equal(result.ruleId, 'webhook-authentication');
  assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'workflows/open-hook--103.json');
  assert.ok(result.locations[0].physicalLocation.region.startLine > 1);
  assert.equal(sarif.runs[0].tool.driver.version, VERSION);
  const github = await cli(['lint', 'workflows', '--format', 'github'], { cwd });
  assert.match(github.out, /^::error file=workflows\/open-hook--103\.json,line=\d+,title=webhook-authentication::/m);
  assert.equal(github.code, 1);
});

test('lint --output writes the report to a file', async (t) => {
  const cwd = await project(t, { 'workflows/open-hook--103.json': openWebhook() });
  const result = await cli(['lint', 'workflows', '--format', 'sarif', '--output', 'reports/lint.sarif'], { cwd });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(await readFile(path.join(cwd, 'reports/lint.sarif'), 'utf8')).version, '2.1.0');
});

test('lint --list-rules prints all 14 rules', async (t) => {
  const result = await cli(['lint', '--list-rules'], { cwd: await tempDir(t) });
  assert.equal(result.code, 0);
  for (const id of ['no-hardcoded-secrets', 'webhook-authentication', 'no-cycles', 'sticky-note-documentation']) assert.ok(result.out.includes(id), id);
});

test('lint never prints a detected secret', async (t) => {
  const secret = fakeSecret('stripe');
  const wf = workflow({ id: '104', name: 'Leaky' });
  wf.nodes[1].parameters.apiKey = secret;
  const cwd = await project(t, { 'workflows/leaky--104.json': wf });
  for (const format of ['text', 'json', 'sarif', 'github']) {
    const result = await cli(['lint', 'workflows', '--format', format], { cwd });
    assert.equal(result.code, 1, format);
    assert.match(result.out, /no-hardcoded-secrets/);
    assert.ok(!result.out.includes(secret) && !result.err.includes(secret), format);
  }
});

test('lint reports unreadable files and missing targets', async (t) => {
  const cwd = await project(t, { 'workflows/broken.json': '{ nope' });
  const broken = await cli(['lint', 'workflows'], { cwd });
  assert.equal(broken.code, 1);
  assert.match(broken.err, /broken\.json/);
  const missing = await cli(['lint', 'nowhere'], { cwd });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /No such file or directory/);
});

test('validate passes clean workflows and fails on structural errors', async (t) => {
  const cwd = await project(t);
  const ok = await cli(['validate', 'workflows'], { cwd });
  assert.equal(ok.code, 0, ok.out + ok.err);
  const bad = workflow({ id: '105', name: 'Dangling', connections: connect([['Receive order', 'Ghost']]) });
  await writeFileAtomic(path.join(cwd, 'workflows/dangling--105.json'), stableStringify(bad));
  const failed = await cli(['validate', 'workflows'], { cwd });
  assert.equal(failed.code, 1);
  assert.match(failed.out + failed.err, /dangling--105\.json/);
  assert.match(failed.out + failed.err, /Ghost/);
});

test('validate --json, --strict and duplicate ids', async (t) => {
  const cwd = await project(t, { 'copy/order-intake--101.json': workflow() });
  const dupes = await cli(['validate', '.', '--json'], { cwd });
  assert.equal(dupes.code, 1);
  assert.ok(JSON.stringify(JSON.parse(dupes.out)).includes('workflow-id-duplicate'));
  const warnOnly = await project(t, { 'workflows/pinned--106.json': workflow({ id: '106', name: 'Pinned', pinData: { Ghost: [] } }) });
  assert.equal((await cli(['validate', 'workflows'], { cwd: warnOnly })).code, 0);
  assert.equal((await cli(['validate', 'workflows', '--strict'], { cwd: warnOnly })).code, 1);
});

test('redact prints a cleaned single workflow to stdout', async (t) => {
  const secret = fakeSecret('github');
  const wf = workflow({ id: '104', name: 'Leaky' });
  wf.nodes[1].parameters.token = secret;
  const cwd = await project(t, { 'leaky.json': wf });
  const result = await cli(['redact', 'leaky.json'], { cwd });
  assert.equal(result.code, 0);
  assert.ok(!result.out.includes(secret));
  assert.equal(JSON.parse(result.out).nodes.find((/** @type {any} */ n) => n.name === 'Look up customer').parameters.token, '***REDACTED***');
  assert.ok((await readFile(path.join(cwd, 'leaky.json'), 'utf8')).includes(secret), 'the source file is untouched without --write');
});

test('redact --check fails when secrets are present; --write fixes the files in place', async (t) => {
  const secret = fakeSecret('aws');
  const wf = workflow({ id: '104', name: 'Leaky' });
  wf.nodes[1].parameters.accessKeyId = secret;
  const cwd = await project(t, { 'workflows/leaky--104.json': wf });
  const check = await cli(['redact', 'workflows', '--check'], { cwd });
  assert.equal(check.code, 1);
  assert.match(check.out + check.err, /leaky--104\.json/);
  assert.ok(!(check.out + check.err).includes(secret));
  const write = await cli(['redact', 'workflows', '--write'], { cwd });
  assert.equal(write.code, 0);
  assert.ok(!(await readFile(path.join(cwd, 'workflows/leaky--104.json'), 'utf8')).includes(secret));
  assert.equal((await cli(['redact', 'workflows', '--check'], { cwd })).code, 0);
});

test('redact --out-dir writes cleaned copies and --mode strip empties values', async (t) => {
  const wf = workflow({ id: '104', name: 'Leaky' });
  wf.nodes[1].parameters.token = fakeSecret('slack');
  const cwd = await project(t, { 'workflows/leaky--104.json': wf });
  const result = await cli(['redact', 'workflows', '--out-dir', 'public', '--mode', 'strip', '--json'], { cwd });
  assert.equal(result.code, 0);
  const copy = JSON.parse(await readFile(path.join(cwd, 'public/leaky--104.json'), 'utf8'));
  assert.equal(copy.nodes.find((/** @type {any} */ n) => n.name === 'Look up customer').parameters.token, '');
  assert.ok(JSON.parse(result.out));
});

test('graph renders Mermaid by default, selected by file, id or name', async (t) => {
  const cwd = await project(t);
  const byFile = await cli(['graph', 'workflows/order-intake--101.json'], { cwd });
  assert.equal(byFile.code, 0);
  assert.match(byFile.out, /^flowchart LR\n/);
  const byId = await cli(['graph', '101', '--dir', 'workflows'], { cwd });
  const byName = await cli(['graph', 'Order intake', '--dir', 'workflows'], { cwd });
  assert.equal(byId.out, byFile.out);
  assert.equal(byName.out, byFile.out);
  assert.equal((await cli(['graph', 'No such flow', '--dir', 'workflows'], { cwd })).code, 2);
});

test('graph --format dot, --direction, --markdown and --output', async (t) => {
  const cwd = await project(t);
  const dot = await cli(['graph', '102', '--dir', 'workflows', '--format', 'dot', '--direction', 'TB'], { cwd });
  assert.match(dot.out, /^digraph "Nightly report" \{\n {2}rankdir=TB;/);
  const md = await cli(['graph', '102', '--dir', 'workflows', '--markdown'], { cwd });
  assert.match(md.out, /^```mermaid\nflowchart LR\n/);
  const out = await cli(['graph', '102', '--dir', 'workflows', '--output', 'docs/nightly.mmd'], { cwd });
  assert.equal(out.code, 0);
  assert.match(await readFile(path.join(cwd, 'docs/nightly.mmd'), 'utf8'), /^flowchart LR/);
  assert.equal((await cli(['graph', '102', '--dir', 'workflows', '--format', 'svg'], { cwd })).code, 2);
});

test('docs prints a catalogue, writes it with --output and verifies it with --check', async (t) => {
  const cwd = await project(t);
  const printed = await cli(['docs', 'workflows', '--title', 'Automation inventory'], { cwd });
  assert.equal(printed.code, 0);
  assert.match(printed.out, /^# Automation inventory\n/);
  assert.match(printed.out, /\| \[Order intake\]\(#order-intake\) \| yes \| webhook \| 3 \| orders \|/);
  assert.equal((await cli(['docs', 'workflows', '--output', 'WORKFLOWS.md', '--check'], { cwd })).code, 1, 'missing file is stale');
  assert.equal((await cli(['docs', 'workflows', '--output', 'WORKFLOWS.md', '--graphs'], { cwd })).code, 0);
  assert.match(await readFile(path.join(cwd, 'WORKFLOWS.md'), 'utf8'), /```mermaid/);
  assert.equal((await cli(['docs', 'workflows', '--output', 'WORKFLOWS.md', '--graphs', '--check'], { cwd })).code, 0);
  await writeFileAtomic(path.join(cwd, 'workflows/extra--107.json'), stableStringify(workflow({ id: '107', name: 'Extra', nodes: [node('Start', 'manualTrigger')], connections: {} })));
  assert.equal((await cli(['docs', 'workflows', '--output', 'WORKFLOWS.md', '--graphs', '--check'], { cwd })).code, 1);
});

test('commands that need the API explain what is missing', async (t) => {
  const cwd = await project(t);
  const result = await cli(['pull'], { cwd, env: {} });
  assert.equal(result.code, 2);
  assert.match(result.err, /N8N_BASE_URL/);
  const noKey = await cli(['pull'], { cwd, env: { N8N_BASE_URL: 'https://n8n.example.com' } });
  assert.equal(noKey.code, 2);
  assert.match(noKey.err, /N8N_API_KEY/);
});
