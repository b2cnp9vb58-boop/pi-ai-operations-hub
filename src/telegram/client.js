const API_ORIGIN = 'https://api.telegram.org';
const MAX_BACKOFF_MS = 30_000;

export class TelegramApiError extends Error {
  constructor(message, { retryable = true, retryAfterMs } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function requireToken(token) {
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('Telegram bot token is required');
  return token;
}

function retryDelay(attempt) {
  return Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.min(attempt, 5)));
}

function errorForResponse(status, payload) {
  const retryAfter = Number(payload?.parameters?.retry_after);
  if (status === 429) {
    return new TelegramApiError('Telegram rate limited the request', {
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(MAX_BACKOFF_MS, retryAfter * 1000) : undefined,
    });
  }
  if (status >= 500 || status === 408) return new TelegramApiError('Telegram service is temporarily unavailable');
  return new TelegramApiError('Telegram rejected the request', { retryable: false });
}

function aborted(signal) {
  const error = signal?.reason instanceof Error ? signal.reason : new Error('Telegram request aborted');
  error.name = error.name === 'Error' ? 'AbortError' : error.name;
  return error;
}

function requestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Telegram request timed out'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

export class TelegramClient {
  constructor(options = {}) {
    const { token, fetch = globalThis.fetch, logger, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), requestTimeoutMs = 30_000 } = options;
    this.token = requireToken(token);
    if (typeof fetch !== 'function') throw new TypeError('Telegram fetch implementation is required');
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new TypeError('Telegram request timeout must be a positive integer');
    this.fetch = fetch;
    this.logger = logger;
    this.sleep = sleep;
    this.requestTimeoutMs = requestTimeoutMs;
    this.hasExplicitRequestTimeout = Object.hasOwn(options, 'requestTimeoutMs');
  }

  async getUpdates({ offset = 0, timeout = 45, signal } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Telegram update offset must be a non-negative safe integer');
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 50) throw new TypeError('Telegram poll timeout must be an integer between 1 and 50 seconds');
    const timeoutMs = this.hasExplicitRequestTimeout ? this.requestTimeoutMs : Math.max(this.requestTimeoutMs, (timeout + 5) * 1000);
    return this.#request('getUpdates', { offset, timeout }, { signal, timeoutMs });
  }

  async sendMessage(chatId, text, options = {}) {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new TypeError('Telegram chat id must be a positive safe integer');
    if (typeof text !== 'string' || text.length === 0) throw new TypeError('Telegram message text must be non-empty');
    return this.#request('sendMessage', { chat_id: chatId, text, ...options });
  }

  async deleteMessage(chatId, messageId) {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new TypeError('Telegram chat id must be a positive safe integer');
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new TypeError('Telegram message id must be a positive safe integer');
    return this.#request('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  async editMessageText(chatId, messageId, text) {
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0) throw new TypeError('valid chat and message ids are required');
    if (typeof text !== 'string' || text.length === 0) throw new TypeError('Telegram message text must be non-empty');
    return this.#request('editMessageText', { chat_id: chatId, message_id: messageId, text });
  }

  async #request(method, payload, { signal: parentSignal, timeoutMs = this.requestTimeoutMs } = {}) {
    let attempt = 0;
    for (;;) {
      if (parentSignal?.aborted) throw aborted(parentSignal);
      const attemptSignal = requestSignal(parentSignal, timeoutMs);
      try {
        const response = await this.fetch(`${API_ORIGIN}/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: attemptSignal.signal,
        });
        let body;
        try {
          body = JSON.parse(await response.text());
        } catch {
          throw new TelegramApiError('Telegram returned malformed JSON');
        }
        if (!response || typeof response.status !== 'number') throw new TelegramApiError('Telegram returned an invalid response');
        if (response.status < 200 || response.status >= 300 || body?.ok !== true) {
          throw errorForResponse(response.status, body);
        }
        return body.result;
      } catch (error) {
        if (parentSignal?.aborted) throw aborted(parentSignal);
        const retryable = attemptSignal.timedOut() || !(error instanceof TelegramApiError) || error.retryable;
        if (!retryable) throw error;
        const delay = error instanceof TelegramApiError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : retryDelay(attempt);
        this.#warnRetry(method, delay);
        if (!(error instanceof TelegramApiError && error.retryAfterMs !== undefined)) attempt += 1;
        await this.sleep(delay);
      } finally {
        attemptSignal.dispose();
      }
    }
  }

  #warnRetry(method, delay) {
    // Do not include URLs, response bodies, or thrown error text: all may contain secrets.
    this.logger?.warn?.(`Telegram ${method} retrying in ${delay}ms`);
  }
}
