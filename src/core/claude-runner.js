import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn as spawnChild } from 'node:child_process';
import { join } from 'node:path';

const RUNTIME_ENVIRONMENT_KEYS = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
]);
const APPROVED_PROVIDER_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
]);
const APPROVED_PROVIDER_KEY_SET = new Set(APPROVED_PROVIDER_KEYS);
const FORBIDDEN_ENVIRONMENT = /^(?:TELEGRAM_|PI_CONTROL_|PASSWORD|PAIRING_|SQLITE_|DATABASE_|NODE_OPTIONS$)/i;

function safeCallback(callbacks, name, value) {
  try {
    callbacks?.[name]?.(value);
  } catch {
    // A presentation callback must never change the durable worker outcome.
  }
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (item?.type === 'text') return String(item.text ?? '');
    return '';
  }).join('');
}

function toolOutput(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(toolOutput).join('');
  if (content && typeof content === 'object') return typeof content.text === 'string' ? content.text : JSON.stringify(content);
  return String(content ?? '');
}

function resultSuccess(event) {
  return event?.type === 'result' && (event.subtype === 'success' || event.is_error === false);
}

function taskPrompt(task, context, maxToolRounds = 30) {
  return [
    'You are the Pi control worker. Execute the owner task using the context below.',
    'Use exactly one tool call at a time. Never emit a batch containing multiple tool calls.',
    `You have a budget of at most ${maxToolRounds} tool calls for this task. Plan carefully, and do not repeat the same failing operation — if the budget is exhausted the task is terminated.`,
    'Do not disclose environment variables, credentials, passwords, tokens, pairing information, or control-plane configuration.',
    `Task: ${String(task.text ?? task.body ?? '')}`,
    `Context: ${JSON.stringify(context)}`,
  ].join('\n\n');
}

export function analyzeToolBatch(content) {
  const count = Array.isArray(content) ? content.filter((block) => block?.type === 'tool_use').length : 0;
  return count <= 1
    ? { allowed: true }
    : { allowed: false, instruction: 'Retry using exactly one tool call at a time.' };
}

