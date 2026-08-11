import { authorizeTelegramUpdate, createPairingRequest as createPairingRequestInDatabase } from '../security/identity.js';

function ignored(reason) {
  return { accepted: true, kind: 'ignored', reason };
}

function isPrivateStart(update) {
  const message = update?.message;
  return Number.isSafeInteger(message?.from?.id)
    && message.from.id > 0
    && Number.isSafeInteger(message?.chat?.id)
    && message.chat.id > 0
    && message.chat.type === 'private'
    && message.text === '/start';
}

function validUpdateId(update) {
  return Number.isSafeInteger(update?.update_id) && update.update_id >= 0;
}

function supportedPayloadType(update) {
  if (update === null || typeof update !== 'object' || Array.isArray(update)) return null;
  const hasMessage = Object.hasOwn(update, 'message');
  const hasCallback = Object.hasOwn(update, 'callback_query');
  if (Number(hasMessage) + Number(hasCallback) !== 1) return null;
  const type = hasMessage ? 'message' : 'callback_query';
  const payload = update[type];
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? type : null;
}

function acceptedByCore(result) {
  return result?.ok === true;
}

const RESCUE_ACTION = /^(?:status|check-websites|reboot|(?:logs|restart):[A-Za-z0-9.-]+)$/;

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DOCUMENT_TYPES = new Map([
  ['image/jpeg', ['.jpg', '.jpeg']], ['image/png', ['.png']], ['image/webp', ['.webp']],
  ['application/pdf', ['.pdf']], ['text/plain', ['.txt', '.log']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['.docx']],
]);

