import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { resolvePreloadPath } from './preload-path.ts';

function makeTempMainDir(): string {
  return mkdtempSync(join(tmpdir(), 'videotitler-preload-'));
}

test('resolvePreloadPath uses the built .mjs preload bundle when present', () => {
  const mainDir = join(makeTempMainDir(), 'dist', 'main');
  const preloadPath = join(mainDir, '../preload/index.mjs');

  mkdirSync(dirname(preloadPath), { recursive: true });
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(preloadPath, '');

  assert.equal(resolvePreloadPath(mainDir), preloadPath);
});

test('resolvePreloadPath falls back to .js when that preload bundle exists', () => {
  const mainDir = join(makeTempMainDir(), 'dist', 'main');
  const preloadPath = join(mainDir, '../preload/index.js');

  mkdirSync(dirname(preloadPath), { recursive: true });
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(preloadPath, '');

  assert.equal(resolvePreloadPath(mainDir), preloadPath);
});

test('resolvePreloadPath prefers .js over .mjs when both preload bundles exist', () => {
  const mainDir = join(makeTempMainDir(), 'dist', 'main');
  const jsPreloadPath = join(mainDir, '../preload/index.js');
  const mjsPreloadPath = join(mainDir, '../preload/index.mjs');

  mkdirSync(dirname(jsPreloadPath), { recursive: true });
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(jsPreloadPath, '');
  writeFileSync(mjsPreloadPath, '');

  assert.equal(resolvePreloadPath(mainDir), jsPreloadPath);
});

test('resolvePreloadPath uses the built .cjs preload bundle when present', () => {
  const mainDir = join(makeTempMainDir(), 'dist', 'main');
  const preloadPath = join(mainDir, '../preload/index.cjs');

  mkdirSync(dirname(preloadPath), { recursive: true });
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(preloadPath, '');

  assert.equal(resolvePreloadPath(mainDir), preloadPath);
});