function signalChildTree(child, signal) {
  if (!child) return false;
  if (process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== 'ESRCH') return false;
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

export function buildClaudeEnv(parentEnv = process.env, requiredProviderKeys = APPROVED_PROVIDER_KEYS) {
  if (requiredProviderKeys !== undefined && !Array.isArray(requiredProviderKeys)) {
    throw new TypeError('requiredProviderKeys must be an array');
  }
  for (const key of requiredProviderKeys) {
    if (!APPROVED_PROVIDER_KEY_SET.has(key)) {
      throw new TypeError(`${String(key)} is not an approved Claude provider key`);
    }
  }
  const allowed = new Set([...RUNTIME_ENVIRONMENT_KEYS, ...requiredProviderKeys]);
  const sanitized = {};
  for (const key of allowed) {
    if (typeof key !== 'string' || FORBIDDEN_ENVIRONMENT.test(key)) continue;
    const value = stringValue(parentEnv[key]);
    if (value !== undefined) sanitized[key] = value;
  }
  return sanitized;
}

export class ClaudeRunner {
  constructor({
    conversationService,
    config,
    spawn = spawnChild,
    spawnEnv = process.env,
    fixtureArgs = [],
    timeoutMs = 15 * 60 * 1000,
    terminateGraceMs = 2_000,
    hardKillWaitMs = 1_000,
    attachmentDir = null,
    maxToolOutputBytes = 8 * 1024,
    maxToolRounds = 30,
    cancelGraceMs = 10_000,
    taskService = null,
  }) {
    if (!conversationService || typeof conversationService.append !== 'function') {
      throw new TypeError('ClaudeRunner requires a ConversationService');
    }
    if (!config || typeof config.claudeBin !== 'string' || typeof config.claudeCwd !== 'string') {
      throw new TypeError('ClaudeRunner requires claudeBin and claudeCwd configuration');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
    if (!Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 1) {
      throw new TypeError('terminateGraceMs must be a positive integer');
    }
    if (!Number.isSafeInteger(hardKillWaitMs) || hardKillWaitMs < 1) {
      throw new TypeError('hardKillWaitMs must be a positive integer');
    }
    if (!Number.isSafeInteger(maxToolOutputBytes) || maxToolOutputBytes < 256) {
      throw new TypeError('maxToolOutputBytes must be an integer of at least 256');
    }
    if (!Number.isSafeInteger(maxToolRounds) || maxToolRounds < 1) throw new TypeError('maxToolRounds must be a positive integer');
    if (!Number.isInteger(cancelGraceMs) || cancelGraceMs < 1) throw new TypeError('cancelGraceMs must be positive');
    this.conversation = conversationService;
    this.config = config;
    this.spawn = spawn;
    this.spawnEnv = spawnEnv;
    this.fixtureArgs = fixtureArgs;
    this.timeoutMs = timeoutMs;
    this.terminateGraceMs = terminateGraceMs;
    this.hardKillWaitMs = hardKillWaitMs;
    this.attachmentDir = attachmentDir ?? config.attachmentDir ?? join(config.dataDir ?? process.cwd(), 'attachments');
    this.maxToolOutputBytes = maxToolOutputBytes;
    this.maxToolRounds = maxToolRounds;
    this.cancelGraceMs = cancelGraceMs;
    this.activeRuns = new Map();
    this.taskService = taskService;
  }

  #interrupt(run) {
    if (run.interruptSent) return;
    run.interruptSent = true;
    signalChildTree(run.child, 'SIGINT');
    run.cancelTimer = setTimeout(() => {
      if (!run.closed) signalChildTree(run.child, 'SIGTERM');
    }, this.cancelGraceMs);
    run.cancelTimer.unref?.();
  }

  noteToolStart(taskId, toolUseId) {
    const run = this.activeRuns.get(taskId);
    if (!run || run.closed || typeof toolUseId !== 'string') return false;
    run.activeTools.add(toolUseId);
    return true;
  }

  noteToolEnd(taskId, toolUseId) {
    const run = this.activeRuns.get(taskId);
    if (!run || run.closed) return false;
    run.activeTools.delete(toolUseId);
    if (run.cancelRequested && run.activeTools.size === 0) this.#interrupt(run);
    return true;
  }

  cancelSafely(taskId) {
    const run = this.activeRuns.get(taskId);
    if (!run || run.closed) return false;
    run.cancelRequested = true;
    if (run.activeTools.size === 0) this.#interrupt(run);
    return true;
  }

  async #appendTool(task, kind, payload) {
    let body = JSON.stringify({ kind, ...payload });
    const output = typeof payload.output === 'string' ? payload.output : null;
    if (output && Buffer.byteLength(output, 'utf8') > this.maxToolOutputBytes) {
      const hash = createHash('sha256').update(output, 'utf8').digest('hex');
      const storedName = `${hash}.tool-output.txt`;
      body = JSON.stringify({ ...JSON.parse(body), output: `${output.slice(0, this.maxToolOutputBytes)}\n[full output attachment: ${hash}]` });
      if (this.attachmentDir) {
        await mkdir(this.attachmentDir, { recursive: true, mode: 0o700 });
        await writeFile(join(this.attachmentDir, storedName), output, { mode: 0o600, flag: 'w' });
      }
      const message = this.conversation.append({ channel: task.channel ?? 'system', role: 'tool', body, taskId: task.id ?? null });
      if (this.attachmentDir) {
        this.conversation.db.prepare(`
          INSERT INTO attachments(id, message_id, original_name, stored_name, mime_type, size_bytes, sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), message.id, 'tool-output.txt', storedName, 'text/plain', Buffer.byteLength(output, 'utf8'), hash, new Date().toISOString());
      }
      return message;
    }
    return this.conversation.append({ channel: task.channel ?? 'system', role: 'tool', body, taskId: task.id ?? null });
  }

  run(task, context, callbacks = {}) {
    if (!task || typeof task !== 'object') return Promise.reject(new TypeError('task must be an object'));
    const sessionId = typeof task.claudeSessionId === 'string' && task.claudeSessionId.length > 0
      ? task.claudeSessionId : randomUUID();
    const args = [
      ...this.fixtureArgs,
      '--print', '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages', '--include-hook-events',
    ];
    if (typeof this.config.claudeSettings === 'string' && this.config.claudeSettings.length > 0) {
      args.push('--settings', this.config.claudeSettings);
    }
    if (task.claudeSessionId) args.push('--resume', sessionId);
    else args.push('--session-id', sessionId, '--name', 'pi-control-main');
    args.push(taskPrompt(task, context, this.maxToolRounds));

    const childEnvironment = buildClaudeEnv(this.spawnEnv, this.config.requiredProviderKeys ?? APPROVED_PROVIDER_KEYS);
    childEnvironment.PI_CLAUDE_TASK_ID = String(task.id ?? '');
    childEnvironment.PI_CLAUDE_CORE_URL = this.config.coreUrl ?? 'http://127.0.0.1:4330';
    if (typeof this.config.hookKeyFile === 'string') childEnvironment.PI_CLAUDE_HOOK_KEY_FILE = this.config.hookKeyFile;
    safeCallback(callbacks, 'onSessionReady', sessionId);
    return new Promise((resolve) => {
      let child;
      let activeRun;
      let complete = false;
      let timedOut = false;
      let stdoutBuffer = '';
      let stderr = '';
      let multiToolBatch = false;
      let batchRegistrationFailed = false;
      let batchGeneration = 0;
      let maxRoundsExceeded = false;
      let result = { sessionId, status: 'failed', finalText: '', usage: null, stopReason: 'no_result' };
      let streamChain = Promise.resolve();
      let timeoutTimer;
      let hardKillTimer;
      let forceSettleTimer;

      const clearRunTimers = () => {
        clearTimeout(timeoutTimer);
        clearTimeout(hardKillTimer);
        clearTimeout(forceSettleTimer);
      };

      const releaseChildListeners = () => {
        child?.stdout?.removeAllListeners('data');
        child?.stderr?.removeAllListeners('data');
        child?.removeAllListeners('error');
        child?.removeAllListeners('close');
      };

      const fail = (error, stopReason = 'error') => {
        if (complete) return;
        complete = true;
        clearRunTimers();
        if (activeRun) {
          activeRun.closed = true;
          clearTimeout(activeRun.cancelTimer);
          if (this.activeRuns.get(task.id) === activeRun) this.activeRuns.delete(task.id);
        }
        result = { ...result, status: 'failed', stopReason };
        this.conversation.append({ channel: task.channel ?? 'system', role: 'system', body: `Claude run failed: ${error.message}`, taskId: task.id ?? null });
        safeCallback(callbacks, 'onError', error);
        releaseChildListeners();
        resolve(result);
      };

      const terminateMultiToolBatch = () => {
        clearTimeout(timeoutTimer);
        signalChildTree(child, 'SIGTERM');
        hardKillTimer = setTimeout(() => signalChildTree(child, 'SIGKILL'), this.terminateGraceMs);
        hardKillTimer.unref?.();
      };

      const processEvent = async (event) => {
        if (!event || typeof event !== 'object') return;
        if (multiToolBatch) return;
        const eventSession = stringValue(event.session_id) ?? stringValue(event.sessionId);
        if (eventSession && !task.claudeSessionId) result.sessionId = eventSession;

        const delta = event.type === 'stream_event' && event.event?.type === 'content_block_delta'
          ? event.event.delta?.text : null;
        if (typeof delta === 'string' && delta.length > 0) {
          this.conversation.append({ channel: task.channel ?? 'system', role: 'assistant', body: delta, taskId: task.id ?? null });
          safeCallback(callbacks, 'onAssistantText', delta);
        }

        const assistantContent = event.type === 'assistant' ? event.message?.content : null;
        if (Array.isArray(assistantContent)) {
          const toolCalls = assistantContent.filter((block) => block?.type === 'tool_use').map((block) => ({
            toolUseId: block.id,
            toolName: block.name,
            toolInput: block.input ?? {},
          }));
          if (toolCalls.length > 0) {
            batchGeneration += 1;
            if (batchGeneration > this.maxToolRounds) {
              maxRoundsExceeded = true;
              const budgetMsg = `（工具调用已达 ${this.maxToolRounds} 轮预算上限，任务在此终止。）`;
              this.conversation.append({ channel: task.channel ?? 'system', role: 'assistant', body: budgetMsg, taskId: task.id ?? null });
              result = { ...result, status: 'completed', finalText: budgetMsg, stopReason: 'max_tool_rounds' };
              signalChildTree(child, 'SIGTERM');
              return;
            }
            if (typeof callbacks.onToolBatch === 'function') {
              try {
                await callbacks.onToolBatch({
                  taskId: task.id,
                  sessionId: task.claudeSessionId || eventSession || result.sessionId,
                  generation: batchGeneration,
                  toolCalls,
                });
              } catch {
                batchRegistrationFailed = true;
                this.conversation.append({ channel: task.channel ?? 'system', role: 'system', body: 'Tool batch registration failed; retry the task.', taskId: task.id ?? null });
                terminateMultiToolBatch();
                return;
              }
            }
          }
          const batch = analyzeToolBatch(assistantContent);
          if (!batch.allowed) {
            multiToolBatch = true;
            this.conversation.append({ channel: task.channel ?? 'system', role: 'system', body: batch.instruction, taskId: task.id ?? null });
            safeCallback(callbacks, 'onError', new Error(batch.instruction));
            terminateMultiToolBatch();
            return;
          }
          for (const block of assistantContent) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
              this.conversation.append({ channel: task.channel ?? 'system', role: 'assistant', body: block.text, taskId: task.id ?? null });
              safeCallback(callbacks, 'onAssistantText', block.text);
            }
            if (block?.type === 'tool_use') {
              const detail = { toolUseId: block.id ?? null, toolName: block.name ?? null, input: block.input ?? {} };
              this.noteToolStart(task.id, detail.toolUseId);
              await this.#appendTool(task, 'tool_start', detail);
              safeCallback(callbacks, 'onToolStart', detail);
            }
          }
        }

        const toolResultBlocks = event.type === 'user' ? event.message?.content : null;
        if (Array.isArray(toolResultBlocks)) {
          for (const block of toolResultBlocks) {
            if (block?.type !== 'tool_result') continue;
            const detail = { toolUseId: block.tool_use_id ?? null, output: toolOutput(block.content), isError: Boolean(block.is_error) };
            this.noteToolEnd(task.id, detail.toolUseId);
            await this.#appendTool(task, 'tool_end', detail);
            safeCallback(callbacks, 'onToolEnd', detail);
          }
        }

        const deferred = event.deferred_tool_use ?? event.event?.deferred_tool_use
          ?? event.hook_response?.deferred_tool_use ?? event.data?.deferred_tool_use;
        if (deferred) {
          await this.#appendTool(task, 'tool_deferred', { deferred });
          safeCallback(callbacks, 'onDeferred', deferred);
        }

        if (event.type === 'result') {
          const finalText = typeof event.result === 'string' ? event.result : extractText(event.message?.content);
          result = {
            sessionId: task.claudeSessionId || eventSession || result.sessionId,
            status: !multiToolBatch && resultSuccess(event) ? 'completed' : 'failed',
            finalText,
            usage: event.usage ?? null,
            stopReason: multiToolBatch ? 'multiple_tool_calls' : event.stop_reason ?? event.subtype ?? null,
          };
          if (finalText.length > 0) {
            this.conversation.append({ channel: task.channel ?? 'system', role: 'assistant', body: finalText, taskId: task.id ?? null });
          }
        }
      };

      const processLine = (line) => {
        if (line.trim().length === 0) return;
        try {
          const event = JSON.parse(line);
          streamChain = streamChain.then(() => processEvent(event));
        } catch {
          safeCallback(callbacks, 'onError', new Error('Ignored malformed Claude stream JSON line'));
        }
      };

      try {
        child = this.spawn(this.config.claudeBin, args, {
          cwd: this.config.claudeCwd,
          env: childEnvironment,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        fail(error);
        return;
      }
      activeRun = {
        child, workerId: task.workerId, activeTools: new Set(), cancelRequested: false,
        interruptSent: false, cancelTimer: null, closed: false,
      };
      this.activeRuns.set(task.id, activeRun);
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        signalChildTree(child, 'SIGTERM');
        hardKillTimer = setTimeout(() => {
          signalChildTree(child, 'SIGKILL');
          forceSettleTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            fail(new Error(`Claude run timed out after ${this.timeoutMs}ms`), 'timeout');
          }, this.hardKillWaitMs);
          forceSettleTimer.unref?.();
        }, this.terminateGraceMs);
        hardKillTimer.unref?.();
      }, this.timeoutMs);
      timeoutTimer.unref?.();

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString('utf8');
        let newline;
        while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          processLine(line);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096);
      });
      child.once('error', (error) => {
        clearRunTimers();
        fail(error);
      });
      child.once('close', async (code) => {
        clearRunTimers();
        if (activeRun) {
          activeRun.closed = true;
          clearTimeout(activeRun.cancelTimer);
        }
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        try {
          await streamChain;
        } catch (error) {
          fail(error);
          return;
        }
        if (complete) return;
        if (maxRoundsExceeded) {
          complete = true;
          if (this.activeRuns.get(task.id) === activeRun) this.activeRuns.delete(task.id);
          releaseChildListeners();
          resolve(result);
          return;
        }
        if (timedOut) {
          fail(new Error(`Claude run timed out after ${this.timeoutMs}ms`), 'timeout');
          return;
        }
        if (activeRun?.cancelRequested) {
          try {
            this.taskService?.finishCancellation?.(task.id, activeRun.workerId);
          } catch (error) {
            fail(error, 'cancel_persistence_failed');
            return;
          }
          fail(new Error('Claude run cancelled'), 'cancelled');
          return;
        }
        if (multiToolBatch) {
          fail(new Error('Retry using exactly one tool call at a time.'), 'multiple_tool_calls');
          return;
        }
        if (batchRegistrationFailed) {
          fail(new Error('Tool batch registration failed; retry the task.'), 'batch_registration_failed');
          return;
        }
        if (code !== 0) {
          fail(new Error(`Claude exited with code ${code}${stderr ? `: ${stderr}` : ''}`), 'exit_error');
          return;
        }
        if (result.status !== 'completed') {
          fail(new Error('Claude stream ended without a successful result'), result.stopReason ?? 'no_result');
          return;
        }
        complete = true;
        if (this.activeRuns.get(task.id) === activeRun) this.activeRuns.delete(task.id);
        releaseChildListeners();
        resolve(result);
      });
    });
  }
}
