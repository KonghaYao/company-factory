import type { ChatReplicaStatus } from "@peri-code/sdk/view";
import { RemoteActionError, parseActionTarget, type RemoteDisposition } from "./actions";
import type { ActionTargetDTO, Chat } from "./contracts";
import type { ChatDisplayState } from "./display-state";
import type { SyncConnectionStatus } from "./sync";

/**
 * 视图状态派生：把控制器内部事实（副本就绪度、连接状态、取消意图、动作错误）
 * 映射为 `ChatView` 字段。
 *
 * 全部是无副作用的纯函数：输入显式、不读类实例、不构造 `ChatDisplayState`
 * （DTO 物化只由 `display-state` 负责），便于单独覆盖边界。
 */

/** 页面阶段；`streaming`/`cancelling` 由副本运行事实驱动，不由列表推断。 */
export type Phase = "idle" | "loading" | "streaming" | "cancelling" | "syncing" | "blocked";

/** 读面状态：`unsupported` 与「空历史」明确区分。 */
export type ChatLoadState = "idle" | "loading" | "ready" | "failed" | "unsupported";

export type SyncStatus = "connecting" | "synced" | "failed";

/** 恢复入口：错误文案必须有可执行动作，不能让用户停留在无法解释的阻断态。 */
export type ChatRecovery = "none" | "reload" | "rebuild";

/** 发送结果：prompt 的 202 即受理；旧 queue 的送达由副本队列/用户条目结算。 */
export type ChatSendOutcome =
  | { delivered: true; sessionId: string }
  | {
    delivered: false;
    sessionId: string | null;
    message: string;
    /** 只有 rejected/not_sent 且未被阻断时允许直接重试；unknown 永不重试。 */
    disposition?: "rejected" | "unknown" | "not_sent";
    /** 失败后输入区是否需要保持阻断（仅当存在 reload/rebuild 恢复入口）。 */
    blocked?: boolean;
  };

/** 控制器发布的只读视图；UI 只消费，不直接修改。 */
export interface ChatView {
  selected: Chat | null;
  state: ChatDisplayState | null;
  phase: Phase;
  historyReady: boolean;
  loadState: ChatLoadState;
  liveSync: SyncStatus;
  error: string;
  /** 当前错误对应的恢复动作；`none` 表示只能等待或 dismiss。 */
  recovery: ChatRecovery;
}

/** 不受支持的数据版本：只在读面事实为 `unsupported` 时出现。 */
const UNSUPPORTED = "会话使用了不受支持的数据版本，请刷新页面或升级应用后再继续。";

/** 错误归一：宿主字符串、Error 与任意抛出值用同一条规则取文案。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LiveSyncInput {
  /** 副本状态；没有活跃副本时为 undefined。 */
  projectionStatus?: ChatReplicaStatus;
  syncStatus?: SyncConnectionStatus;
}

/** 读面同步状态：副本已同步才算 `synced`；副本或连接任一失败都算 `failed`。 */
export function deriveLiveSync(input: LiveSyncInput): SyncStatus {
  if (input.projectionStatus === "synced") return "synced";
  if (input.projectionStatus === "failed" || input.syncStatus === "failed") return "failed";
  return "connecting";
}

export interface LoadStateInput {
  hasActive: boolean;
  hasSelection: boolean;
  /** 副本就绪度；没有活跃副本时为 null。 */
  readiness: ChatDisplayState["readiness"] | null;
  /** 本连接是否曾经就绪；用于断线后仍保留可读历史。 */
  everReady: boolean;
  /** 上一次发布的读面状态；`unsupported` 一旦确认不会被断线降级。 */
  previous: ChatLoadState;
  liveSync: SyncStatus;
  connectionError: string;
}

/** 读面状态：先看副本就绪度，再看断线/连接错误，最后落到加载中。 */
export function deriveLoadState(input: LoadStateInput): ChatLoadState {
  if (!input.hasActive) return input.hasSelection ? "loading" : "idle";
  if (input.readiness === "ready") return "ready";
  if (input.readiness === "unsupported") return "unsupported";
  if (input.everReady) return input.previous === "unsupported" ? "unsupported" : "ready";
  return input.liveSync === "failed" || input.connectionError ? "failed" : "loading";
}

export interface PhaseInput {
  hasActive: boolean;
  loadState: ChatLoadState;
  /** 动作结果未知：只记录事实，不单独阻断输入。 */
  uncertain: boolean;
  /** 宿主执行阻断：无可见恢复动作时不阻断，由 recovery 决定。 */
  executionBlocked: boolean;
  recovery: ChatRecovery;
  running: boolean;
  cancelPending: boolean;
  historyReady: boolean;
}

/**
 * 页面阶段。阻断只跟随可见恢复动作：reload/rebuild 且读面就绪时阻断，
 * 用户能从横幅执行重新加载或重启会话；none（含结果未知、执行阻断）不阻断，
 * 用户仍可发送新消息，任何失败都不会自动重发。
 */
