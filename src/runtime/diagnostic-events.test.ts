import { describe, expect, test } from "bun:test";
import {
  agentExecutionFailureFromNotice,
  extractRpcErrorMetadata,
  sanitizeReadEntry,
  wasmDiagnosticLine,
} from "./diagnostic-events";

function notice(
  event: unknown,
  eventId = "evt-1",
): Record<string, unknown> {
  return {
    kind: "notice",
    notification: {
      method: "peri/agent_event",
      params: {
        event_json: typeof event === "string" ? event : JSON.stringify(event),
        _meta: { peri: { eventId } },
      },
    },
  };
}

describe("agentExecutionFailureFromNotice", () => {
  test("extracts only the public message and correlation fields", () => {
    const fact = notice({
      type: "agent_execution_failed",
      value: {
        message: "Conversation persistence failed; reload the session to recover",
        turn_id: "turn-1",
        stop_reason: "error",
        secret: { content: "NEVER_READ" },
      },
    });
    expect(agentExecutionFailureFromNotice(fact)).toEqual({
      message: "Conversation persistence failed; reload the session to recover",
      eventId: "evt-1",
      turnId: "turn-1",
      stopReason: "error",
    });
  });

  test("accepts event_json as an object and camelCase fallbacks", () => {
    const fact = notice({
      type: "agent_execution_failed",
      value: { message: "boom", turnId: "t", stopReason: "failed" },
    }) as any;
    fact.notification.params.event_json = {
      type: "agent_execution_failed",
      value: { message: "boom", turnId: "t", stopReason: "failed" },
    };
    expect(agentExecutionFailureFromNotice(fact)).toEqual({
      message: "boom",
      eventId: "evt-1",
      turnId: "t",
      stopReason: "failed",
    });
  });

  test("rejects malformed or unrelated facts without throwing", () => {
    const cases: unknown[] = [
      null,
      { kind: "history-page", items: [], nextCursor: null },
      { kind: "notice", notification: { method: "session/update", params: {} } },
      notice("{not json"),
      notice({ type: "agent_execution_failed", value: {} }),
      notice({ type: "agent_execution_failed", value: { message: "   " } }),
      notice({ type: "turn_complete", value: { message: "not a failure" } }),
    ];
    for (const fact of cases) expect(agentExecutionFailureFromNotice(fact)).toBeNull();
  });
});

describe("wasmDiagnosticLine", () => {
  test.each([
    ["append_history failed: database is locked", "append_history_failed"],
    ["transcript persist entered terminal failure: disk", "transcript_persist_terminal"],
    ["[v2] execution failed at phase 4", "v2_execution_failed"],
    ["[v2] phase 8 transcript flush failed", "v2_phase8_flush_failed"],
    ["conversation persistence failed: reload", "conversation_persistence_failed"],
    ["LLM generate_reasoning failed", "llm_generate_reasoning"],
    ["dispatch_tools: returning MiddlewareError", "dispatch_tools_middleware_error"],
    ["LLM HTTP 502 from upstream", "llm_http_502"],
    ["LLM error: connection reset", "llm_error"],
    ["Middleware error: transcript rejected", "middleware_error"],
  ])("allowlists %s", (line, pattern) => {
    const diagnostic = wasmDiagnosticLine(line);
    expect(diagnostic?.pattern).toBe(pattern);
    expect(diagnostic?.text.length).toBeGreaterThan(0);
  });

  test("drops arbitrary native output, blank lines and ANSI-only noise", () => {
    expect(wasmDiagnosticLine("stdout scratch buffer 123")).toBeNull();
    expect(wasmDiagnosticLine("   \t ")).toBeNull();
    expect(wasmDiagnosticLine("\x1b[31m\x1b[0m")).toBeNull();
  });

  test("strips ANSI and redacts URL/token before returning text", () => {
    const line =
      "\x1b[31mappend_history failed\x1b[0m https://host.example/x?token=secret 0123456789abcdef0123456789abcdef";
    const diagnostic = wasmDiagnosticLine(line);
    expect(diagnostic?.text).toContain("append_history failed");
    expect(diagnostic?.text).toContain("[url]");
    expect(diagnostic?.text).toContain("[redacted]");
    expect(diagnostic?.text).not.toContain("host.example");
    expect(diagnostic?.text).not.toContain("0123456789abcdef0123456789abcdef");
    expect(diagnostic?.text).not.toContain("\x1b");
  });

  test("bounds oversized lines and marks them truncated", () => {
    const diagnostic = wasmDiagnosticLine(
      `append_history failed ${"x".repeat(9000)}`,
    );
    expect(diagnostic?.truncated).toBe(true);
    expect(diagnostic!.text.length).toBeLessThanOrEqual(501);
  });
});

