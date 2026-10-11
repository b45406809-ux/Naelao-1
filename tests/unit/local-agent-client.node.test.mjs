import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import * as localAgent from '../../workers/agents/local-agent/naelao-local-agent.mjs';

test('local agent imports without opening a connection', () => {
  assert.equal(typeof localAgent.normalizePath, 'function');
});

test('normalizePath collapses traversal', () => {
  assert.equal(localAgent.normalizePath('/home/alice/project/../../../etc/passwd'), '/etc/passwd');
  assert.equal(localAgent.normalizePath('/home/alice/project/./readme.md'), '/home/alice/project/readme.md');
});

test('isWithinAny requires path-segment containment', () => {
  assert.equal(localAgent.isWithinAny('/home/alice/allowed/file.txt', ['/home/alice/allowed']), true);
  assert.equal(localAgent.isWithinAny('/home/alice/allowed-evil/file.txt', ['/home/alice/allowed']), false);
  assert.equal(localAgent.isWithinAny('/anything/at/all', []), true);
});

test('isAllowedCommand requires an exact match', () => {
  assert.equal(localAgent.isAllowedCommand('npm test', ['npm test']), true);
  assert.equal(localAgent.isAllowedCommand('npm test && rm -rf /', ['npm test']), false);
});

test('inference and tunnel URLs enforce local or encrypted endpoints', () => {
  assert.equal(localAgent.isLoopbackInferenceUrl('http://127.0.0.1:11434/v1/chat/completions'), true);
  assert.equal(localAgent.isLoopbackInferenceUrl('http://localhost:8000/v1/chat/completions'), true);
  assert.equal(localAgent.isLoopbackInferenceUrl('https://example.com/v1/chat/completions'), false);
  assert.equal(localAgent.isSecureTunnelUrl('wss://agents.example.test'), true);
  assert.equal(localAgent.isSecureTunnelUrl('ws://agents.example.test'), false);
  assert.equal(localAgent.isSecureTunnelUrl('ws://127.0.0.1:8787'), true);
});

test('handleChatCompletion forwards only to the configured loopback inference server', async () => {
  const fetchMock = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.deepEqual(JSON.parse(init.body), { model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 });
  };
  const result = await localAgent.handleChatCompletion(
    { inferenceUrl: 'http://127.0.0.1:11434/v1/chat/completions' },
    { model: 'llama3', messages: [{ role: 'user', content: 'hi' }] },
    fetchMock,
  );
  assert.equal(result.choices[0].message.content, 'hello');
});

test('handleRequest rejects reads outside the configured directory', async () => {
  await assert.rejects(
    localAgent.handleRequest({ allowDirs: ['/home/alice/allowed'], allowCommands: [] }, 'read_file', { path: '/etc/passwd' }),
    /local policy/,
  );
});

test('handleRequest rejects unknown operations', async () => {
  await assert.rejects(
    localAgent.handleRequest({ allowDirs: [], allowCommands: [] }, 'delete_everything', {}),
    /unknown op/,
  );
});

test('handleRequest performs an allowed write and read round trip', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'naelao-local-agent-test-'));
  try {
    const filePath = path.join(tmpDir, 'out.txt');
    assert.deepEqual(
      await localAgent.handleRequest({ allowDirs: [tmpDir], allowCommands: [] }, 'write_file', { path: filePath, content: 'hello' }),
      { written: true },
    );
    assert.equal(await localAgent.handleRequest({ allowDirs: [tmpDir], allowCommands: [] }, 'read_file', { path: filePath }), 'hello');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('handleRequest runs an explicitly allowed command', async () => {
  const result = await localAgent.handleRequest(
    { allowDirs: [], allowCommands: ['echo naelao-local-agent-test'] },
    'exec',
    { command: 'echo naelao-local-agent-test' },
  );
  assert.equal(result.stdout.trim(), 'naelao-local-agent-test');
});
