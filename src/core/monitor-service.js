import { execFile as nodeExecFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { connect } from 'node:net';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import {
  claimAlertOutbox, markOutboxSent, releaseOutbox, updateSettingWithOutbox,
} from '../db/repositories.js';

const SERVICES = Object.freeze([
  'nginx', 'cloudflared', 'pi-control-core', 'telegram-control', 'weixin-control',
]);
const PUBLIC_URLS = Object.freeze([
  'https://example.org/',
]);

function nowMilliseconds(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('clock must return a valid time');
  return milliseconds;
}

function command(file, args, { execFile = nodeExecFile } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { shell: false, timeout: 8_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, detail: String(stdout || stderr || error?.message || '').trim() });
    });
  });
}

function http(url, { fetch = globalThis.fetch, headers = {} } = {}) {
  return async ({ signal } = {}) => {
    const response = await fetch(url, { method: 'GET', redirect: 'error', headers, signal });
    return { ok: response.ok, detail: `HTTP ${response.status}` };
  };
}

function tcp(host, port, { connectSocket = connect } = {}) {
  return ({ signal } = {}) => new Promise((resolve) => {
    const socket = connectSocket({ host, port });
    const finish = (ok, detail) => {
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.once('connect', () => finish(true, 'connected'));
    socket.once('error', (error) => finish(false, error.message));
    signal?.addEventListener('abort', () => finish(false, 'timeout'), { once: true });
  });
}

function mountedDisk(path, { statfsFile = statfs, readText = readFile } = {}) {
  return async () => {
    const mounts = await readText('/proc/mounts', 'utf8');
    const entry = mounts.split('\n').map((line) => line.split(' ')).find((fields) => fields[1] === path);
    if (!entry) return { ok: false, detail: 'not mounted' };
    const flags = entry[3] ?? '';
    const stats = await statfsFile(path);
    const used = 1 - Number(stats.bavail) / Number(stats.blocks);
    const readOnly = flags.split(',').includes('ro');
    return { ok: used < 0.9 && !readOnly, detail: `${Math.round(used * 100)}% used; ${flags}` };
  };
}

export function createDefaultProbes(options = {}) {
  const adminKey = options.adminKey ?? process.env.PI_CONTROL_ADMIN_KEY ?? '';
  const probes = SERVICES.map((service) => ({
    name: `service:${service}`, category: 'service',
    run: () => command('/usr/bin/systemctl', ['is-active', '--quiet', `${service}.service`], options),
  }));
  probes.push(
    { name: 'nginx:config', category: 'service', run: () => command('/usr/sbin/nginx', ['-t'], options) },
    { name: 'port:core', category: 'port', run: tcp('127.0.0.1', 4330, options) },
    { name: 'vnc:handshake', category: 'port', run: tcp('127.0.0.1', 5900, options) },
    { name: 'cloudflare:metrics', category: 'api', run: http('http://127.0.0.1:20241/metrics', options) },
    { name: 'api:core-health', category: 'api', run: http('http://127.0.0.1:4330/v1/health', {
      ...options, headers: adminKey ? { 'X-Pi-Control-Key': adminKey } : {},
    }) },
    {
      name: 'system:temperature', category: 'system', run: async () => {
        const celsius = Number(await (options.readText ?? readFile)('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000;
        return { ok: Number.isFinite(celsius) && celsius < 80, detail: `${celsius.toFixed(1)} C` };
      },
    },
    {
      name: 'system:memory', category: 'system', run: async () => {
        const total = (options.totalMemory ?? totalmem)();
        const free = (options.freeMemory ?? freemem)();
        const used = 1 - free / total;
        return { ok: Number.isFinite(used) && used < 0.9, detail: `${Math.round(used * 100)}% used` };
      },
    },
    {
      name: 'system:load', category: 'system', run: async () => {
        const load = (options.loadAverage ?? loadavg)()[0];
        const cores = (options.cpuList ?? cpus)().length || 1;
        return { ok: Number.isFinite(load) && load / cores < 2, detail: `${load.toFixed(2)} / ${cores} cores` };
      },
    },
    { name: 'disk:root', category: 'disk', run: mountedDisk('/', options) },
    { name: 'disk:usb', category: 'disk', run: mountedDisk(options.usbPath ?? '/media/pi-control/usb', options) },
  );
  for (const url of PUBLIC_URLS) {
    probes.push({ name: `website:${new URL(url).hostname}`, category: 'website', run: http(url, options) });
  }
  return probes;
}

export class MonitorService {
  constructor({
    db, probes = createDefaultProbes(), clock = Date.now, timeoutMs = 8_000,
    failureThreshold = 3, cooldownMs = 300_000, retryDelayMs = 30_000,
  } = {}) {
    if (!db?.prepare) throw new TypeError('db is required');
    this.db = db;
    this.probes = probes;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.retryDelayMs = retryDelayMs;
    this.cyclePromise = null;
  }

  #now() {
    return nowMilliseconds(this.clock);
  }

  async observe(name, ok, detail = {}) {
    const key = `monitor:${name}`;
    const now = this.#now();
    const updatedAt = new Date(now).toISOString();
    return updateSettingWithOutbox(this.db, key, updatedAt, (stored) => {
      let state = { failures: 0, incidentOpen: false, lastAlertAt: null };
      try {
        state = { ...state, ...JSON.parse(stored ?? '{}') };
      } catch {
        // Corrupt monitoring state fails closed into a fresh debounce window.
      }
      let event = null;
      if (ok) {
        if (state.incidentOpen) {
          event = { kind: 'recovery', payload: { probe: name, detail, at: updatedAt } };
        }
        state.failures = 0;
        state.incidentOpen = false;
      } else {
        state.failures += 1;
        const cooledDown = state.lastAlertAt === null || now - state.lastAlertAt >= this.cooldownMs;
        if (!state.incidentOpen && state.failures >= this.failureThreshold && cooledDown) {
          event = { kind: 'alert', payload: { probe: name, detail, at: updatedAt } };
          state.incidentOpen = true;
          state.lastAlertAt = now;
        }
      }
      return { value: JSON.stringify(state), event, result: state };
    });
  }

  async #runProbe(probe) {
    const startedAt = this.#now();
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ ok: false, detail: `timeout after ${this.timeoutMs}ms` });
        }, this.timeoutMs);
      });
      const operation = Promise.resolve().then(() => probe.run({ signal: controller.signal })).then(
        (value) => ({ ok: value?.ok === true, detail: String(value?.detail ?? '') }),
        (error) => ({ ok: false, detail: String(error?.message ?? error) }),
      );
      const outcome = await Promise.race([operation, timeout]);
      const result = {
        name: probe.name, category: probe.category, ok: outcome.ok,
        detail: outcome.detail, durationMs: Math.max(0, this.#now() - startedAt),
      };
      await this.observe(probe.name, result.ok, { category: probe.category, message: result.detail });
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  runCycle() {
    if (this.cyclePromise) return this.cyclePromise;
    const cycle = Promise.all(this.probes.map((probe) => this.#runProbe(probe)));
    const tracked = cycle.finally(() => {
      if (this.cyclePromise === tracked) this.cyclePromise = null;
    });
    this.cyclePromise = tracked;
    return tracked;
  }

  async deliverAlerts({ telegram, wechat, limit = 20 } = {}) {
    if (typeof telegram !== 'function') throw new TypeError('telegram sender is required');
    const now = this.#now();
    const events = claimAlertOutbox(this.db, limit, new Date(now).toISOString());
    let delivered = 0;
    for (const event of events) {
      try {
        await telegram(event.payload, event);
      } catch {
        releaseOutbox(this.db, event.id, new Date(now + this.retryDelayMs).toISOString());
        continue;
      }
      if (typeof wechat === 'function') Promise.resolve().then(() => wechat(event.payload, event)).catch(() => {});
      markOutboxSent(this.db, event.id);
      delivered += 1;
    }
    return delivered;
  }
}
