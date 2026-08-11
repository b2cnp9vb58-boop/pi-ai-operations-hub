import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { appendOutbox } from '../src/db/repositories.js';
import { createWeixinGateway } from '../src/weixin/main.js';

test('an unpaired WeChat sender never creates a core task', async () => {
  const db = openDatabase(':memory:');
  const controller = new AbortController();
  let polls = 0;
  let coreRequests = 0;
  const client = {
    async getUpdates() {
      polls += 1;
      if (polls === 1) {
        return {
          msgs: [{
            message_id: 'unpaired-1',
            message_type: 1,
            from_user_id: 'unpaired-user@im.wechat',
            context_token: 'context-token',
            item_list: [{ type: 1, text_item: { text: '检查服务器' } }],
          }],
        };
      }
      controller.abort();
      return { msgs: [] };
    },
    async sendMessage() {
      throw new Error('unpaired sender must not receive a reply');
    },
  };
  const gateway = createWeixinGateway({
    config: { coreUrl: 'http://127.0.0.1:4330', coreClientKey: 'a'.repeat(32), pollTimeoutSeconds: 1 },
    db,
    client,
    fetch: async () => {
      coreRequests += 1;
      return new Response(JSON.stringify({ data: { taskId: 'should-not-exist' } }), { status: 202 });
    },
    logger: { warn() {} },
    sleep: async () => {},
    deliveryIntervalMs: 10,
  });

  try {
    await gateway.run({ signal: controller.signal });
    assert.equal(coreRequests, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM weixin_updates').get().count, 1);
  } finally {
    db.close();
  }
});

test('the WeChat gateway never attempts Telegram outbox delivery', async () => {
  const db = openDatabase(':memory:');
  const controller = new AbortController();
  let sends = 0;
  appendOutbox(db, { kind: 'telegram.task.result', payload: { taskId: 'telegram-task', status: 'completed', summary: 'private' } });
  db.prepare('INSERT INTO owner_binding(singleton, user_id, chat_id, paired_at) VALUES (1, ?, ?, ?)')
    .run('1', '2', new Date().toISOString());
  const gateway = createWeixinGateway({
    config: { coreUrl: 'http://127.0.0.1:4330', coreClientKey: 'a'.repeat(32), pollTimeoutSeconds: 1 },
    db,
    client: {
      async getUpdates() { controller.abort(); return { msgs: [] }; },
      async sendMessage() { sends += 1; },
    },
    logger: { warn() {} },
    sleep: async () => {},
  });

  try {
    await gateway.run({ signal: controller.signal });
    assert.equal(sends, 0);
    assert.equal(db.prepare('SELECT state FROM outbox').get().state, 'pending');
  } finally {
    db.close();
  }
});
