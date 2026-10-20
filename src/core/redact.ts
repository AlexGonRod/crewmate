const SENSITIVE_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH|CREDENTIAL)/i;

const TOKEN_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
];

export function redactText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let output = text;
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 4 && SENSITIVE_KEY.test(key)) {
      output = output.split(value).join('[REDACTED]');
    }
  }
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  return output;
}

export function redactDeep(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    return redactText(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, env));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = redactDeep(item, env);
    }
    return result;
  }
  return value;
}
