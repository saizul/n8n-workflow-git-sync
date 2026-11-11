import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { ConfigError } from '../src/errors.js';
import { RC_FILE_NAME, findRcFile, loadRc, normalizeBaseUrl, resolveConfig, validateRc } from '../src/config.js';
import { tempDir } from './helpers/fixtures.js';

const RC = {
  baseUrl: 'https://rc.example.com',
  dir: 'flows',
  defaultEnvironment: 'dev',
  environments: {
    dev: { baseUrl: 'https://dev.example.com', apiKeyEnv: 'N8N_DEV_KEY' },
    prod: {
      baseUrl: 'https://prod.example.com/',
      apiKeyEnv: 'N8N_PROD_KEY',
      idMap: 'env/prod.idmap.json',
      credentialMap: { 'CRM API': 'CRM API (prod)' },
    },
  },
};

test('normalizeBaseUrl strips trailing slashes and the /api/v1 suffix', () => {
  assert.equal(normalizeBaseUrl('https://n8n.example.com/'), 'https://n8n.example.com');
  assert.equal(normalizeBaseUrl(' https://n8n.example.com/api/v1/ '), 'https://n8n.example.com');
  assert.equal(normalizeBaseUrl('http://localhost:5678/n8n'), 'http://localhost:5678/n8n');
});

test('normalizeBaseUrl rejects other schemes, garbage and embedded credentials', () => {
  assert.throws(() => normalizeBaseUrl('ftp://n8n.example.com'), ConfigError);
  assert.throws(() => normalizeBaseUrl('not a url'), /Invalid base URL/);
  assert.throws(() => normalizeBaseUrl(`https://${['user', 'pw'].join(':')}@n8n.example.com`), /embedded credentials/);
});

test('flags beat environment variables, which beat the rc file', () => {
  const env = { N8N_BASE_URL: 'https://env.example.com', N8N_API_KEY: 'env-key' };
  const rc = { baseUrl: 'https://rc.example.com', apiKey: 'rc-key' };
  const fromFlag = resolveConfig({ flags: { baseUrl: 'https://flag.example.com', apiKey: 'flag-key' }, env, rc });
  assert.equal(fromFlag.baseUrl, 'https://flag.example.com');
  assert.equal(fromFlag.apiKey, 'flag-key');
  assert.equal(fromFlag.sources.apiKey, 'flag');
  const fromEnv = resolveConfig({ env, rc });
  assert.equal(fromEnv.baseUrl, 'https://env.example.com');
  assert.equal(fromEnv.apiKey, 'env-key');
  assert.equal(fromEnv.sources.baseUrl, 'env');
  const fromRc = resolveConfig({ env: {}, rc });
  assert.equal(fromRc.baseUrl, 'https://rc.example.com');
  assert.equal(fromRc.sources.baseUrl, 'rc');
});

test('the default environment supplies base URL and reads the key from apiKeyEnv', () => {
  const config = resolveConfig({ env: { N8N_DEV_KEY: 'dev-key' }, rc: RC });
  assert.equal(config.environment, 'dev');
  assert.equal(config.baseUrl, 'https://dev.example.com');
  assert.equal(config.apiKey, 'dev-key');
  assert.equal(config.sources.apiKey, 'env:N8N_DEV_KEY');
});

test('an explicit --env is not overridden by generic N8N_* variables', () => {
  const env = { N8N_BASE_URL: 'https://dev.example.com', N8N_API_KEY: 'dev-key', N8N_PROD_KEY: 'prod-key' };
  const config = resolveConfig({ flags: { env: 'prod' }, env, rc: RC });
  assert.equal(config.baseUrl, 'https://prod.example.com');
  assert.equal(config.apiKey, 'prod-key');
  assert.deepEqual(config.credentialMap, { 'CRM API': 'CRM API (prod)' });
});

test('N8N_SYNC_ENV selects an environment but generic variables still win', () => {
  const config = resolveConfig({ env: { N8N_SYNC_ENV: 'prod', N8N_BASE_URL: 'https://override.example.com', N8N_PROD_KEY: 'prod-key' }, rc: RC });
  assert.equal(config.environment, 'prod');
  assert.equal(config.baseUrl, 'https://override.example.com');
  assert.equal(config.apiKey, 'prod-key');
});

test('an unknown environment lists the defined ones', () => {
  assert.throws(() => resolveConfig({ flags: { env: 'staging' }, rc: RC }), /Unknown environment "staging".*dev, prod/s);
  assert.throws(() => resolveConfig({ flags: { env: 'x' }, rc: {} }), /No environments are defined/);
});

test('requireApi reports a missing URL or key with guidance', () => {
  assert.throws(() => resolveConfig({ requireApi: true }), /Missing n8n base URL/);
  assert.throws(() => resolveConfig({ requireApi: true, env: { N8N_BASE_URL: 'https://n8n.example.com' } }), /Missing n8n API key/);
  assert.equal(resolveConfig({}).baseUrl, '');
});

