import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveProjectRoot, resolvePythonExecutable } from './python-runtime.ts';

test('resolveProjectRoot prefers the current cwd when the Python package exists there', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'videotitler-root-'));
  mkdirSync(join(cwd, 'videotitler'), { recursive: true });
  writeFileSync(join(cwd, 'videotitler', 'worker.py'), '');

  assert.equal(resolveProjectRoot({ cwd, mainDir: join(cwd, 'apps', 'desktop', 'dist', 'main') }), cwd);
});

test('resolveProjectRoot falls back to a path derived from the Electron main directory', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'videotitler-root-'));
  const mainDir = join(repoRoot, 'apps', 'desktop', 'dist', 'main');

  mkdirSync(join(repoRoot, 'videotitler'), { recursive: true });
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(repoRoot, 'videotitler', 'worker.py'), '');

  assert.equal(resolveProjectRoot({ cwd: join(repoRoot, 'apps', 'desktop'), mainDir }), repoRoot);
});

test('resolvePythonExecutable prefers the explicit VIDEOTITLER_PYTHON override', () => {
  assert.equal(
    resolvePythonExecutable({
      projectRoot: 'C:/repo',
      env: { VIDEOTITLER_PYTHON: 'C:/custom/python.exe' },
      platform: 'win32'
    }),
    'C:/custom/python.exe'
  );
});

test('resolvePythonExecutable uses the repo virtualenv when present', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'videotitler-root-'));
  const pythonPath = join(repoRoot, '.venv', 'Scripts', 'python.exe');

  mkdirSync(join(repoRoot, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(pythonPath, '');

  assert.equal(
    resolvePythonExecutable({
      projectRoot: repoRoot,
      env: {},
      platform: 'win32'
    }),
    pythonPath
  );
});

test('resolvePythonExecutable falls back to python on PATH when no override exists', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'videotitler-root-'));

  assert.equal(
    resolvePythonExecutable({
      projectRoot: repoRoot,
      env: {},
      platform: 'win32'
    }),
    'python'
  );
});
