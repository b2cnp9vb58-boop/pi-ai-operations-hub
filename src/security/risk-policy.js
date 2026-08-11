import { canonicalHash } from '../shared/canonical-json.js';
import { existsSync, realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';

const SECRET_OR_CONTROL_PATH = /(?:^|\/)(?:etc|boot|opt\/pi-control)(?:\/|$)|(?:^|\/)\.claude(?:\/|$)|(?:^|\/)(?:\.ssh|ssh)(?:\/|$)|(?:^|\/)(?:audit|audits)(?:\/|$)|(?:^|\/)(?:[^/]*(?:secret|password|token|credential|private[-_]?key)[^/]*|[^/]*\.env)(?:\/|$)|\/proc\/[^/]+\/environ(?:$|\/)/i;
const COMPOUND_SHELL = /(?:&&|\|\||;|\r|\n|(?<!\|)\|(?!\|)|`|\$\()/;
const OVERWRITE_REDIRECT = /(?:^|[^>])>{1,2}(?!>)/;
const JOURNAL_MUTATION = /(?:^|\s)--(?:rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|vacuum-(?:size|time|files))(?:=|\s|$)/i;
const SAFE_READ_ROOTS = Object.freeze(['/opt/pi-ai-operations-hub/workspace', '/var/log', '/var/www', '/tmp', '/usr/share', '/usr/local/share', '/media/pi-control']);
const BROAD_SEARCH_ROOTS = new Set(['/', '/home', '/var', '/media', '/mnt', ...SAFE_READ_ROOTS]);

const HIGH_COMMAND_RULES = [
  ['destructive filesystem command', /(?:^|\s)(?:sudo\s+)?(?:rm|rmdir|shred|unlink|mv|cp|install|truncate|dd|touch|mkdir)\b/i],
  ['permission or identity change', /(?:^|\s)(?:sudo\s+)?(?:chmod|chown|chgrp|setfacl|useradd|userdel|usermod|groupadd|groupdel|passwd|visudo|su)\b/i],
  ['package management', /(?:^|\s)(?:sudo\s+)?(?:apt(?:-get)?|dpkg|snap|pip|npm|pnpm|yarn)\s+(?:install|remove|purge|upgrade|update|uninstall|add)\b/i],
  ['service or system mutation', /(?:^|\s)(?:sudo\s+)?(?:systemctl|service)\s+(?:start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b|(?:^|\s)(?:sudo\s+)?(?:shutdown|reboot|poweroff|halt)\b/i],
  ['process signal', /(?:^|\s)(?:sudo\s+)?(?:kill|killall|pkill)\b/i],
  ['mount or format operation', /(?:^|\s)(?:sudo\s+)?(?:mount|umount|mkfs(?:\.\w+)?|fdisk|parted|wipefs|fsck)\b/i],
  ['database mutation', /\b(?:insert|update|delete|drop|alter|create|replace|vacuum|reindex)\b/i],
  ['network or firewall mutation', /(?:^|\s)(?:sudo\s+)?(?:nft|iptables|ip6tables|ufw|firewall-cmd|nmcli)\b|(?:^|\s)(?:sudo\s+)?ip\s+(?:addr|address|route|link|rule|netns)\b/i],
  ['environment or credential disclosure', /^(?:sudo\s+)?(?:env|printenv|set)\s*$|\b(?:cat|head|tail|less|more|grep|find)\b.*(?:\.env|environ|id_rsa|id_ed25519|credential|secret|token|password|private[-_]?key)/i],
  ['persistent file mutation', /(?:^|\s)(?:sudo\s+)?(?:tee|sed\s+-i|perl\s+-\S*i)\b/i],
];

function hashFor(toolName, toolInput) {
  try {
    return canonicalHash({ toolName, toolInput });
  } catch {
    return canonicalHash({ toolName: typeof toolName === 'string' ? toolName : null, toolInput: null, malformed: true });
  }
}

function result(toolName, toolInput, level, reasons) {
  return { level, reasons, operationHash: hashFor(toolName, toolInput) };
}

function pathsFrom(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const values = [];
  const visit = (value, key = '') => {
    if (typeof value === 'string' && /(?:path|glob|pattern)/i.test(key)) values.push(value);
    else if (Array.isArray(value)) value.forEach((entry) => visit(entry, key));
    else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(input);
  return values;
}

function searchPatternFields(input) {
  const values = [];
  const visit = (value, key = '') => {
    if (typeof value === 'string' && /(?:pattern|glob)/i.test(key)) values.push(value);
    else if (Array.isArray(value)) value.forEach((entry) => visit(entry, key));
    else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(input);
  return values;
}

function isWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function pathApi(value) {
  return isWindowsPath(value) ? win32 : posix;
}

function realpathAware(value) {
  const api = pathApi(value);
  if (!api.isAbsolute(value)) return null;
  const windowsStyle = isWindowsPath(value);
  if (windowsStyle !== (process.platform === 'win32')) return api.normalize(value);
  let current = api.normalize(value);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = api.dirname(current);
    if (parent === current) return api.normalize(value);
    suffix.unshift(api.basename(current));
    current = parent;
  }
  try {
    return api.join(realpathSync.native(current), ...suffix);
  } catch {
    return api.normalize(value);
  }
}

function protectedPath(value) {
  const lexical = pathApi(value).normalize(value);
  const resolved = realpathAware(value) ?? lexical;
  return SECRET_OR_CONTROL_PATH.test(lexical) || SECRET_OR_CONTROL_PATH.test(resolved);
}

function inside(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function safeAbsoluteReadPath(value) {
  if (typeof value !== 'string') return false;
  const normalized = realpathAware(value);
  if (!normalized || isWindowsPath(normalized)) return false;
  return SAFE_READ_ROOTS.some((root) => inside(normalized, root));
}

function firstWildcardIndex(value) {
  const indexes = ['*', '?', '['].map((character) => value.indexOf(character)).filter((index) => index >= 0);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
}

function searchPatternsStayWithinBase(toolName, input, base) {
  for (const raw of searchPatternFields(input)) {
    if (raw.includes('\0')) return false;
    const normalizedSeparators = raw.replaceAll('\\', '/');
    const pathLike = toolName === 'Glob'
      || /[\\/]/.test(raw)
      || /[*?\[]/.test(raw)
      || normalizedSeparators.split('/').includes('..');
    if (!pathLike) continue;
    if (normalizedSeparators.split('/').includes('..')) return false;
    if (/^[A-Za-z]:\//.test(normalizedSeparators) || normalizedSeparators.startsWith('//')) return false;

    const wildcard = firstWildcardIndex(normalizedSeparators);
    const prefix = wildcard === -1 ? normalizedSeparators : normalizedSeparators.slice(0, wildcard);
    const candidate = prefix.startsWith('/')
      ? realpathAware(prefix) ?? posix.normalize(prefix)
      : realpathAware(posix.join(base, prefix)) ?? posix.normalize(posix.join(base, prefix));
    if (!safeAbsoluteReadPath(candidate) || !inside(candidate, base)) return false;
  }
  return true;
}

function journalctlIsReadOnly(command) {
  const tokens = command.split(/\s+/);
  if (tokens.shift()?.toLowerCase() !== 'journalctl') return false;
  const flagsWithoutValues = new Set(['--no-pager', '--quiet', '-q', '--reverse', '-r', '--utc', '--local', '--all', '-a', '--catalog', '-x', '--merge', '-m', '--list-boots']);
  const flagsWithValues = new Set(['-u', '--unit', '-n', '--lines', '-b', '--boot', '--since', '--until', '-p', '--priority', '-g', '--grep', '-t', '--identifier']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (flagsWithoutValues.has(token)) continue;
    if (flagsWithValues.has(token)) {
      if (!tokens[index + 1] || tokens[index + 1].startsWith('-')) return false;
      index += 1;
      continue;
    }
    if (/^(?:--(?:unit|lines|boot|since|until|priority|grep|identifier)=|-[unbpgt])[^\s]+$/.test(token)) continue;
    if (/^_[A-Z0-9_]+=[A-Za-z0-9@_.:\/-]+$/.test(token)) continue;
    return false;
  }
  return true;
}

function lowBashReason(command) {
  const lowPatterns = [
    ['service status query', /^(?:sudo\s+)?systemctl\s+(?:--no-pager\s+)?status\s+[A-Za-z0-9@_.-]+(?:\s+--no-pager)?$/i],
    ['disk usage query', /^df(?:\s+-[A-Za-z]+)*(?:\s+\/[A-Za-z0-9._\/-]*)?$/i],
    ['memory query', /^free(?:\s+-[A-Za-z]+)*$/i],
    ['temperature query', /^vcgencmd\s+measure_temp$/i],
    ['socket query', /^ss(?:\s+-[A-Za-z]+)*$/i],
    ['HTTP GET or HEAD query', /^curl\s+(?:(?:-I|--head)|(?:(?:-X|--request)\s+(?:GET|HEAD)))\s+https?:\/\/[^\s]+$/i],
    ['configuration syntax check', /^(?:sudo\s+)?(?:nginx\s+-t|sshd\s+-t|apachectl\s+configtest)$/i],
  ];
  if (journalctlIsReadOnly(command)) return 'journal query';
  return lowPatterns.find(([, pattern]) => pattern.test(command))?.[0] ?? null;
}

export function classifyToolCall(toolName, toolInput) {
  if (typeof toolName !== 'string' || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return result(toolName, toolInput, 'unknown', ['malformed tool call']);
  }

  const paths = pathsFrom(toolInput);
  if (paths.some(protectedPath)) {
    return result(toolName, toolInput, 'high', ['secret or control path']);
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    return result(toolName, toolInput, 'high', ['persistent file mutation']);
  }
  if (toolName === 'Read') {
    return typeof toolInput.file_path === 'string' && safeAbsoluteReadPath(toolInput.file_path)
      ? result(toolName, toolInput, 'low', ['read-only file access'])
      : result(toolName, toolInput, 'unknown', ['missing, broad, or ambiguous read path']);
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    const base = typeof toolInput.path === 'string' ? realpathAware(toolInput.path) : null;
    const pattern = toolInput.pattern;
    const broadPattern = typeof pattern === 'string' && /^(?:\*|\*\*|\*\*\/\*)$/.test(pattern.trim());
    const broadBase = typeof base === 'string' && BROAD_SEARCH_ROOTS.has(base);
    return typeof pattern === 'string'
      && pattern.length > 0
      && safeAbsoluteReadPath(toolInput.path)
      && !(broadPattern && broadBase)
      && searchPatternsStayWithinBase(toolName, toolInput, base)
      ? result(toolName, toolInput, 'low', ['read-only search'])
      : result(toolName, toolInput, 'unknown', ['malformed, broad, or ambiguous search']);
  }
  if (toolName !== 'Bash' || typeof toolInput.command !== 'string' || toolInput.command.trim() === '') {
    return result(toolName, toolInput, 'unknown', ['unsupported or malformed tool call']);
  }

  const command = toolInput.command.trim();
  if (OVERWRITE_REDIRECT.test(command)) return result(toolName, toolInput, 'high', ['shell output overwrite']);
  if (COMPOUND_SHELL.test(command)) return result(toolName, toolInput, 'unknown', ['compound or unparsed shell command']);
  if (JOURNAL_MUTATION.test(command)) return result(toolName, toolInput, 'high', ['journal mutation']);
  if (SECRET_OR_CONTROL_PATH.test(command)) return result(toolName, toolInput, 'high', ['secret or control path']);
  for (const [reason, pattern] of HIGH_COMMAND_RULES) {
    if (pattern.test(command)) return result(toolName, toolInput, 'high', [reason]);
  }
  const lowReason = lowBashReason(command);
  if (lowReason) return result(toolName, toolInput, 'low', [lowReason]);
  return result(toolName, toolInput, 'unknown', ['unclassified shell command']);
}
