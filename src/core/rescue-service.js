import { spawn } from 'node:child_process';
import { classifyToolCall } from '../security/risk-policy.js';

const KNOWN_SERVICES = Object.freeze([
  'nginx.service', 'cloudflared.service', 'pi-control-core.service', 'pi-control-telegram.service',
  'pi-control-core.service', 'telegram-control.service', 'weixin-control.service',
]);
const KNOWN_SERVICE_SET = new Set(KNOWN_SERVICES);
const WEBSITES = Object.freeze([
  'https://example.org/',
]);

function spawnCommand(file, args, { shell = false, timeoutMs = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function fixedCommands(action) {
  if (action === 'status') {
    return [{ file: '/usr/bin/systemctl', args: ['--no-pager', '--full', 'status', ...KNOWN_SERVICES] }];
  }
  if (action === 'check-websites') {
    return WEBSITES.map((url) => ({
      file: '/usr/bin/curl', args: ['--fail', '--silent', '--show-error', '--max-time', '8', url],
    }));
  }
  if (action === 'reboot') return [{ file: '/usr/bin/systemctl', args: ['reboot'] }];
  const separator = action.indexOf(':');
  if (separator < 1) return null;
  const verb = action.slice(0, separator);
  const service = action.slice(separator + 1);
  if (!KNOWN_SERVICE_SET.has(service)) return null;
  if (verb === 'logs') {
    return [{ file: '/usr/bin/journalctl', args: ['--no-pager', '-n', '100', '-u', service] }];
  }
  if (verb === 'restart') return [{ file: '/usr/bin/systemctl', args: ['restart', service] }];
  return null;
}

function riskFor(action) {
  if (action === 'reboot') return classifyToolCall('Bash', { command: 'sudo systemctl reboot' });
  if (action.startsWith('restart:')) {
    return classifyToolCall('Bash', { command: `sudo systemctl restart ${action.slice('restart:'.length)}` });
  }
  return null;
}

export class RescueService {
  constructor({ ownerId, isPrimaryHealthy, approvalService, run = spawnCommand, timeoutMs = 8_000 } = {}) {
    if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('ownerId is required');
    if (typeof isPrimaryHealthy !== 'function') throw new TypeError('primary health check is required');
    this.ownerId = ownerId;
    this.isPrimaryHealthy = isPrimaryHealthy;
    this.approvalService = approvalService;
    this.run = run;
    this.timeoutMs = timeoutMs;
  }

  async isActive() {
    try {
      return !(await this.isPrimaryHealthy());
    } catch {
      return true;
    }
  }

  async execute(action, actor, approval = null) {
    if (!actor || String(actor.userId) !== this.ownerId) throw new Error('rescue commands are owner-only');
    if (!(await this.isActive())) throw new Error('rescue mode is inactive');
    if (typeof action !== 'string') throw new Error('unsupported rescue action');
    const commands = fixedCommands(action);
    if (!commands) throw new Error('unsupported rescue action');

    const risk = riskFor(action);
    if (risk) {
      const binding = approval && typeof approval.taskId === 'string' ? {
        taskId: approval.taskId, ownerId: this.ownerId, operationHash: risk.operationHash,
      } : null;
      if (!binding || typeof approval.id !== 'string'
          || !this.approvalService?.consume?.(approval.id, binding)) {
        throw new Error('high-risk approval required');
      }
    }

    const results = [];
    for (const item of commands) {
      results.push(await this.run(item.file, [...item.args], { shell: false, timeoutMs: this.timeoutMs }));
    }
    return { ok: results.every((result) => result?.code === 0), action, results };
  }
}
