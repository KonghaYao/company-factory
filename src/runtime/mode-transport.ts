import type {
  JsonRpcNotification,
  ReverseRequestHandler,
  Transport,
} from "@peri-code/sdk";

/** Peri 的 ACP 模式 id：不逐次 HITL 询问敏感工具。 */
export const AGENT_MODE_ID = "bypass";

export interface ModeTransportOptions {
  modeId?: string;
  /** 诊断输出接缝；默认 console.warn。 */
  warn?: (message: string) => void;
}

/** 未建立/已关闭会话时拒绝 direct prompt；不向 queue 回退。 */
export class ModeTransportNotReadyError extends Error {
  readonly code = "not_ready";
  readonly disposition = "not_sent";

  constructor() {
    super("Session is not loaded; prompt was not sent.");
    this.name = "ModeTransportNotReadyError";
  }
}

const isSessionEstablishment = (method: string) =>
  method === "session/new" || method === "session/load";

function sessionIdOf(result: unknown, params: unknown): string | undefined {
  const fromResult = (result as { sessionId?: unknown } | null)?.sessionId;
  if (typeof fromResult === "string" && fromResult) return fromResult;
  const fromParams = (params as { sessionId?: unknown } | null)?.sessionId;
  if (typeof fromParams === "string" && fromParams) return fromParams;
  return undefined;
}

