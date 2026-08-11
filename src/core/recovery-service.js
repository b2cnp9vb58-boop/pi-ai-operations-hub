import { appendOutbox } from '../db/repositories.js';

const SAFE_ACTION = /^(?:status|check-websites|logs:(?:nginx|cloudflared|pi-control-core|telegram-control|weixin-control)\.service)$/;

function milliseconds(clock) {
  const value = clock();
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(result)) throw new TypeError('clock must return a valid time');
  return result;
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

function event(db, taskId, kind, payload, at) {
  db.prepare('INSERT INTO task_events(task_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)')
    .run(taskId, kind, JSON.stringify(payload), at);
}

export class RecoveryService {
  constructor({ db, clock = Date.now, maxAttempts = 3 } = {}) {
    if (!db?.prepare) throw new TypeError('db is required');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be positive');
    this.db = db;
    this.clock = clock;
    this.maxAttempts = maxAttempts;
  }

  reconcileStartup() {
    const check = this.db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || check[0].quick_check !== 'ok') throw new Error('SQLite quick_check failed');
    const now = milliseconds(this.clock);
    const at = new Date(now).toISOString();
    return transaction(this.db, () => {
      const report = {
        database: 'ok',
        queued: this.db.prepare("SELECT id FROM tasks WHERE state = 'queued' ORDER BY created_at, rowid").all().map(({ id }) => id),
        autoResumed: [], interrupted: [], activeLeases: [], alerts: [],
      };

      this.db.prepare("UPDATE approvals SET state = 'cancelled' WHERE state IN ('pending', 'granted')").run();
      this.db.prepare(`
        UPDATE deferred_tool_calls SET state = 'cancelled', updated_at = ?
        WHERE state IN ('waiting_action', 'waiting_password', 'approved')
      `).run(at);
      this.db.prepare("UPDATE tool_batches SET state = 'invalid' WHERE state = 'registered'").run();

      const active = this.db.prepare(`
        SELECT tasks.*, messages.body AS message_body
        FROM tasks JOIN messages ON messages.id = tasks.request_message_id
        WHERE tasks.state IN ('running', 'waiting_confirmation', 'cancelling')
        ORDER BY tasks.created_at, tasks.rowid
      `).all();
      for (const task of active) {
        if (task.lease_expires_at && Date.parse(task.lease_expires_at) > now) {
          report.activeLeases.push(task.id);
          continue;
        }
        const hasBoundary = Boolean(
          this.db.prepare('SELECT 1 FROM approvals WHERE task_id = ? LIMIT 1').get(task.id)
          || this.db.prepare('SELECT 1 FROM deferred_tool_calls WHERE task_id = ? LIMIT 1').get(task.id)
          || this.db.prepare('SELECT 1 FROM tool_batches WHERE task_id = ? LIMIT 1').get(task.id),
        );
        const safe = task.state === 'running' && SAFE_ACTION.test(task.message_body) && !hasBoundary;
        if (safe && Number(task.attempt_count) < this.maxAttempts) {
          const updated = this.db.prepare(`
            UPDATE tasks SET state = 'queued', worker_id = NULL, lease_expires_at = NULL,
              heartbeat_at = NULL, updated_at = ?
            WHERE id = ? AND state = 'running'
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          `).run(at, task.id, at);
          if (updated.changes === 1) {
            event(this.db, task.id, 'startup-requeued', { attemptCount: Number(task.attempt_count) }, at);
            report.autoResumed.push(task.id);
          }
          continue;
        }
        const updated = this.db.prepare(`
          UPDATE tasks SET state = 'interrupted', worker_id = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL, updated_at = ?
          WHERE id = ? AND state = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        `).run(at, task.id, task.state, at);
        if (updated.changes !== 1) continue;
        const retryLimit = safe && Number(task.attempt_count) >= this.maxAttempts;
        event(this.db, task.id, 'startup-interrupted', { previousState: task.state, retryLimit }, at);
        report.interrupted.push(task.id);
        if (retryLimit) {
          appendOutbox(this.db, {
            kind: 'alert', payload: { probe: 'worker-crash-loop', taskId: task.id, attempts: Number(task.attempt_count), at },
          });
          report.alerts.push(task.id);
        }
      }
      return report;
    });
  }
}
