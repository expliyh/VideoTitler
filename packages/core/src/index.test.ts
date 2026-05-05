import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { suggestIndexFromFileNames, suggestVideoIndexForPath } from './index.ts';

test('suggestIndexFromFileNames returns every missing index and defaults to the first gap', () => {
  const suggestion = suggestIndexFromFileNames([
    '001-Opening.mp4',
    '003-Move.mkv',
    '005-End.webm',
    'raw.mp4'
  ]);

  assert.equal(suggestion.suggestedIndex, 2);
  assert.deepEqual(suggestion.candidateIndexes, [2, 4]);
  assert.equal(suggestion.suggestedIndexPadding, 3);
  assert.equal(suggestion.isAutoIncrement, false);
});

test('suggestIndexFromFileNames follows the existing folder padding width', () => {
  const suggestion = suggestIndexFromFileNames([
    '0001-Opening.mp4',
    '0003-Move.mkv',
    'raw.mp4'
  ]);

  assert.equal(suggestion.suggestedIndex, 2);
  assert.equal(suggestion.suggestedIndexPadding, 4);
});

test('suggestIndexFromFileNames auto-increments when no gaps exist', () => {
  const suggestion = suggestIndexFromFileNames([
    '001-Opening.mp4',
    '002-Move.mkv',
    'raw.mp4'
  ]);

  assert.equal(suggestion.suggestedIndex, 3);
  assert.deepEqual(suggestion.candidateIndexes, []);
  assert.equal(suggestion.suggestedIndexPadding, 3);
  assert.equal(suggestion.isAutoIncrement, true);
});

test('suggestVideoIndexForPath scans the selected video parent directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'videotitler-index-'));
  writeFileSync(join(root, '001-Opening.mp4'), 'one');
  writeFileSync(join(root, '003-Move.mp4'), 'three');
  writeFileSync(join(root, 'raw.mp4'), 'raw');

  const suggestion = await suggestVideoIndexForPath(join(root, 'raw.mp4'));

  assert.equal(suggestion.suggestedIndex, 2);
  assert.deepEqual(suggestion.candidateIndexes, [2]);
});
