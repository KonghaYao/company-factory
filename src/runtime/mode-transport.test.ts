import { describe, expect, spyOn, test } from "bun:test";
import type {
  JsonRpcNotification,
  ReverseRequestHandler,
  Transport,
} from "@peri-code/sdk";
import { AGENT_MODE_ID, ModeTransport } from "./mode-transport";

type Call = { method: string; params?: unknown };

class FakeTransport implements Transport {
  readonly calls: Call[] = [];
  readonly failures = new Map<string, Error>();
  readonly responses = new Map<string, unknown>();
  closed = false;

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const failure = this.failures.get(method);
    if (failure) throw failure;
    return (this.responses.get(method) ?? {}) as T;
  }

  sendRequest<T = unknown>(method: string, params?: unknown) {
    return Promise.resolve({ response: this.request<T>(method, params) });
  }

  async notify(): Promise<void> {}

  subscribe(): () => void {
    return () => {};
  }

  async *events(): AsyncIterable<JsonRpcNotification> {}

  setRequestHandler(_handler: ReverseRequestHandler): void {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("ModeTransport", () => {
  test("session/new 成功后补发一次 session/set_mode，并原样返回创建结果", async () => {
    const created = {
      sessionId: "session-1",
      modes: { currentModeId: "default", availableModes: [] },
    };
    const inner = new FakeTransport();
    inner.responses.set("session/new", created);
    const transport = new ModeTransport(inner);

    const result = await transport.request("session/new", {
      cwd: "/tmp/workspace",
      mcpServers: [],
    });

    expect(result).toEqual(created);
    expect(inner.calls).toEqual([
      { method: "session/new", params: { cwd: "/tmp/workspace", mcpServers: [] } },
      {
        method: "session/set_mode",
        params: { sessionId: "session-1", modeId: AGENT_MODE_ID },
      },
    ]);
    expect(AGENT_MODE_ID).toBe("bypass");
  });

  test("session/load 从请求参数取 sessionId，并补发 session/set_mode", async () => {
    const loaded = { modes: { currentModeId: "bypass", availableModes: [] } };
    const inner = new FakeTransport();
    inner.responses.set("session/load", loaded);
    const transport = new ModeTransport(inner);

    const result = await transport.request("session/load", {
      cwd: "/tmp/workspace",
      mcpServers: [],
      sessionId: "session-2",
      loadGeneration: "generation-1",
    });

    expect(result).toEqual(loaded);
    expect(inner.calls.map((call) => call.method)).toEqual([
      "session/load",
      "session/set_mode",
    ]);
    expect(inner.calls[1]?.params).toEqual({
      sessionId: "session-2",
      modeId: "bypass",
    });
  });

  test("set_mode 失败不阻断会话建立，只输出脱敏的结构化诊断", async () => {
    const inner = new FakeTransport();
    inner.responses.set("session/new", { sessionId: "session-3" });
    inner.failures.set(
      "session/set_mode",
      new Error(
        "session/set_mode failed for https://internal.example/path token=0123456789abcdef0123456789abcdef",
      ),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const transport = new ModeTransport(inner);
      const result = await transport.request("session/new", {
        cwd: "/tmp/workspace",
        mcpServers: [],
      });

      expect(result).toEqual({ sessionId: "session-3" });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(message).toContain("[wasm_mode_apply_failed]");
      expect(message).toContain('"modeId":"bypass"');
      expect(message).toContain('"sessionId":"session-3"');
      expect(message).not.toContain("https://internal.example");
      expect(message).not.toContain("0123456789abcdef0123456789abcdef");
    } finally {
      warn.mockRestore();
    }
  });

  test("非会话建立请求不触发 set_mode，其余方法委派内部 transport", async () => {
    const inner = new FakeTransport();
    inner.responses.set("session/prompt", { stopReason: "end_turn" });
    const transport = new ModeTransport(inner);

    expect(await transport.request("session/prompt", { sessionId: "s" })).toEqual({
      stopReason: "end_turn",
    });
    expect(inner.calls.map((call) => call.method)).toEqual(["session/prompt"]);

    await transport.notify("session/cancel", { sessionId: "s" });
    await transport.close();
    expect(inner.closed).toBe(true);
  });
});
