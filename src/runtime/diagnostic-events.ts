import { redactRuntimeMessage } from "./redaction";

/** The only events the diagnostics sink accepts. */
export const DIAGNOSTIC_EVENTS = [
  "process_start",
  "agent_execution_failed",
  "wasm_stderr",
  "chat_action_failed",
  "im_delivery_failed",
] as const;

export type DiagnosticEventName = (typeof DIAGNOSTIC_EVENTS)[number];

/** Structured failure events accepted by the sink. Fields stay scalar by design. */
export type DiagnosticFailureEvent =
  | {
      event: "agent_execution_failed";
      companyId?: string;
      agentId?: string;
      sessionId?: string;
      chatId?: string;
      bindingRevision?: number;
      eventId?: string | null;
      turnId?: string;
      stopReason?: string;
      message: string;
    }
  | {
      event: "wasm_stderr";
      companyId?: string;
      agentId?: string;
      pattern: string;
      text: string;
      truncated?: boolean;
    }
  | {
      event: "chat_action_failed";
      companyId?: string;
      agentId?: string;
      chatId?: string;
      op?: string;
      requestId?: string;
      code?: string | number;
      errorName?: string;
      message?: string;
      rejected?: boolean;
      generation?: string;
      revision?: number;
      snapshotSessionId?: string;
      itemCount?: number;
      activeRequestId?: string;
    }
  | {
      event: "im_delivery_failed";
      companyId?: string;
      agentId?: string;
      messageId?: string;
      threadId?: string;
      attempt?: number;
      code?: string | number;
      disposition?: "rejected" | "not_sent" | "unknown";
      uncertain?: boolean;
      message?: string;
    };

export type DiagnosticEvent = DiagnosticFailureEvent;

