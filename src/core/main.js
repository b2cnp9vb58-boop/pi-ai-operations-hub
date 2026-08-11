export async function initializeCoreRuntime({ recoveryService, notifier } = {}) {
  if (typeof recoveryService?.reconcileStartup !== 'function') throw new TypeError('recoveryService is required');
  const report = recoveryService.reconcileStartup();
  try { await notifier?.status?.('recovery complete'); } catch {}
  try { await notifier?.ready?.(); } catch {}
  return report;
}

export function startWatchdog({ notifier, isHealthy, intervalMs = 10_000, timers = globalThis } = {}) {
  if (typeof notifier?.watchdog !== 'function') throw new TypeError('watchdog notifier is required');
  if (typeof isHealthy !== 'function') throw new TypeError('health check is required');
  const timer = timers.setInterval(async () => {
    try {
      if (await isHealthy()) await notifier.watchdog();
    } catch {
      // Missing a watchdog pulse lets systemd decide; this code never kills the healthy process.
    }
  }, intervalMs);
  timer?.unref?.();
  return { stop() { timers.clearInterval(timer); } };
}

export async function runWorkerOnce({
  taskService, runner, contextForTask = async () => ({}), heartbeatMs = 10_000, timers = globalThis,
} = {}) {
  if (!taskService || typeof taskService.claimNext !== 'function') throw new TypeError('taskService is required');
  if (!runner || typeof runner.run !== 'function') throw new TypeError('runner is required');
  const task = taskService.claimNext();
  if (!task) return null;
  const heartbeat = timers.setInterval(() => {
    try {
      if (!taskService.heartbeat(task.id)) runner.cancelSafely?.(task.id);
    } catch {
      runner.cancelSafely?.(task.id);
    }
  }, heartbeatMs);
  heartbeat?.unref?.();
  try {
    const result = await runner.run(task, await contextForTask(task), {
      onSessionReady: (sessionId) => taskService.persistSession(task.id, taskService.workerId, sessionId),
    });
    const status = result?.status === 'completed' ? 'completed' : 'failed';
    taskService.finish(task.id, { status, summary: result?.finalText ?? result?.stopReason ?? null });
    return { taskId: task.id, status, result };
  } finally {
    timers.clearInterval(heartbeat);
  }
}
