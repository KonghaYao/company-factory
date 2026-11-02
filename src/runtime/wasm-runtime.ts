import {
  createNodeDnsPort,
  createNodeNetworkPort,
  instantiatePeriWasm,
  startWasmRuntime,
  withDeadline,
  type NativeWasmAcp,
  type PeriWasmModuleFactory,
} from "@peri-code/sdk/wasm-node";
import { ModeTransport } from "./mode-transport";
import { wasmDiagnosticLine } from "./diagnostic-events";
import type { DiagnosticsSink } from "./diagnostics";

/** 与 SDK WasmRuntimePool 的默认启动预算一致。 */
const STARTUP_TIMEOUT_MS = 20_000;

export interface WasmAgentScope {
  companyId: string;
  agentId: string;
  diagnostics?: DiagnosticsSink;
}

export interface WasmAgentModuleHooks {
  /**
   * 每个 Chat 的 activation 创建一个 ModeTransport；宿主据此把 direct
   * `session/prompt` 绑到同一个 inner transport。
   */
  onTransport?: (chatId: string, transport: ModeTransport) => void;
}

/** Manager 拥有端口兜底回收；native 与 scheduler 生命周期仍由 SDK 驱动。 */
export function createAgentWasmModules(
  scope?: WasmAgentScope,
  hooks: WasmAgentModuleHooks = {},
) {
  const pending = new Set<() => Promise<void>>();
  /**
   * Native stderr is allowlist-only: at most 8 lines per callback, and only the
   * recognized diagnostic patterns survive. Raw output is never forwarded.
   */
  const printErr = (text: string) => {
    const current = scope;
    const diagnostics = current?.diagnostics;
    if (!current || !diagnostics?.wasmEnabled) return;
    try {
      for (const line of String(text ?? "").split(/\r?\n/).slice(0, 8)) {
        const diagnostic = wasmDiagnosticLine(line);
        if (!diagnostic) continue;
        diagnostics.record({
          event: "wasm_stderr",
          companyId: current.companyId,
          agentId: current.agentId,
          ...diagnostic,
        });
      }
    } catch {
      // A diagnostics failure must never surface into the WASM runtime.
    }
  };
  const factory: PeriWasmModuleFactory = async (options = {}) => {
    const network = createNodeNetworkPort();
    const closeNetwork = async () => {
      let failed = false;
      try { network.close(); } catch { failed = true; }
      try { await withDeadline(network.drain(), 5000, "WASM network close"); } catch { failed = true; }
      if (failed) throw new Error("WASM 网络端口关闭未获确认。");
      pending.delete(closeNetwork);
    };
    pending.add(closeNetwork);
    try {
      const module = await instantiatePeriWasm({
        moduleOptions: {
          ...options,
          periNet: network.module,
          periDns: createNodeDnsPort(),
          periWorkerSockets: true,
          // 原生输出可能包含连接或模型凭据；print 保持 no-op，printErr 仅走 allowlist。
          print: () => {},
          printErr,
        },
      });
      return {
        get ENV() { return module.ENV; },
        PeriWasmAcp: {
          async start(configJson: string) {
            let native: NativeWasmAcp;
            try { native = await module.PeriWasmAcp.start(configJson); } catch {
              await closeNetwork();
              throw new Error("WASM Session 启动失败；请检查本地 sqld、模型与 MCP 配置。");
            }
            return {
              async send(frame: string) {
                try { await native.send(frame); } catch { throw new Error("WASM ACP 发送失败。"); }
              },
              async recv() {
                try { return await native.recv(); } catch { throw new Error("WASM ACP 接收失败。"); }
              },
              free() {
                try { native.free?.(); } catch { throw new Error("WASM 实例释放未获确认。"); }
              },
              async close() {
                let failed = false;
                try { await native.close(); } catch { failed = true; }
                try { await closeNetwork(); } catch { failed = true; }
                if (failed) throw new Error("WASM Session 或网络端口关闭未获确认。");
              },
            };
          },
        },
      };
    } catch {
      await closeNetwork();
      throw new Error("无法加载 SDK 随包 WASM artifact；未回退 native ACP。");
    }
  };
  return {
    factory,
    /**
     * SDK 托管的每次激活启动：端口生命周期仍由上面的 native.close 回收，
     * transport 仅追加会话建立后的模式设置。
     */
    async startTransport(options: {
      configJson: string;
      signal?: AbortSignal;
      chatId?: string;
    }): Promise<ModeTransport> {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) forwardAbort();
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
      try {
        const starting = startWasmRuntime({
          configJson: options.configJson,
          moduleFactory: factory,
          signal: controller.signal,
        });
        try {
          const transport = new ModeTransport(
            await withDeadline(
              starting,
              STARTUP_TIMEOUT_MS,
              "Peri WASM runtime startup",
            ),
          );
          if (options.chatId)
            hooks.onTransport?.(options.chatId, transport);
          return transport;
        } catch (error) {
          // 超时/取消后中止启动，让 SDK 自行结算 native 与端口清理。
          controller.abort(error);
          throw error;
        }
      } finally {
        options.signal?.removeEventListener("abort", forwardAbort);
      }
    },
    async close() {
      const results = await Promise.allSettled([...pending].map((close) => close()));
      if (results.some((result) => result.status === "rejected"))
        throw new Error("WASM 网络端口关闭未获确认。");
    },
  };
}
