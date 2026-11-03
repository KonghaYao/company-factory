import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type {
  AcpMcpServerInstance,
  AcpMcpServerInstanceFactory,
  AcpMcpTransport,
} from "@peri-code/sdk";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_BYTES = 2 * MAX_FRAME_BYTES;
const MAX_PENDING = 256;
type RpcId = string | number;
type RpcFrame = Record<string, unknown> & {
  jsonrpc: "2.0";
  id?: RpcId;
  method?: string;
};

export interface WorkspaceMcpServerOptions {
  periBinary: string;
  directory: string;
  env?: { PATH?: string; LANG?: string; HOME?: string };
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
}

function rpcFrame(value: unknown): RpcFrame {
  const invalid = () => new Error("Workspace MCP JSON-RPC 帧无效。");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const frame = value as Record<string, unknown>;
  if (frame.jsonrpc !== "2.0") throw invalid();
  const hasId = Object.hasOwn(frame, "id");
  if (hasId && !isRpcId(frame.id)) throw invalid();
  const hasResult = Object.hasOwn(frame, "result");
  const hasError = Object.hasOwn(frame, "error");
  if (Object.hasOwn(frame, "method")) {
    if (typeof frame.method !== "string" || !frame.method || hasResult || hasError)
      throw invalid();
  } else {
    if (!hasId || hasResult === hasError) throw invalid();
    if (hasError) {
      const error = frame.error;
      if (!error || typeof error !== "object" || Array.isArray(error) ||
        !Number.isInteger((error as Record<string, unknown>).code) ||
        typeof (error as Record<string, unknown>).message !== "string")
        throw invalid();
    }
  }
  return frame as RpcFrame;
}

/** 每个 SDK activation 独占一个官方 Workspace stdio，不复用浏览器文件端连接。 */
class WorkspaceMcpServer implements AcpMcpServerInstance {
  private child?: ChildProcessWithoutNullStreams;
  private transport?: AcpMcpTransport;
  private pending = new Set<RpcId>();
  private reversePending = new Set<RpcId>();
  // 取消后的迟到响应不能误配到重用的 request id；墓碑同样受 MAX_PENDING 限制。
  private cancelled = new Set<RpcId>();
  private queuedBytes = 0;
  private closed = false;
  private processClosed = false;
  private closeCompleted = false;
  private closing?: Promise<void>;
  private reading?: Promise<void>;
  private interruptions = new Set<() => void>();
  private onMessage = (message: unknown) => {
    void this.fromClient(message).catch(() => this.fail());
  };
  private onTransportClose = () => {
    void this.close().catch(() => this.report("Workspace MCP 关闭未获确认。"));
  };

  constructor(private options: WorkspaceMcpServerOptions) {}

