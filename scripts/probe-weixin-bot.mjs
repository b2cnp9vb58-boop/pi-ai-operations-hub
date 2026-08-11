#!/usr/bin/env node

import { WeixinClient } from '../src/weixin/client.js';
import { isMainModule } from '../src/shared/main-module.js';

async function probe({ fetch = globalThis.fetch, logger = console } = {}) {
  const client = new WeixinClient({ fetch, logger });
  let qrBuffer;
  try {
    qrBuffer = await client.getBotQrcode();
  } catch (error) {
    return { ok: false, reason: `QR code fetch failed: ${error.message}` };
  }
  if (!qrBuffer || qrBuffer.byteLength < 100) {
    return { ok: false, reason: 'QR code response is too small' };
  }
  return { ok: true, qrSize: qrBuffer.byteLength };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const result = await probe();
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
