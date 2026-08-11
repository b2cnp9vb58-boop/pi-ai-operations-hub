import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(metaUrl, argvEntry = process.argv[1]) {
  if (!argvEntry) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