function safeFileId(value) {
  return typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

function safeDocument(document) {
  if (!safeFileId(document?.file_id) || typeof document.file_name !== 'string'
    || document.file_name.length < 1 || document.file_name.length > 255
    || !Number.isSafeInteger(document.file_size) || document.file_size < 0 || document.file_size > MAX_ATTACHMENT_BYTES) return null;
  const mimeType = document.mime_type;
  const allowed = DOCUMENT_TYPES.get(mimeType);
  const normalized = document.file_name.replaceAll('\\', '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  if (!allowed?.includes(extension)) return null;
  return { kind: 'document', fileId: document.file_id, fileName: document.file_name, mimeType, sizeBytes: document.file_size };
}

function ownerEnvelope(update, authorization, payloadType) {
  const message = authorization.message;
  const requestId = `telegram:${update.update_id}`;
  if (payloadType === 'callback_query') {
    if (typeof update.callback_query.data !== 'string' || update.callback_query.data.length === 0) return null;
    return { requestId, channel: 'telegram', text: update.callback_query.data, attachments: [] };
  }
  if (typeof message.text === 'string' && message.text.length > 0) {
    return { requestId, channel: 'telegram', text: message.text, attachments: [] };
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo.at(-1);
    if (!safeFileId(photo?.file_id) || (photo.file_size !== undefined
      && (!Number.isSafeInteger(photo.file_size) || photo.file_size < 0 || photo.file_size > MAX_ATTACHMENT_BYTES))) return null;
    return {
      requestId,
      channel: 'telegram',
      text: typeof message.caption === 'string' && message.caption.length > 0 ? message.caption : '[photo]',
      attachments: [{ kind: 'photo', fileId: photo.file_id }],
    };
  }
  if (message.document) {
    const attachment = safeDocument(message.document);
    if (!attachment) return null;
    return {
      requestId,
      channel: 'telegram',
      text: typeof message.caption === 'string' && message.caption.length > 0 ? message.caption : `[document: ${attachment.fileName}]`,
      attachments: [attachment],
    };
  }
  return null;
}

export async function routeUpdate(update, context = {}) {
  const payloadType = supportedPayloadType(update);
  if (!payloadType) return ignored('ambiguous-or-unsupported-payload');
  if (!validUpdateId(update)) return ignored('invalid-update-id');

  if (!context.owner) {
    if (payloadType !== 'message' || !isPrivateStart(update)) return ignored('not-paired');
    const createPairingRequest = context.createPairingRequest ?? createPairingRequestInDatabase;
    try {
      const request = createPairingRequest(context.db, update.message.from.id, update.message.chat.id, context.clock);
      if (typeof context.sendMessage === 'function') {
        await context.sendMessage(update.message.chat.id, `Pairing code: ${request.code}`);
      }
      return { accepted: true, kind: 'pairing-request', request };
    } catch {
      return { accepted: false, kind: 'pairing-request' };
    }
  }

  const authorizationUpdate = payloadType === 'message'
    ? { message: update.message }
    : { callback_query: update.callback_query };
  const authorization = authorizeTelegramUpdate(authorizationUpdate, context.owner);
  if (!authorization.ok) return ignored('unauthorized');

  if (payloadType === 'callback_query' && typeof context.submitApprovalAction === 'function') {
    const match = /^(approve|cancel):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
      .exec(update.callback_query.data ?? '');
    if (match) {
      try {
        const result = await context.submitApprovalAction({ action: match[1], approvalId: match[2], ownerId: context.owner.userId });
        return { accepted: acceptedByCore(result), kind: 'approval-action' };
      } catch {
        return { accepted: false, kind: 'approval-action' };
      }
    }
  }

  const pendingPassword = payloadType === 'message'
    && typeof context.isPendingPassword === 'function'
    && await context.isPendingPassword(update);
  if (pendingPassword) {
    if (typeof authorization.message.text !== 'string' || authorization.message.text.length === 0
      || typeof context.submitPassword !== 'function') return { accepted: false, kind: 'pending-password' };
    try {
      const result = await context.submitPassword({
        update: update.update_id,
        ownerId: context.owner.userId,
        password: authorization.message.text,
      });
      const accepted = acceptedByCore(result);
      if (accepted && typeof context.deletePasswordMessage === 'function'
        && Number.isSafeInteger(authorization.message.message_id)) {
        try {
          await context.deletePasswordMessage(authorization.message.chat.id, authorization.message.message_id);
        } catch {
          // Core already consumed the sensitive update. Telegram deletion is best-effort
          // and must never make the plaintext update eligible for ordinary chat replay.
        }
      }
      return { accepted, kind: 'pending-password' };
    } catch {
      return { accepted: false, kind: 'pending-password' };
    }
  }

  if (payloadType === 'message' && typeof context.rescueActive === 'function') {
    let active;
    try {
      active = await context.rescueActive();
    } catch {
      return { accepted: false, kind: 'rescue-state' };
    }
    if (active) {
      const action = authorization.message.text;
      if (typeof action !== 'string' || !RESCUE_ACTION.test(action)
          || typeof context.executeRescue !== 'function') return ignored('unsupported-rescue-command');
      try {
        const approval = typeof context.rescueApproval === 'function'
          ? await context.rescueApproval(update, action) : null;
        const result = await context.executeRescue(action, context.owner, approval);
        return { accepted: acceptedByCore(result), kind: 'rescue-command' };
      } catch {
        return { accepted: false, kind: 'rescue-command' };
      }
    }
  }

  const envelope = ownerEnvelope(update, authorization, payloadType);
  if (!envelope) return ignored('unsupported-owner-update');
  if (typeof context.submit !== 'function') return { accepted: false, kind: 'core-message' };
  try {
    const result = await context.submit(envelope);
    return { accepted: acceptedByCore(result), kind: 'core-message', envelope };
  } catch {
    return { accepted: false, kind: 'core-message' };
  }
}

export async function processBatch(updates, context = {}) {
  if (!Array.isArray(updates)) throw new TypeError('Telegram updates must be an array');
  const valid = updates.filter(validUpdateId).sort((left, right) => left.update_id - right.update_id);
  let nextOffset = Number.isSafeInteger(context.offset) && context.offset >= 0
    ? context.offset : (valid[0]?.update_id ?? 0);
  const batchIds = new Set();

  for (const update of valid) {
    if (update.update_id < nextOffset || batchIds.has(update.update_id)) continue;
    batchIds.add(update.update_id);
    if (typeof context.hasRecordedUpdate === 'function' && context.hasRecordedUpdate(update.update_id)) {
      nextOffset = update.update_id + 1;
      continue;
    }
    const result = await routeUpdate(update, context);
    if (!result.accepted) return { nextOffset, retry: true, result };
    if (result.kind !== 'ignored' && typeof context.recordUpdate === 'function') {
      context.recordUpdate(update.update_id);
    }
    nextOffset = update.update_id + 1;
  }
  return { nextOffset, retry: false };
}
