import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { UsageError } from '../src/errors.js';
import { formatOptions, parseArgs } from '../src/util/args.js';
import {
  isDirectory, listFiles, pathExists, readJsonFile, readJsonFileOr, removeFileAndEmptyParents, toPosix,
  writeFileAtomic, writeIfChanged, writeJsonFile,
} from '../src/util/fs.js';
import { createLogger, createMemoryLogger, createRedactor } from '../src/util/logger.js';
import {
  compactTimestamp, idFromFileName, parseCompactTimestamp, safeId, slugify, workflowFileName,
} from '../src/util/slug.js';
import { tempDir } from './helpers/fixtures.js';

// ---- slug ---------------------------------------------------------------

test('slugify lowercases, strips accents and collapses punctuation', () => {
  assert.equal(slugify('Héllo Wörld! -- Order/Intake (v2)'), 'hello-world-order-intake-v2');
});

test('slugify falls back for empty or non-latin names', () => {
  assert.equal(slugify(''), 'untitled');
  assert.equal(slugify('日本語'), 'untitled');
  assert.equal(slugify('???', { fallback: 'workflow' }), 'workflow');
});

test('slugify truncates without leaving a trailing dash', () => {
  assert.equal(slugify('x'.repeat(100)).length, 60);
  assert.equal(slugify('a-b-c-d', { maxLength: 4 }), 'a-b');
});

test('safeId removes path separators and dots', () => {
  assert.equal(safeId('ab/c..d'), 'abcd');
  assert.equal(safeId(12), '12');
});

test('workflowFileName combines slug and id, and idFromFileName reverses it', () => {
  const file = workflowFileName({ id: 'aB3xYz', name: 'Order intake' });
  assert.equal(file, 'order-intake--aB3xYz.json');
  assert.equal(idFromFileName(`orders/${file}`), 'aB3xYz');
  assert.equal(idFromFileName('plain.json'), null);
});

test('workflowFileName cannot escape the directory through a hostile id or name', () => {
  const file = workflowFileName({ id: '../../etc/passwd', name: '../..\\evil' });
  assert.ok(!file.includes('/') && !file.includes('\\') && !file.includes('..'), file);
});

test('compactTimestamp round-trips through parseCompactTimestamp', () => {
  const stamp = compactTimestamp(new Date('2026-01-31T23:59:59.123Z'));
  assert.equal(stamp, '20260131T235959Z');
  assert.equal(parseCompactTimestamp(stamp)?.toISOString(), '2026-01-31T23:59:59.000Z');
  assert.equal(parseCompactTimestamp('nope'), null);
  assert.equal(parseCompactTimestamp('20261331T000000Z'), null);
});

// ---- args ---------------------------------------------------------------

/** @type {import('../src/util/args.js').OptionSpecs} */
const SPECS = {
  dir: { type: 'string', short: 'd', description: 'Directory', placeholder: 'path' },
  'dry-run': { type: 'boolean', short: 'n', description: 'Dry run' },
  tag: { type: 'list', description: 'Tag' },
  keep: { type: 'number', description: 'Keep' },
  prune: { type: 'boolean', default: true, description: 'Prune' },
  format: { type: 'string', choices: ['text', 'json'], default: 'text', description: 'Format' },
};

test('parseArgs handles long, short, inline and repeated options', () => {
  const { options, positionals } = parseArgs(['-d', 'x', '--dry-run', '--tag', 'a', '--tag=b,c', 'pos', '--keep', '3'], SPECS);
  assert.equal(options.dir, 'x');
  assert.equal(options.dryRun, true);
  assert.deepEqual(options.tag, ['a', 'b', 'c']);
  assert.equal(options.keep, 3);
  assert.deepEqual(positionals, ['pos']);
});

test('parseArgs applies defaults and --no- negation', () => {
  assert.equal(parseArgs([], SPECS).options.prune, true);
  assert.equal(parseArgs([], SPECS).options.format, 'text');
  assert.equal(parseArgs(['--no-prune'], SPECS).options.prune, false);
  assert.deepEqual(parseArgs([], SPECS).options.tag, []);
});

test('parseArgs treats everything after -- as positional', () => {
  assert.deepEqual(parseArgs(['a', '--', '--dir', '-n'], SPECS).positionals, ['a', '--dir', '-n']);
});

test('parseArgs rejects unknown options, bad numbers, missing values and bad choices', () => {
  assert.throws(() => parseArgs(['--nope'], SPECS), (err) => err instanceof UsageError && /--nope/.test(err.message));
  assert.throws(() => parseArgs(['--keep', 'x'], SPECS), /expects a number/);
  assert.throws(() => parseArgs(['--dir'], SPECS), /requires a value/);
  assert.throws(() => parseArgs(['--format', 'xml'], SPECS), /must be one of: text, json/);
  assert.throws(() => parseArgs(['--no-dir'], SPECS), UsageError);
});

