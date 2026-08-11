#!/usr/bin/env node

import { join } from 'node:path';
import { openDatabase } from '../src/db/database.js';
import { createWeixinPairingRequest } from '../src/weixin/identity.js';

const dataDir = process.env.PI_CONTROL_DATA_DIR ?? '/var/lib/pi-control/weixin';
const dbPath = process.env.PI_CONTROL_DB_PATH ?? join(dataDir, 'weixin.sqlite');
const db = openDatabase(dbPath);
try {
  const request = createWeixinPairingRequest(db);
  process.stdout.write(`请在 ${request.expiresAt} 前，使用你的微信向机器人发送以下 8 位验证码：\n${request.code}\n`);
  process.stdout.write('验证码仅用于本次绑定；绑定后，其他微信账号的消息会被直接拒绝。\n');
} finally {
  db.close();
}
