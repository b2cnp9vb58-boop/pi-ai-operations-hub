import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

class MemorySessionStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

async function loadChatPage(storage) {
  globalThis.window = {};
  globalThis.document = { querySelector: () => ({ content: 'csrf-token' }) };
  globalThis.sessionStorage = storage;
  const source = pathToFileURL(path.resolve('portal/chat-page.patch.js')).href;
  await import(`${source}?test=${Date.now()}-${Math.random()}`);
  return globalThis.window.PiSharedChat;
}

test('an accepted message whose response is lost keeps one outbox id across reload and retry', async () => {
  const storage = new MemorySessionStorage();
  const coreTasks = new Map();
  const submittedRids = [];
  let disconnectAfterAccept = true;

  globalThis.fetch = async (_path, options) => {
    const payload = JSON.parse(options.body);
    submittedRids.push(payload.rid);
    if (!coreTasks.has(payload.rid)) coreTasks.set(payload.rid, `task-${coreTasks.size + 1}`);
    if (disconnectAfterAccept) {
      disconnectAfterAccept = false;
      throw new TypeError('connection lost after core accepted the message');
    }
    return new Response(JSON.stringify({
      status: 'accepted', rid: payload.rid, taskId: coreTasks.get(payload.rid),
    }), { status: 202, headers: { 'content-type': 'application/json' } });
  };

  let chat = await loadChatPage(storage);
  const pending = chat.createPendingMessage('check all services');
  await assert.rejects(chat.sendMessage(pending), /connection lost/);
  assert.deepEqual(chat.listPendingMessages(), [pending]);

  chat = await loadChatPage(storage);
  const restored = chat.listPendingMessages()[0];
  const accepted = await chat.sendMessage(restored);

  assert.equal(accepted.taskId, 'task-1');
  assert.deepEqual(submittedRids, [pending.rid, pending.rid]);
  assert.equal(coreTasks.size, 1);
  assert.deepEqual(chat.listPendingMessages(), []);
  assert.notEqual(chat.createPendingMessage('check all services').rid, pending.rid);
});

test('two clicks for the same pending item share one in-flight request', async () => {
  const storage = new MemorySessionStorage();
  let requests = 0;
  let release;
  globalThis.fetch = (_path, options) => {
    requests += 1;
    const { rid } = JSON.parse(options.body);
    return new Promise((resolve) => {
      release = () => resolve(new Response(JSON.stringify({
        status: 'accepted', rid, taskId: 'task-1',
      }), { status: 202, headers: { 'content-type': 'application/json' } }));
    });
  };

  const chat = await loadChatPage(storage);
  const pending = chat.createPendingMessage('once');
  const first = chat.sendMessage(pending);
  const second = chat.sendMessage(pending);

  assert.strictEqual(first, second);
  assert.equal(requests, 1);
  release();
  await first;
});

test('processing without an accepted or existing acknowledgement keeps the outbox item', async () => {
  const storage = new MemorySessionStorage();
  globalThis.fetch = async (_path, options) => {
    const { rid } = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'processing', rid, taskId: 'task-1' }), {
      status: 202, headers: { 'content-type': 'application/json' },
    });
  };
  const chat = await loadChatPage(storage);
  const pending = chat.createPendingMessage('keep until durable acknowledgement');
  await assert.rejects(chat.sendMessage(pending), /did not acknowledge/);
  assert.deepEqual(chat.listPendingMessages(), [pending]);
});
