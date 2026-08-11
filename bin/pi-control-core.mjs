#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from '../src/db/database.js';
import { ApprovalService } from '../src/security/approval-service.js';
import { ClaudeRunner } from '../src/core/claude-runner.js';
import { ConversationService } from '../src/core/conversation-service.js';
import { HookService } from '../src/core/hook-service.js';
import { initializeCoreRuntime, runWorkerOnce, startWatchdog } from '../src/core/main.js';
import { RecoveryService } from '../src/core/recovery-service.js';
import { createCoreServer } from '../src/core/server.js';
import { SystemdNotifier } from '../src/core/systemd-notifier.js';
import { TaskService } from '../src/core/task-service.js';
import { resolveCoreConfig } from '../src/shared/config.js';
import { isMainModule } from '../src/shared/main-module.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    server.once('error', failed);
    server.listen(() => {
      server.off('error', failed);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function passwordRecord(env) {
  if (typeof env.PI_CONTROL_PASSWORD_RECORD === 'string' && env.PI_CONTROL_PASSWORD_RECORD.length > 0) {
    return env.PI_CONTROL_PASSWORD_RECORD;
  }
  if (typeof env.CREDENTIALS_DIRECTORY === 'string' && env.CREDENTIALS_DIRECTORY.length > 0) {
    const value = (await readFile(join(env.CREDENTIALS_DIRECTORY, 'high-risk-password'), 'utf8')).trim();
    if (!value) throw new Error('high-risk confirmation password is not configured');
    return value;
  }
  const filename = env.PI_CONTROL_PASSWORD_FILE ?? '/etc/pi-control/high-risk-password.hash';
  const value = (await readFile(filename, 'utf8')).trim();
  if (!value) throw new Error('high-risk confirmation password is not configured');
  return value;
}

export async function startCoreProcess({
  env = process.env,
  notifier = new SystemdNotifier(),
  logger = console,
  workerIntervalMs = 500,
} = {}) {
  if (!Number.isInteger(workerIntervalMs) || workerIntervalMs < 10) throw new TypeError('worker interval is invalid');
  const config = resolveCoreConfig(env);
  const dbPath = env.PI_CONTROL_DB_PATH ?? join(config.dataDir, 'conversations.sqlite');
  const db = openDatabase(dbPath);
  let server;
  let watchdog;
  let workerTimer;
  let stopped = false;
  try {
    const tasks = new TaskService(db);
    const conversation = new ConversationService(db);
    const maxToolRounds = Number(env.PI_CONTROL_MAX_TOOL_ROUNDS) > 0 ? Number(env.PI_CONTROL_MAX_TOOL_ROUNDS) : 30;
    const runner = new ClaudeRunner({ conversationService: conversation, config, spawnEnv: env, taskService: tasks, maxToolRounds });
    const approvals = new ApprovalService({
      db,
      passwordRecord: await passwordRecord(env),
      ttlMs: config.approvalTtlMs,
    });

    const runTask = async (task) => {
      const result = await runner.run(task, conversation.buildContext({ query: task.text }), {
        onSessionReady: (sessionId) => tasks.persistSession(task.id, tasks.workerId, sessionId),
      });
      tasks.finish(task.id, {
        status: result?.status === 'completed' ? 'completed' : 'failed',
        summary: result?.finalText ?? result?.stopReason ?? null,
      });
      return result;
    };
    const hooks = new HookService({
      db,
      approvalService: approvals,
      resume: async ({ taskId }) => {
        const task = tasks.get(taskId);
        if (!task || task.state !== 'running') throw new Error('approved task is not runnable');
        return runTask(task);
      },
    });
    const recovery = new RecoveryService({ db });
    server = createCoreServer({
      config,
      db,
      services: { taskService: tasks, claudeRunner: runner, hookService: hooks },
    });
    await listen(server);
    await initializeCoreRuntime({ recoveryService: recovery, notifier });
    watchdog = startWatchdog({ notifier, isHealthy: () => server.listening && !stopped });

    let workerBusy = false;
    const tick = async () => {
      if (workerBusy || stopped) return;
      workerBusy = true;
      try {
        await runWorkerOnce({
          taskService: tasks,
          runner,
          contextForTask: (task) => conversation.buildContext({ query: task.text }),
        });
      } catch (error) {
        logger?.error?.(`core worker failed: ${error?.message ?? error}`);
      } finally {
        workerBusy = false;
      }
    };
    workerTimer = setInterval(tick, workerIntervalMs);
    workerTimer.unref?.();
    void tick();

    return {
      server,
      get stopped() { return stopped; },
      async stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(workerTimer);
        watchdog?.stop();
        await close(server);
        db.close();
      },
    };
  } catch (error) {
    clearInterval(workerTimer);
    watchdog?.stop();
    if (server?.listening) await close(server).catch(() => {});
    db.close();
    throw error;
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  startCoreProcess().then((runtime) => {
    const shutdown = () => runtime.stop().then(() => process.exit(0), () => process.exit(1));
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }).catch((error) => {
    process.stderr.write(`pi-control-core: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
