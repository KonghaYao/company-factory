/**
 * `session/prompt` 与 legacy input-queue 错误的唯一分类表。
 *
 * 分类只读取稳定的 code / message / data.kind，不把上游 message 交给调用方。
 * 所有出网文案都是固定中文；上游原文只作为 cause 留在内存，不序列化。
 */

export type PromptDisposition = "rejected" | "unknown" | "not_sent";
export type PromptRecovery = "none" | "reload" | "rebuild";

export interface ClassifiedPromptError {
  code: string;
  status: number;
  disposition: PromptDisposition;
  recovery: PromptRecovery;
  message: string;
  /** unknown disposition 的显式标记，便于 HTTP 与 UI 不靠状态反推。 */
  uncertain: boolean;
}

export interface PromptFailureRecord {
  requestId?: string;
  code: string;
  message: string;
  disposition: PromptDisposition;
  recovery: PromptRecovery;
  at: string;
}

type Definition = Omit<ClassifiedPromptError, "uncertain"> & {
  uncertain?: boolean;
};

/**
 * code → HTTP/disposition/recovery/文案。既有 legacy queue code 保留，
 * 供旧路径与诊断使用；prompt 路径不会主动产生这些 code。
 */
const DEFINITIONS: Record<string, Definition> = {
  stale_session: {
    code: "stale_session",
    status: 409,
    disposition: "rejected",
    recovery: "reload",
    message: "会话绑定已过期，请刷新会话后重试。",
  },
  invalid_prompt: {
    code: "invalid_prompt",
    status: 400,
    disposition: "rejected",
    recovery: "none",
    message: "消息内容无效，未发送。",
  },
  session_closed: {
    code: "session_closed",
    status: 410,
    disposition: "rejected",
    recovery: "rebuild",
    message: "会话已关闭，需要重建运行时。",
  },
  session_closing: {
    code: "session_closing",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "会话正在关闭，请稍后重试。",
  },
  runtime_unavailable: {
    code: "runtime_unavailable",
    status: 503,
    disposition: "rejected",
    recovery: "rebuild",
    message: "会话运行时不可用，需要重建后重试。",
  },
  session_busy: {
    code: "session_busy",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "会话正忙，请等待当前任务结束后重试。",
  },
  persistence_pending: {
    code: "persistence_pending",
    status: 503,
    disposition: "unknown",
    recovery: "rebuild",
    message: "会话持久化尚未结算；需要重建运行时，且不能自动重试。",
    uncertain: true,
  },
  persistence_inconsistent: {
    code: "persistence_inconsistent",
    status: 503,
    disposition: "unknown",
    recovery: "rebuild",
    message: "会话持久化状态不一致；需要重建运行时，且不能自动重试。",
    uncertain: true,
  },
  execution_failed: {
    code: "execution_failed",
    status: 502,
    disposition: "unknown",
    recovery: "none",
    message: "模型执行失败；本轮结果不确定，请核对会话状态。",
    uncertain: true,
  },
  session_restore_failed: {
    code: "session_restore_failed",
    status: 500,
    disposition: "rejected",
    recovery: "reload",
    message: "会话历史恢复失败，请重新加载。",
  },
  prompt_superseded: {
    code: "prompt_superseded",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "该输入已被更新的操作取代，未执行。",
  },
  prompt_not_admitted: {
    code: "prompt_not_admitted",
    status: 503,
    disposition: "not_sent",
    recovery: "none",
    message: "输入未被受理，请稍后重试。",
  },
  // 内部 admission receipt 容量耗尽：输入确定未发送，可安全重试，不能按未知结果阻断。
  input_receipt_capacity: {
    code: "input_receipt_capacity",
    status: 503,
    disposition: "not_sent",
    recovery: "none",
    message: "待确认的输入占用已满，消息未发送；请稍后重试。",
  },
  prompt_failed: {
    code: "prompt_failed",
    status: 500,
    disposition: "unknown",
    recovery: "reload",
    message: "消息执行失败；结果不确定，请刷新会话核对。",
    uncertain: true,
  },
  // Peri 在进入 ReAct 循环前构建 stage 失败：用户 prompt 尚未写入，确定未发送。
  session_initialization_failed: {
    code: "session_initialization_failed",
    status: 503,
    disposition: "not_sent",
    recovery: "none",
    message: "会话初始化失败，消息未发送；请稍后重试。",
  },
  not_ready: {
    code: "not_ready",
    status: 409,
    disposition: "not_sent",
    recovery: "none",
    message: "Agent 会话尚未就绪，消息未发送。",
  },
  // HTTP/Action 边界也会出现的稳定 code：同样只出固定中文，避免英文原文越过 API。
  chat_not_found: {
    code: "chat_not_found",
    status: 410,
    disposition: "rejected",
    recovery: "reload",
    message: "会话不存在，请重新加载会话。",
  },
  busy: {
    code: "busy",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "会话正在运行，停止后才能重启。",
  },
  closed: {
    code: "closed",
    status: 503,
    disposition: "rejected",
    recovery: "rebuild",
    message: "会话已关闭，需要重建运行时。",
  },
  invalid_action: {
    code: "invalid_action",
    status: 400,
    disposition: "rejected",
    recovery: "none",
    message: "动作格式不合法，命令未发送。",
  },
  binding_conflict: {
    code: "binding_conflict",
    status: 409,
    disposition: "rejected",
    recovery: "reload",
    message: "会话绑定已过期，请重新加载会话后再继续。",
  },
  workspace_mismatch: {
    code: "workspace_mismatch",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "会话工作区与当前 Agent 不一致，请检查配置。",
  },
  model_not_configured: {
    code: "model_not_configured",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "模型未配置，消息未发送。请先在设置中完成模型配置。",
  },
  idempotency_conflict: {
    code: "idempotency_conflict",
    status: 409,
    disposition: "not_sent",
    recovery: "none",
    message: "输入标识与既有请求冲突，未发送。",
  },
  missing_session: {
    code: "missing_session",
    status: 500,
    disposition: "rejected",
    recovery: "none",
    message: "会话缺少固定绑定，无法重启；请检查 Agent 配置。",
  },
  close_incomplete: {
    code: "close_incomplete",
    status: 503,
    disposition: "unknown",
    recovery: "rebuild",
    message: "会话关闭未完成，请重启会话；不要重发。",
    uncertain: true,
  },
  wasm_cleanup_unconfirmed: {
    code: "wasm_cleanup_unconfirmed",
    status: 503,
    disposition: "unknown",
    recovery: "rebuild",
    message: "会话运行时清理未确认，请重启会话；不要重发。",
    uncertain: true,
  },
  // 宿主存储解析/绑定失败：消息未发送，用户无法在会话内修复，交由宿主配置处理。
  wasm_store_scope_invalid: {
    code: "wasm_store_scope_invalid",
    status: 500,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储 scope 无效，消息未发送；请检查 Agent 配置。",
  },
  wasm_store_not_configured: {
    code: "wasm_store_not_configured",
    status: 503,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储未配置，消息未发送；请检查宿主存储配置。",
  },
  wasm_store_invalid_url: {
    code: "wasm_store_invalid_url",
    status: 503,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储端点无效，消息未发送；请检查宿主存储配置。",
  },
  wasm_store_config_exposed: {
    code: "wasm_store_config_exposed",
    status: 503,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储配置位于 Agent 可见目录，消息未发送；请由宿主移出。",
  },
  wasm_store_config_permissions: {
    code: "wasm_store_config_permissions",
    status: 503,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储配置权限不安全，消息未发送；请由宿主设为 0600。",
  },
  wasm_store_config_invalid: {
    code: "wasm_store_config_invalid",
    status: 503,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储配置无效，消息未发送；请检查宿主存储配置。",
  },
  wasm_store_config_close_failed: {
    code: "wasm_store_config_close_failed",
    status: 503,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储配置读取未完成，消息未发送；请检查宿主存储配置。",
  },
  wasm_store_conflict: {
    code: "wasm_store_conflict",
    status: 503,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储配置存在重复 scope，消息未发送；请检查宿主存储配置。",
  },
  wasm_store_provider_failed: {
    code: "wasm_store_provider_failed",
    status: 503,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储无法解析，消息未发送；请检查宿主存储配置。",
  },
  wasm_store_binding_invalid: {
    code: "wasm_store_binding_invalid",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储绑定无效，消息未发送；请重新创建会话。",
  },
  legacy_session_backend: {
    code: "legacy_session_backend",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "该 Agent 仍使用旧版会话存储，消息未发送；请重新创建会话。",
  },
  wasm_store_binding_missing: {
    code: "wasm_store_binding_missing",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "会话缺少可信存储绑定，消息未发送；请重新创建会话。",
  },
  wasm_session_creation_unconfirmed: {
    code: "wasm_session_creation_unconfirmed",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "上次会话创建未确认，未再次新建；请人工核验存储。",
  },
  wasm_session_binding_mismatch: {
    code: "wasm_session_binding_mismatch",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "会话绑定与当前存储不一致，消息未发送。",
  },
  wasm_store_backend_changed: {
    code: "wasm_store_backend_changed",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储端点已变更，消息未发送；请恢复原端点或重新创建会话。",
  },
  wasm_store_unavailable: {
    code: "wasm_store_unavailable",
    status: 503,
    disposition: "rejected",
    recovery: "none",
    message: "会话存储暂不可用，消息未发送；请检查宿主存储服务。",
  },
  wasm_session_cwd_mismatch: {
    code: "wasm_session_cwd_mismatch",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "会话工作目录与当前 Agent 不一致，消息未发送。",
  },
  // SDK ChatActionError 的其余稳定 code：旧队列/历史/取消路径仍可能返回。
  session_creation_failed: {
    code: "session_creation_failed",
    status: 500,
    disposition: "unknown",
    recovery: "reload",
    message: "会话创建失败；结果不确定，请重新加载会话核对。",
    uncertain: true,
  },
  binding_failed: {
    code: "binding_failed",
    status: 500,
    disposition: "rejected",
    recovery: "reload",
    message: "会话绑定失败，请重新加载会话。",
  },
  binding_cleanup_failed: {
    code: "binding_cleanup_failed",
    status: 500,
    disposition: "unknown",
    recovery: "rebuild",
    message: "会话绑定清理未完成，请重启会话；不要重发。",
    uncertain: true,
  },
  session_lookup_failed: {
    code: "session_lookup_failed",
    status: 500,
    disposition: "rejected",
    recovery: "reload",
    message: "会话查找失败，请重新加载会话。",
  },
  history_failed: {
    code: "history_failed",
    status: 500,
    disposition: "rejected",
    recovery: "reload",
    message: "历史记录读取失败；诊断已记录。",
  },
  cancel_failed: {
    code: "cancel_failed",
    status: 500,
    disposition: "unknown",
    recovery: "none",
    message: "停止请求未确认；不要重复发送。",
    uncertain: true,
  },
  tool_failed: {
    code: "tool_failed",
    status: 500,
    disposition: "rejected",
    recovery: "none",
    message: "工具执行失败；诊断已记录。",
  },
  agent_execution_failed: {
    code: "agent_execution_failed",
    status: 500,
    disposition: "unknown",
    recovery: "none",
    message: "本轮执行失败；结果不确定，不会自动重发。",
    uncertain: true,
  },
  claim_failed: {
    code: "claim_failed",
    status: 500,
    disposition: "rejected",
    recovery: "reload",
    message: "会话所有权读取失败，请重新加载会话。",
  },
  // Legacy input queue：保留供旧路径/诊断，用户入口不再使用。
  queue_stale: {
    code: "queue_stale",
    status: 409,
    disposition: "rejected",
    recovery: "reload",
    message: "输入队列已过期，请刷新会话后重试。",
  },
  queue_closed: {
    code: "queue_closed",
    status: 503,
    disposition: "rejected",
    recovery: "rebuild",
    message: "输入队列已关闭，需要重建运行时。",
  },
  queue_full: {
    code: "queue_full",
    status: 429,
    disposition: "rejected",
    recovery: "none",
    message: "输入队列已满，请稍后重试。",
  },
  queue_identity_conflict: {
    code: "queue_identity_conflict",
    status: 409,
    disposition: "rejected",
    recovery: "none",
    message: "输入标识与既有请求冲突，未发送。",
  },
  queue_unavailable: {
    code: "queue_unavailable",
    status: 409,
    disposition: "rejected",
    recovery: "rebuild",
    message: "输入队列不可用，需要重建运行时。",
  },
};

