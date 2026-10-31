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

/** 与 SDK WasmRuntimePool 的默认启动预算一致。 */
const STARTUP_TIMEOUT_MS = 20_000;

/** Manager 拥有端口兜底回收；native 与 scheduler 生命周期仍由 SDK 驱动。 */
export function createAgentWasmModules() {
  const pending = new Set<() => Promise<void>>();
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
          // 原生输出可能包含连接或模型凭据，不转为宿主日志。
          print: () => {},
          printErr: () => {},
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
          return new ModeTransport(
            await withDeadline(
              starting,
              STARTUP_TIMEOUT_MS,
              "Peri WASM runtime startup",
            ),
          );
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
