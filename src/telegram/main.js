import { recordTelegramUpdate } from '../db/repositories.js';
import { createPairingRequest } from '../security/identity.js';
import { TelegramClient } from './client.js';
import { runTelegramDeliveryLoop, TelegramDeliveryWorker } from './delivery.js';
import { processBatch } from './update-router.js';

function databaseHandle(database) {
  return database?.db ?? database;
}

function defaultOwner(database) {
  const row = database.prepare('SELECT user_id, chat_id FROM owner_binding WHERE singleton = 1').get();
  return row ? { userId: row.user_id, chatId: row.chat_id } : null;
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
    return { ok: body?.data && typeof body.data.taskId === 'string' };
  } catch {
    return { ok: false };
  } finally {
    requestSignal.dispose();
  }
}

async function coreApprovalRequest(config, path, { method = 'GET', body, fetch = globalThis.fetch } = {}) {
  try {
    const response = await fetch(`${config.coreUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Pi-Control-Key': config.coreClientKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status !== 200) return null;
    return JSON.parse(await response.text())?.data ?? null;
  } catch {
    return null;
  }
}

export async function submitCoreApprovalAction(config, payload, options = {}) {
  const data = await coreApprovalRequest(config, '/v1/approvals/action', { ...options, method: 'POST', body: payload });
  return { ok: typeof data?.state === 'string' };
}

export async function checkCorePendingPassword(config, ownerId, options = {}) {
  const data = await coreApprovalRequest(config, `/v1/approvals/pending-password?ownerId=${encodeURIComponent(ownerId)}`, options);
  return data?.pending === true;
}

export async function submitCorePassword(config, payload, options = {}) {
  const data = await coreApprovalRequest(config, '/v1/approvals/password', { ...options, method: 'POST', body: payload });
  return { ok: data?.ok === true };
}

export function createTelegramGateway({ config, db, client, fetch = globalThis.fetch, logger, notifier, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), getOwner, isPendingPassword, submitPassword, submitApprovalAction, deliveryIntervalMs = 500 } = {}) {
  if (!config || typeof config.coreUrl !== 'string' || typeof config.coreClientKey !== 'string') {
    throw new TypeError('Telegram gateway requires Telegram configuration');
  }
  const database = databaseHandle(db);
  if (!database || typeof database.prepare !== 'function') throw new TypeError('Telegram gateway requires a SQLite database');
  const telegram = client ?? new TelegramClient({ token: config.botToken, fetch, logger });
  const ownerForBatch = getOwner ?? (() => defaultOwner(database));
  const hasRecordedUpdate = (updateId) => Boolean(database.prepare('SELECT 1 FROM telegram_updates WHERE update_id = ?').get(updateId));
  const submit = (envelope) => submitCoreMessage(config, envelope, {
    fetch,
    timeoutMs: config.coreRequestTimeoutMs ?? 10_000,
  });
  const delivery = new TelegramDeliveryWorker({ db: database, client: telegram, getOwner: ownerForBatch });

  return {
    client: telegram,
    async run({ signal, initialOffset = 0 } = {}) {
      try { await notifier?.ready?.(); } catch {}
      const deliveryDone = runTelegramDeliveryLoop({
        worker: delivery, signal, intervalMs: deliveryIntervalMs, logger,
      });
      let offset = initialOffset;
      let failedAttempts = 0;
      try {
        while (!signal?.aborted) {
          try {
            const updates = await telegram.getUpdates({ offset, timeout: config.pollTimeoutSeconds, signal });
            const owner = await ownerForBatch();
            const result = await processBatch(updates, {
              offset,
              owner,
              db: database,
              createPairingRequest,
              sendMessage: telegram.sendMessage.bind(telegram),
              submit,
              isPendingPassword: isPendingPassword ?? (() => checkCorePendingPassword(config, owner.userId, { fetch })),
              submitPassword: submitPassword ?? ((payload) => submitCorePassword(config, payload, { fetch })),
              submitApprovalAction: submitApprovalAction ?? ((payload) => submitCoreApprovalAction(config, payload, { fetch })),
              deletePasswordMessage: telegram.deleteMessage.bind(telegram),
              hasRecordedUpdate,
              recordUpdate: (updateId) => recordTelegramUpdate(database, updateId),
            });
            offset = result.nextOffset;
            try { await notifier?.watchdog?.(); } catch {}
            if (!result.retry) {
              failedAttempts = 0;
              continue;
            }
          } catch {
            // The client and core credentials must never be included in gateway logs.
          }
          if (signal?.aborted) break;
          const delay = retryDelay(failedAttempts);
          failedAttempts += 1;
          logger?.warn?.(`Telegram gateway retrying in ${delay}ms`);
          await sleep(delay);
        }
      } finally {
        await deliveryDone;
      }
    },
  };
}