export function derivePhase(input: PhaseInput): Phase {
  if (!input.hasActive) return "idle";
  if (input.loadState === "loading") return "loading";
  if ((input.recovery === "reload" || input.recovery === "rebuild") && input.loadState === "ready")
    return "blocked";
  if (input.running) return input.cancelPending ? "cancelling" : "streaming";
  if (!input.historyReady && input.loadState !== "failed" && input.loadState !== "unsupported") return "syncing";
  return "idle";
}

/** 取消意图只对发起时的 running turn 有效。 */
export interface CancelIntent {
  requested: boolean;
  /** 发起取消时的 turnId；null 表示没有可归属的轮次。 */
  turnId: string | null;
}

/** `running=false` 或 active turn 已换代即失效，避免停止后输入被永久拦住。 */
export function isCancelPending(intent: CancelIntent, state: ChatDisplayState | null): boolean {
  if (!intent.requested) return false;
  if (!state?.running) return false;
  if (intent.turnId !== null && state.activeTurn.turnId !== null
    && state.activeTurn.turnId !== intent.turnId) return false;
  return true;
}

/** 动作目标绑定：副本尚未绑定或代次非法时返回 null，不猜目标。 */
export function bindingTargetOf(state: ChatDisplayState | null): ActionTargetDTO | null {
  if (!state?.sessionId || state.bindingRevision === null) return null;
  try {
    return parseActionTarget({ sessionId: state.sessionId, bindingRevision: state.bindingRevision });
  } catch {
    return null;
  }
}

export interface ActionFailure {
  /** 已按 code 归一的中文文案；不透传上游 message。 */
  message: string;
  recovery: ChatRecovery;
  /** 结果为未知时需要置位；调用方只置 true，不把已确认的未知状态回退。 */
  uncertain: boolean;
  /** 是否存在可见恢复动作（reload/rebuild）；none 不阻断输入。 */
  blocked: boolean;
  code: string;
  disposition: RemoteDisposition;
}

interface FailureCopy {
  message: string;
  recovery: ChatRecovery;
  uncertain?: boolean;
}

/**
 * code → 固定中文文案与恢复动作。
 *
 * 服务端 message 只作为诊断留在 cause，不进入用户视图；这里同时是同步
 * Action 错误与异步 promptFailure 的唯一文案来源。
 */
const FAILURE_COPIES: Record<string, FailureCopy> = {
  stale_session: {
    message: "会话绑定已过期，请重新加载会话后继续。",
    recovery: "reload",
  },
  chat_not_found: {
    message: "会话不存在，请重新加载会话。",
    recovery: "reload",
  },
  session_restore_failed: {
    message: "会话历史恢复失败，请重新加载会话。",
    recovery: "reload",
  },
  prompt_failed: {
    message: "消息执行失败，结果不确定，请重新加载会话核对；不要重发。",
    recovery: "reload",
    uncertain: true,
  },
  session_closed: {
    message: "会话已关闭，请重启会话。",
    recovery: "rebuild",
  },
  runtime_unavailable: {
    message: "会话运行时不可用，请重启会话。",
    recovery: "rebuild",
  },
  persistence_pending: {
    message: "会话持久化尚未结算。重新加载无效，请重启会话；不要重发。",
    recovery: "rebuild",
    uncertain: true,
  },
  persistence_inconsistent: {
    message: "会话持久化状态不一致。重新加载无效，请重启会话；不要重发。",
    recovery: "rebuild",
    uncertain: true,
  },
  close_incomplete: {
    message: "会话关闭未完成，请重启会话；不要重发。",
    recovery: "rebuild",
    uncertain: true,
  },
  closed: {
    message: "会话已关闭，请重启会话。",
    recovery: "rebuild",
  },
  queue_closed: {
    message: "输入队列已关闭，请重启会话。",
    recovery: "rebuild",
  },
  queue_stale: {
    message: "输入队列已过期，请重新加载会话。",
    recovery: "reload",
  },
  queue_unavailable: {
    message: "输入队列不可用，请重启会话。",
    recovery: "rebuild",
  },
  session_busy: {
    message: "会话正忙，请等待当前任务结束后再试。",
    recovery: "none",
  },
  session_closing: {
    message: "会话正在关闭，请稍后再试。",
    recovery: "none",
  },
  prompt_superseded: {
    message: "该输入已被更新的操作取代，未执行。",
    recovery: "none",
  },
  invalid_prompt: {
    message: "消息内容无效，未发送。",
    recovery: "none",
  },
  idempotency_conflict: {
    message: "输入标识与既有请求冲突，未发送。",
    recovery: "none",
  },
  queue_full: {
    message: "输入队列已满，请稍后再试。",
    recovery: "none",
  },
  queue_identity_conflict: {
    message: "输入标识与既有请求冲突，未发送。",
    recovery: "none",
  },
  execution_failed: {
    message: "模型执行失败，本轮结果不确定；请核对会话状态，不要重复发送。",
    recovery: "none",
    uncertain: true,
  },
  prompt_not_admitted: {
    message: "输入未被受理，可以修正后重试。",
    recovery: "none",
  },
  input_receipt_capacity: {
    message: "待确认的输入占用已满，消息未发送；请稍后重试。",
    recovery: "none",
  },
  not_sent: {
    message: "消息未发送，可以重试。",
    recovery: "none",
  },
  not_ready: {
    message: "Agent 会话尚未就绪，消息未发送。",
    recovery: "none",
  },
  model_not_configured: {
    message: "模型未配置，消息未发送。请先在设置中完成模型配置。",
    recovery: "none",
  },
  invalid_action: {
    message: "动作格式不合法，命令未发送。",
    recovery: "none",
  },
  invalid_target: {
    message: "动作目标绑定格式不合法，命令未发送。",
    recovery: "none",
  },
  binding_conflict: {
    message: "会话绑定已过期，请重新加载会话后再继续。",
    recovery: "reload",
  },
  workspace_mismatch: {
    message: "会话工作区与当前 Agent 不一致，请检查配置。",
    recovery: "none",
  },
  missing_session: {
    message: "会话缺少固定绑定，无法重启；请检查 Agent 配置。",
    recovery: "none",
  },
  session_creation_failed: {
    message: "会话创建失败；结果不确定，请重新加载会话核对。",
    recovery: "reload",
    uncertain: true,
  },
  binding_failed: {
    message: "会话绑定失败，请重新加载会话。",
    recovery: "reload",
  },
  binding_cleanup_failed: {
    message: "会话绑定清理未完成，请重启会话；不要重发。",
    recovery: "rebuild",
    uncertain: true,
  },
  session_lookup_failed: {
    message: "会话查找失败，请重新加载会话。",
    recovery: "reload",
  },
  history_failed: {
    message: "历史记录读取失败；诊断已记录。",
    recovery: "reload",
  },
  cancel_failed: {
    message: "停止请求未确认；不要重复发送。",
    recovery: "none",
    uncertain: true,
  },
  tool_failed: {
    message: "工具执行失败；诊断已记录。",
    recovery: "none",
  },
  agent_execution_failed: {
    message: "本轮执行失败；结果不确定，不会自动重发。",
    recovery: "none",
    uncertain: true,
  },
  claim_failed: {
    message: "会话所有权读取失败，请重新加载会话。",
    recovery: "reload",
  },
  busy: {
    message: "会话正在运行，停止后才能重启。",
    recovery: "none",
  },
  wasm_cleanup_unconfirmed: {
    message: "会话运行时清理未确认，请重启会话；不要重发。",
    recovery: "rebuild",
    uncertain: true,
  },
};

