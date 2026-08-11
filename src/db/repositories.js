import { randomUUID } from 'node:crypto';

const TASK_PATCH_COLUMNS = Object.freeze({
  claudeSessionId: 'claude_session_id',
  cancelRequested: 'cancel_requested',
  resultSummary: 'result_summary',
});

function timestamp() {
  return new Date().toISOString();
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function asStoredMessage(row) {
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

function asStoredTask(row) {
  return {
    id: row.id,
    source: row.source,
    requestMessageId: row.request_message_id,
    state: row.state,
    claudeSessionId: row.claude_session_id,
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resultSummary: row.result_summary,
  };
}

function asStoredOutboxEvent(row) {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

function appendTaskEvent(db, taskId, kind, payload, createdAt = timestamp()) {
  db.prepare(`
    INSERT INTO task_events(task_id, kind, payload_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(taskId, kind, JSON.stringify(payload), createdAt);
}

function taskPatch(patch) {
  const entries = Object.entries(patch ?? {});
  for (const [key] of entries) {
    if (!(key in TASK_PATCH_COLUMNS)) {
      throw new Error(`unsupported task patch field: ${key}`);
    }
  }
  return entries.map(([key, value]) => [TASK_PATCH_COLUMNS[key], key === 'cancelRequested' ? Number(Boolean(value)) : value]);
}

export function appendMessage(db, message) {
  const id = randomUUID();
  const createdAt = timestamp();
  db.prepare(`
    INSERT INTO messages(id, sequence, channel, role, body, task_id, created_at)
    VALUES (?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM messages), ?, ?, ?, ?, ?)
  `).run(id, message.channel, message.role, message.body, message.taskId ?? null, createdAt);
  return asStoredMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
}

export function createTask(db, task) {
  return transaction(db, () => {
    const id = randomUUID();
    const createdAt = timestamp();
    db.prepare(`
      INSERT INTO tasks(id, source, request_message_id, state, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `).run(id, task.source, task.requestMessageId, createdAt, createdAt);
    appendTaskEvent(db, id, 'created', { source: task.source, requestMessageId: task.requestMessageId }, createdAt);
    return asStoredTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  });
}

export function transitionTask(db, taskId, from, to, patch = {}) {
  return transaction(db, () => {
    const assignments = taskPatch(patch);
    const updatedAt = timestamp();
    const setClauses = ['state = ?', 'updated_at = ?', ...assignments.map(([column]) => `${column} = ?`)];
    const values = [to, updatedAt, ...assignments.map(([, value]) => value), taskId, from];
    const result = db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ? AND state = ?`).run(...values);
    if (result.changes !== 1) {
      throw new Error(`state conflict for task ${taskId}: expected ${from}`);
    }
    appendTaskEvent(db, taskId, 'transitioned', { from, to, patch }, updatedAt);
    return asStoredTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
  });
}

export function recordTelegramUpdate(db, updateId) {
  const result = db.prepare(`
    INSERT INTO telegram_updates(update_id, received_at) VALUES (?, ?)
    ON CONFLICT(update_id) DO NOTHING
  `).run(updateId, timestamp());
  return result.changes === 1;
}

export function recordWeixinUpdate(db, updateId) {
  const result = db.prepare(`
    INSERT INTO weixin_updates(update_id, received_at) VALUES (?, ?)
    ON CONFLICT(update_id) DO NOTHING
  `).run(String(updateId), timestamp());
  return result.changes === 1;
}

export function appendOutbox(db, event) {
  const createdAt = timestamp();
  const result = db.prepare(`
    INSERT INTO outbox(kind, payload_json, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(event.kind, JSON.stringify(event.payload), event.nextAttemptAt ?? createdAt, createdAt);
  return asStoredOutboxEvent(db.prepare('SELECT * FROM outbox WHERE id = ?').get(Number(result.lastInsertRowid)));
}

export function claimOutbox(db, limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('outbox claim limit must be a positive integer');
  }
  return transaction(db, () => {
    const ids = db.prepare(`
      SELECT id FROM outbox
      WHERE state = 'pending' AND next_attempt_at <= ?
      ORDER BY id
      LIMIT ?
    `).all(timestamp(), limit).map(({ id }) => id);
    const claim = db.prepare(`
      UPDATE outbox SET state = 'sending', attempts = attempts + 1
      WHERE id = ? AND state = 'pending'
    `);
    for (const id of ids) {
      if (claim.run(id).changes !== 1) {
        throw new Error(`outbox claim conflict for event ${id}`);
      }
    }
    if (ids.length === 0) return [];
    return db.prepare(`SELECT * FROM outbox WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`).all(...ids)
      .map(asStoredOutboxEvent);
  });
}

export function claimAlertOutbox(db, limit, now = timestamp()) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('outbox claim limit must be a positive integer');
  }
  return transaction(db, () => {
    const ids = db.prepare(`
      SELECT id FROM outbox
      WHERE state = 'pending' AND kind IN ('alert', 'recovery') AND next_attempt_at <= ?
      ORDER BY id
      LIMIT ?
    `).all(now, limit).map(({ id }) => id);
    const claim = db.prepare(`
      UPDATE outbox SET state = 'sending', attempts = attempts + 1
      WHERE id = ? AND state = 'pending'
    `);
    for (const id of ids) {
      if (claim.run(id).changes !== 1) throw new Error(`outbox claim conflict for event ${id}`);
    }
    if (ids.length === 0) return [];
    return db.prepare(`SELECT * FROM outbox WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`).all(...ids)
      .map(asStoredOutboxEvent);
  });
}

export function claimTelegramOutbox(db, limit, now = timestamp()) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('outbox claim limit must be a positive integer');
  }
  return transaction(db, () => {
    const ids = db.prepare(`
      SELECT id FROM outbox
      WHERE state = 'pending' AND kind LIKE 'telegram.%' AND next_attempt_at <= ?
      ORDER BY id
      LIMIT ?
    `).all(now, limit).map(({ id }) => id);
    const claim = db.prepare(`
      UPDATE outbox SET state = 'sending', attempts = attempts + 1
      WHERE id = ? AND state = 'pending'
    `);
    for (const id of ids) {
      if (claim.run(id).changes !== 1) throw new Error(`outbox claim conflict for event ${id}`);
    }
    if (ids.length === 0) return [];
    return db.prepare(`SELECT * FROM outbox WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`).all(...ids)
      .map(asStoredOutboxEvent);
  });
}

export function markOutboxSent(db, id) {
  const result = db.prepare(`
    UPDATE outbox SET state = 'sent', sent_at = ?
    WHERE id = ? AND state = 'sending'
  `).run(timestamp(), id);
  if (result.changes !== 1) {
    throw new Error(`outbox state conflict for event ${id}`);
  }
}

export function releaseOutbox(db, id, nextAttemptAt) {
  const result = db.prepare(`
    UPDATE outbox SET state = 'pending', next_attempt_at = ?
    WHERE id = ? AND state = 'sending'
  `).run(nextAttemptAt, id);
  if (result.changes !== 1) throw new Error(`outbox state conflict for event ${id}`);
}

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setSetting(db, key, value, updatedAt = timestamp()) {
  db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, updatedAt);
}

export function updateSettingWithOutbox(db, key, updatedAt, update) {
  if (typeof update !== 'function') throw new TypeError('setting update function is required');
  return transaction(db, () => {
    const current = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    const next = update(current);
    if (!next || typeof next.value !== 'string') throw new TypeError('setting update must return a string value');
    if (next.event) appendOutbox(db, next.event);
    db.prepare(`
      INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, next.value, updatedAt);
    return next.result;
  });
}
