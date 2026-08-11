import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { ApprovalService } from '../src/security/approval-service.js';
import { hashConfirmationPassword } from '../src/security/password.js';
import { HookService } from '../src/core/hook-service.js';

function fixture() {
  const filename = join(tmpdir(), `pi-control-hook-${randomUUID()}.sqlite`);
  const db = openDatabase(filename);
  db.prepare("INSERT INTO owner_binding(singleton, user_id, chat_id, paired_at) VALUES (1, '123', '456', ?)").run(new Date().toISOString());
  db.prepare(`INSERT INTO tasks(id, source, request_message_id, state, claude_session_id, created_at, updated_at)
    VALUES ('task-1', 'telegram', 'message-1', 'running', 'session-1', ?, ?)`)
    .run(new Date().toISOString(), new Date().toISOString());
  return {
    db,
    cleanup() {
      db.close();
      for (const suffix of ['', '-shm', '-wal']) if (existsSync(`${filename}${suffix}`)) rmSync(`${filename}${suffix}`);
    },
  };
}

function hook(toolName, toolInput, toolUseId = 'tool-1') {
  return { sessionId: 'session-1', taskId: 'task-1', toolName, toolInput, toolUseId };
}

function register(service, input, generation = 1) {
  return service.registerToolBatch({ taskId: input.taskId, sessionId: input.sessionId, generation, toolCalls: [input] });
}

test('low-risk read allows while unknown and destructive calls defer durably', async () => {
  const f = fixture();
  try {
    const approvals = new ApprovalService({ db: f.db, passwordRecord: await hashConfirmationPassword('correct') });
    const service = new HookService({ db: f.db, approvalService: approvals, batchWaitMs: 20, batchPollMs: 2 });
    const read = hook('Read', { file_path: '/var/log/nginx/access.log' }, 'read-1');
    register(service, read, 1);
    assert.equal((await service.preToolUse(read)).decision, 'allow');

    const destructive = hook('Bash', { command: 'rm -rf /var/www/site' }, 'tool-1');
    register(service, destructive, 2);
    const deferred = await service.preToolUse(destructive);
    assert.equal(deferred.decision, 'defer');
    assert.ok(deferred.approvalId);
    assert.equal(f.db.prepare("SELECT state FROM tasks WHERE id = 'task-1'").get().state, 'waiting_confirmation');
    const stored = f.db.prepare('SELECT session_id, task_id, owner_id, tool_use_id, operation_hash, state FROM deferred_tool_calls').get();
    assert.deepEqual({ ...stored, operation_hash: stored.operation_hash.length }, {
      session_id: 'session-1', task_id: 'task-1', owner_id: '123', tool_use_id: 'tool-1', operation_hash: 64, state: 'waiting_action',
    });
  } finally { f.cleanup(); }
});

test('approval password resumes the same session and consumes exactly one matching grant', async () => {
  const f = fixture();
  const resumes = [];
  const password = 'do-not-persist-this';
  try {
    const approvals = new ApprovalService({ db: f.db, passwordRecord: await hashConfirmationPassword(password) });
    const service = new HookService({ db: f.db, approvalService: approvals, resume: async (value) => resumes.push(value), batchWaitMs: 20, batchPollMs: 2 });
    const input = hook('Bash', { command: 'rm -rf /var/www/site' });
    register(service, input);
    const deferred = await service.preToolUse(input);
    assert.equal(service.handleApprovalAction({ action: 'approve', approvalId: deferred.approvalId, ownerId: '123' }).state, 'waiting_password');
    assert.equal((await service.submitPassword({ ownerId: '123', password })).ok, true);
    assert.deepEqual(resumes, [{ taskId: 'task-1', sessionId: 'session-1' }]);
    assert.equal((await service.preToolUse(input)).decision, 'allow');
    assert.equal((await service.preToolUse(input)).decision, 'deny');
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM messages').all()).includes(password), false);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM task_events').all()).includes(password), false);
  } finally { f.cleanup(); }
});

test('password submission uses one fail-closed object contract', async () => {
  const f = fixture();
  try {
    const password = 'correct-password';
    const approvals = new ApprovalService({ db: f.db, passwordRecord: await hashConfirmationPassword(password) });
    const service = new HookService({ db: f.db, approvalService: approvals, batchWaitMs: 20, batchPollMs: 2 });
    const input = hook('Bash', { command: 'sudo systemctl restart nginx' });
    register(service, input);
    const deferred = await service.preToolUse(input);
    service.handleApprovalAction({ action: 'approve', approvalId: deferred.approvalId, ownerId: '123' });
    assert.deepEqual(await service.submitPassword({ ownerId: '123', password: 'wrong' }), { ok: false });
    assert.equal((await service.submitPassword({ ownerId: '123', password })).ok, true);
  } finally { f.cleanup(); }
});

