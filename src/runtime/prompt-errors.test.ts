import { describe, expect, test } from "bun:test";
import {
  PROMPT_ERROR_CODES,
  classifyAgentExecutionFailure,
  classifyPromptError,
  isAdmissionPromptError,
  isPersistencePromptError,
  promptErrorDefinition,
} from "./prompt-errors";

type Rpc = Error & { code: number; data?: unknown };

function rpc(code: number, message: string, data?: unknown): Rpc {
  const error = new Error(message) as Rpc;
  error.name = "RpcError";
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function expectClassified(
  error: unknown,
  expected: {
    code: string;
    status: number;
    disposition: string;
    recovery: string;
    uncertain: boolean;
  },
) {
  expect(classifyPromptError(error)).toMatchObject(expected);
}

describe("classifyPromptError: session/prompt wire errors", () => {
  test("-32602 with rejected/snapshot is a stale binding, without it is invalid params", () => {
    expectClassified(
      rpc(-32602, "user input queue generation changed", {
        rejected: true,
        snapshot: { generation: "g1" },
      }),
      {
        code: "stale_session",
        status: 409,
        disposition: "rejected",
        recovery: "reload",
        uncertain: false,
      },
    );
    expectClassified(rpc(-32602, "stale", { snapshot: {} }), {
      code: "stale_session",
      status: 409,
      disposition: "rejected",
      recovery: "reload",
      uncertain: false,
    });
    expectClassified(rpc(-32602, "missing sessionId"), {
      code: "invalid_prompt",
      status: 400,
      disposition: "rejected",
      recovery: "none",
      uncertain: false,
    });
  });

  test("session not found wins over generic -32602 invalid params", () => {
    expectClassified(rpc(-32602, "session not found"), {
      code: "session_closed",
      status: 410,
      disposition: "rejected",
      recovery: "rebuild",
      uncertain: false,
    });
  });

  test("-32010 lifecycle messages map to distinct recovery actions", () => {
    expectClassified(rpc(-32010, "Session is closing"), {
      code: "session_closing",
      status: 409,
      disposition: "rejected",
      recovery: "none",
      uncertain: false,
    });
    expectClassified(rpc(-32010, "Session runtime is no longer active"), {
      code: "runtime_unavailable",
      status: 503,
      disposition: "rejected",
      recovery: "rebuild",
      uncertain: false,
    });
    expectClassified(
      rpc(-32010, "Session context is owned by an in-flight prompt"),
      {
        code: "session_busy",
        status: 409,
        disposition: "rejected",
        recovery: "none",
        uncertain: false,
      },
    );
    expectClassified(
      rpc(
        -32010,
        "Session persistence is not settled; explicit persistence recovery is required before retrying: writer closed",
      ),
      {
        code: "persistence_pending",
        status: 503,
        disposition: "unknown",
        recovery: "rebuild",
        uncertain: true,
      },
    );
  });

  test("-32000 internal persistence wording wins over generic execution failure", () => {
    for (const message of [
      "Conversation persistence failed: writer closed; reload the session to recover",
      "Conversation persistence outcome is unconfirmed; reload the session to recover",
      "compact persistence outcome is unknown; reload the session",
    ]) {
      expectClassified(rpc(-32000, message, { kind: "internal" }), {
        code: "persistence_inconsistent",
        status: 503,
        disposition: "unknown",
        recovery: "rebuild",
        uncertain: true,
      });
    }
  });

  test("-32000 llm/llm_http is an execution failure with uncertain outcome", () => {
    for (const kind of ["llm", "llm_http"]) {
      expectClassified(rpc(-32000, "provider failed", { kind }), {
        code: "execution_failed",
        status: 502,
        disposition: "unknown",
        recovery: "none",
        uncertain: true,
      });
    }
  });

  test("history restore, cancellation and supersession have stable codes", () => {
    expectClassified(rpc(-32603, "session history load failed: corrupt"), {
      code: "session_restore_failed",
      status: 500,
      disposition: "rejected",
      recovery: "reload",
      uncertain: false,
    });
    expectClassified(rpc(-32800, "user input attempt superseded"), {
      code: "prompt_superseded",
      status: 409,
      disposition: "rejected",
      recovery: "none",
      uncertain: false,
    });
    expectClassified(rpc(-32800, "request cancelled"), {
      code: "prompt_not_admitted",
      status: 503,
      disposition: "not_sent",
      recovery: "none",
      uncertain: false,
    });
  });

  test("input receipt capacity is not sent, needs no recovery and never blocks", () => {
    expect(promptErrorDefinition("input_receipt_capacity")).toMatchObject({
      code: "input_receipt_capacity",
      status: 503,
      disposition: "not_sent",
      recovery: "none",
      uncertain: false,
    });
    expectClassified(
      Object.assign(new Error("input receipt capacity"), { code: "input_receipt_capacity" }),
      {
        code: "input_receipt_capacity",
        status: 503,
        disposition: "not_sent",
        recovery: "none",
        uncertain: false,
      },
    );
    expect(promptErrorDefinition("input_receipt_capacity")?.message).toContain("消息未发送");
  });

  test("unclassified errors never leak upstream text", () => {
    const classified = classifyPromptError(
      rpc(
        -1,
        "failed https://internal.example/path token=0123456789abcdef0123456789abcdef",
      ),
    );
    expect(classified).toMatchObject({
      code: "prompt_failed",
      status: 500,
      disposition: "unknown",
      recovery: "reload",
      uncertain: true,
    });
    expect(classified.message).not.toContain("internal.example");
    expect(classified.message).not.toContain("0123456789abcdef");
  });

  test("legacy queue codes remain available for rollback and diagnostics", () => {
    const cases: Array<[string, number, string]> = [
      ["queue_stale", 409, "reload"],
      ["queue_closed", 503, "rebuild"],
      ["queue_full", 429, "none"],
      ["queue_identity_conflict", 409, "none"],
      ["queue_unavailable", 409, "rebuild"],
    ];
    for (const [code, status, recovery] of cases) {
      expect(promptErrorDefinition(code)).toMatchObject({
        code,
        status,
        recovery,
      });
      expectClassified(Object.assign(new Error(code), { code }), {
        code,
        status,
        disposition: "rejected",
        recovery,
        uncertain: false,
      });
    }
    expect(PROMPT_ERROR_CODES).toContain("session_busy");
    expect(PROMPT_ERROR_CODES).toContain("queue_stale");
  });

  test("plain JSON-RPC error envelopes are accepted", () => {
    expectClassified(
      {
        error: {
          code: -32000,
          message: "Conversation persistence is uncertain; reload the session",
          data: { kind: "internal" },
        },
      },
      {
        code: "persistence_inconsistent",
        status: 503,
        disposition: "unknown",
        recovery: "rebuild",
        uncertain: true,
      },
    );
  });
});

describe("classifyAgentExecutionFailure", () => {
  test("persistence notices take priority over generic execution failure", () => {
    expect(classifyAgentExecutionFailure(
      "Conversation persistence outcome is unconfirmed; reload the session to recover",
    )).toMatchObject({
      code: "persistence_inconsistent",
      status: 503,
      disposition: "unknown",
      recovery: "rebuild",
      uncertain: true,
    });
    expect(classifyAgentExecutionFailure(
      "Session persistence is not settled; retry after recovery",
    )).toMatchObject({
      code: "persistence_pending",
      status: 503,
      disposition: "unknown",
      recovery: "rebuild",
    });
    expect(classifyAgentExecutionFailure("LLM HTTP 500")).toMatchObject({
      code: "execution_failed",
      status: 502,
      disposition: "unknown",
      recovery: "none",
    });
  });

  test("helpers identify persistence and admission classes", () => {
    expect(isPersistencePromptError("persistence_pending")).toBe(true);
    expect(isPersistencePromptError("execution_failed")).toBe(false);
    expect(isAdmissionPromptError("session_busy")).toBe(true);
    expect(isAdmissionPromptError("persistence_inconsistent")).toBe(false);
  });
});
