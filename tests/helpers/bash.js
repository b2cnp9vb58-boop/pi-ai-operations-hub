import { existsSync } from 'node:fs';

export function resolveBash({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const override = typeof env.BASH === 'string' ? env.BASH.trim() : '';
  if (override) return override;
  if (platform === 'win32') return 'C:/Program Files/Git/bin/bash.exe';
  if (exists('/bin/bash')) return '/bin/bash';
  return 'bash';
}
