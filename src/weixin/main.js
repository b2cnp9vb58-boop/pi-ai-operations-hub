import { recordWeixinUpdate } from '../db/repositories.js';
import { WeixinClient } from './client.js';
import { approveWeixinPairing, authorizeWeixinSender } from './identity.js';

function databaseHandle(database) {
  return database?.db ?? database;
}

function retryDelay(attempt) {
  return Math.min(30_000, 1000 * (2 ** Math.min(attempt, 5)));
}

function coreRequestSignal(parentSignal, timeoutMs, timers) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = timers.setTimeout(() => controller.abort(new Error('Core request timed out')), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      timers.clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}


async function deliverReply(taskId, contextToken, fromUserId, weixin, config, sleep) {
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    try {
      const resp = await fetch(`${config.coreUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
        headers: { 'X-Pi-Control-Key': config.coreClientKey },
      });
      const data = (await resp.json())?.data;
      const state = data?.state;
      if (state === 'completed') {
        const summary = data?.resultSummary;
        if (summary && weixin?.sendMessage) {
          try {
            await weixin.sendMessage({ contextToken, text: String(summary).slice(0, 3500), chatId: fromUserId });
          } catch (err) {
            logger?.warn?.('WeChat sendText failed: ' + (err?.message ?? 'unknown'));
          }
        }
        return;
      }
      if (state === 'failed' || state === 'interrupted') return;
    } catch {}
  }
}

export async function submitCoreMessage(config, envelope, {
  fetch = globalThis.fetch,
  signal,
  timeoutMs = 10_000,
  timers = globalThis,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('core request timeout must be a positive integer');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
    throw new TypeError('core request timers are required');
  }
  const requestSignal = coreRequestSignal(signal, timeoutMs, timers);
  try {
    if (requestSignal.signal.aborted) return { ok: false };
    const response = await fetch(`${config.coreUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Control-Key': config.coreClientKey },
      body: JSON.stringify(envelope),
      signal: requestSignal.signal,
    });
    if (response.status !== 202) return { ok: false };
    const body = JSON.parse(await response.text());
    return { ok: body?.data && typeof body.data.taskId === 'string', taskId: body?.data?.taskId ?? null };
  } catch {
    return { ok: false };
  } finally {
    requestSignal.dispose();
  }
}

export function createWeixinGateway({
  config, db, client, fetch = globalThis.fetch,
  logger, notifier, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!config || typeof config.coreUrl !== 'string' || typeof config.coreClientKey !== 'string') {
    throw new TypeError('WeChat gateway requires configuration');
  }
  const database = databaseHandle(db);
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('WeChat gateway requires a SQLite database');
  }
  const weixin = client ?? new WeixinClient({ fetch, logger });
  if (config.botToken) {
    weixin.setToken(config.botToken);
  }
  const hasRecordedUpdate = (updateId) => Boolean(
    database.prepare('SELECT 1 FROM weixin_updates WHERE update_id = ?').get(updateId),
  );
  const submit = (envelope) => submitCoreMessage(config, envelope, {
    fetch,
    timeoutMs: config.coreRequestTimeoutMs ?? 10_000,
  });

  return {
    client: weixin,
    async run({ signal, initialOffset = 0 } = {}) {
      try { await notifier?.ready?.(); } catch {}
      let buf = '';
      let failedAttempts = 0;
      while (!signal?.aborted) {
          try {
            const updates = await weixin.getUpdates({ buf, timeout: config.pollTimeoutSeconds, signal });
            if (updates?.get_updates_buf) buf = updates.get_updates_buf;

            const messages = updates?.msgs ?? [];
            for (const msg of messages) {
              if (!msg || typeof msg !== 'object') continue;
              if (msg.message_type !== 1) continue;
              const rawUpdateId = msg.message_id ?? msg.seq ?? msg.id;
              const updateId = rawUpdateId == null ? '' : String(rawUpdateId);
              let text = '';
              for (const item of (msg.item_list ?? [])) {
                if (item && item.type === 1 && item.text_item && item.text_item.text != null) {
                  text = String(item.text_item.text);
                  break;
                }
              }
              const contextToken = msg.context_token ?? '';
              const fromUserId = msg.from_user_id ?? '';

              if (!text || !contextToken || !fromUserId || !updateId) continue;
              if (hasRecordedUpdate(updateId)) continue;

              if (!authorizeWeixinSender(database, fromUserId)) {
                const pairing = text.trim().match(/^(?:\/?绑定\s*)?(\d{8})$/u);
                if (pairing) {
                  try {
                    approveWeixinPairing(database, pairing[1], fromUserId);
                    await weixin.sendMessage({
                      contextToken,
                      chatId: fromUserId,
                      text: '绑定完成。之后只有此微信账号可以使用该机器人。',
                    });
                  } catch {
                    // Do not reveal whether a valid code or owner binding exists.
                  }
                }
                recordWeixinUpdate(database, updateId);
                continue;
              }

              const envelope = {
                requestId: `weixin:${updateId}`,
                channel: 'weixin',
                text,
                attachments: [],
              };
              const submitted = await submit(envelope);
              if (submitted?.ok && submitted?.taskId && contextToken) {
                try {
                  await deliverReply(submitted.taskId, contextToken, fromUserId, weixin, config, sleep);
                } catch (err) {
                  logger?.warn?.('WeChat reply failed: ' + (err?.message ?? 'unknown'));
                }
              }

              recordWeixinUpdate(database, updateId);
            }
            try { await notifier?.watchdog?.(); } catch {}
            failedAttempts = 0;
          } catch (err) {
            logger?.warn?.('WeChat poll failed: ' + (err?.message ?? 'unknown'));
          }
          if (signal?.aborted) break;
          const delay = retryDelay(failedAttempts);
          failedAttempts += 1;
          logger?.warn?.(`WeChat gateway retrying in ${delay}ms`);
          await sleep(delay);
      }
    },
  };
}
