const SECRET_PATTERNS = Object.freeze([
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})\b/g,
  /\b(Bearer\s+[A-Za-z0-9._~+\/-]+=*)\b/g,
  /\b(scrypt\$[^\s]{20,})\b/g,
  /\b(ANTHROPIC_API_KEY\s*[=:]\s*\S+)\b/gi,
  /\b(ANTHROPIC_AUTH_TOKEN\s*[=:]\s*\S+)\b/gi,
  /\b(TELEGRAM_BOT_TOKEN\s*[=:]\s*\S+)\b/gi,
  /\b(PI_CONTROL_\w+_KEY\s*[=:]\s*\S+)\b/gi,
  /\b(\/etc\/pi-control\/\S+)\b/gi,
  /\b(\/etc\/portal-accounts)\b/gi,
  /\b(CLAUDE_CODE_OAUTH_TOKEN\s*[=:]\s*\S+)\b/gi,
]);

const REDACTED = '[已过滤]';

export function guardWeixinResponse(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
