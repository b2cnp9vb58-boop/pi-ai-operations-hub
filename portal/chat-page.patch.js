(() => {
  'use strict';
  const OUTBOX_KEY = 'pi-shared-chat-outbox-v1';
  const acceptedStatuses = new Set(['accepted', 'existing']);
  const inFlight = new Map();
  let historyCursor = 0;
  let stopped = false;

  function textHash(text) {
    let hash = 2166136261;
    for (const character of text) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function listPendingMessages() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(OUTBOX_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => item && typeof item.rid === 'string'
        && typeof item.text === 'string' && item.hash === textHash(item.text));
    } catch (_error) {
      return [];
    }
  }

  function writeOutbox(items) {
    if (items.length) sessionStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
    else sessionStorage.removeItem(OUTBOX_KEY);
  }

  function createPendingMessage(text) {
    if (typeof text !== 'string' || !text) throw new TypeError('message text is required');
    const pending = { rid: crypto.randomUUID(), text, hash: textHash(text) };
    writeOutbox([...listPendingMessages(), pending]);
    return pending;
  }

  function storedPending(candidate) {
    if (!candidate || typeof candidate.rid !== 'string' || typeof candidate.text !== 'string'
        || candidate.hash !== textHash(candidate.text)) throw new TypeError('invalid pending message');
    const stored = listPendingMessages().find((item) => item.rid === candidate.rid);
    if (!stored || stored.text !== candidate.text || stored.hash !== candidate.hash) {
      throw new TypeError('pending message is not in the outbox');
    }
    return stored;
  }

  function removePendingMessage(rid) {
    writeOutbox(listPendingMessages().filter((item) => item.rid !== rid));
  }

  function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
  }

  async function portalFetch(path, options = {}) {
    const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) };
    if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrfToken();
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 401 || response.status === 403) throw new Error('portal session expired');
    if (!response.ok) throw new Error('portal request failed');
    return response.json();
  }

  function renderMessage(message, container) {
    const row = document.createElement('div');
    row.className = 'message';
    const meta = document.createElement('small');
    meta.textContent = `${message.channel || 'system'} · ${message.createdAt || ''} · ${message.taskId || ''}`;
    const body = document.createElement('div');
    body.textContent = String(message.body || '');
    row.append(meta, body);
    container.append(row);
  }

  async function loadHistory(container) {
    try {
      const response = await portalFetch(`/chat-api/history?after=${encodeURIComponent(historyCursor)}`);
      for (const message of response.events || []) renderMessage(message, container);
      historyCursor = Number(response.eventCursor || historyCursor);
    } finally {
      if (!stopped) setTimeout(() => loadHistory(container), 1500);
    }
  }

  function sendMessage(candidate) {
    const pending = storedPending(candidate);
    if (inFlight.has(pending.rid)) return inFlight.get(pending.rid);
    const request = portalFetch('/chat-api', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rid: pending.rid, text: pending.text }),
    }).then((response) => {
      if (!response || response.rid !== pending.rid || typeof response.taskId !== 'string'
          || !response.taskId || !acceptedStatuses.has(response.status)) {
        throw new Error('portal did not acknowledge the pending message');
      }
      removePendingMessage(pending.rid);
      return response;
    }).finally(() => inFlight.delete(pending.rid));
    inFlight.set(pending.rid, request);
    return request;
  }

  function retryPendingMessage(rid) {
    const pending = listPendingMessages().find((item) => item.rid === rid);
    if (!pending) throw new TypeError('unknown pending message');
    return sendMessage(pending);
  }

  async function pollTask(rid) {
    return portalFetch(`/chat-api?rid=${encodeURIComponent(rid)}`);
  }

  async function cancelTask(rid) {
    return portalFetch(`/chat-api/cancel?rid=${encodeURIComponent(rid)}`, { method: 'POST' });
  }

  window.PiSharedChat = {
    createPendingMessage, listPendingMessages, sendMessage, retryPendingMessage,
    loadHistory, pollTask, cancelTask, stop() { stopped = true; },
  };
})();
