import { createHash, randomUUID } from 'node:crypto';
import { appendOutbox } from '../db/repositories.js';

const ACTIVE_STATES = Object.freeze(['running', 'waiting_confirmation', 'cancelling']);

function timestamp() {
  return new Date().toISOString();
}

function requestMessageId(channel, requestId) {
  const digest = createHash('sha256').update(channel).update('\0').update(requestId).digest('hex');
  return `request-${digest}`;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('attachment numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('attachments must contain only JSON values');
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('attachments must contain only JSON values');
}

// The canonical payload contains exactly text then attachments. Text is exact,
// object keys are recursively sorted, and every array position is significant.
function payloadFingerprint(text, attachments) {
  const canonical = `{"text":${canonicalJson(text)},"attachments":${canonicalJson(attachments)}}`;
  return createHash('sha256').update(canonical).digest('hex');
}

function storedPayloadFingerprint(row) {
  try {
    const created = JSON.parse(row.created_payload_json);
    const reconstructed = payloadFingerprint(row.message_body, created.attachments);
    if (created.payloadFingerprint !== undefined && created.payloadFingerprint !== reconstructed) return null;
    return reconstructed;
  } catch {
    return null;
  }
}

export class RequestConflictError extends Error {
  constructor() {
    super('requestId already exists with a different payload');
    this.name = 'RequestConflictError';
    this.code = 'request_conflict';
  }
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

function asTask(row, eventCursor) {
  if (!row) return null;
  const task = {
    id: row.id,
    source: row.source,
    requestMessageId: row.request_message_id,
    state: row.state,
    claudeSessionId: row.claude_session_id,
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resultSummary: row.result_summary,
    workerId: row.worker_id ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    heartbeatAt: row.heartbeat_at ?? null,
    attemptCount: Number(row.attempt_count ?? 0),
  };
  if (typeof row.message_body === 'string') task.text = row.message_body;
  if (typeof row.message_channel === 'string') task.channel = row.message_channel;
  if (eventCursor !== undefined) task.eventCursor = eventCursor;
  return task;
}

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

function validateEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('task envelope must be an object');
  }
  const allowed = new Set(['requestId', 'channel', 'text', 'attachments']);
  for (const key of Object.keys(envelope)) {
    if (!allowed.has(key)) throw new TypeError(`unknown task envelope field: ${key}`);
  }
  if (typeof envelope.requestId !== 'string' || envelope.requestId.length === 0 || envelope.requestId.length > 256) {
    throw new TypeError('requestId must be a non-empty string of at most 256 characters');
  }
  if (!['telegram', 'web', 'weixin'].includes(envelope.channel)) {
    throw new TypeError('channel must be telegram, web, or weixin');
  }
  if (typeof envelope.text !== 'string' || envelope.text.length === 0) {
    throw new TypeError('text must be a non-empty string');
  }
  const attachments = envelope.attachments ?? [];
  if (!Array.isArray(attachments)) {
    throw new TypeError('attachments must be an array');
  }
  return { ...envelope, attachments };
}