describe("extractRpcErrorMetadata", () => {
  test("keeps scalar snapshot metadata and only the item count", () => {
    const metadata = extractRpcErrorMetadata({
      code: -32602,
      message: "stale generation",
      name: "RpcError",
      data: {
        rejected: true,
        snapshot: {
          generation: "gen-2",
          revision: 7,
          sessionId: "session-1",
          activeRequestId: "req-active",
          items: [{ content: "SECRET_CONTENT" }, { content: "SECOND" }],
        },
      },
    });
    expect(metadata).toEqual({
      code: -32602,
      message: "stale generation",
      errorName: "RpcError",
      rejected: true,
      generation: "gen-2",
      revision: 7,
      snapshotSessionId: "session-1",
      itemCount: 2,
      activeRequestId: "req-active",
    });
    expect(JSON.stringify(metadata)).not.toContain("SECRET_CONTENT");
    expect(JSON.stringify(metadata)).not.toContain("items");
  });

  test("walks a bounded cause chain and prefers the data-bearing error", () => {
    const rpc = Object.assign(new Error("stale generation"), {
      code: -32602,
      data: {
        rejected: true,
        snapshot: {
          generation: "gen-9",
          revision: 9,
          sessionId: "session-9",
          items: [],
        },
      },
    });
    const wrapper = new Error("command failed", { cause: rpc });
    const metadata = extractRpcErrorMetadata(wrapper)!;
    expect(metadata.code).toBe(-32602);
    expect(metadata.generation).toBe("gen-9");
    expect(metadata.itemCount).toBe(0);
    expect(metadata.errorName).toBe("Error");
  });

  test("returns null for values without error shape or metadata", () => {
    expect(extractRpcErrorMetadata(null)).toBeNull();
    expect(extractRpcErrorMetadata("nope")).toBeNull();
    expect(extractRpcErrorMetadata({})).toBeNull();
  });
});

describe("sanitizeReadEntry", () => {
  test("drops unknown events, unknown fields, items and content", () => {
    expect(sanitizeReadEntry({ msg: "unknown_event", message: "x" })).toBeNull();
    expect(sanitizeReadEntry("not an object")).toBeNull();
    const sanitized = sanitizeReadEntry({
      msg: "agent_execution_failed",
      time: "2026-11-02T00:00:00.000Z",
      level: 50,
      bootId: "boot-1",
      message:
        "failed at https://host.example/x with 0123456789abcdef0123456789abcdef",
      items: [{ content: "SECRET_CONTENT" }],
      content: "SECRET_CONTENT",
      token: "SECRET_TOKEN",
      data: { snapshot: { items: [] } },
    })!;
    expect(sanitized.event).toBe("agent_execution_failed");
    expect(sanitized.message).toContain("[url]");
    expect(sanitized.message).toContain("[redacted]");
    const serialized = JSON.stringify(sanitized);
    for (const forbidden of [
      "SECRET_CONTENT",
      "SECRET_TOKEN",
      "host.example",
      "items",
      "content",
      "snapshot",
    ])
      expect(serialized).not.toContain(forbidden);
  });

  test("re-redacts wasm text and bounds other strings", () => {
    const sanitized = sanitizeReadEntry({
      msg: "wasm_stderr",
      pattern: "append_history_failed",
      text: "append_history failed https://host.example/x",
      truncated: true,
      companyId: "c".repeat(300),
      unknown: "drop me",
    })!;
    expect(sanitized.text).toContain("[url]");
    expect((sanitized.companyId as string).length).toBe(200);
    expect(sanitized.unknown).toBeUndefined();
  });

  test("keeps only the bounded retention shape for process_start", () => {
    const sanitized = sanitizeReadEntry({
      msg: "process_start",
      app: "company-factory",
      pid: 1,
      bootId: "boot-1",
      retention: { maxBytesPerFile: 1024, maxFiles: 3, secret: "x" },
      cwd: "/tmp/secret",
    })!;
    expect(sanitized.retention).toEqual({ maxBytesPerFile: 1024, maxFiles: 3 });
    expect(JSON.stringify(sanitized)).not.toContain("/tmp/secret");
  });
});