test('changed tool identity or input never consumes a deferred grant and cancel denies it', async () => {
  const f = fixture();
  try {
    const approvals = new ApprovalService({ db: f.db, passwordRecord: await hashConfirmationPassword('correct') });
    const service = new HookService({ db: f.db, approvalService: approvals, batchWaitMs: 20, batchPollMs: 2 });
    const original = hook('Bash', { command: 'rm -rf /var/www/site' });
    register(service, original);
    const deferred = await service.preToolUse(original);
    assert.equal(service.handleApprovalAction({ action: 'cancel', approvalId: deferred.approvalId, ownerId: '123' }).state, 'cancelled');
    assert.equal((await service.preToolUse(hook('Bash', { command: 'rm -rf /var/www/site' }))).decision, 'deny');
    assert.equal((await service.preToolUse(hook('Bash', { command: 'rm -rf /var/www/other' }, 'tool-2'))).decision, 'deny');
  } finally { f.cleanup(); }
});

test('hooks arriving before registration wait for the complete batch and deny every multi-tool item', async () => {
  const f = fixture();
  try {
    const approvals = new ApprovalService({ db: f.db, passwordRecord: await hashConfirmationPassword('correct') });
    const service = new HookService({ db: f.db, approvalService: approvals, batchWaitMs: 200, batchPollMs: 2 });
    const first = hook('Read', { file_path: '/var/log/nginx/access.log' }, 'tool-a');
    const second = hook('Bash', { command: 'df -h' }, 'tool-b');
    const sideEffects = [0, 0];
    const decisions = [service.preToolUse(first), service.preToolUse(second)].map(async (pending, index) => {
      const decision = await pending;
      if (decision.decision === 'allow') sideEffects[index] += 1;
      return decision;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    service.registerToolBatch({
      taskId: 'task-1', sessionId: 'session-1', generation: 1,
      toolCalls: [
        { toolUseId: first.toolUseId, toolName: first.toolName, toolInput: first.toolInput },
        { toolUseId: second.toolUseId, toolName: second.toolName, toolInput: second.toolInput },
      ],
    });
    const results = await Promise.all(decisions);
    assert.deepEqual(results.map((result) => result.decision), ['deny', 'deny']);
    assert.equal(results.some((result) => result.decision === 'allow'), false);
    assert.deepEqual(sideEffects, [0, 0]);
  } finally { f.cleanup(); }
});

test('a registered exact single-tool batch proceeds but absent registration times out denied', async () => {
  const f = fixture();
  try {
    const approvals = new ApprovalService({ db: f.db, passwordRecord: await hashConfirmationPassword('correct') });
    const service = new HookService({ db: f.db, approvalService: approvals, batchWaitMs: 20, batchPollMs: 2 });
    const input = hook('Read', { file_path: '/var/log/nginx/access.log' }, 'single');
    service.registerToolBatch({ taskId: 'task-1', sessionId: 'session-1', generation: 1, toolCalls: [input] });
    assert.equal((await service.preToolUse(input)).decision, 'allow');
    assert.equal((await service.preToolUse(hook('Read', { file_path: '/var/log/nginx/error.log' }, 'missing'))).decision, 'deny');
  } finally { f.cleanup(); }
});

test('batch registrations from a previous HookService instance fail closed after restart', async () => {
  const f = fixture();
  try {
    const approvals = new ApprovalService({ db: f.db, passwordRecord: await hashConfirmationPassword('correct') });
    const input = hook('Read', { file_path: '/var/log/nginx/access.log' }, 'pre-restart');
    const first = new HookService({ db: f.db, approvalService: approvals, batchWaitMs: 20, batchPollMs: 2 });
    first.registerToolBatch({ taskId: 'task-1', sessionId: 'session-1', generation: 1, toolCalls: [input] });
    const restarted = new HookService({ db: f.db, approvalService: approvals, batchWaitMs: 20, batchPollMs: 2 });
    assert.equal((await restarted.preToolUse(input)).decision, 'deny');
  } finally { f.cleanup(); }
});
