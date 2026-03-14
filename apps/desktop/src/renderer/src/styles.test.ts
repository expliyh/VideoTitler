import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function getRuleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`, 'm'));

  assert.ok(match, `Expected to find CSS rule for ${selector}`);
  return match[1];
}

test('table-card stays stretchable so the scanned list can match the detail pane height on desktop', () => {
  const tableCardRule = getRuleBody('.table-card');

  assert.match(tableCardRule, /height:\s*var\(--detail-card-height,\s*100%\);/);
  assert.doesNotMatch(tableCardRule, /align-self:\s*start;/);
  assert.doesNotMatch(tableCardRule, /height:\s*auto;/);
});

test('video-summary-scroll does not cap the desktop list viewport below the card height', () => {
  const scrollRule = getRuleBody('.video-summary-scroll');

  assert.match(scrollRule, /height:\s*100%;/);
  assert.doesNotMatch(scrollRule, /max-height:\s*clamp\(/);
});