function appendTaskEvent(db, taskId, kind, payload, createdAt = timestamp()) {
  db.prepare(`
    INSERT INTO task_events(task_id, kind, payload_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(taskId, kind, JSON.stringify(payload), createdAt);
}

function transition(db, row, to, patch = {}) {
  const updatedAt = timestamp();
  const result = db.prepare(`
    UPDATE tasks
    SET state = ?, cancel_requested = ?, updated_at = ?
    WHERE id = ? AND state = ?
  `).run(to, Number(patch.cancelRequested ?? Boolean(row.cancel_requested)), updatedAt, row.id, row.state);
  if (result.changes !== 1) {
    throw new Error(`state conflict for task ${row.id}: expected ${row.state}`);
  }
  appendTaskEvent(db, row.id, 'transitioned', { from: row.state, to, patch }, updatedAt);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
}

export class TaskService {
  constructor(database, { workerId = randomUUID(), leaseMs = 30_000, clock = Date.now } = {}) {
    this.db = database?.db ?? database;
    if (!this.db || typeof this.db.prepare !== 'function') {
      throw new TypeError('TaskService requires a SQLite database');
    }
    if (typeof workerId !== 'string' || !workerId) throw new TypeError('workerId is required');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('leaseMs must be positive');
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.clock = clock;
  }

  #now() {
    const value = this.clock();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw new TypeError('clock must return a valid time');
    return milliseconds;
  }

  submit(input) {
    const envelope = validateEnvelope(input);
    const fingerprint = payloadFingerprint(envelope.text, envelope.attachments);
    return transaction(this.db, () => {
      const messageId = requestMessageId(envelope.channel, envelope.requestId);
      const existing = this.db.prepare(`
        SELECT tasks.*, messages.sequence AS event_cursor, messages.body AS message_body,
          (SELECT payload_json FROM task_events
            WHERE task_events.task_id = tasks.id AND task_events.kind = 'created'
            ORDER BY task_events.id LIMIT 1) AS created_payload_json
        FROM tasks
        JOIN messages ON messages.id = tasks.request_message_id AND messages.role = 'user'
        WHERE tasks.source = ? AND tasks.request_message_id = ?
        LIMIT 1
      `).get(envelope.channel, messageId);
      if (existing) {
        if (storedPayloadFingerprint(existing) !== fingerprint) throw new RequestConflictError();
        return asTask(existing, existing.event_cursor);
      }

      const taskId = randomUUID();
      const createdAt = timestamp();
      const sequence = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM messages').get().sequence;
      this.db.prepare(`
        INSERT INTO tasks(id, source, request_message_id, state, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?)
      `).run(taskId, envelope.channel, messageId, createdAt, createdAt);
      this.db.prepare(`
        INSERT INTO messages(id, sequence, channel, role, body, task_id, created_at)
        VALUES (?, ?, ?, 'user', ?, ?, ?)
      `).run(messageId, sequence, envelope.channel, envelope.text, taskId, createdAt);
      appendTaskEvent(this.db, taskId, 'created', {
        source: envelope.channel,
        requestId: envelope.requestId,
        messageId,
        attachments: envelope.attachments,
        payloadFingerprint: fingerprint,
      }, createdAt);
      if (envelope.channel === 'telegram') {
        appendOutbox(this.db, { kind: 'telegram.task.accepted', payload: { taskId } });
      }
      return asTask(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId), sequence);
    });
  }

  claimNext() {
    return transaction(this.db, () => {
      const active = this.db.prepare(`
        SELECT id FROM tasks WHERE state IN (${ACTIVE_STATES.map(() => '?').join(', ')}) LIMIT 1
      `).get(...ACTIVE_STATES);
      if (active) return null;

      const queued = this.db.prepare(`
        SELECT tasks.*, messages.body AS message_body, messages.channel AS message_channel
        FROM tasks JOIN messages ON messages.id = tasks.request_message_id
        WHERE tasks.state = 'queued' ORDER BY tasks.created_at, tasks.rowid LIMIT 1
      `).get();
      if (!queued) return null;
      const now = this.#now();
      const heartbeatAt = new Date(now).toISOString();
      const leaseExpiresAt = new Date(now + this.leaseMs).toISOString();
      const claimed = this.db.prepare(`
        UPDATE tasks SET state = 'running', worker_id = ?, heartbeat_at = ?, lease_expires_at = ?,
          attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(this.workerId, heartbeatAt, leaseExpiresAt, heartbeatAt, queued.id);
      if (claimed.changes !== 1) return null;
      appendTaskEvent(this.db, queued.id, 'transitioned', {
        from: 'queued', to: 'running', patch: {
          workerId: this.workerId, leaseExpiresAt, attemptCount: Number(queued.attempt_count ?? 0) + 1,
        },
      }, heartbeatAt);
      return asTask(this.db.prepare(`
        SELECT tasks.*, messages.body AS message_body, messages.channel AS message_channel
        FROM tasks JOIN messages ON messages.id = tasks.request_message_id WHERE tasks.id = ?
      `).get(queued.id));
    });
  }

  get(id) {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('task id must be a non-empty string');
    return asTask(this.db.prepare(`
      SELECT tasks.*, messages.body AS message_body, messages.channel AS message_channel
      FROM tasks JOIN messages ON messages.id = tasks.request_message_id WHERE tasks.id = ?
    `).get(id));
  }

  heartbeat(id) {
    if (typeof id !== 'string' || !id) throw new TypeError('task id must be a non-empty string');
    const now = this.#now();
    const heartbeatAt = new Date(now).toISOString();
    const leaseExpiresAt = new Date(now + this.leaseMs).toISOString();
    const result = this.db.prepare(`
      UPDATE tasks SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND state = 'running' AND worker_id = ? AND lease_expires_at > ?
    `).run(heartbeatAt, leaseExpiresAt, heartbeatAt, id, this.workerId, heartbeatAt);
    return result.changes === 1;
  }

  persistSession(id, workerId, sessionId) {
    if (![id, workerId, sessionId].every((value) => typeof value === 'string' && value)) return false;
    const now = new Date(this.#now()).toISOString();
    const result = this.db.prepare(`
      UPDATE tasks SET claude_session_id = ?, updated_at = ?
      WHERE id = ? AND state = 'running' AND worker_id = ?
    `).run(sessionId, now, id, workerId);
    return result.changes === 1;
  }

  finish(id, { status, summary = null } = {}) {
    if (!['completed', 'failed', 'interrupted'].includes(status)) throw new TypeError('invalid task finish status');
    return transaction(this.db, () => {
      const now = new Date(this.#now()).toISOString();
      const result = this.db.prepare(`
        UPDATE tasks SET state = ?, result_summary = ?, worker_id = NULL, heartbeat_at = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'running' AND worker_id = ?
      `).run(status, summary, now, id, this.workerId);
      if (result.changes !== 1) return false;
      appendTaskEvent(this.db, id, 'worker-finished', { status, summary }, now);
      const task = this.db.prepare('SELECT source FROM tasks WHERE id = ?').get(id);
      if (task?.source === 'telegram') {
        appendOutbox(this.db, {
          kind: 'telegram.task.result', payload: { taskId: id, status, summary },
        });
      }
      return true;
    });
  }

  requestCancel(id) {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('task id must be a non-empty string');
    return transaction(this.db, () => {
      let row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!row) return null;
      if (row.state === 'queued') row = transition(this.db, row, 'interrupted', { cancelRequested: true });
      else if (row.state === 'running' || row.state === 'waiting_confirmation') {
        row = transition(this.db, row, 'cancelling', { cancelRequested: true });
      }
      return asTask(row);
    });
  }

  finishCancellation(id, expectedWorkerId) {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('task id must be a non-empty string');
    if (typeof expectedWorkerId !== 'string' || expectedWorkerId.length === 0) return false;
    return transaction(this.db, () => {
      const updatedAt = new Date(this.#now()).toISOString();
      const result = this.db.prepare(`
        UPDATE tasks SET state = 'interrupted', cancel_requested = 1, worker_id = NULL,
          heartbeat_at = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND worker_id = ? AND state IN ('running', 'waiting_confirmation', 'cancelling')
      `).run(updatedAt, id, expectedWorkerId);
      if (result.changes !== 1) return false;
      appendTaskEvent(this.db, id, 'worker-cancelled', { workerId: expectedWorkerId }, updatedAt);
      return true;
    });
  }

  forceFinishCancellation(id) {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('task id must be a non-empty string');
    return transaction(this.db, () => {
      const updatedAt = new Date(this.#now()).toISOString();
      const result = this.db.prepare(`
        UPDATE tasks SET state = 'interrupted', cancel_requested = 1, worker_id = NULL,
          heartbeat_at = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state IN ('running', 'waiting_confirmation', 'cancelling')
      `).run(updatedAt, id);
      if (result.changes !== 1) return false;
      appendTaskEvent(this.db, id, 'admin-force-cancelled', {}, updatedAt);
      return true;
    });
  }

  listEvents(after, limit) {
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('after must be a non-negative safe integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer between 1 and 100');
    const events = this.db.prepare(`
      SELECT * FROM messages WHERE sequence > ? ORDER BY sequence LIMIT ?
    `).all(after, limit).map(asMessage);
    return { events, eventCursor: events.at(-1)?.sequence ?? after };
  }
}
