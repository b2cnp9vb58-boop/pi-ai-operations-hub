#!/usr/bin/env node

import { join } from 'node:path';
import { openDatabase } from '../src/db/database.js';
import { SystemdNotifier } from '../src/core/systemd-notifier.js';
import { resolveTelegramConfig } from '../src/shared/config.js';
import { createTelegramGateway } from '../src/telegram/main.js';
import { recoverTelegramOutbox } from '../src/telegram/delivery.js';
import { isMainModule } from '../src/shared/main-module.js';

export async function startTelegramProcess({
  env = process.env,
  client,
  notifier = new SystemdNotifier(),
  logger = console,
  sleep,
  deliveryIntervalMs,
} = {}) {
  const config = resolveTelegramConfig(env);
  const dataDir = env.PI_CONTROL_DATA_DIR ?? '/var/lib/pi-control/shared';
  const dbPath = env.PI_CONTROL_DB_PATH ?? join(dataDir, 'conversations.sqlite');
  const db = openDatabase(dbPath);
  recoverTelegramOutbox(db);
  const controller = new AbortController();
  let stopped = false;
  let gateway;
  try {
    gateway = createTelegramGateway({ config, db, client, notifier, logger, sleep, deliveryIntervalMs });
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
      controller.abort(new Error('Telegram gateway stopped'));
      await done;
    },
  };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  startTelegramProcess().then((runtime) => {
    const shutdown = () => runtime.stop().then(() => process.exit(0), () => process.exit(1));
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    runtime.done.catch((error) => {
      process.stderr.write(`telegram-control: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    });
  }).catch((error) => {
    process.stderr.write(`telegram-control: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
