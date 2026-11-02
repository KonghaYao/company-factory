import { describe, expect, test } from "bun:test";
import { ChatCloseIncompleteError } from "@peri-code/sdk";
import { InputReceiptCache } from "../../runtime/input-receipts";
import { PeriRuntime, RuntimeError, type RuntimeAgent } from "../../runtime";
import { WasmStoreError } from "../../runtime/wasm-store";
import { createPeriChatApi, type ChatScope } from "./chat-api";

const scopeInput = { companyId: "company", agentId: "agent" };

function binding() {
  return { chatId: "chat-1", sessionId: "s1", bindingRevision: 1 };
}

async function json(response: Response) {
  return (await response.json()) as Record<string, any>;
}

function sendBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "send",
    requestId: "req-1",
    payload: { text: "请回复 prompt-clean" },
    target: { sessionId: "s1", bindingRevision: 1 },
    ...overrides,
  };
}

function actionRequest(body: unknown) {
  return new Request(
    "http://company.test/api/chats/chat-1/actions?companyId=company&agentId=agent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function deleteRequest(query = "") {
  return new Request(
    `http://company.test/api/chats/chat-1?companyId=company&agentId=agent${query}`,
    { method: "DELETE" },
  );
}

function apiHarness(options: {
  send?: (input: RuntimeAgent, payload: any) => Promise<any>;
  state?: "ready" | "not_found" | "unavailable";
  restart?: (caller: any, agentId: string, options?: any) => Promise<unknown>;
  chatRunning?: boolean;
  wakeError?: unknown;
} = {}) {
  const calls = {
    sends: [] as Array<{ input: RuntimeAgent; payload: any }>,
    restarts: [] as Array<{ caller: any; agentId: string; options?: any }>,
    executes: [] as unknown[],
    stops: [] as RuntimeAgent[],
  };
  const chat = {
    id: "chat-1",
    sessionId: "s1",
    bindingRevision: 1,
    get binding() {
      return binding();
    },
    execute: async (action: unknown) => {
      calls.executes.push(action);
      throw new Error("queue path must not be used by send");
    },
  };
  const sendImpl =
    options.send ??
    (async (_input: RuntimeAgent, payload: any) => ({
      accepted: true,
      mode: "prompt",
      inputId: payload.requestId,
      requestId: payload.requestId,
      sessionId: "s1",
    }));
  const runtime = {
    validateSendText: (_input: RuntimeAgent, text: string) => text,
    wakeChat: async () => {
      if (options.wakeError !== undefined) throw options.wakeError;
      return chat;
    },
    sessionBinding: () => ({ sessionId: "s1", bindingRevision: 1 }),
    send: async (input: RuntimeAgent, payload: any) => {
      calls.sends.push({ input, payload });
      return sendImpl(input, payload);
    },
    chatForScope: () => (options.state === "not_found" ? undefined : chat),
    scopeChatState: () => options.state ?? "ready",
    chatRunning: () => options.chatRunning ?? false,
    stop: async (input: RuntimeAgent) => {
      calls.stops.push(input);
      return { requestId: "stop-1", status: "requested" };
    },
  };
  const api = createPeriChatApi({
    runtime: runtime as any,
    scope: async (): Promise<ChatScope> => ({
      caller: { type: "user", id: "owner", companyId: "company" } as any,
      agent: scopeInput as any,
      input: scopeInput as any,
    }),
    restart: async (caller, agentId, restartOptions) => {
      calls.restarts.push({ caller, agentId, options: restartOptions });
      return options.restart
        ? options.restart(caller, agentId, restartOptions)
        : undefined;
    },
  });
  return { api, calls, chat, runtime };
}

describe("POST /api/chats/:chatId/actions send = direct prompt", () => {
  test("admits through runtime.send and returns 202 prompt receipt without waiting for a turn", async () => {
    const harness = apiHarness();
    const response = await harness.api.request(actionRequest(sendBody()));
    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      ok: true,
      mode: "prompt",
      inputId: "req-1",
      accepted: true,
      requestId: "req-1",
      chatId: "chat-1",
      sessionId: "s1",
      bindingRevision: 1,
    });
    expect(harness.calls.sends).toHaveLength(1);
    expect(harness.calls.sends[0]?.payload).toEqual({
      text: "请回复 prompt-clean",
      requestId: "req-1",
    });
    // User send must not touch ChatUserAction.send / recoverStrandedInput.
    expect(harness.calls.executes).toEqual([]);
  });

  test("RuntimeError.details.disposition/recovery are preserved, never hardcoded rejected", async () => {
    const harness = apiHarness({
      send: async () => {
        throw new RuntimeError(
          "persistence_inconsistent",
          "会话持久化状态不一致；需要重建运行时，且不能自动重试。",
          503,
          {
            disposition: "unknown",
            recovery: "rebuild",
            uncertain: true,
            requestId: "req-1",
          },
        );
      },
    });
    const response = await harness.api.request(actionRequest(sendBody()));
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({
      ok: false,
      code: "persistence_inconsistent",
      disposition: "unknown",
      recovery: "rebuild",
      uncertain: true,
      requestId: "req-1",
      chatId: "chat-1",
    });
  });

  test("a classified 409 rejection stays a 409 with its recovery", async () => {
    const harness = apiHarness({
      send: async () => {
        throw new RuntimeError(
          "session_busy",
          "会话正忙，请等待当前任务结束后重试。",
          409,
          { disposition: "rejected", recovery: "none" },
        );
      },
    });
    const response = await harness.api.request(actionRequest(sendBody()));
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      code: "session_busy",
      disposition: "rejected",
      recovery: "none",
    });
  });
  test("known codes never echo the upstream English message", async () => {
    const harness = apiHarness({
      send: async () => {
        throw new RuntimeError(
          "input_receipt_capacity",
          "Input receipt capacity is occupied by pending or uncertain admissions; no new input was sent.",
          503,
          { disposition: "not_sent" },
        );
      },
    });
    const response = await harness.api.request(actionRequest(sendBody()));
    expect(response.status).toBe(503);
    const body = await json(response);
    expect(body).toMatchObject({
      code: "input_receipt_capacity",
      disposition: "not_sent",
      recovery: "none",
    });
    expect(String(body.message)).toContain("消息未发送");
    expect(String(body.message)).not.toContain("Input receipt capacity");
  });

  test("model_not_configured is normalized to a fixed Chinese message", async () => {
    const harness = apiHarness({
      send: async () => {
        throw new RuntimeError(
          "model_not_configured",
          'Model profile "default" has no usable model; configure $COMPANY_HOME/model-library.yaml.',
          409,
        );
      },
    });
    const response = await harness.api.request(actionRequest(sendBody()));
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.code).toBe("model_not_configured");
    expect(body.message).toContain("模型未配置");
    expect(String(body.message)).not.toContain("model-library");
  });
  test("target binding mismatch is a Chinese binding_conflict with reload", async () => {
    const harness = apiHarness();
    const response = await harness.api.request(actionRequest(sendBody({
      target: { sessionId: "s1", bindingRevision: 999 },
    })));
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body).toMatchObject({
      code: "binding_conflict",
      message: "会话绑定已过期，请重新加载会话后再继续。",
      disposition: "rejected",
      recovery: "reload",
    });
    expect(harness.calls.sends).toHaveLength(0);
  });

  test("malformed target is a Chinese invalid_action and never reaches runtime", async () => {
    const harness = apiHarness();
    const response = await harness.api.request(actionRequest(sendBody({
      target: { sessionId: 123, bindingRevision: 1 },
    })));
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.code).toBe("invalid_action");
    expect(body.message).toContain("target.sessionId");
    expect(body.recovery).toBe("none");
    expect(harness.calls.sends).toHaveLength(0);
  });
});

