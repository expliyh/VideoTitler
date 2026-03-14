import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('App syncs the left list height from the right detail card on desktop', () => {
  assert.match(appSource, /new ResizeObserver\(/);
  assert.match(appSource, /--detail-card-height/);
  assert.match(appSource, /matchMedia\('\(min-width:\s*1181px\)'\)/);
  assert.match(appSource, /ref=\{detailCardRef\}/);
});