export const PROMPT_ERROR_CODES = Object.freeze(Object.keys(DEFINITIONS));

function materialize(definition: Definition): ClassifiedPromptError {
  return {
    code: definition.code,
    status: definition.status,
    disposition: definition.disposition,
    recovery: definition.recovery,
    message: definition.message,
    uncertain: definition.uncertain ?? definition.disposition === "unknown",
  };
}

/** 已知 code 的固定映射；未知 code 返回 null，调用方再按消息分类。 */
export function promptErrorDefinition(
  code: unknown,
): ClassifiedPromptError | null {
  return typeof code === "string" && DEFINITIONS[code]
    ? materialize(DEFINITIONS[code])
    : null;
}

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

/** 支持 RpcError、RuntimeError、普通 JSON-RPC error envelope。 */
function errorEnvelope(error: unknown) {
  const root = record(error) ?? {};
  const nested = record(root.error);
  return {
    code: root.code ?? nested?.code,
    message:
      typeof root.message === "string"
        ? root.message
        : typeof nested?.message === "string"
          ? nested.message
          : "",
    data: root.data ?? nested?.data,
  };
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

const PERSISTENCE_WORDS = [
  "persistence",
  "persist",
  "reload the session",
  "outcome unconfirmed",
  "outcome is unknown",
  "not settled",
];

function hasPersistenceWord(message: string): boolean {
  return PERSISTENCE_WORDS.some((word) => message.includes(word));
}

function kindOf(data: unknown): string | null {
  const value = record(data)?.kind;
  return typeof value === "string" ? value : null;
}

/**
 * 把 `session/prompt` 的传输/执行错误归一为 HTTP 语义与恢复建议。
 *
 * 判定顺序是有意的：先处理带 queue snapshot 的 -32602，再处理明确的
 * session 生命周期文案；持久化文案优先于通用 internal，避免把“不可自动
 * 重发”的不确定状态误报成普通执行失败。
 */
export function classifyPromptError(error: unknown): ClassifiedPromptError {
  const { code, message, data } = errorEnvelope(error);
  const text = compact(message);

  // RuntimeError / ModeTransport 已经携带稳定字符串 code。
  if (typeof code === "string") {
    const known = promptErrorDefinition(code);
    if (known) return known;
  }

  if (code === -32602) {
    const rejected = record(data)?.rejected === true;
    const snapshot = record(record(data)?.snapshot);
    if (rejected || snapshot) return materialize(DEFINITIONS.stale_session);
  }

  if (text.includes("session not found"))
    return materialize(DEFINITIONS.session_closed);

  if (text.includes("session is closing"))
    return materialize(DEFINITIONS.session_closing);

  if (text.includes("session runtime is no longer active"))
    return materialize(DEFINITIONS.runtime_unavailable);

  if (text.includes("session context is owned by an in-flight prompt"))
    return materialize(DEFINITIONS.session_busy);

  // stage 初始化在执行前失败；即使文案里混入 persistence 字样，也确定未发送。
  if (code === -32000 && text.includes("agent stage initialization failed"))
    return materialize(DEFINITIONS.session_initialization_failed);

  if (text.includes("session persistence is not settled"))
    return materialize(DEFINITIONS.persistence_pending);

  if (code === -32000) {
    const kind = kindOf(data);
    if (
      (kind === "internal" || kind === null) &&
      hasPersistenceWord(text)
    )
      return materialize(DEFINITIONS.persistence_inconsistent);
    if (kind === "llm" || kind === "llm_http")
      return materialize(DEFINITIONS.execution_failed);
  }

  if (code === -32603 && text.includes("session history load failed"))
    return materialize(DEFINITIONS.session_restore_failed);

  if (code === -32800 && text.includes("user input attempt superseded"))
    return materialize(DEFINITIONS.prompt_superseded);

  if (code === -32800 && text.includes("request cancelled"))
    return materialize(DEFINITIONS.prompt_not_admitted);

  if (code === -32602) return materialize(DEFINITIONS.invalid_prompt);

  // Legacy queue 的稳定文案；显式 code 已在上面优先命中。
  if (/queue.*(generation|stale).*(changed|expired)?/.test(text))
    return materialize(DEFINITIONS.queue_stale);
  if (/user input queue is closed|input queue is closed/.test(text))
    return materialize(DEFINITIONS.queue_closed);
  if (/queue.*(full|capacity)|no capacity/.test(text))
    return materialize(DEFINITIONS.queue_full);
  if (/queue.*identity|belongs to another input/.test(text))
    return materialize(DEFINITIONS.queue_identity_conflict);
  if (/input queue (is )?unavailable/.test(text))
    return materialize(DEFINITIONS.queue_unavailable);

  return materialize(DEFINITIONS.prompt_failed);
}

/**
 * `peri/agent_event` 的 `agent_execution_failed` 没有 RPC code。
 *
 * 只按文案判断：持久化相关一律按更严格的不确定状态处理；其余归为
 * execution_failed。真正的 persistence 文案必须优先于通用 RPC 失败。
 */
export function classifyAgentExecutionFailure(
  message: string,
): ClassifiedPromptError {
  const text = compact(message ?? "");
  // stage 初始化没有进入执行；后到的 notice 不得把它改写成“结果不确定”。
  if (text.includes("agent stage initialization failed"))
    return materialize(DEFINITIONS.session_initialization_failed);
  if (text.includes("session persistence is not settled"))
    return materialize(DEFINITIONS.persistence_pending);
  if (hasPersistenceWord(text))
    return materialize(DEFINITIONS.persistence_inconsistent);
  return materialize(DEFINITIONS.execution_failed);
}

/** 持久化失败具有最高优先级，不能被后来的通用 RPC/notice 文案覆盖。 */
export function isPersistencePromptError(code: string): boolean {
  return code === "persistence_pending" || code === "persistence_inconsistent";
}

/** 已知的 admission 拒绝；后到的执行 notice 不得把它们改写成执行失败。 */
export function isAdmissionPromptError(code: string): boolean {
  return [
    "stale_session",
    "invalid_prompt",
    "session_closed",
    "session_closing",
    "runtime_unavailable",
    "session_busy",
    "session_restore_failed",
    "prompt_superseded",
    "prompt_not_admitted",
    "input_receipt_capacity",
    "not_ready",
    "session_initialization_failed",
  ].includes(code);
}
