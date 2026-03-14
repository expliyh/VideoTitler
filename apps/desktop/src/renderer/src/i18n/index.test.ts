import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const zhSource = readFileSync(new URL('./zh.ts', import.meta.url), 'utf8');

test('zh source-directory rename labels stay readable', () => {
  assert.match(zhSource, /renameSourceDirectory:\s*'\\u91cd\\u547d\\u540d\\u6587\\u4ef6\\u5939'/);
  assert.match(zhSource, /renameSourceDirectoryPlaceholder:\s*'\\u8f93\\u5165\\u65b0\\u7684\\u6587\\u4ef6\\u5939\\u540d\\u79f0'/);
  assert.match(zhSource, /renameSourceDirectoryConfirm:\s*'\\u786e\\u8ba4\\u91cd\\u547d\\u540d'/);
  assert.match(zhSource, /cancel:\s*'\\u53d6\\u6d88'/);
  assert.match(zhSource, /renameSourceDirectoryEmptyName:\s*'\\u8bf7\\u5148\\u8f93\\u5165\\u65b0\\u7684\\u6587\\u4ef6\\u5939\\u540d\\u79f0\\u3002'/);
  assert.match(zhSource, /renameSourceDirectoryUnchanged:\s*'\\u65b0\\u6587\\u4ef6\\u5939\\u540d\\u79f0\\u4e0d\\u80fd\\u4e0e\\u5f53\\u524d\\u540d\\u79f0\\u76f8\\u540c\\u3002'/);
  assert.match(zhSource, /renameSourceDirectoryLog:\s*\(directory\)\s*=>\s*`\\u5df2\\u5c06\\u6e90\\u76ee\\u5f55\\u91cd\\u547d\\u540d\\u4e3a \$\{directory\}\\u3002`/);
  assert.match(zhSource, /renameSourceDirectoryFailed:\s*\(m\)\s*=>\s*`\\u91cd\\u547d\\u540d\\u6e90\\u76ee\\u5f55\\u5931\\u8d25\\uff1a\$\{m\}`/);
});
