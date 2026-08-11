import { randomUUID } from 'node:crypto';
import { appendMessage } from '../db/repositories.js';

function asMessage(row) {
  return {
    id: row.id,
    sequence: row.sequence,
    channel: row.channel,
    role: row.role,
    body: row.body,
    taskId: row.task_id,
    createdAt: row.created_at,
  };
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
}

function quotedFtsQuery(query) {
  if (typeof query !== 'string' || query.trim().length === 0) return null;
  return `"${query.trim().replaceAll('"', '""')}"`;
}

export class ConversationService {
  constructor(database, { stableMemory = '' } = {}) {
    this.db = database?.db ?? database;
    if (!this.db || typeof this.db.prepare !== 'function') {
      throw new TypeError('ConversationService requires a SQLite database');
    }
    if (typeof stableMemory !== 'string') throw new TypeError('stableMemory must be a string');
    this.stableMemory = stableMemory;
  }

  append(message) {
    if (message === null || typeof message !== 'object') throw new TypeError('message must be an object');
    if (!['telegram', 'web', 'system', 'weixin'].includes(message.channel)) throw new TypeError('invalid message channel');
    if (!['user', 'assistant', 'tool', 'system'].includes(message.role)) throw new TypeError('invalid message role');
    if (typeof message.body !== 'string') throw new TypeError('message body must be a string');
    return appendMessage(this.db, message);
  }

  saveSummary({ throughSequence, body }) {
    nonNegativeInteger(throughSequence, 'throughSequence');
    if (typeof body !== 'string' || body.trim().length === 0) throw new TypeError('summary body must be non-empty');
    const latestSequence = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages').get().sequence;
    if (throughSequence > latestSequence) throw new RangeError('summary cannot extend beyond stored messages');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conversation_summaries(id, through_sequence, body, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, throughSequence, body, createdAt);
    return { id, throughSequence, body, createdAt };
  }

  listAfter(after = 0, limit = 100) {
    nonNegativeInteger(after, 'after');
    positiveInteger(limit, 'limit', 1000);
    return this.db.prepare(`
      SELECT * FROM messages WHERE sequence > ? ORDER BY sequence LIMIT ?
    `).all(after, limit).map(asMessage);
  }

  search(query, limit = 20, { beforeSequence } = {}) {
    positiveInteger(limit, 'limit', 100);
    const ftsQuery = quotedFtsQuery(query);
    if (!ftsQuery) return [];
    const hasBefore = beforeSequence !== undefined;
    if (hasBefore) nonNegativeInteger(beforeSequence, 'beforeSequence');
    const sql = `
      SELECT messages.*
      FROM messages_fts
      JOIN messages ON messages.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ? ${hasBefore ? 'AND messages.sequence < ?' : ''}
      ORDER BY bm25(messages_fts), messages.sequence DESC
      LIMIT ?
    `;
    const values = hasBefore ? [ftsQuery, beforeSequence, limit] : [ftsQuery, limit];
    return this.db.prepare(sql).all(...values).map(asMessage);
  }

  buildContext({ query = '', stableMemory } = {}) {
    if (stableMemory !== undefined && typeof stableMemory !== 'string') throw new TypeError('stableMemory must be a string');
    const recentRows = this.db.prepare(`
      SELECT * FROM messages ORDER BY sequence DESC LIMIT 40
    `).all().reverse();
    const recentMessages = recentRows.map(asMessage);
    const oldestRecentSequence = recentMessages[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
    const summaryRow = this.db.prepare(`
      SELECT * FROM conversation_summaries ORDER BY through_sequence DESC, created_at DESC LIMIT 1
    `).get();
    const summary = summaryRow ? {
      id: summaryRow.id,
      throughSequence: summaryRow.through_sequence,
      body: summaryRow.body,
      createdAt: summaryRow.created_at,
    } : null;
    const importedMemory = this.stableMemory.length === 0 && stableMemory === undefined
      ? this.db.prepare('SELECT body FROM memory_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 1').get()?.body ?? ''
      : null;
    return {
      stableMemory: (stableMemory ?? this.stableMemory) || importedMemory,
      summary,
      recentMessages,
      relevantMessages: this.search(query, 20, { beforeSequence: oldestRecentSequence }),
    };
  }
}
