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
 * 安装的 @peri-code/sdk 0.3.0 对应 sdk-v0.3.0 快照，WASM 初始模式仍为 Default；
 * 源码 HEAD 的 f5cfed893 才把 WASM 默认值改为 Bypass，因此本包装在升级后仍然幂等。
 *
 * 失败策略为 fail-open：会话建立照常返回，只输出结构化诊断。若后续要求
 * 模式不可降级，可改为 fail-closed（向调用方抛出 set_mode 错误）。
 *
 * 注意：Peri 的 set_mode 只更新核心权限状态并发送 config_option_update
 * （peri-acp/src/host/requests/config_options.rs:26-42），不发送
 * session_info_update；SDK 0.3.0 仅在 seed（session/new|load 的 modes）与
 * session_info_update 时刷新 modeState（dist/view.js:2926,2948-2960），
 * 因此 `GET /chat` 的 view.session.modeState 会保留建立时的值。该方法只做
 * 展示，权威状态是核心的 permission_mode（可用 ACP session/metadata 读取）。
 */
export class ModeTransport implements Transport {
  private readonly modeId: string;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly inner: Transport,
    options: ModeTransportOptions = {},
  ) {
    this.modeId = options.modeId ?? AGENT_MODE_ID;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const result = await this.inner.request<T>(method, params);
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
