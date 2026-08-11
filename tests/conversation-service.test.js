import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { ConversationService } from '../src/core/conversation-service.js';

test('raw history remains searchable after a summary is created', () => {
  const db = openDatabase(':memory:');
  try {
    const service = new ConversationService(db, { stableMemory: 'Pi runs continuously.' });
    service.append({ channel: 'telegram', role: 'user', body: 'old exact text' });
    service.saveSummary({ throughSequence: 1, body: 'compact summary' });

    assert.equal(service.search('old exact text')[0].body, 'old exact text');
    const context = service.buildContext({ query: 'old exact text' });
    assert.equal(context.stableMemory, 'Pi runs continuously.');
    assert.equal(context.summary.body, 'compact summary');
    assert.equal(context.recentMessages[0].body, 'old exact text');
  } finally {
    db.close();
  }
});

test('context retains the forty newest messages and at most twenty older ranked matches', () => {
  const db = openDatabase(':memory:');
  try {
    const service = new ConversationService(db);
    for (let index = 0; index < 65; index += 1) {
      service.append({ channel: 'web', role: 'user', body: `needle record ${index}` });
    }
    const context = service.buildContext({ query: 'needle' });

    assert.equal(context.recentMessages.length, 40);
    assert.equal(context.recentMessages[0].body, 'needle record 25');
    assert.equal(context.relevantMessages.length, 20);
    assert.ok(context.relevantMessages.every((message) => message.sequence < 26));
  } finally {
    db.close();
  }
});

test('listAfter uses the durable global message sequence', () => {
  const db = openDatabase(':memory:');
  try {
    const service = new ConversationService(db);
    service.append({ channel: 'telegram', role: 'user', body: 'one' });
    service.append({ channel: 'web', role: 'assistant', body: 'two' });
    assert.deepEqual(service.listAfter(1, 10).map((message) => message.body), ['two']);
  } finally {
    db.close();
  }
});

test('context loads the latest imported durable Pi memory when no fixed memory is supplied', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare(`
      INSERT INTO memory_snapshots(id, source_file, sha256, body, created_at)
      VALUES ('memory-one', 'CLAUDE.md', 'a', 'first memory', '2026-01-01T00:00:00.000Z'),
             ('memory-two', 'CLAUDE.md', 'b', 'latest memory', '2026-01-02T00:00:00.000Z')
    `).run();
    const service = new ConversationService(db);
    assert.equal(service.buildContext().stableMemory, 'latest memory');
  } finally {
    db.close();
  }
});