test('formatOptions lists every option with its short flag and default', () => {
  const text = formatOptions(SPECS);
  assert.match(text, /-d, --dir <path>/);
  assert.match(text, /--format .*\(text\|json\).*\[default: text\]/);
  assert.equal(text.split('\n').length, Object.keys(SPECS).length);
});

// ---- fs -----------------------------------------------------------------

test('writeFileAtomic creates parent directories and leaves no temp files', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'a', 'b', 'c.txt');
  await writeFileAtomic(file, 'hello');
  assert.equal(await readFile(file, 'utf8'), 'hello');
  assert.deepEqual(await readdir(path.dirname(file)), ['c.txt']);
});

test('writeIfChanged reports whether the file was written', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'x.json');
  assert.equal(await writeIfChanged(file, 'one'), true);
  assert.equal(await writeIfChanged(file, 'one'), false);
  assert.equal(await writeIfChanged(file, 'two'), true);
});

test('readJsonFile names the file on a parse error; readJsonFileOr falls back when missing', async (t) => {
  const dir = await tempDir(t);
  const bad = path.join(dir, 'bad.json');
  await writeFile(bad, '{not json');
  await assert.rejects(readJsonFile(bad), /bad\.json/);
  assert.deepEqual(await readJsonFileOr(path.join(dir, 'missing.json'), { ok: true }), { ok: true });
  await writeJsonFile(path.join(dir, 'good.json'), { b: 1, a: 2 });
  assert.deepEqual(await readJsonFile(path.join(dir, 'good.json')), { a: 2, b: 1 });
});

test('listFiles returns sorted POSIX paths and skips dot directories and node_modules', async (t) => {
  const dir = await tempDir(t);
  for (const rel of ['b.json', 'a/z.json', 'a/y.txt', '.git/config.json', 'node_modules/pkg/index.json']) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), '{}');
  }
  assert.deepEqual(await listFiles(dir, (rel) => rel.endsWith('.json')), ['a/z.json', 'b.json']);
  assert.deepEqual(await listFiles(path.join(dir, 'does-not-exist')), []);
});

test('removeFileAndEmptyParents removes emptied folders but not the root or busy folders', async (t) => {
  const dir = await tempDir(t);
  await writeFileAtomic(path.join(dir, 'a/b/one.json'), '{}');
  await writeFileAtomic(path.join(dir, 'a/two.json'), '{}');
  await removeFileAndEmptyParents(dir, 'a/b/one.json');
  assert.equal(await pathExists(path.join(dir, 'a/b')), false);
  assert.equal(await pathExists(path.join(dir, 'a/two.json')), true);
  await removeFileAndEmptyParents(dir, 'a/two.json');
  assert.equal(await pathExists(path.join(dir, 'a')), false);
  assert.equal(await isDirectory(dir), true);
});

test('toPosix converts backslashes', () => {
  assert.equal(toPosix(['a', 'b', 'c.json'].join(path.sep)), 'a/b/c.json');
});

// ---- logger -------------------------------------------------------------

test('logger sends results to stdout and diagnostics to stderr', () => {
  const logger = createMemoryLogger({ level: 'info' });
  logger.out('result');
  logger.info('note');
  logger.warn('careful');
  logger.error(new Error('boom'));
  logger.debug('hidden at info level');
  assert.deepEqual(logger.stdout, ['result\n']);
  assert.deepEqual(logger.stderr, ['note\n', 'warning: careful\n', 'error: boom\n']);
});

test('logger level error silences info and warnings', () => {
  /** @type {string[]} */
  const err = [];
  const logger = createLogger({ level: 'error', stdout: () => {}, stderr: (text) => err.push(text) });
  logger.info('a');
  logger.warn('b');
  logger.error('c');
  assert.deepEqual(err, ['error: c\n']);
});

test('logger masks registered secrets on both streams, including in objects', () => {
  const logger = createMemoryLogger();
  const secret = ['top', 'secret', 'value'].join('-');
  logger.addSecret(secret);
  logger.info(`key ${secret}`, { nested: secret });
  logger.out(`printed ${secret}`);
  assert.ok(!logger.text().includes(secret));
  assert.ok(!logger.errText().includes(secret));
  assert.match(logger.errText(), /key \*\*\*/);
});

test('redactor masks longer secrets first and ignores short or empty entries', () => {
  const redact = createRedactor(['abcd', 'abcdefgh', '', 'x', /** @type {any} */ (undefined)]);
  assert.equal(redact('1 abcdefgh 2 abcd 3 x'), '1 *** 2 *** 3 x');
});

test('redactor masks API key and authorization headers it has never seen', () => {
  const redact = createRedactor([]);
  const value = ['zz', 'unknown', 'value'].join('');
  assert.ok(!redact(`{"X-N8N-API-KEY":"${value}"}`).includes(value));
  assert.ok(!redact(`authorization: Bearer ${value}`).includes(value));
});