const UNKNOWN_FAILURE: FailureCopy = {
  message: "操作失败，执行状态尚未确认；请重新加载会话核对，不要重复发送。",
  recovery: "none",
  uncertain: true,
};

const INTERNAL_FAILURE: FailureCopy = {
  message: "操作失败，执行状态尚未确认；请重新加载会话核对，不要重复发送。",
  recovery: "none",
  uncertain: true,
};

/** 已知 code 的固定文案；未知 code 返回 null，由调用方按未知结果处理。 */
export function failureMessageForCode(code: string): string | null {
  return FAILURE_COPIES[code]?.message ?? null;
}

/** 已知 code 的恢复动作；未知 code 返回 null。 */
export function failureRecoveryForCode(code: string): ChatRecovery | null {
  return FAILURE_COPIES[code]?.recovery ?? null;
}

/**
 * 动作失败归并：`disposition` 是唯一可重试性权威，code 决定恢复动作。
 * 未知结果只标记 uncertain，不阻断输入；只有 reload/rebuild 才提供阻断与
 * 可见恢复入口，且不提供“重试”文案。
 */
export function describeActionFailure(error: unknown): ActionFailure {
  const remote = error instanceof RemoteActionError
    ? error
    : new RemoteActionError("internal_error", "", "unknown");
  const known = FAILURE_COPIES[remote.code];
  const copy = known ?? (remote.code === "internal_error" ? INTERNAL_FAILURE : UNKNOWN_FAILURE);
  const uncertain = remote.options.uncertain === true
    || copy.uncertain === true
    || remote.disposition === "unknown"
    || known === undefined;
  // 服务端 recovery 是权威；本地表只在旧服务端缺省时补齐，避免新 code 被降级为 none。
  const recovery = remote.options.recovery ?? copy.recovery;
  return {
    message: copy.message,
    recovery,
    uncertain,
    blocked: recovery !== "none",
    code: remote.code,
    disposition: remote.disposition,
  };
}

export interface RawErrorInput {
  actionError: string;
  connectionError: string;
  loadState: ChatLoadState;
}

/** 原始错误优先级：动作错误 > 连接错误 > 不受支持的数据版本。 */
export function rawErrorOf(input: RawErrorInput): string {
  if (input.actionError) return input.actionError;
  if (input.connectionError) return input.connectionError;
  if (input.loadState === "unsupported") return UNSUPPORTED;
  return "";
}