test('paths from the rc file resolve relative to it, paths from flags relative to cwd', () => {
  const rcPath = path.join('/repo', 'config', RC_FILE_NAME);
  const fromRc = resolveConfig({ flags: { env: 'prod' }, env: { N8N_PROD_KEY: 'k' }, rc: RC, rcPath, cwd: '/repo/sub' });
  assert.equal(fromRc.dir, path.resolve('/repo/config/flows'));
  assert.equal(fromRc.idMap, path.resolve('/repo/config/env/prod.idmap.json'));
  assert.equal(fromRc.backup.dir, path.resolve('/repo/config/backups'));
  const fromFlag = resolveConfig({ flags: { dir: 'out', idMap: 'map.json', backupDir: 'snaps' }, rc: RC, env: {}, rcPath, cwd: '/repo/sub' });
  assert.equal(fromFlag.dir, path.resolve('/repo/sub/out'));
  assert.equal(fromFlag.idMap, path.resolve('/repo/sub/map.json'));
  assert.equal(fromFlag.backup.dir, path.resolve('/repo/sub/snaps'));
});

test('defaults are applied for pull, push, http and backup settings', () => {
  const config = resolveConfig({ cwd: '/work' });
  assert.equal(config.dir, path.resolve('/work/workflows'));
  assert.equal(config.idMap, null);
  assert.deepEqual(config.pull, { stripVolatile: true, groupBy: 'none', keepPinData: false, includeArchived: false });
  assert.equal(config.push.activate, 'keep');
  assert.equal(config.http.retries, 3);
  assert.equal(config.backup.keep, 0);
});

test('numeric settings come from flags, env and rc, and are validated', () => {
  const config = resolveConfig({
    flags: { timeout: 500, keep: 7 },
    env: { N8N_SYNC_RETRIES: '5' },
    rc: { http: { timeoutMs: 9000, retries: 1, pageSize: 25 }, backup: { maxAgeDays: 30 } },
  });
  assert.equal(config.http.timeoutMs, 500);
  assert.equal(config.http.retries, 5);
  assert.equal(config.http.pageSize, 25);
  assert.equal(config.backup.keep, 7);
  assert.equal(config.backup.maxAgeDays, 30);
  assert.throws(() => resolveConfig({ env: { N8N_SYNC_TIMEOUT_MS: 'soon' } }), /timeout must be a non-negative number/);
  assert.throws(() => resolveConfig({ flags: { retries: -1 } }), ConfigError);
});

test('boolean pull flags override the rc file in both directions', () => {
  const rc = { pull: { stripVolatile: false, groupBy: 'tag' } };
  assert.equal(resolveConfig({ rc }).pull.stripVolatile, false);
  assert.equal(resolveConfig({ rc, flags: { stripVolatile: true } }).pull.stripVolatile, true);
  assert.equal(resolveConfig({ rc }).pull.groupBy, 'tag');
  assert.equal(resolveConfig({ rc, flags: { groupBy: 'project' } }).pull.groupBy, 'project');
});

test('validateRc collects every problem in one error', () => {
  assert.throws(
    () => validateRc({ baseUrl: 5, environments: [], push: { activate: 'sometimes' }, defaultEnvironment: 'nope' }, 'rc'),
    (err) => err instanceof ConfigError
      && /baseUrl must be a string/.test(err.message)
      && /environments must be an object/.test(err.message)
      && /push\.activate/.test(err.message),
  );
  assert.throws(() => validateRc([], 'rc'), /expected a JSON object/);
  assert.throws(() => validateRc({ defaultEnvironment: 'qa', environments: { dev: {} } }, 'rc'), /"qa" is not defined/);
});

test('findRcFile searches upwards and loadRc parses the file', async (t) => {
  const root = await tempDir(t);
  const nested = path.join(root, 'a', 'b');
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(root, RC_FILE_NAME), JSON.stringify({ dir: 'flows' }));
  assert.equal(await findRcFile(nested), path.join(root, RC_FILE_NAME));
  const { rc, rcPath } = await loadRc({ cwd: nested });
  assert.equal(rc.dir, 'flows');
  assert.equal(rcPath, path.join(root, RC_FILE_NAME));
});

test('loadRc fails for a missing explicit file and for invalid JSON', async (t) => {
  const root = await tempDir(t);
  await assert.rejects(loadRc({ cwd: root, explicitPath: 'missing.json' }), /Config file not found/);
  await writeFile(path.join(root, 'broken.json'), '{ nope');
  await assert.rejects(loadRc({ cwd: root, explicitPath: 'broken.json' }), ConfigError);
});
