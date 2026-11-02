import { describe, expect, spyOn, test } from "bun:test";
import type {
  JsonRpcNotification,
  ReverseRequestHandler,
  Transport,
} from "@peri-code/sdk";
import { AGENT_MODE_ID, ModeTransport, ModeTransportNotReadyError } from "./mode-transport";

type Call = { method: string; params?: unknown };

class FakeTransport implements Transport {
  readonly calls: Call[] = [];
  readonly notifications: Call[] = [];
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

  async notify(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params });
  }

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

  test("prompt 使用已加载 Session 发 ACP session/prompt，绝不发 enqueue", async () => {
    const inner = new FakeTransport();
    inner.responses.set("session/new", { sessionId: "session-prompt" });
    inner.responses.set("session/prompt", { stopReason: "end_turn" });
    const transport = new ModeTransport(inner);

    await transport.request("session/new", { cwd: "/tmp/workspace" });
    const result = await transport.prompt("请回复 prompt-clean");

    expect(result).toEqual({ stopReason: "end_turn" });
    const calls = inner.calls.filter((call) => call.method !== "session/set_mode");
    expect(calls).toEqual([
      { method: "session/new", params: { cwd: "/tmp/workspace" } },
      {
        method: "session/prompt",
        params: {
          sessionId: "session-prompt",
          // Peri origin/main: peri-acp/src/dispatch/prompt.rs PromptRequest wire shape.
          prompt: [{ type: "text", text: "请回复 prompt-clean" }],
        },
      },
    ]);
    expect(
      inner.calls.some((call) => call.method.startsWith("session/input/")),
    ).toBe(false);
  });

  test("未加载 Session 时 prompt 抛 not_ready，且不发任何请求", async () => {
    const inner = new FakeTransport();
    const transport = new ModeTransport(inner);

    await expect(transport.prompt("hello")).rejects.toBeInstanceOf(
      ModeTransportNotReadyError,
    );
    await expect(transport.prompt("hello")).rejects.toMatchObject({
      code: "not_ready",
      disposition: "not_sent",
    });
    expect(inner.calls).toEqual([]);
  });

  test("session/load 后 prompt 复用请求参数中的 sessionId；close 后回到 not_ready", async () => {
    const inner = new FakeTransport();
    inner.responses.set("session/load", {});
    const transport = new ModeTransport(inner);

    await transport.request("session/load", {
      cwd: "/tmp/workspace",
      sessionId: "session-loaded",
      loadGeneration: "g1",
    });
    await transport.prompt("hello");
    expect(inner.calls.at(-1)).toEqual({
      method: "session/prompt",
      params: {
        sessionId: "session-loaded",
        prompt: [{ type: "text", text: "hello" }],
      },
    });

    await transport.request("session/close", { sessionId: "session-loaded" });
    await expect(transport.prompt("after close")).rejects.toMatchObject({
      code: "not_ready",
    });
  });

  test("direct prompt cancel 只带 sessionId，不带 requestId/generation", async () => {
    const inner = new FakeTransport();
    inner.responses.set("session/new", { sessionId: "session-cancel" });
    const transport = new ModeTransport(inner);
    await transport.request("session/new", { cwd: "/tmp/workspace" });

    await transport.cancel();
    expect(inner.notifications).toEqual([
      { method: "session/cancel", params: { sessionId: "session-cancel" } },
    ]);
    expect(inner.notifications[0]?.params).not.toHaveProperty("requestId");
    expect(inner.notifications[0]?.params).not.toHaveProperty("generation");
  });
});
