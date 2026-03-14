import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PythonWorkerClient } from './python-worker.ts';

function createFixtureScript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'videotitler-worker-fixture-'));
  const filePath = join(dir, 'fixture.mjs');

  writeFileSync(
    filePath,
    [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.method === 'ping') {",
      "    console.log(JSON.stringify({ type: 'event', event: 'log', message: 'worker ready' }));",
      "    console.log(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true, payload: { pong: request.params.value } }));",
      "    return;",
      "  }",
      "  if (request.method === 'fail') {",
      "    console.log(JSON.stringify({ type: 'response', requestId: request.requestId, ok: false, error: 'boom' }));",
      "    return;",
      "  }",
      "  if (request.method === 'shutdown') {",
      "    console.log(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true, payload: { shutdown: true } }));",
      "    process.exit(0);",
      "  }",
      "});"
    ].join('\n'),
    'utf8'
  );

  return filePath;
}

test('PythonWorkerClient routes worker events and responses', async () => {
  const fixturePath = createFixtureScript();
  const client = new PythonWorkerClient({
    command: process.execPath,
    args: [fixturePath],
    cwd: process.cwd()
  });
  const events: Array<{ event: string; message?: string }> = [];

  client.on('event', (event) => {
    events.push(event as { event: string; message?: string });
  });

  await client.start();
  const response = await client.request<{ pong: string }>('ping', { value: 'ok' });

  assert.deepEqual(response, { pong: 'ok' });
  assert.equal(events[0]?.event, 'log');
  assert.equal(events[0]?.message, 'worker ready');

  await client.shutdown();
});

test('PythonWorkerClient rejects failed worker responses', async () => {
  const fixturePath = createFixtureScript();
  const client = new PythonWorkerClient({
    command: process.execPath,
    args: [fixturePath],
    cwd: process.cwd()
  });

  await client.start();

  await assert.rejects(() => client.request('fail', {}), /boom/);

  await client.shutdown();
});
