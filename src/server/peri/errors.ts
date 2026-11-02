import {
  ChatActionError,
  ChatActionValidationError,
  ChatBusyError,
  ChatClosedError,
  ChatNotReadyError,
  PayloadReadError,
  SessionBindingConflictError,
  SessionCreationError,
  SessionWorkspaceMismatchError,
  type ChatDisposition,
} from "@peri-code/sdk";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  promptErrorDefinition,
  type PromptDisposition,
  type PromptRecovery,
} from "../../runtime/prompt-errors";
import { redactPublicMessage } from "../../runtime/redaction";

/** HTTP 边界只负责把领域错误映射为状态与稳定 code；disposition 不反推。 */
interface ChatErrorBody {
  ok: false;
  code: string;
  message: string;
  disposition: ChatDisposition;
  recovery?: PromptRecovery;
  uncertain?: boolean;
  requestId?: string;
  chatId?: string;
  createdSessionId?: string;
  stage?: string;
}

interface ChatErrorContext {
  chatId?: string;
  requestId?: string;
}

interface MappedError {
  status: ContentfulStatusCode;
  body: ChatErrorBody;
}

function isDisposition(value: unknown): value is PromptDisposition {
  return value === "rejected" || value === "unknown" || value === "not_sent";
}

function isRecovery(value: unknown): value is PromptRecovery {
  return value === "none" || value === "reload" || value === "rebuild";
}

/** 敏感 key 无论值长短都整体遮蔽；字符串值再走公开脱敏。 */
const SENSITIVE_DETAIL_KEY =
  /token|secret|password|passwd|authorization|api[_-]?key|cookie|credential/i;

/**
 * 全局错误兜底的 details 白名单：只保留标量并逐值脱敏，不转发嵌套对象。
 * 导出供 app.onError 与回归测试共用。
 */