describe("store binding failures map to stable chat errors", () => {
  function wakeRequest() {
    return new Request(
      "http://company.test/api/chats?companyId=company&agentId=agent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
  }

  test("legacy_session_backend stays 409 with a fixed Chinese message", async () => {
    const harness = apiHarness({
      wakeError: new WasmStoreError(
        "legacy_session_backend",
        "该 Agent 有旧 Session 或 native sessions.db，但没有可信 wasm-sqld-v1 绑定。",
      ),
    });
    const response = await harness.api.request(wakeRequest());
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      ok: false,
      code: "legacy_session_backend",
      message: "该 Agent 仍使用旧版会话存储，消息未发送；请重新创建会话。",
      disposition: "rejected",
      recovery: "none",
    });
  });

  test("host store configuration failures are 503, never internal_error", async () => {
    const harness = apiHarness({
      wakeError: new WasmStoreError("wasm_store_not_configured", "宿主配置缺失"),
    });
    const response = await harness.api.request(wakeRequest());
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({
      ok: false,
      code: "wasm_store_not_configured",
      message: "会话存储未配置，消息未发送；请检查宿主存储配置。",
      disposition: "rejected",
      recovery: "none",
    });
  });
});

describe("DELETE /api/chats/:chatId availability and force", () => {
  test("unknown chat is 410 chat_not_found", async () => {
    const harness = apiHarness({ state: "not_found" });
    const response = await harness.api.request(deleteRequest());
    expect(response.status).toBe(410);
    expect(await json(response)).toMatchObject({
      code: "chat_not_found",
      message: "会话不存在，请重新加载会话。",
      disposition: "rejected",
      recovery: "reload",
    });
  });

  test("registered but cleanup-unconfirmed runtime is 503 runtime_unavailable, not 410", async () => {
    const harness = apiHarness({ state: "unavailable" });
    const response = await harness.api.request(deleteRequest());
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({
      code: "runtime_unavailable",
      disposition: "unknown",
      recovery: "rebuild",
      uncertain: true,
    });
  });

  test("DELETE ?force=1 passes force to restart and still returns 204", async () => {
    const harness = apiHarness();
    const response = await harness.api.request(deleteRequest("&force=1"));
    expect(response.status).toBe(204);
    expect(harness.calls.restarts).toHaveLength(1);
    expect(harness.calls.restarts[0]?.options).toEqual({ force: true });
  });

  test("force also bypasses the runtime_unavailable precheck", async () => {
    const harness = apiHarness({ state: "unavailable" });
    const response = await harness.api.request(deleteRequest("&force=true"));
    expect(response.status).toBe(204);
    expect(harness.calls.restarts[0]?.options).toEqual({ force: true });
  });

  test("a running chat is busy for a plain DELETE but force still attempts restart", async () => {
    const plain = apiHarness({ chatRunning: true });
    const busy = await plain.api.request(deleteRequest());
    expect(busy.status).toBe(409);
    expect(await json(busy)).toMatchObject({
      code: "busy",
      recovery: "none",
    });
    expect(plain.calls.restarts).toHaveLength(0);

    const forced = apiHarness({ chatRunning: true });
    const response = await forced.api.request(deleteRequest("&force=1"));
    expect(response.status).toBe(204);
    // force 先请求取消当前轮，再 restart(force)，避免旧 runtime 与新轮次叠加。
    expect(forced.calls.stops).toHaveLength(1);
    expect(forced.calls.restarts).toHaveLength(1);
    expect(forced.calls.restarts[0]?.options).toEqual({ force: true });
  });

  test("RuntimeError close_incomplete errors are publicly redacted", async () => {
    const harness = apiHarness({
      restart: async () => {
        throw new RuntimeError(
          "close_incomplete",
          "强制重建未完成；上一个运行时的关闭仍未确认。",
          503,
          {
            disposition: "unknown",
            recovery: "rebuild",
            uncertain: true,
            errors: [
              "close failed at https://secret.invalid/x?token=SUPERSECRET1234567890",
              "auth failed SUPERSECRET1234567890",
            ],
          },
        );
      },
    });
    const response = await harness.api.request(deleteRequest("&force=1"));
    expect(response.status).toBe(503);
    const serialized = JSON.stringify(await json(response));
    expect(serialized).not.toContain("secret.invalid");
    expect(serialized).not.toContain("SUPERSECRET1234567890");
  });

  test("force rebuild failure returns explicit close_incomplete", async () => {
    const harness = apiHarness({
      restart: async () => {
        throw new RuntimeError(
          "close_incomplete",
          "强制重建未完成；上一个运行时的关闭仍未确认。",
          503,
          {
            disposition: "unknown",
            recovery: "rebuild",
            uncertain: true,
            errors: ["Session close failed"],
          },
        );
      },
    });
    const response = await harness.api.request(deleteRequest("&force=1"));
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({
      code: "close_incomplete",
      disposition: "unknown",
      incomplete: true,
      errors: ["Session close failed"],
    });
  });

  test("ChatCloseIncompleteError is a Chinese 503 without leaking failure detail", async () => {
    const harness = apiHarness({
      restart: async () => {
        throw new ChatCloseIncompleteError(
          [new Error("close failed at https://secret.invalid/x?token=SUPERSECRET1234567890")],
          "raw upstream close failure",
        );
      },
    });
    const response = await harness.api.request(deleteRequest("&force=1"));
    expect(response.status).toBe(503);
    const body = await json(response);
    expect(body).toMatchObject({
      code: "close_incomplete",
      message: "会话关闭未完成，请重启会话；不要重发。",
      disposition: "unknown",
      recovery: "rebuild",
      incomplete: true,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret.invalid");
    expect(serialized).not.toContain("SUPERSECRET1234567890");
    expect(serialized).not.toContain("raw upstream");
  });
});

/**
 * Runtime-level projection tests: use a real PeriRuntime prototype with an
 * injected bound handle and fake direct-prompt transport, so HTTP/queue paths
 * are not involved.
 */
function runtimeHarness(prompt: (text: string) => Promise<unknown>) {
  const input: RuntimeAgent = {
    companyId: "company",
    agentId: "agent",
    directory: "/tmp/company-prompt-test",
    sessionId: "s1",
  };
  const view = {
    running: false,
    tasks: [],
    activeTurnStatus: "idle",
    executionBlocked: false,
    closed: false,
    closedReason: null,
    readiness: "ready",
    activeTurnId: null,
    turns: [],
    inputQueue: null,
    pendingInteractions: [],
    plan: [],
    session: { availableCommands: [] },
  };
  const bound: any = {
    input,
    manager: {},
    chat: { id: "chat-1", sessionId: "s1", bindingRevision: 1 },
    replica: { read: () => view },
    configured: true,
    modelAlias: "sonnet",
    model: "fixture",
    modelMeta: null,
    nextCursor: null,
    promptInFlight: new Map<string, { startedAt: string }>(),
  };
  const runtime: any = Object.create(PeriRuntime.prototype);
  runtime.agents = new Map([["company/agent", bound]]);
  runtime.provisioned = new Map();
  runtime.promptTransports = new Map([
    ["chat-1", { prompt, cancel: async () => {} }],
  ]);
  runtime.deliveries = new InputReceiptCache();
  runtime.database = { redact: (value: unknown) => value };
  runtime.accepting = true;
  runtime.locks = new Map();
  runtime.wake = async () => bound;
  return { runtime: runtime as PeriRuntime, bound, input };
}

describe("prompt admission and asynchronous failure projection", () => {
  test("window-internal success still returns the prompt admission, and flushes in-flight", async () => {
    const harness = runtimeHarness(async () => ({ stopReason: "end_turn" }));
    const receipt = await harness.runtime.send(harness.input, {
      text: "done quickly",
      requestId: "quick",
    });
    expect(receipt).toMatchObject({
      accepted: true,
      mode: "prompt",
      inputId: "quick",
      requestId: "quick",
      sessionId: "s1",
    });
    const snapshot = harness.runtime.snapshot(scopeInput) as any;
    expect(snapshot.promptInFlight).toBe(0);
    expect(snapshot.promptFailure).toBeNull();
    expect(snapshot.capabilities.queue).toBe(false);
  });

  test("failure after the admission window is projected to promptFailure and is never auto-resent", async () => {
    let calls = 0;
    const harness = runtimeHarness(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 800));
      const error = new Error("provider failed") as Error & {
        code: number;
        data: unknown;
      };
      error.code = -32000;
      error.data = { kind: "llm_http", status: 500 };
      throw error;
    });
    const admission = await harness.runtime.send(harness.input, {
      text: "slow failure",
      requestId: "slow-1",
    });
    expect(admission.accepted).toBe(true);
    expect(harness.bound.promptInFlight.size).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 950));
    const snapshot = harness.runtime.snapshot(scopeInput) as any;
    expect(snapshot.promptInFlight).toBe(0);
    expect(snapshot.promptFailure).toMatchObject({
      requestId: "slow-1",
      code: "execution_failed",
      disposition: "unknown",
      recovery: "none",
    });

    const replay = await harness.runtime.send(harness.input, {
      text: "slow failure",
      requestId: "slow-1",
    });
    expect(replay.inputId).toBe("slow-1");
    expect(calls).toBe(1);
    expect(harness.runtime.snapshot(scopeInput).promptFailure).toMatchObject({
      requestId: "slow-1",
      code: "execution_failed",
    });
  });

  test("AgentExecutionFailed persistence notice upgrades the projection without duplicating it", async () => {
    const harness = runtimeHarness(async () => {
      throw Object.assign(new Error("provider failed"), {
        code: -32000,
        data: { kind: "llm" },
      });
    });
    await expect(
      harness.runtime.send(harness.input, {
        text: "failure",
        requestId: "failure-1",
      }),
    ).rejects.toMatchObject({
      code: "execution_failed",
      details: { disposition: "unknown" },
    });
    const internals = harness.runtime as any;
    internals.recordNoticePromptFailure(
      harness.bound,
      "Conversation persistence outcome is unconfirmed; reload the session to recover",
    );
    const snapshot = harness.runtime.snapshot(scopeInput) as any;
    expect(snapshot.promptFailure).toMatchObject({
      code: "persistence_inconsistent",
      disposition: "unknown",
      recovery: "rebuild",
    });

    // A later generic notice must not downgrade persistence wording.
    internals.recordNoticePromptFailure(harness.bound, "LLM HTTP 500");
    expect(harness.runtime.snapshot(scopeInput).promptFailure).toMatchObject({
      code: "persistence_inconsistent",
    });
  });

  test("new admission clears a previous promptFailure", async () => {
    const harness = runtimeHarness(async () => ({ stopReason: "end_turn" }));
    const internals = harness.runtime as any;
    internals.recordNoticePromptFailure(
      harness.bound,
      "LLM HTTP 500",
    );
    expect(harness.runtime.snapshot(scopeInput).promptFailure).not.toBeNull();
    await harness.runtime.send(harness.input, {
      text: "new prompt",
      requestId: "new-1",
    });
    expect(harness.runtime.snapshot(scopeInput).promptFailure).toBeNull();
  });

  test("a rebuild-recovery failure refuses a new admission until the runtime is rebuilt", async () => {
    let calls = 0;
    const harness = runtimeHarness(async () => {
      calls += 1;
      return { stopReason: "end_turn" };
    });
    const internals = harness.runtime as any;
    internals.recordNoticePromptFailure(
      harness.bound,
      "Conversation persistence outcome is unconfirmed; reload the session to recover",
    );
    await expect(
      harness.runtime.send(harness.input, {
        text: "must not be admitted",
        requestId: "blocked-1",
      }),
    ).rejects.toMatchObject({
      code: "persistence_inconsistent",
      details: {
        // 本次输入确定未发送：不能用旧失败的 unknown 污染 receipt 缓存。
        disposition: "rejected",
        recovery: "rebuild",
        uncertain: true,
      },
    });
    expect(calls).toBe(0);
    expect(harness.runtime.snapshot(scopeInput).promptFailure).toMatchObject({
      code: "persistence_inconsistent",
      recovery: "rebuild",
    });
    // rejected 会让 receipt 缓存删除条目：既不占容量，也不会毒化同一 requestId。
    expect(internals.deliveries.size).toBe(0);

    // 模拟 rebuild 完成：同一 requestId 可以重新发送。
    harness.bound.promptFailure = undefined;
    const replay = await harness.runtime.send(harness.input, {
      text: "must not be admitted",
      requestId: "blocked-1",
    });
    expect(replay).toMatchObject({ accepted: true, mode: "prompt", inputId: "blocked-1" });
    expect(calls).toBe(1);
  });
});
