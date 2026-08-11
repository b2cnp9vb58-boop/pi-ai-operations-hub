import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramClient } from '../src/telegram/client.js';

function response({ status = 200, body, text } = {}) {
  return {
    status,
    async text() {
      return text ?? JSON.stringify(body);
    },
  };
}

test('getUpdates posts the exclusive offset and returns a successful Bot API result', async () => {
  const calls = [];
  const client = new TelegramClient({
    token: '123456:very-secret-bot-token',
    fetch: async (url, options) => {
      calls.push({ url, options });
      return response({ body: { ok: true, result: [{ update_id: 11 }] } });
    },
  });

  const updates = await client.getUpdates({ offset: 9, timeout: 45 });

  assert.deepEqual(updates, [{ update_id: 11 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123456:very-secret-bot-token/getUpdates');
  assert.deepEqual(JSON.parse(calls[0].options.body), { offset: 9, timeout: 45 });
});

test('client retries rate limits, timeouts, and malformed Bot API JSON without logging its token', async () => {
  const token = '123456:do-not-log-this-token';
  const delays = [];
  const logs = [];
  let calls = 0;
  const client = new TelegramClient({
    token,
    requestTimeoutMs: 5,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    logger: { warn: (...values) => logs.push(values.join(' ')) },
    fetch: async (_url, options) => {
      calls += 1;
      if (calls === 1) return response({ status: 429, body: { ok: false, parameters: { retry_after: 2 } } });
      if (calls === 2) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
      if (calls === 3) return response({ text: '{not json' });
      return response({ body: { ok: true, result: [] } });
    },
  });

  assert.deepEqual(await client.getUpdates({ offset: 0, timeout: 1 }), []);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [2000, 1000, 2000]);
  assert.equal(logs.join(' ').includes(token), false);
});

test('sendMessage and deleteMessage use the Bot API and return their result', async () => {
  const methods = [];
  const client = new TelegramClient({
    token: '123456:send-delete-token',
    fetch: async (url, options) => {
      methods.push({ url, body: JSON.parse(options.body) });
      return response({ body: { ok: true, result: true } });
    },
  });

  assert.equal(await client.sendMessage(42, 'queued', { reply_markup: { inline_keyboard: [] } }), true);
  assert.equal(await client.deleteMessage(42, 99), true);
  assert.equal(await client.editMessageText(42, 99, 'updated'), true);
  assert.deepEqual(methods.map(({ url, body }) => ({ method: url.split('/').at(-1), body })), [
    { method: 'sendMessage', body: { chat_id: 42, text: 'queued', reply_markup: { inline_keyboard: [] } } },
    { method: 'deleteMessage', body: { chat_id: 42, message_id: 99 } },
    { method: 'editMessageText', body: { chat_id: 42, message_id: 99, text: 'updated' } },
  ]);
});
