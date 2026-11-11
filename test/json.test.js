import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson, clone, deepEqual, diffJson, formatPath, getAtPath, isPlainObject, parseJson, parsePath,
  setAtPath, sortKeysDeep, stableStringify, walkLeaves,
} from '../src/util/json.js';
import { hashJson, sha256, shannonEntropy } from '../src/util/hash.js';

test('isPlainObject accepts objects and rejects arrays, null and class instances', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject('x'), false);
});

test('sortKeysDeep sorts nested keys and keeps array order', () => {
  const sorted = sortKeysDeep({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } });
  assert.deepEqual(Object.keys(sorted), ['a', 'b']);
  assert.deepEqual(Object.keys(sorted.a), ['c', 'd']);
  assert.deepEqual(Object.keys(sorted.a.c[0]), ['y', 'z']);
});

test('sortKeysDeep puts priority keys first at the top level', () => {
  const sorted = sortKeysDeep({ zebra: 1, name: 'x', alpha: 2, id: 3 }, ['id', 'name']);
  assert.deepEqual(Object.keys(sorted), ['id', 'name', 'alpha', 'zebra']);
});

test('stableStringify is independent of key insertion order', () => {
  const a = stableStringify({ x: 1, y: { b: 2, a: 1 } });
  const b = stableStringify({ y: { a: 1, b: 2 }, x: 1 });
  assert.equal(a, b);
  assert.ok(a.endsWith('\n'), 'ends with a newline');
});

test('stableStringify drops undefined and honours the newline option', () => {
  assert.equal(stableStringify({ a: undefined, b: 1 }, { indent: 0, newline: false }), '{"b":1}');
});

test('canonicalJson is compact and stable', () => {
  assert.equal(canonicalJson({ b: [2, 1], a: null }), '{"a":null,"b":[2,1]}');
});

test('deepEqual compares structurally and ignores key order', () => {
  assert.equal(deepEqual({ a: [1, { b: 2 }], c: 3 }, { c: 3, a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), true);
  assert.equal(deepEqual(null, {}), false);
  assert.equal(deepEqual(1, '1'), false);
});

test('clone returns an independent deep copy', () => {
  const source = { a: { b: [1, 2] } };
  const copy = clone(source);
  copy.a.b.push(3);
  assert.deepEqual(source.a.b, [1, 2]);
});

test('formatPath renders dots, indexes and quoted keys', () => {
  assert.equal(formatPath(['parameters', 'headers', 0, 'value']), '$.parameters.headers[0].value');
  assert.equal(formatPath(['a b', 'c']), '$["a b"].c');
  assert.equal(formatPath([], 'node'), 'node');
});

test('parsePath is the inverse of formatPath', () => {
  for (const segments of [['a', 0, 'b'], ['with space', 'x'], ['Content-Type'], []]) {
    assert.deepEqual(parsePath(formatPath(segments)), segments);
  }
});

test('getAtPath and setAtPath read and write nested values', () => {
  const value = { a: [{ b: 1 }] };
  assert.equal(getAtPath(value, ['a', 0, 'b']), 1);
  assert.equal(getAtPath(value, ['a', 3, 'b']), undefined);
  setAtPath(value, ['a', 0, 'b'], 2);
  assert.equal(value.a[0].b, 2);
});

test('walkLeaves visits every primitive with its path', () => {
  /** @type {string[]} */
  const seen = [];
  walkLeaves({ a: [1, { b: 'x' }], c: null }, (leaf, path) => seen.push(`${formatPath(path)}=${leaf}`));
  assert.deepEqual(seen.sort(), ['$.a[0]=1', '$.a[1].b=x', '$.c=null']);
});

test('diffJson reports additions, removals and replacements with paths', () => {
  const changes = diffJson({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { a: 1, b: { c: 5 }, e: [1, 2, 3], f: true });
  const byPath = Object.fromEntries(changes.map((change) => [formatPath(change.path), change]));
  assert.equal(byPath['$.b.c'].op, 'replace');
  assert.equal(byPath['$.b.c'].before, 2);
  assert.equal(byPath['$.b.c'].after, 5);
  assert.equal(byPath['$.b.d'].op, 'remove');
  assert.equal(byPath['$.e[2]'].op, 'add');
  assert.equal(byPath['$.f'].op, 'add');
  assert.equal(changes.length, 4);
});

test('diffJson returns nothing for equal values and one replace for type changes', () => {
  assert.deepEqual(diffJson({ a: [1] }, { a: [1] }), []);
  const changes = diffJson({ a: [1] }, { a: { 0: 1 } });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].op, 'replace');
});

test('parseJson includes the label in the error message', () => {
  assert.deepEqual(parseJson('{"a":1}', 'x.json'), { a: 1 });
  assert.throws(() => parseJson('{oops', 'broken.json'), /broken\.json/);
});

test('sha256 and hashJson are stable', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 }));
  assert.notEqual(hashJson({ a: 1 }), hashJson({ a: 2 }));
});

test('shannonEntropy is zero for a repeated character and grows with variety', () => {
  assert.equal(shannonEntropy(''), 0);
  assert.equal(shannonEntropy('aaaaaaaa'), 0);
  assert.equal(shannonEntropy('abab'), 1);
  assert.ok(shannonEntropy('abcdefghijklmnop') > shannonEntropy('aabbccdd'));
});
