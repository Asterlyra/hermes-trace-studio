const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|cookie|authorization|private[_-]?key)/i;

const TEXT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}\b/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /((?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|SECRET)\s*[=:]\s*)[^\s,;"']+/gi,
];

const MAX_TEXT_LENGTH = 200_000;

export function redactText(input) {
  if (input == null) return input;
  let value = String(input);
  for (const pattern of TEXT_PATTERNS) {
    value = value.replace(pattern, (match, prefix) =>
      prefix && /[=:]/.test(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  if (value.length > MAX_TEXT_LENGTH) {
    value = `${value.slice(0, MAX_TEXT_LENGTH)}\n… [内容已截断，原始长度 ${value.length}]`;
  }
  return value;
}

export function redactValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen));
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redactValue(entry, seen);
  }
  return output;
}

export function safeJson(value) {
  if (value === undefined) return null;
  return JSON.stringify(redactValue(value));
}

export function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
