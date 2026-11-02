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
