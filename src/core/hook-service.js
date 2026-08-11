import { randomUUID } from 'node:crypto';
import { classifyToolCall } from '../security/risk-policy.js';

function output(decision, reason, extra = {}) {
  return {
    decision,
    ...extra,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function validText(value) {
  return typeof value === 'string' && value.length > 0;
}

export class HookService {
  constructor({ db, approvalService, resume = async () => {}, batchWaitMs = 5_000, batchPollMs = 10, sleep } = {}) {
    if (!db?.prepare) throw new TypeError('HookService requires a database');
    if (!approvalService?.request || !approvalService?.consume) throw new TypeError('HookService requires ApprovalService');
    this.db = db;
    this.approvals = approvalService;
    this.resume = resume;
    if (!Number.isInteger(batchWaitMs) || batchWaitMs < 1 || batchWaitMs > 25_000) throw new TypeError('batchWaitMs must be between 1 and 25000');
    if (!Number.isInteger(batchPollMs) || batchPollMs < 1 || batchPollMs > batchWaitMs) throw new TypeError('batchPollMs is invalid');
    this.batchWaitMs = batchWaitMs;
    this.batchPollMs = batchPollMs;
    this.sleep = sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.instanceId = randomUUID();
    this.db.prepare("UPDATE tool_batches SET state = 'invalid' WHERE state = 'registered'").run();
  }

  registerToolBatch({ taskId, sessionId, generation, toolCalls } = {}) {
    if (!validText(taskId) || !validText(sessionId) || !Number.isSafeInteger(generation) || generation < 1
      || !Array.isArray(toolCalls) || toolCalls.length < 1) throw new TypeError('invalid tool batch');
    const task = this.db.prepare('SELECT state, claude_session_id FROM tasks WHERE id = ?').get(taskId);
    const owner = this.db.prepare('SELECT user_id FROM owner_binding WHERE singleton = 1').get();
    if (!task || !owner || task.state !== 'running' || task.claude_session_id !== sessionId) throw new Error('tool batch identity could not be verified');
    const normalized = toolCalls.map((call) => {
      const toolUseId = call?.toolUseId ?? call?.id;
      const toolName = call?.toolName ?? call?.name;
      const toolInput = call?.toolInput ?? call?.input;
      if (!validText(toolUseId) || !validText(toolName) || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
        throw new TypeError('invalid tool batch item');
      }
      return { toolUseId, toolName, toolInput, operationHash: classifyToolCall(toolName, toolInput).operationHash };
    });
    if (new Set(normalized.map((call) => call.toolUseId)).size !== normalized.length) throw new TypeError('duplicate tool use id');

    return transaction(this.db, () => {
      const batchId = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO tool_batches(id, task_id, owner_id, session_id, generation, tool_count, service_instance_id, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', ?)
      `).run(batchId, taskId, owner.user_id, sessionId, generation, normalized.length, this.instanceId, now);
      const insert = this.db.prepare(`
        INSERT INTO tool_batch_items(batch_id, tool_use_id, tool_name, tool_input_json, operation_hash)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const call of normalized) insert.run(batchId, call.toolUseId, call.toolName, JSON.stringify(call.toolInput), call.operationHash);
      return { batchId, taskId, sessionId, generation, count: normalized.length };
    });
  }

  #batchProof(input) {
    return this.db.prepare(`
      SELECT b.*, i.tool_use_id, i.tool_name, i.operation_hash,
        (SELECT COUNT(*) FROM tool_batch_items all_items WHERE all_items.batch_id = b.id) AS actual_count
      FROM tool_batches b JOIN tool_batch_items i ON i.batch_id = b.id
      WHERE b.task_id = ? AND b.session_id = ? AND i.tool_use_id = ?
      LIMIT 1
    `).get(input.taskId, input.sessionId, input.toolUseId);
  }

  async #waitForBatch(input) {
    const deadline = Date.now() + this.batchWaitMs;
    for (;;) {
      const proof = this.#batchProof(input);
      if (proof) return proof;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.sleep(Math.min(this.batchPollMs, remaining));
    }
  }

  #binding(input) {
    if (!input || !validText(input.sessionId) || !validText(input.taskId)
      || !validText(input.toolName) || !validText(input.toolUseId)
      || !input.toolInput || typeof input.toolInput !== 'object' || Array.isArray(input.toolInput)) return null;
    const task = this.db.prepare('SELECT id, state, claude_session_id, source FROM tasks WHERE id = ?').get(input.taskId);
    const owner = this.db.prepare('SELECT user_id FROM owner_binding WHERE singleton = 1').get();
    if (!task || !owner || task.claude_session_id !== input.sessionId) return null;
    return { task, ownerId: owner.user_id };
  }

  async preToolUse(input) {
    try {
      const binding = this.#binding(input);
      if (!binding) return output('deny', 'Tool identity could not be verified');
      const risk = classifyToolCall(input.toolName, input.toolInput);
      const proof = await this.#waitForBatch(input);
      if (!proof) return output('deny', 'Complete tool batch was not registered before timeout');
      if (proof.state !== 'registered' || proof.service_instance_id !== this.instanceId
        || proof.owner_id !== binding.ownerId || proof.tool_count !== proof.actual_count
        || proof.tool_count !== 1 || proof.tool_name !== input.toolName || proof.operation_hash !== risk.operationHash) {
        return output('deny', proof.tool_count > 1 ? 'Multi-tool batches are forbidden' : 'Tool batch proof did not match');
      }
      const existing = this.db.prepare(`
        SELECT * FROM deferred_tool_calls WHERE task_id = ? AND tool_use_id = ?
      `).get(input.taskId, input.toolUseId);

      if (existing) {
        const exact = existing.owner_id === binding.ownerId
          && existing.session_id === input.sessionId
          && existing.tool_name === input.toolName
          && existing.operation_hash === risk.operationHash;
        if (!exact) return output('deny', 'Deferred tool identity changed');
        if (existing.state === 'approved') {
          const consumed = this.approvals.consume(existing.approval_id, {
            taskId: input.taskId,
            ownerId: binding.ownerId,
            operationHash: risk.operationHash,
          });
          if (!consumed) return output('deny', 'Approval is absent, expired, changed, or already used');
          this.db.prepare("UPDATE deferred_tool_calls SET state = 'consumed', updated_at = ? WHERE approval_id = ? AND state = 'approved'")
            .run(new Date().toISOString(), existing.approval_id);
          return output('allow', 'Matching one-use approval consumed');
        }
        if (existing.state === 'waiting_action' || existing.state === 'waiting_password') {
          return output('defer', 'Waiting for owner confirmation', { approvalId: existing.approval_id });
        }
        return output('deny', 'Deferred tool is no longer authorized');
      }

      // WeChat secretary: reject all non-low operations immediately — no approval flow
      if (binding.task.source === 'weixin') {
        return output('deny', 'WeChat secretary is read-only');
      }
      if (risk.level === 'low' && binding.task.state === 'running') return output('allow', risk.reasons.join('; '));
      if (binding.task.state !== 'running') return output('deny', 'Task is not in an executable state');

      const approval = this.approvals.request({
        taskId: input.taskId,
        ownerId: binding.ownerId,
        operationHash: risk.operationHash,
      });
      try {
        transaction(this.db, () => {
          const now = new Date().toISOString();
          this.db.prepare(`
            INSERT INTO deferred_tool_calls(
              approval_id, task_id, owner_id, session_id, tool_use_id, tool_name,
              tool_input_json, operation_hash, state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting_action', ?, ?)
          `).run(
            approval.id, input.taskId, binding.ownerId, input.sessionId, input.toolUseId,
            input.toolName, JSON.stringify(input.toolInput), risk.operationHash, now, now,
          );
          const changed = this.db.prepare(`
            UPDATE tasks SET state = 'waiting_confirmation', updated_at = ? WHERE id = ? AND state = 'running'
          `).run(now, input.taskId);
          if (changed.changes !== 1) throw new Error('task state changed before deferral');
          this.db.prepare('INSERT INTO task_events(task_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)')
            .run(input.taskId, 'tool_deferred', JSON.stringify({ approvalId: approval.id, toolUseId: input.toolUseId, operationHash: risk.operationHash }), now);
          this.db.prepare(`INSERT INTO outbox(kind, payload_json, next_attempt_at, created_at) VALUES (?, ?, ?, ?)`)
            .run('telegram.approval', JSON.stringify({ approvalId: approval.id, taskId: input.taskId, reasons: risk.reasons }), now, now);
        });
      } catch (error) {
        this.db.prepare("UPDATE approvals SET state = 'cancelled' WHERE id = ? AND state = 'pending'").run(approval.id);
        throw error;
      }
      return output('defer', 'Owner confirmation required', { approvalId: approval.id });
    } catch {
      return output('deny', 'Risk control failed closed');
    }
  }

  handleApprovalAction({ action, approvalId, ownerId } = {}) {
    if (!['approve', 'cancel'].includes(action) || !validText(approvalId) || !validText(ownerId)) {
      throw new TypeError('invalid approval action');
    }
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM deferred_tool_calls WHERE approval_id = ? AND owner_id = ?').get(approvalId, ownerId);
      if (!row || row.state !== 'waiting_action') throw new Error('approval is not waiting for an action');
      const now = new Date().toISOString();
      if (action === 'approve') {
        this.db.prepare("UPDATE deferred_tool_calls SET state = 'waiting_password', updated_at = ? WHERE approval_id = ? AND state = 'waiting_action'")
          .run(now, approvalId);
        return { state: 'waiting_password', approvalId };
      }
      this.db.prepare("UPDATE deferred_tool_calls SET state = 'cancelled', updated_at = ? WHERE approval_id = ? AND state = 'waiting_action'")
        .run(now, approvalId);
      this.db.prepare("UPDATE approvals SET state = 'cancelled' WHERE id = ? AND state = 'pending'").run(approvalId);
      this.db.prepare("UPDATE tasks SET state = 'interrupted', updated_at = ? WHERE id = ? AND state = 'waiting_confirmation'")
        .run(now, row.task_id);
      return { state: 'cancelled', approvalId };
    });
  }

  isPendingPassword(ownerId) {
    return Boolean(this.db.prepare("SELECT 1 FROM deferred_tool_calls WHERE owner_id = ? AND state = 'waiting_password' LIMIT 1").get(ownerId));
  }

  async submitPassword({ ownerId, password } = {}) {
    if (!validText(ownerId) || typeof password !== 'string') return { ok: false };
    const row = this.db.prepare(`
      SELECT * FROM deferred_tool_calls WHERE owner_id = ? AND state = 'waiting_password' ORDER BY created_at DESC LIMIT 1
    `).get(ownerId);
    if (!row || !await this.approvals.grantWithPassword(row.approval_id, password)) return { ok: false };
    const now = new Date().toISOString();
    const changed = transaction(this.db, () => {
      const deferred = this.db.prepare("UPDATE deferred_tool_calls SET state = 'approved', updated_at = ? WHERE approval_id = ? AND state = 'waiting_password'")
        .run(now, row.approval_id);
      const task = this.db.prepare("UPDATE tasks SET state = 'running', updated_at = ? WHERE id = ? AND state = 'waiting_confirmation'")
        .run(now, row.task_id);
      return deferred.changes === 1 && task.changes === 1;
    });
    if (!changed) return { ok: false };
    try {
      await this.resume({ taskId: row.task_id, sessionId: row.session_id });
      return { ok: true, taskId: row.task_id, sessionId: row.session_id, approvalId: row.approval_id };
    } catch {
      transaction(this.db, () => {
        this.db.prepare("UPDATE deferred_tool_calls SET state = 'cancelled', updated_at = ? WHERE approval_id = ? AND state = 'approved'").run(new Date().toISOString(), row.approval_id);
        this.db.prepare("UPDATE approvals SET state = 'cancelled' WHERE id = ? AND state = 'granted'").run(row.approval_id);
        this.db.prepare("UPDATE tasks SET state = 'interrupted', updated_at = ? WHERE id = ? AND state = 'running'").run(new Date().toISOString(), row.task_id);
      });
      return { ok: false };
    }
  }
}
