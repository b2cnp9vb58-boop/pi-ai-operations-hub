import {
  claimTelegramOutbox, markOutboxSent, releaseOutbox,
} from '../db/repositories.js';

const MAX_MESSAGE_LENGTH = 3_500;

function databaseHandle(database) {
  return database?.db ?? database;
}

function ownerChatId(owner) {
  const chatId = Number(owner?.chatId);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return null;
  return chatId;
}

function splitText(text, limit = MAX_MESSAGE_LENGTH) {
  const value = String(text ?? '').trim();
  if (!value) return [];
  const parts = [];
  let remaining = value;
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf('\n', limit);
    if (end < Math.floor(limit / 2)) end = limit;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end).replace(/^\n+/, '');
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function eventMessages(event) {
  if (event.kind === 'telegram.task.accepted') {
    return [{ text: '任务已收到，正在处理…' }];
  }
  if (event.kind === 'telegram.task.result') {
    const completed = event.payload?.status === 'completed';
    const heading = completed ? '任务处理完成' : '任务执行未完成';
    const summary = String(event.payload?.summary ?? '').trim();
    const chunks = splitText(summary || (completed ? '任务已完成。' : '没有可用的错误说明。'));
    return chunks.map((chunk, index) => ({
      text: `${heading}${chunks.length > 1 ? `（${index + 1}/${chunks.length}）` : ''}\n\n${chunk}`,
    }));
  }
  if (event.kind === 'telegram.approval') {
    const approvalId = event.payload?.approvalId;
    if (typeof approvalId !== 'string' || !approvalId) throw new Error('invalid Telegram approval event');
    const reasons = Array.isArray(event.payload?.reasons) ? event.payload.reasons.join('；') : '';
    return [{
      text: `检测到高风险操作，需要你的确认。${reasons ? `\n\n原因：${reasons}` : ''}`,
      options: {
        reply_markup: {
          inline_keyboard: [[
            { text: '确认', callback_data: `approve:${approvalId}` },
            { text: '取消', callback_data: `cancel:${approvalId}` },
          ]],
        },
      },
    }];
  }
  throw new Error(`unsupported Telegram outbox event: ${event.kind}`);
}

export function recoverTelegramOutbox(database) {
  const db = databaseHandle(database);
  if (!db?.prepare) throw new TypeError('Telegram outbox recovery requires a SQLite database');
  return db.prepare(`
    UPDATE outbox SET state = 'pending'
    WHERE state = 'sending' AND kind LIKE 'telegram.%'
  `).run().changes;
}

export class TelegramDeliveryWorker {
  constructor({ db, client, getOwner, clock = Date.now, retryDelayMs = 30_000 } = {}) {
    this.db = databaseHandle(db);
    if (!this.db?.prepare) throw new TypeError('Telegram delivery requires a SQLite database');
    if (typeof client?.sendMessage !== 'function') throw new TypeError('Telegram delivery requires a client');
    if (typeof getOwner !== 'function') throw new TypeError('Telegram delivery requires an owner resolver');
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 1) throw new TypeError('retry delay must be positive');
    this.client = client;
    this.getOwner = getOwner;
    this.clock = clock;
    this.retryDelayMs = retryDelayMs;
  }

  #now() {
    const value = this.clock();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw new TypeError('clock must return a valid time');
    return milliseconds;
  }

  async flushOnce(limit = 20) {
    const now = this.#now();
    const events = claimTelegramOutbox(this.db, limit, new Date(now).toISOString());
    let delivered = 0;
    for (const event of events) {
      try {
        const chatId = ownerChatId(await this.getOwner());
        if (chatId === null) throw new Error('Telegram owner is not paired');
        for (const message of eventMessages(event)) {
          await this.client.sendMessage(chatId, message.text, message.options);
        }
        markOutboxSent(this.db, event.id);
        delivered += 1;
      } catch {
        releaseOutbox(this.db, event.id, new Date(now + this.retryDelayMs).toISOString());
      }
    }
    return delivered;
  }
}

function waitForNextDelivery(intervalMs, signal, timers) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      timers.clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = timers.setTimeout(done, intervalMs);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function runTelegramDeliveryLoop({
  worker, signal, intervalMs = 500, timers = globalThis, logger,
} = {}) {
  if (typeof worker?.flushOnce !== 'function') throw new TypeError('Telegram delivery worker is required');
  if (!Number.isInteger(intervalMs) || intervalMs < 10) throw new TypeError('delivery interval must be at least 10ms');
  while (!signal?.aborted) {
    try {
      await worker.flushOnce();
    } catch {
      logger?.warn?.('Telegram durable delivery loop will retry');
    }
    await waitForNextDelivery(intervalMs, signal, timers);
  }
}
