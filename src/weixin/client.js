import crypto from 'node:crypto';
import https from 'node:https';
import { URL } from 'node:url';
const API_ORIGIN = 'https://ilinkai.weixin.qq.com';
const MAX_BACKOFF_MS = 30_000;

export class WeixinApiError extends Error {
  constructor(message, { retryable = true, retryAfterMs } = {}) {
    super(message);
    this.name = 'WeixinApiError';
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryDelay(attempt) {
  return Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.min(attempt, 5)));
}


function randomWechatUin() {
  const value = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(value), "utf-8").toString("base64");
}

function errorForResponse(status, payload) {
  if (status === 429) {
    const retryAfter = Number(payload?.retry_after);
    return new WeixinApiError('WeChat rate limited the request', {
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(MAX_BACKOFF_MS, retryAfter * 1000) : undefined,
    });
  }
  if (status >= 500 || status === 408) return new WeixinApiError('WeChat service is temporarily unavailable');
  return new WeixinApiError('WeChat rejected the request', { retryable: false });
}

function aborted(signal) {
  const error = signal?.reason instanceof Error ? signal.reason : new Error('WeChat request aborted');
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
    controller.abort(new Error('WeChat request timed out'));
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

const CHANNEL_VERSION = '1.0.0';
const BOT_AGENT = 'pi-control-weixin/1.0';

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

export class WeixinClient {
  constructor(options = {}) {
    const {
      token,
      fetch = globalThis.fetch,
      logger,
      sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      requestTimeoutMs = 30_000,
    } = options;
    this.token = token ?? null;
    if (typeof fetch !== 'function') throw new TypeError('WeChat fetch implementation is required');
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new TypeError('WeChat request timeout must be a positive integer');
    }
    this.fetch = fetch;
    this.logger = logger;
    this.sleep = sleep;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  setToken(token) {
    if (typeof token !== 'string' || token.length === 0) throw new TypeError('WeChat token is required');
    this.token = token;
  }

  #authHeaders() {
    if (!this.token) throw new WeixinApiError('WeChat client is not authenticated', { retryable: false });
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
    };
  }

  async #request(method, path, payload, { signal: parentSignal, timeoutMs = this.requestTimeoutMs } = {}) {
    let attempt = 0;
    for (;;) {
      if (parentSignal?.aborted) throw aborted(parentSignal);
      const attemptSignal = requestSignal(parentSignal, timeoutMs);
      try {
        const url = `${API_ORIGIN}${path}`;
        const options = {
          method,
          headers: path.includes('/get_bot_qrcode') ? {} : this.#authHeaders(),
          signal: attemptSignal.signal,
        };
        if (method !== 'GET') {
          const body = payload ?? {};
          body.base_info = buildBaseInfo();
          options.body = JSON.stringify(body);
        }
        const response = await this.fetch(url, options);
        let body;
        try {
          body = JSON.parse(await response.text());
        } catch {
          throw new WeixinApiError('WeChat returned malformed JSON');
        }
        if (!response || typeof response.status !== 'number') {
          throw new WeixinApiError('WeChat returned an invalid response');
        }

        // Token expired — caller must re-authenticate
        if (body?.errcode === -14) {
          throw new WeixinApiError('WeChat session expired', { retryable: false });
        }

        if (response.status < 200 || response.status >= 300 || body?.ok === false) {
          throw errorForResponse(response.status, body);
        }
        return body;
      } catch (error) {
        if (error instanceof WeixinApiError && !error.retryable) throw error;
        if (parentSignal?.aborted) throw aborted(parentSignal);
        const retryable = attemptSignal.timedOut() || !(error instanceof WeixinApiError) || error.retryable;
        if (!retryable) throw error;
        const delay = error instanceof WeixinApiError && error.retryAfterMs !== undefined
          ? error.retryAfterMs : retryDelay(attempt);
        this.#warnRetry(path, delay);
        if (!(error instanceof WeixinApiError && error.retryAfterMs !== undefined)) attempt += 1;
        await this.sleep(delay);
      } finally {
        attemptSignal.dispose();
      }
    }
  }

  #warnRetry(path, delay) {
    this.logger?.warn?.(`WeChat ${path} retrying in ${delay}ms`);
  }

  // === QR Login Flow ===

  async getBotQrcode(botType = 3) {
    const response = await this.fetch(`${API_ORIGIN}/ilink/bot/get_bot_qrcode?bot_type=${botType}`);
    if (!response.ok) throw new WeixinApiError('Failed to get QR code');
    return response.arrayBuffer();
  }

  async getQrcodeStatus() {
    const body = await this.#request('GET', '/ilink/bot/get_qrcode_status');
    return {
      status: body?.status,
      token: body?.token ?? body?.bot_token ?? null,
      botId: body?.bot_id ?? body?.ilink_bot_id ?? null,
    };
  }

  // === Messaging ===

  async getUpdates({ buf, timeout = 35, signal } = {}) {
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 50) {
      throw new TypeError('WeChat poll timeout must be an integer between 1 and 50 seconds');
    }
    const timeoutMs = Math.max(this.requestTimeoutMs, (timeout + 10) * 1000);
    const payload = {};
    if (typeof buf === 'string' && buf.length > 0) payload.get_updates_buf = buf;
    return this.#request('POST', '/ilink/bot/getupdates', payload, { signal, timeoutMs });
  }

  async sendMessage({ contextToken, text, chatId } = {}) {
    if (typeof text !== 'string' || text.length === 0) throw new TypeError('WeChat message text must be non-empty');
    if (typeof contextToken !== 'string' || contextToken.length === 0) {
      throw new TypeError('WeChat context token is required');
    }
    if (typeof chatId !== 'string' || chatId.length === 0) {
      throw new TypeError('WeChat to_user_id (chatId) is required');
    }
    const clientId = 'wx-bot-' + crypto.randomBytes(8).toString('hex');
    const payload = {
      msg: {
        from_user_id: '',
        to_user_id: chatId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
      },
    };
    return this.#directRequest('/ilink/bot/sendmessage', payload);
  }

  #directRequest(path, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ ...payload, base_info: buildBaseInfo() });
      const url = new URL(API_ORIGIN + path);
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          ...this.#authHeaders(),
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
        });
      });
      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    });
  }

  async sendTyping({ contextToken, status = 1 } = {}) {
    if (typeof contextToken !== 'string' || contextToken.length === 0) {
      throw new TypeError('WeChat context token is required for typing indicator');
    }
    return this.#request('POST', '/ilink/bot/sendtyping', {
      context_token: contextToken,
      status,
    });
  }
}
