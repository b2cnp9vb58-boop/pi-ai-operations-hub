#!/usr/bin/env node

import { join } from 'node:path';
import { openDatabase } from '../src/db/database.js';
import { SystemdNotifier } from '../src/core/systemd-notifier.js';
import { resolveWeixinConfig } from '../src/shared/config.js';
import { createWeixinGateway } from '../src/weixin/main.js';
import { isMainModule } from '../src/shared/main-module.js';

export async function startWeixinProcess({
  env = process.env,
  client,
  notifier = new SystemdNotifier(),
  logger = console,
  sleep,
  deliveryIntervalMs,
} = {}) {
  const config = resolveWeixinConfig(env);
  const dataDir = env.PI_CONTROL_DATA_DIR ?? '/var/lib/pi-control/weixin';
  const dbPath = env.PI_CONTROL_DB_PATH ?? join(dataDir, 'weixin.sqlite');
  const db = openDatabase(dbPath);
  const controller = new AbortController();
  let stopped = false;
  let gateway;
  try {
    gateway = createWeixinGateway({ config, db, client, notifier, logger, sleep, deliveryIntervalMs });
  } catch (error) {
    db.close();
    throw error;
  }
  const done = gateway.run({ signal: controller.signal }).finally(() => db.close());
  return {
    done,
    get stopped() { return stopped; },
    async stop() {
      if (stopped) return;
      stopped = true;
      controller.abort(new Error('WeChat gateway stopped'));
      await done;
    },
  };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  startWeixinProcess().then((runtime) => {
    const shutdown = () => runtime.stop().then(() => process.exit(0), () => process.exit(1));
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    runtime.done.catch((error) => {
      process.stderr.write(`weixin-control: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    });
  }).catch((error) => {
    process.stderr.write(`weixin-control: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
