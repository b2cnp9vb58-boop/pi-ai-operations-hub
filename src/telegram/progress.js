export async function sendProgressMessage(client, chatId, text, options = {}) {
  return client.sendMessage(chatId, text, options);
}

export async function deleteProgressMessage(client, chatId, messageId) {
  return client.deleteMessage(chatId, messageId);
}

export function approvalOptions(approvalId) {
  if (typeof approvalId !== 'string' || approvalId.length === 0) throw new TypeError('approvalId is required');
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: '确认', callback_data: `approve:${approvalId}` },
        { text: '取消', callback_data: `cancel:${approvalId}` },
      ]],
    },
  };
}

const IMMEDIATE = new Set(['accepted', 'waiting_confirmation', 'recovery', 'failed', 'completed', 'interrupted', 'cancelled']);
const FINAL = new Set(['failed', 'completed', 'interrupted', 'cancelled']);

export class ProgressPublisher {
  constructor({ client, chatId, intervalMs = 5_000, clock = Date.now } = {}) {
    if (!client?.sendMessage || !client?.editMessageText) throw new TypeError('progress client requires send and edit methods');
    if (!Number.isSafeInteger(chatId)) throw new TypeError('chatId is required');
    if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new TypeError('intervalMs must be positive');
    this.client = client;
    this.chatId = chatId;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.tasks = new Map();
    this.chains = new Map();
    this.finalQueued = new Map();
  }

  publish(event = {}) {
    if (typeof event.taskId !== 'string' || typeof event.kind !== 'string' || typeof event.text !== 'string') {
      throw new TypeError('invalid progress event');
    }
    const text = event.text.trim().slice(0, 1_000);
    if (!text) throw new TypeError('progress text is required');
    if (this.finalQueued.has(event.taskId) && !FINAL.has(event.kind)) return Promise.resolve({ published: false, final: true });
    const finalToken = FINAL.has(event.kind) ? Symbol(event.taskId) : null;
    if (finalToken) this.finalQueued.set(event.taskId, finalToken);
    const previous = this.chains.get(event.taskId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#publishNow(event, text));
    this.chains.set(event.taskId, current);
    const result = current.catch((error) => {
      if (finalToken && this.finalQueued.get(event.taskId) === finalToken && !this.tasks.get(event.taskId)?.final) {
        this.finalQueued.delete(event.taskId);
      }
      throw error;
    });
    return result.finally(() => {
      if (this.chains.get(event.taskId) === current) this.chains.delete(event.taskId);
    });
  }

  async #publishNow(event, text) {
    const now = Number(this.clock());
    let state = this.tasks.get(event.taskId);
    if (state?.final) return { published: false, final: true };
    if (!state) {
      const sent = await this.client.sendMessage(this.chatId, text);
      const messageId = Number(sent?.message_id ?? sent);
      if (!Number.isSafeInteger(messageId)) throw new Error('Telegram did not return a progress message id');
      state = { messageId, lastPublishedAt: now, final: FINAL.has(event.kind) };
      this.tasks.set(event.taskId, state);
      return { published: true, messageId };
    }
    if (!IMMEDIATE.has(event.kind) && now - state.lastPublishedAt < this.intervalMs) return { published: false, messageId: state.messageId };
    await this.client.editMessageText(this.chatId, state.messageId, text);
    state.lastPublishedAt = now;
    if (FINAL.has(event.kind)) state.final = true;
    return { published: true, messageId: state.messageId };
  }
}
