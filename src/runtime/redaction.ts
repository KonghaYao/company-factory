/**
 * Free-text redaction shared by runtime diagnostics and public error mapping.
 *
 * Only messages explicitly designated as free text pass through here. Structured
 * identifiers (session/chat IDs) are allowed as-is; applying the 32+ token rule to
 * them would destroy 36-character UUIDs.
 */
export function redactRuntimeMessage(message: string, limit = 240): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const redacted = compact
    // Any scheme://... (http, https, libsql, postgres, ws, ...), including DSNs.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi, "[url]")
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|token|access[_-]?token|api[_-]?key|apikey|secret|password|passwd|credential)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

/**
 * HTTP 出网专用：在诊断脱敏之上再遮蔽 20+ 位、至少含一个数字的 token 片段，
 * 覆盖未带 `token=`/`Authorization:` 前缀的短凭据。诊断日志不使用本函数，
 * 以免把可关联的 UUID/requestId 一起抹掉。
 */
export function redactPublicMessage(message: string, limit = 240): string {
  return redactRuntimeMessage(message, limit).replace(
    /\b(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g,
    "[redacted]",
  );
}