export function publicErrorDetails(details: unknown): Record<string, unknown> | undefined {
  if (details === null || typeof details !== "object" || Array.isArray(details))
    return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) {
      safe[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string") safe[key] = redactPublicMessage(value);
    else if (typeof value === "number" || typeof value === "boolean" || value === null)
      safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/**
 * RuntimeError 的 details 是 disposition/recovery 的第一权威；缺失时才用
 * 稳定 code 表补齐，绝不从 HTTP status 反推。
 */
export function runtimeErrorBody(
  error: {
    code: string;
    message: string;
    status: number;
    details?: Record<string, unknown>;
  },
  context: ChatErrorContext = {},
): MappedError {
  const definition = promptErrorDefinition(error.code);
  const details = error.details ?? {};
  const disposition: ChatDisposition = isDisposition(details.disposition)
    ? details.disposition
    : definition?.disposition ??
      (error.status >= 500 ? "unknown" : "rejected");
  const recovery = isRecovery(details.recovery)
    ? details.recovery
    : definition?.recovery;
  const uncertain =
    typeof details.uncertain === "boolean"
      ? details.uncertain
      : definition?.uncertain ?? disposition === "unknown";
  const requestId =
    typeof details.requestId === "string"
      ? details.requestId
      : context.requestId;
  return {
    status: (definition?.status ?? error.status) as ContentfulStatusCode,
    body: {
      ok: false,
      code: error.code,
      // 已知 code 只出固定中文；只有未登记的 code 才回退到脱敏后的运行时原文。
      message: definition?.message
        ?? redactPublicMessage(error.message || "请求失败；诊断已记录"),
      disposition,
      ...(recovery ? { recovery } : {}),
      ...(uncertain ? { uncertain: true } : {}),
      ...(requestId ? { requestId } : {}),
      ...(context.chatId ? { chatId: context.chatId } : {}),
    },
  };
}

function statusFor(error: ChatActionError): ContentfulStatusCode {
  if (error instanceof ChatActionValidationError) return 400;
  if (
    error instanceof ChatBusyError
    || error instanceof ChatNotReadyError
    || error instanceof SessionBindingConflictError
    || error instanceof SessionWorkspaceMismatchError
  ) return 409;
  if (error instanceof ChatClosedError) return 503;
  // session/new 已取得身份但后续失败：调用方必须先核对，不能盲目重建。
  if (error instanceof SessionCreationError) return 500;
  switch (error.code) {
    case "invalid_action": return 400;
    case "busy":
    case "binding_conflict":
    case "workspace_mismatch":
    case "not_ready": return 409;
    case "closed": return 503;
    default: return 500;
  }
}

/**
 * Action 错误映射。
 *
 * `invalid_action` → 400；busy/binding_conflict/workspace_mismatch/not_ready → 409；closed → 503；
 * 加载路径 ownership 读/写故障（`claim_failed`）、session 创建失败
 * （`session_creation_failed`，含 stage `claim`）与 unknown/internal → 500。
 * 未知错误统一 unknown，绝不声称动作未生效。
 */
export function mapChatActionError(
  error: unknown,
  context: ChatErrorContext = {},
): MappedError {
  if (error instanceof ChatActionError) {
    const requestId = error.requestId || context.requestId;
    const definition = promptErrorDefinition(error.code);
    const body: ChatErrorBody = {
      ok: false,
      code: error.code,
      message: definition?.message ?? redactPublicMessage(error.message),
      disposition: error.disposition,
      ...(definition?.recovery ? { recovery: definition.recovery } : {}),
      ...(definition?.uncertain ? { uncertain: true } : {}),
      ...(requestId ? { requestId } : {}),
      ...(context.chatId ? { chatId: context.chatId } : {}),
    };
    if (error instanceof SessionCreationError) {
      body.createdSessionId = error.createdSessionId;
      body.stage = error.stage;
    }
    return { status: statusFor(error), body };
  }
  return {
    status: 500,
    body: {
      ok: false,
      code: "internal_error",
      message: "命令执行失败；诊断已记录",
      disposition: "unknown",
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.chatId ? { chatId: context.chatId } : {}),
    },
  };
}

/** 未知 Chat：句柄已关闭或从未登记。 */
export function chatNotFound(chatId: string): MappedError {
  const definition = promptErrorDefinition("chat_not_found")!;
  return {
    status: 410,
    body: {
      ok: false,
      code: definition.code,
      message: definition.message,
      disposition: "rejected",
      recovery: definition.recovery,
      chatId,
    },
  };
}

/** 已登记但 cleanup/activation 未确认：不是 chat_not_found，也不能当作 410。 */
export function runtimeUnavailable(chatId: string): MappedError {
  const definition = promptErrorDefinition("runtime_unavailable")!;
  return {
    status: 503,
    body: {
      ok: false,
      code: definition.code,
      message: definition.message,
      disposition: "unknown",
      recovery: definition.recovery,
      uncertain: true,
      chatId,
    },
  };
}

/** 原因链有界展开；不序列化任意对象，避免把请求/凭据带进响应。 */
function describeFailure(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const cause = depth < 3 && error.cause !== undefined
    ? ` <- ${describeFailure(error.cause, depth + 1)}`
    : "";
  return `${error.name}: ${error.message}${cause}`;
}

interface CloseIncompleteBody {
  ok: false;
  code: "close_incomplete";
  message: string;
  disposition: "unknown";
  recovery: "rebuild";
  incomplete: true;
  errors: string[];
  chatId?: string;
}

/** close 未确认：不是“已停止”的证明，保留资源与原因供重试。 */
export function closeIncomplete(
  error: Error & { failures?: readonly unknown[] },
  chatId: string,
): { status: 503; body: CloseIncompleteBody } {
  const definition = promptErrorDefinition("close_incomplete")!;
  return {
    status: 503,
    body: {
      ok: false,
      code: "close_incomplete",
      message: definition.message,
      disposition: "unknown",
      recovery: "rebuild",
      incomplete: true,
      errors: (error.failures ?? []).map((failure) =>
        redactPublicMessage(describeFailure(failure)),
      ),
      chatId,
    },
  };
}

const PAYLOAD_STATUS: Record<PayloadReadError["code"], ContentfulStatusCode> = {
  unauthorized: 403,
  unavailable: 404,
  too_large: 413,
  aborted: 408,
  integrity_error: 502,
  transport_error: 502,
};

export function mapPayloadError(error: unknown): {
  status: ContentfulStatusCode;
  body: { ok: false; code: string; message: string };
} {
  if (error instanceof PayloadReadError) {
    return {
      status: PAYLOAD_STATUS[error.code],
      body: {
        ok: false,
        code: error.code,
        message: redactPublicMessage(error.message),
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      code: "internal_error",
      message: "载荷读取失败；诊断已记录",
    },
  };
}