export interface AgentExecutionFailure {
  message: string;
  eventId: string | null;
  turnId?: string;
  stopReason?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Extract the upstream failure message from a Peri `notice` fact.
 *
 * Only `value.message` and a small set of correlation identifiers are read.
 * The raw `event_json`, `value` object and every other field are never returned.
 */
export function agentExecutionFailureFromNotice(
  fact: unknown,
): AgentExecutionFailure | null {
  const envelope = record(fact);
  if (!envelope || envelope.kind !== "notice") return null;
  const notification = record(envelope.notification);
  if (!notification || notification.method !== "peri/agent_event") return null;
  const params = record(notification.params);
  if (!params) return null;

  let event: Record<string, unknown> | null = null;
  const raw = params.event_json;
  if (typeof raw === "string") {
    try {
      event = record(JSON.parse(raw));
    } catch {
      return null;
    }
  } else if (record(raw)) {
    event = record(raw);
  }
  if (!event || event.type !== "agent_execution_failed") return null;

  const value = record(event.value);
  const message = nonEmptyString(value?.message);
  if (!message) return null;

  const meta = record(params._meta);
  const periMeta = record(meta?.peri);
  const eventId = nonEmptyString(periMeta?.eventId);

  const turnId = nonEmptyString(value?.turn_id) ?? nonEmptyString(value?.turnId);
  const stopReason =
    nonEmptyString(value?.stop_reason) ?? nonEmptyString(value?.stopReason);

  return {
    message,
    eventId,
    ...(turnId ? { turnId } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

export interface WasmDiagnosticLine {
  pattern: string;
  text: string;
  truncated: boolean;
}

const WASM_LINE_LIMIT = 8 * 1024;
const WASM_TEXT_LIMIT = 500;

/**
 * Allowlisted native stderr lines. Patterns are ordered from most specific to
 * most general; each match produces a stable, distinguishable label.
 */
const WASM_PATTERNS: Array<{
  test: RegExp;
  label: (match: RegExpMatchArray) => string;
}> = [
  {
    test: /append_history failed/i,
    label: () => "append_history_failed",
  },
  {
    test: /transcript persist entered terminal failure/i,
    label: () => "transcript_persist_terminal",
  },
  {
    test: /\[v2\] phase 8 transcript flush failed/i,
    label: () => "v2_phase8_flush_failed",
  },
  {
    test: /\[v2\] execution failed/i,
    label: () => "v2_execution_failed",
  },
  {
    test: /conversation persistence failed/i,
    label: () => "conversation_persistence_failed",
  },
  {
    test: /LLM generate_reasoning/i,
    label: () => "llm_generate_reasoning",
  },
  {
    test: /dispatch_tools: returning MiddlewareError/i,
    label: () => "dispatch_tools_middleware_error",
  },
  {
    test: /LLM HTTP (\d{3})/i,
    label: (match) => `llm_http_${match[1]}`,
  },
  {
    test: /LLM error/i,
    label: () => "llm_error",
  },
  {
    test: /middleware error/i,
    label: () => "middleware_error",
  },
];

/** Normalize one native line; returns null unless the line is allowlisted. */
export function wasmDiagnosticLine(line: string): WasmDiagnosticLine | null {
  const withoutAnsi = String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const compact = withoutAnsi.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  const truncated = compact.length > WASM_LINE_LIMIT;
  const bounded = truncated ? compact.slice(0, WASM_LINE_LIMIT) : compact;
  for (const rule of WASM_PATTERNS) {
    const match = bounded.match(rule.test);
    if (!match) continue;
    return {
      pattern: rule.label(match),
      text: redactRuntimeMessage(bounded, WASM_TEXT_LIMIT),
      truncated,
    };
  }
  return null;
}

export interface RpcErrorMetadata {
  code?: string | number;
  message?: string;
  errorName?: string;
  rejected?: boolean;
  generation?: string;
  revision?: number;
  snapshotSessionId?: string;
  itemCount?: number;
  activeRequestId?: string;
}

interface CandidateMetadata extends RpcErrorMetadata {
  hasData: boolean;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function candidateMetadata(value: unknown): CandidateMetadata | null {
  const error = record(value);
  if (!error) return null;

  const metadata: CandidateMetadata = { hasData: false };
  if (typeof error.code === "string" || typeof error.code === "number")
    metadata.code = error.code;
  if (typeof error.message === "string") metadata.message = error.message;
  if (typeof error.name === "string") metadata.errorName = error.name;

  const data = record(error.data);
  let found = false;
  if (data) {
    if (typeof data.rejected === "boolean") {
      metadata.rejected = data.rejected;
      found = true;
    }
    const snapshot = record(data.snapshot);
    if (snapshot) {
      found = true;
      if (typeof snapshot.generation === "string")
        metadata.generation = snapshot.generation;
      const revision = finiteNumber(snapshot.revision);
      if (revision !== undefined) metadata.revision = revision;
      if (typeof snapshot.sessionId === "string")
        metadata.snapshotSessionId = snapshot.sessionId;
      if (Array.isArray(snapshot.items)) {
        // Length only: item content, arguments and tool output are never read.
        metadata.itemCount = snapshot.items.length;
      }
      if (typeof snapshot.activeRequestId === "string")
        metadata.activeRequestId = snapshot.activeRequestId;
    }
    metadata.hasData = found;
  }

  if (!found && metadata.code === undefined && metadata.message === undefined)
    return null;
  return metadata;
}

/**
 * Walk the bounded cause chain (root plus at most three hops) and prefer the
 * first candidate that carries `data`/`snapshot` metadata.
 */
export function extractRpcErrorMetadata(
  error: unknown,
): RpcErrorMetadata | null {
  let fallback: CandidateMetadata | null = null;
  let current: unknown = error;
  // Root plus up to three cause hops (mirrors the bounded chain used by the
  // existing error mapper) while never serializing anything from the chain.
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const candidate = candidateMetadata(current);
    if (candidate) {
      if (candidate.hasData) {
        const { hasData: _ignored, ...metadata } = candidate;
        return metadata;
      }
      fallback ??= candidate;
    }
    current = (current as { cause?: unknown }).cause;
  }
  if (!fallback) return null;
  const { hasData: _ignored, ...metadata } = fallback;
  return metadata;
}

/** Fields the read endpoint is allowed to expose, per event. */
const READ_FIELDS: Record<DiagnosticEventName, readonly string[]> = {
  process_start: [
    "app",
    "pid",
    "ppid",
    "bootId",
    "startedAt",
    "platform",
    "arch",
    "bunVersion",
    "diagnosticsVersion",
    "retention",
  ],
  agent_execution_failed: [
    "bootId",
    "companyId",
    "agentId",
    "sessionId",
    "chatId",
    "bindingRevision",
    "eventId",
    "turnId",
    "stopReason",
    "message",
  ],
  wasm_stderr: ["bootId", "companyId", "agentId", "pattern", "text", "truncated"],
  chat_action_failed: [
    "bootId",
    "companyId",
    "agentId",
    "chatId",
    "op",
    "requestId",
    "code",
    "errorName",
    "message",
    "rejected",
    "generation",
    "revision",
    "snapshotSessionId",
    "itemCount",
    "activeRequestId",
  ],
  im_delivery_failed: [
    "bootId",
    "companyId",
    "agentId",
    "messageId",
    "threadId",
    "attempt",
    "code",
    "disposition",
    "uncertain",
    "message",
  ],
};

const READ_STRING_LIMIT = 200;

function sanitizeScalar(value: unknown, field: string): unknown {
  if (typeof value === "string") {
    return field === "message" || field === "text"
      ? redactRuntimeMessage(value, 500)
      : value.slice(0, READ_STRING_LIMIT);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  return undefined;
}

/**
 * Re-sanitize one parsed JSONL line for the owner-only read endpoint.
 * Unknown events, unknown fields and non-scalar payloads are dropped.
 */
export function sanitizeReadEntry(
  value: unknown,
): Record<string, unknown> | null {
  const entry = record(value);
  if (!entry) return null;
  const event = entry.msg;
  if (
    typeof event !== "string" ||
    !(DIAGNOSTIC_EVENTS as readonly string[]).includes(event)
  )
    return null;

  const allowed = READ_FIELDS[event as DiagnosticEventName];
  const out: Record<string, unknown> = { event };
  if (typeof entry.time === "string") out.time = entry.time;
  if (typeof entry.level === "number" && Number.isFinite(entry.level))
    out.level = entry.level;

  for (const field of allowed) {
    const raw = entry[field];
    if (field === "retention") {
      const retention = record(raw);
      if (!retention) continue;
      const maxBytesPerFile = finiteNumber(retention.maxBytesPerFile);
      const maxFiles = finiteNumber(retention.maxFiles);
      if (maxBytesPerFile === undefined || maxFiles === undefined) continue;
      out.retention = { maxBytesPerFile, maxFiles };
      continue;
    }
    const scalar = sanitizeScalar(raw, field);
    if (scalar !== undefined) out[field] = scalar;
  }
  return out;
}