/** 诊断不落盘、不回显端点或长 token，只保留定位所需字段。 */
function diagnostic(record: Record<string, unknown>): string {
  const redact = (value: unknown) =>
    typeof value === "string"
      ? value
          .replace(/\s+/g, " ")
          .replace(/https?:\/\/[^\s"'`]+/gi, "[url]")
          .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
          .slice(0, 240)
      : value;
  return `[wasm_mode_apply_failed] ${JSON.stringify({
    ...record,
    message: redact(record.message),
  })}`;
}

/**
 * 在 ACP `session/new` / `session/load` 成功后补发 `session/set_mode`。
 *
 * 依据 Peri 源码（只读核对）：WASM 启动配置只读取 cwd/machineId/storage/settings
 * （peri-wasm/src/emscripten/acp.rs:32-56），权限模式没有启动字段；唯一公共入口是
 * ACP `session/set_mode`（peri-acp/src/host/requests/config_options.rs:26-42）。
 * 安装的 @peri-code/sdk 0.4.0 不提供启动期权限模式字段；本包装在
 * session/new|load 成功后显式补发 set_mode(bypass)，无论随包 WASM 的初始值
 * 是 Default 还是 Bypass，结果都幂等。
 *
 * 失败策略为 fail-open：会话建立照常返回，只输出结构化诊断。若后续要求
 * 模式不可降级，可改为 fail-closed（向调用方抛出 set_mode 错误）。
 *
 * 注意：Peri 的 set_mode 只更新核心权限状态并发送 config_option_update
 * （peri-acp/src/host/requests/config_options.rs:26-42），不发送
 * session_info_update；SDK 0.4.0 仅在 seed（session/new|load 的 modes）与
 * session_info_update 时刷新 modeState（`dist/index.js` 的 seedConfig /
 * acceptSessionInfo），因此 `GET /chat` 的 view.session.modeState 会保留建立时的值。该方法只做
 * 展示，权威状态是核心的 permission_mode（可用 ACP session/metadata 读取）。
 */
export class ModeTransport implements Transport {
  private readonly modeId: string;
  private readonly warn: (message: string) => void;
  /** 当前 activation 已加载的 Session；prompt/cancel 只使用该身份。 */
  private loadedSessionId: string | null = null;

  constructor(
    private readonly inner: Transport,
    options: ModeTransportOptions = {},
  ) {
    this.modeId = options.modeId ?? AGENT_MODE_ID;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** 供宿主诊断与 direct prompt 使用；不是 ACP 公共字段。 */
  get sessionId(): string | null {
    return this.loadedSessionId;
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const result = await this.inner.request<T>(method, params);
    if (method === "session/close") {
      const closed = sessionIdOf(result, params);
      if (!closed || closed === this.loadedSessionId)
        this.loadedSessionId = null;
      return result;
    }
    if (!isSessionEstablishment(method)) return result;
    const sessionId = sessionIdOf(result, params);
    if (!sessionId) {
      this.warn(
        diagnostic({
          method,
          modeId: this.modeId,
          reason: "session id missing; mode not applied",
        }),
      );
      return result;
    }
    // 记录本次 activation 的身份；session/new 与 session/load 都以此为准。
    this.loadedSessionId = sessionId;
    try {
      await this.inner.request("session/set_mode", {
        sessionId,
        modeId: this.modeId,
      });
    } catch (error) {
      const failure = error as {
        name?: unknown;
        code?: unknown;
        message?: unknown;
      } | null;
      this.warn(
        diagnostic({
          method,
          sessionId,
          modeId: this.modeId,
          error: typeof failure?.name === "string" ? failure.name : "Error",
          code: failure?.code,
          message:
            typeof failure?.message === "string"
              ? failure.message
              : String(error),
        }),
      );
    }
    return result;
  }

  /**
   * ACP 正常 prompt：整轮 RPC，不走 `session/input/*` queue。
   *
   * 参数依据 Peri `origin/main` 的 `peri-acp/src/dispatch/prompt.rs`：
   * `session/prompt` 的 wire 形态是 `{ sessionId, prompt: ContentBlock[] }`，
   * text block 为 `{"type":"text","text":...}`。结果由 Peri 返回
   * `PromptResponse`（含 stopReason）；宿主只把受理与事件投影分开。
   */
  async prompt(text: string): Promise<unknown> {
    const sessionId = this.loadedSessionId;
    if (!sessionId) throw new ModeTransportNotReadyError();
    return this.inner.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  /**
   * 把 direct `session/prompt` 投影到 SDK 视图。
   *
   * SDK 0.4.0 的 `ChatView` 只从 `session/update` 推导用户气泡与回合边界；
   * Peri 的 direct prompt 不发送 `user_message_chunk`（仅 Defer 消息与
   * session/load replay 发送），因此这里在本地注入一条等价通知，只进入
   * SDK 订阅者，不写入 WASM、不改变 ACP 请求本身。
   */
  announceExternalUserTurn(text: string): boolean {
    const sessionId = this.loadedSessionId;
    if (!sessionId) return false;
    return this.publishLocal({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text },
        },
      },
    });
  }

  /** 关闭 direct prompt 的本地回合；Peri 已发 done 时调用无副作用。 */
  finishExternalUserTurn(): void {
    this.publishLocal({
      jsonrpc: "2.0",
      method: "peri/agent_event_done",
      params: {},
    });
  }

  private publishLocal(notification: JsonRpcNotification): boolean {
    const publish = (this.inner as unknown as {
      publish?: (value: JsonRpcNotification) => void;
    }).publish;
    if (typeof publish !== "function") {
      this.warn(
        "[wasm_view_bridge] transport 不支持本地通知注入；前端视图可能不更新",
      );
      return false;
    }
    publish.call(this.inner, notification);
    return true;
  }

  /**
   * 轮次级取消：不带 requestId/generation。
   *
   * Peri `origin/main` 的 `session/cancel` 在带 requestId/generation 时只取消
   * 对应 input attempt；direct `session/prompt` 不属于 mailbox attempt，targeted
   * cancel 无法命中，因此这里固定发送非 targeted 形式。
   */
  async cancel(): Promise<void> {
    const sessionId = this.loadedSessionId;
    if (!sessionId) throw new ModeTransportNotReadyError();
    await this.inner.notify("session/cancel", { sessionId });
  }

  sendRequest<T = unknown>(method: string, params?: unknown) {
    return this.inner.sendRequest<T>(method, params);
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.inner.notify(method, params);
  }

  subscribe(listener: (notification: JsonRpcNotification) => void): () => void {
    return this.inner.subscribe(listener);
  }

  events(): AsyncIterable<JsonRpcNotification> {
    return this.inner.events();
  }

  setRequestHandler(handler: ReverseRequestHandler): void {
    this.inner.setRequestHandler(handler);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