  async connect(transport: AcpMcpTransport): Promise<void> {
    if (this.transport || this.closed)
      throw new Error("Workspace MCP 实例不可重复连接；请使用 activation 工厂。");
    this.transport = transport;
    transport.onmessage = this.onMessage;
    transport.onclose = this.onTransportClose;
    try {
      const child = spawn(
        this.options.periBinary,
        [
          "mcp-start",
          "workspace",
          "--stdio",
          "--workspace",
          this.options.directory,
        ],
        {
          cwd: this.options.directory,
          env: {
            PATH: this.options.env?.PATH ?? process.env.PATH,
            LANG: this.options.env?.LANG ?? process.env.LANG ?? "C.UTF-8",
            HOME: this.options.env?.HOME ?? process.env.HOME ?? "/tmp",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      this.child = child;
      const spawned = once(child, "spawn");
      void spawned.catch(() => {});
      child.once("close", () => {
        this.processClosed = true;
        if (!this.closed) this.fail();
      });
      child.on("error", () => this.fail());
      child.stdin.on("error", () => this.fail());
      child.stderr.on("error", () => this.fail());
      // stderr 只排空，不保留、不拼接到错误文本。
      child.stderr.resume();
      this.reading = this.read(child).catch(() => {
        if (!this.closed) this.fail();
      });
      await spawned;
      if (this.closed) throw new Error("Workspace MCP 连接已关闭。");
      await this.duringConnection(transport.start());
      if (this.closed) throw new Error("Workspace MCP 连接已关闭。");
      // 不写 settings bootstrap，也不主动 initialize；握手由 WASM 原样传入。
    } catch {
      await this.close();
      throw new Error("Workspace MCP 连接失败。");
    }
  }

  private report(message: string) {
    try { this.transport?.onerror?.(new Error(message)); } catch {}
  }

  private fail() {
    if (this.closed) return;
    this.report("Workspace MCP 连接已中断。");
    void this.close().catch(() => this.report("Workspace MCP 关闭未获确认。"));
  }

  private async duringConnection<T>(operation: Promise<T>): Promise<T> {
    if (this.closed || this.interruptions.size >= 2 * MAX_PENDING) {
      void operation.catch(() => {});
      throw new Error("Workspace MCP 连接已关闭或传输超过容量限制。");
    }
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(new Error("Workspace MCP 连接已关闭。"));
      this.interruptions.add(stop);
      operation.then((value) => {
        this.interruptions.delete(stop);
        resolve(value);
      }, () => {
        this.interruptions.delete(stop);
        reject(new Error("Workspace MCP 传输失败。"));
      });
    });
  }

  private async write(frame: RpcFrame) {
    const child = this.child;
    if (this.closed || !child || child.stdin.destroyed)
      throw new Error("Workspace MCP 连接已关闭。");
    const body = JSON.stringify(frame);
    const bytes = Buffer.byteLength(body) + 1;
    if (bytes > MAX_FRAME_BYTES + 1 || this.queuedBytes + bytes > MAX_QUEUED_BYTES)
      throw new Error("Workspace MCP 写入超过容量限制。");
    this.queuedBytes += bytes;
    try {
      await this.duringConnection(new Promise<void>((resolve, reject) => {
        child.stdin.write(body + "\n", (error) => {
          if (error) reject(new Error("Workspace MCP 写入失败。"));
          else resolve();
        });
      }));
    } finally {
      this.queuedBytes -= bytes;
    }
  }

  private async send(frame: RpcFrame) {
    if (this.closed || !this.transport)
      throw new Error("Workspace MCP 连接已关闭。");
    await this.duringConnection(this.transport.send(frame));
  }

  private async fromClient(message: unknown) {
    if (this.closed) return;
    const frame = rpcFrame(message);
    if (frame.method === undefined) {
      if (this.reversePending.delete(frame.id!)) await this.write(frame);
      return;
    }
    if (frame.id !== undefined) {
      if (this.pending.has(frame.id) || this.cancelled.has(frame.id) ||
        this.pending.size + this.cancelled.size >= MAX_PENDING)
        throw new Error("Workspace MCP 请求关联超过限制或重复。");
      this.pending.add(frame.id);
    } else if (frame.method === "notifications/cancelled") {
      const params = frame.params as Record<string, unknown> | undefined;
      const id = params?.requestId;
      if (isRpcId(id) && this.pending.delete(id)) {
        this.cancelled.add(id);
        await this.write(frame);
        // SDK 无取消用的 reject API；用同一 id 结算请求，迟到的 child 响应不再投递。
        await this.send({
          jsonrpc: "2.0", id,
          error: { code: -32800, message: "Workspace MCP 请求已取消。" },
        });
        return;
      }
    }
    await this.write(frame);
  }

  private async fromServer(frame: RpcFrame) {
    if (frame.method !== undefined) {
      // 当前 SDK 没有 server 通知的出站通道；不触发其带 method 的 console.warn。
      if (frame.id === undefined) return;
      if (this.reversePending.has(frame.id) || this.reversePending.size >= MAX_PENDING)
        throw new Error("Workspace MCP 反向请求关联超过限制或重复。");
      this.reversePending.add(frame.id);
      // SDK 当前同步回送 -32601；onmessage 会把该错误按原 id 写回官方 Workspace。
      await this.send(frame);
      return;
    }
    if (this.cancelled.delete(frame.id!)) return;
    // 忽略未知/迟到响应，避免交给 SDK 后错误匹配或产生非必要日志。
    if (this.pending.delete(frame.id!)) await this.send(frame);
  }

  private async read(child: ChildProcessWithoutNullStreams) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of child.stdout) {
        if (this.closed) break;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < data.length && !this.closed) {
          const newline = data.indexOf(10, offset);
          const end = newline < 0 ? data.length : newline;
          const part = data.subarray(offset, end);
          size += part.length;
          if (size > MAX_FRAME_BYTES)
            throw new Error("Workspace MCP 帧超过容量限制。");
          if (part.length) parts.push(part);
          if (newline < 0) {
            if (parts.length >= 64) parts = [Buffer.concat(parts, size)];
            break;
          }
          const body = parts.length === 1 ? parts[0]! : Buffer.concat(parts, size);
          parts = [];
          size = 0;
          const line = decoder.decode(body).trim();
          if (line) await this.fromServer(rpcFrame(JSON.parse(line)));
          offset = end + 1;
        }
      }
      if (!this.closed)
        throw new Error("Workspace MCP 输出提前结束或存在不完整帧。");
    } finally {
      parts = [];
      child.stdout.destroy();
    }
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, milliseconds: number) {
    if (this.processClosed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const finish = (exited: boolean) => {
        clearTimeout(timer);
        child.off("close", onClose);
        resolve(exited);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), milliseconds);
      child.once("close", onClose);
    });
  }

  private signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
    try {
      if (!child.kill(signal) && !this.processClosed)
        this.report("Workspace MCP 终止信号发送未获确认。");
    } catch {
      this.report("Workspace MCP 终止信号发送失败。");
    }
  }

  close(): Promise<void> {
    if (this.closeCompleted) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closed = true;
    for (const stop of this.interruptions) stop();
    this.interruptions.clear();
    this.pending.clear();
    this.reversePending.clear();
    this.cancelled.clear();
    if (this.transport?.onmessage === this.onMessage)
      this.transport.onmessage = undefined;
    if (this.transport?.onclose === this.onTransportClose)
      this.transport.onclose = undefined;
    this.child?.stdout.destroy();
    const attempt = this.closeOnce().finally(() => {
      if (this.closing === attempt) this.closing = undefined;
    });
    this.closing = attempt;
    return attempt;
  }

  private async closeOnce() {
    const child = this.child;
    if (child && !this.processClosed) {
      try { child.stdin.end(); } catch { child.stdin.destroy(); }
      if (!await this.waitForExit(child, 2000)) {
        this.signal(child, "SIGTERM");
        if (!await this.waitForExit(child, 3000)) {
          this.signal(child, "SIGKILL");
          await this.waitForExit(child, 3000);
        }
      }
    }
    await this.reading;
    let transportFailed = false;
    try { await this.transport?.close(); } catch { transportFailed = true; }
    // 即便未确认退出，也关闭 SDK 待办；保留 child，供后续 close() 重试。
    if (child && !this.processClosed)
      throw new Error("Workspace MCP 子进程退出未获确认。");
    if (transportFailed)
      throw new Error("Workspace MCP 传输关闭未获确认。");
    child?.stdin.destroy();
    child?.stderr.destroy();
    this.child = undefined;
    this.reading = undefined;
    this.transport = undefined;
    this.closeCompleted = true;
  }
}

/** 只创建工厂；每次调用工厂返回未连接的新实例，SDK 持有其完整生命周期。 */
export function snapshotWorkspaceMcpServerOptions(
  options: WorkspaceMcpServerOptions,
): WorkspaceMcpServerOptions {
  return {
    periBinary: options.periBinary,
    directory: options.directory,
    env: options.env && {
      PATH: options.env.PATH,
      LANG: options.env.LANG,
      HOME: options.env.HOME,
    },
  };
}

export function createWorkspaceMcpServerFactory(
  options: WorkspaceMcpServerOptions,
): AcpMcpServerInstanceFactory {
  const snapshot = snapshotWorkspaceMcpServerOptions(options);
  return () => new WorkspaceMcpServer(snapshot);
}
