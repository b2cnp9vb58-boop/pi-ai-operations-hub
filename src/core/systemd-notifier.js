import { execFile as nodeExecFile } from 'node:child_process';

export class SystemdNotifier {
  constructor({ execFile = nodeExecFile, timeoutMs = 2_000, logger = console } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    this.execFile = execFile;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  #send(args) {
    return new Promise((resolve) => {
      let settled = false;
      let child;
      const finish = (ok, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) this.logger?.error?.(`systemd notification failed: ${error?.message ?? 'timeout'}`);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        try { child?.kill?.('SIGTERM'); } catch {}
        finish(false, new Error('timeout'));
      }, this.timeoutMs);
      try {
        child = this.execFile('/usr/bin/systemd-notify', args, {
          shell: false, timeout: this.timeoutMs, windowsHide: true,
        }, (error) => finish(!error, error));
      } catch (error) {
        finish(false, error);
      }
    });
  }

  ready() {
    return this.#send(['--ready']);
  }

  status(text) {
    const safe = String(text ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
    return this.#send([`--status=${safe}`]);
  }

  watchdog() {
    return this.#send(['WATCHDOG=1']);
  }
}
