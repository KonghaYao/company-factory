import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatActionError } from "@peri-code/sdk";
import { PeriRuntime, RuntimeError, type RuntimeAgent } from "./index";
import { ScopedWasmStore, storeScopeId } from "./wasm-store";
import { INPUT_RECEIPT_LIMIT, InputReceiptCache } from "./input-receipts";
import { AgentService } from "../server/agent-service";
import { createPeriChatApi } from "../server/peri/chat-api";
import { createRemoteActions } from "../../web/src/peri/remote/actions";
import { ChatController } from "../../web/src/peri/remote/controller";

// Real host activation, manifest, service, HTTP and browser open control flow.
// Only the external store endpoint lookup / SDK Chat / live sync boundaries are replaced.
const previousWorkspace = process.env.COMPANY_WORKSPACE;
process.env.COMPANY_WORKSPACE = "disabled";
afterAll(() => {
  if (previousWorkspace === undefined) delete process.env.COMPANY_WORKSPACE;
  else process.env.COMPANY_WORKSPACE = previousWorkspace;
});
const temporary: string[] = [];
const runtimes: PeriRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(session: "present" | "missing" | "wrong-cwd" = "present") {
  const root = await mkdtemp(join(tmpdir(), "company-binding-recovery-"));
  temporary.push(root);
  const input: RuntimeAgent = {
    companyId: "company", agentId: "agent", directory: join(root, "agent"),
    sessionId: "original-session", name: "Agent", config: {},
  };
  await mkdir(input.directory, { recursive: true });
  const manifestDirectory = join(root, "runtime", "wasm-stores");
  const configDirectory = join(root, "runtime", "effective-config");
  await mkdir(manifestDirectory, { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  const manifestPath = join(manifestDirectory, storeScopeId(input) + ".json");
  const binding = {
    backend: "wasm-sqld-v1" as const, companyId: input.companyId, agentId: input.agentId,
    cwd: input.directory, storeIdentity: "a".repeat(64), state: "bound" as const,
    sessionId: input.sessionId!,
  };
  await writeFile(manifestPath, JSON.stringify(binding));
  const effective = {
    settings: { config: {} }, configured: true,
    model: { activeAlias: "sonnet", configured: true, model: "fixture" },
    configuration: {}, mcpServers: {},
  };
  await writeFile(join(configDirectory, "agent.json"), JSON.stringify(effective));
  const sessions = new Map<string, any>();
  if (session !== "missing") sessions.set(input.sessionId!, {
    sessionId: input.sessionId, cwd: session === "wrong-cwd" ? join(root, "another-agent") : input.directory,
  });
  const storage = { getSession: async (id: string) => sessions.get(id) ?? null };
  const store = new ScopedWasmStore(storage as any, input, binding.storeIdentity, binding, manifestPath);
  const actions: Array<{ type: string; sessionId?: string }> = [];
  const chatOptions: any[] = [];
  const factObservers: Array<(envelope: any) => void> = [];
  let creates = 0;
  const manager = {
    createChat(options: any) {
      chatOptions.push(options);
      creates++;
      const chat: any = {
        id: `chat-${creates}`, sessionId: null, bindingRevision: 0,
        get binding() { return chat.sessionId ? { chatId: chat.id, sessionId: chat.sessionId, bindingRevision: chat.bindingRevision } : null; },
        subscribeFacts: (observer: any) => {
          factObservers.push((envelope) => observer.onFact?.(envelope));
          return () => {};
        },
        execute(action: any) {
          actions.push({ type: action.type, sessionId: action.payload?.sessionId });
          if (action.type === "create_new_session") {
            chat.sessionId = "replacement-session";
            sessions.set(chat.sessionId, { sessionId: chat.sessionId, cwd: input.directory });
          } else if (action.type === "change_session") chat.sessionId = action.payload.sessionId;
          chat.bindingRevision = 1;
          return { chatId: chat.id, sessionId: chat.sessionId, bindingRevision: chat.bindingRevision };
        },
      };
      return chat;
    },
    closeChat: async () => {},
  };
  const runtime = new PeriRuntime({ root });
  runtimes.push(runtime);
  const internals = runtime as any;
  internals.agentManager = async () => ({ manager, store });
  internals.attachView = () => ({ sync: () => {} });
  internals.settings = () => effective;
  const caller = { type: "user" as const, id: "owner", companyId: input.companyId };
  const service = new AgentService({ getAgent: async () => input } as any, runtime);
  const api = createPeriChatApi({
    runtime,
    scope: async () => ({ caller, agent: input as any, input }),
    restart: async () => {},
  });
  return { root, input, manifestPath, runtime, internals, store, actions, chatOptions, caller, service, api, creates: () => creates, emitFact: (envelope: any) => factObservers.forEach((observer) => observer(envelope)) };
}

test("wake and explicit restart leave existing frozen Session instructions untouched", async () => {
  const f = await fixture("present");
  await f.runtime.wake({ ...f.input, responsibilities: "mutable-old" });
  await f.runtime.restart({ ...f.input, responsibilities: "mutable-new", systemPrompt: "new-guidance" });
  expect(f.chatOptions.length).toBe(2);
  expect(f.chatOptions.every((options) => options.session.instructions === undefined)).toBe(true);
  expect(f.actions.every((action) => action.type === "change_session" && action.sessionId === "original-session")).toBe(true);
});

test("an existing Session with another cwd fails before SDK activation and preserves the binding", async () => {
  const f = await fixture("wrong-cwd");
  await expect(f.runtime.wake(f.input)).rejects.toMatchObject({ code: "wasm_session_cwd_mismatch" });
  expect(f.creates()).toBe(0);
  expect(f.actions).toEqual([]);
  expect(JSON.parse(await readFile(f.manifestPath, "utf8")).sessionId).toBe("original-session");
});

test("confirmed missing Session replacement is authoritative in warm and cold service projections", async () => {
  const f = await fixture("missing");
  await f.runtime.wake(f.input);
  expect(f.chatOptions[0].session.instructions).toContain("公司身份与边界");
  expect(f.chatOptions[0].session.instructions).toContain("CLAUDE.md");
  expect(f.actions).toEqual([{ type: "create_new_session", sessionId: undefined }]);
  const expected = { sessionId: "replacement-session", replacesSessionId: "original-session" };
  expect(await f.runtime.sessionBinding(f.input)).toEqual(expected);
  expect(await f.service.snapshot(f.caller, f.input.agentId)).toMatchObject(expected);
  await f.runtime.shutdown();
  const cold = new PeriRuntime({ root: f.root });
  runtimes.push(cold);
  const coldService = new AgentService({ getAgent: async () => f.input } as any, cold);
  expect(await coldService.snapshot(f.caller, f.input.agentId)).toMatchObject(expected);
  expect(f.input.sessionId).toBe("original-session");
});

test("a partial business provision confirms its exact Session and never replaces missing history", async () => {
  const f = await fixture("missing");
  await expect(f.runtime.provision(f.input)).rejects.toMatchObject({ code: "wasm_session_missing" });
  expect(f.creates()).toBe(0);
  expect(JSON.parse(await readFile(f.manifestPath, "utf8")).sessionId).toBe("original-session");
  await expect(f.runtime.provision({ ...f.input, sessionId: "unrelated-session" })).rejects.toMatchObject({ code: "wasm_session_binding_mismatch" });
  expect(f.actions).toEqual([]);
});

test("the browser follows an explicit replacement through the real HTTP and action contracts", async () => {
  const f = await fixture("missing");
  const bodies: any[] = [];
  const actions = createRemoteActions({
    origin: "http://company.test",
    fetch: (async (url, init) => {
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      return f.api.request(new Request(String(url), init));
    }) as typeof fetch,
  });
  const controller = new ChatController({
    actions, list: async () => [], listProjects: async () => [],
    createProject: async () => { throw new Error("unused"); }, syncUrl: () => "ws://unused",
  });
  let activated: any;
  (controller as any).activate = async (record: any) => { activated = record; return true; };
  try {
    expect(await controller.openChat({ sessionId: "original-session", title: "Agent", updatedAt: "2026-01-01" })).toBe(true);
    expect(activated.chat.id).toBe("replacement-session");
    expect(bodies[1].payload.sessionId).toBe("replacement-session");
    expect(bodies[1].target).toEqual({ sessionId: "replacement-session", bindingRevision: 1 });
    expect((controller as any).actionError).toContain("原历史未恢复");
    // A stale directory entry remains explainable after the first replacement.
    expect(await actions.createHandle("original-session")).toMatchObject({ sessionId: "replacement-session", replacesSessionId: "original-session" });
    await expect(actions.createHandle("unrelated-session")).rejects.toMatchObject({ code: "binding_conflict" });
  } finally { controller.dispose(); }
});

test("browser does not silently accept an unrelated handle", async () => {
  const sent: unknown[] = [];
  const controller = new ChatController({
    actions: {
      createHandle: async () => ({ id: "handle", sessionId: "other-session", bindingRevision: 1 }),
      execute: async (...args: unknown[]) => { sent.push(args); throw new Error("must not send"); },
      close: async () => {}, readPayload: async () => { throw new Error("unused"); },
    },
    list: async () => [], listProjects: async () => [],
    createProject: async () => { throw new Error("unused"); }, syncUrl: () => "ws://unused",
  });
  try {
    expect(await controller.openChat({ sessionId: "original-session", title: "Agent", updatedAt: "2026-01-01" })).toBe(false);
    expect(sent).toEqual([]);
    expect(controller.getState().error).toContain("会话绑定已过期，请重新加载会话后再继续。");
  } finally { controller.dispose(); }
});

test("runtime internal send retains bounded digests, deduplicates admission, and clears after shutdown", async () => {
  const f = await fixture();
  const bound = await f.runtime.wake(f.input);
  let sends = 0;
  const projected: string[] = [];
  let finishes = 0;
  f.internals.promptTransports.set(bound.chat.id, {
    prompt: async () => {
      sends++;
      return { stopReason: "end_turn" };
    },
    cancel: async () => {},
    announceExternalUserTurn: (text: string) => {
      projected.push(text);
      return true;
    },
    finishExternalUserTurn: () => {
      finishes++;
    },
  });
  const payload = { requestId: "same", text: "正文".repeat(8192) };
  const results = await Promise.all([f.runtime.send(f.input, payload), f.runtime.send(f.input, payload)]);
  expect(results[0].inputId).toBe(results[1].inputId);
  expect(sends).toBe(1);
  expect(projected).toHaveLength(1);
  expect(projected[0]).toBe(payload.text);
  await Promise.resolve();
  expect(finishes).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < INPUT_RECEIPT_LIMIT + 5; i++)
    await f.runtime.send(f.input, { requestId: `notice-${i}`, text: `${i}:` + payload.text });
  const entries = [...f.internals.deliveries.entries.values()] as Array<{ fingerprint: string }>;
  expect(entries).toHaveLength(INPUT_RECEIPT_LIMIT);
  expect(entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.fingerprint))).toBe(true);
  await f.runtime.shutdown();
  expect(f.internals.deliveries.size).toBe(0);
});

test("an execution-failed notice clears a prompt lease whose RPC never settles", async () => {
  const f = await fixture();
  const bound = await f.runtime.wake(f.input);
  // Transport 在整轮结束后才应 settle；这里模拟传输故障下永不 settle 的 RPC。
  f.internals.promptTransports.set(bound.chat.id, {
    prompt: () => new Promise(() => {}),
    cancel: async () => {},
    announceExternalUserTurn: () => true,
    finishExternalUserTurn: () => {},
  });
  const admission = await f.runtime.send(f.input, {
    requestId: "stuck",
    text: "work",
  });
  expect(admission.accepted).toBe(true);
  expect(f.runtime.workState(f.input).promptInFlight).toBe(1);

  // AgentExecutionFailed notice 到达时该轮已经结束。
  f.emitFact({
    fact: {
      kind: "notice",
      notification: {
        method: "peri/agent_event",
        params: {
          event_json: JSON.stringify({
            type: "agent_execution_failed",
            value: {
              message: "Agent execution failed: remote store transport failed",
              turn_id: "turn-1",
              stop_reason: "error",
            },
          }),
          _meta: { peri: { eventId: "evt-1" } },
        },
      },
    },
  });

  expect(f.runtime.workState(f.input)).toMatchObject({
    promptInFlight: 0,
    running: false,
  });
  expect(bound.promptFailure).toMatchObject({
    code: "execution_failed",
    disposition: "unknown",
    recovery: "none",
  });
});

test("runtime send retries not_sent and rejected, but preserves an unknown admission", async () => {
  const f = await fixture();
  const bound = await f.runtime.wake(f.input);
  let sends = 0;
  let failure: Error | undefined;
  f.internals.promptTransports.set(bound.chat.id, {
    prompt: async () => {
      sends++;
      if (failure) throw failure;
      return { stopReason: "end_turn" };
    },
    cancel: async () => {},
    announceExternalUserTurn: () => true,
    finishExternalUserTurn: () => {},
  });
  bound.configured = false;
  await expect(f.runtime.send(f.input, { requestId: "config", text: "work" })).rejects.toMatchObject({ details: { disposition: "not_sent" } });
  expect(sends).toBe(0);
  bound.configured = true;
  expect((await f.runtime.send(f.input, { requestId: "config", text: "work" })).accepted).toBe(true);
  failure = Object.assign(
    new Error("Session context is owned by an in-flight prompt"),
    { code: -32010 },
  );
  await expect(f.runtime.send(f.input, { requestId: "retry", text: "work" })).rejects.toMatchObject({ details: { disposition: "rejected" } });
  failure = undefined;
  expect((await f.runtime.send(f.input, { requestId: "retry", text: "work" })).accepted).toBe(true);
  f.internals.deliveries = new InputReceiptCache({ limit: 1 });
  failure = new ChatActionError("unknown", "send_failed", "response lost", "unknown");
  await expect(f.runtime.send(f.input, { requestId: "unknown", text: "work" })).rejects.toBeInstanceOf(RuntimeError);
  const acceptedCalls = sends;
  failure = undefined;
  await expect(f.runtime.send(f.input, { requestId: "unknown", text: "work" })).rejects.toMatchObject({ details: { disposition: "unknown" } });
  await expect(f.runtime.send(f.input, { requestId: "new", text: "work" })).rejects.toMatchObject({ code: "input_receipt_capacity", details: { disposition: "not_sent" } });
  expect(sends).toBe(acceptedCalls);
});

test("automatic stranded-input repair leaves a multi-input queue for the Agent/runtime to order", async () => {
  const f = await fixture();
  const bound = await f.runtime.wake(f.input);
  const view = bound.replica.read();
  bound.replica.read = () => ({
    ...view, running: false, executionBlocked: false, closed: false,
    pendingInteractions: [], activeTurnId: null,
    inputQueue: { activeRequestId: null, items: [
      { inputId: "one", state: "queued" }, { inputId: "two", state: "queued" },
    ] },
  }) as any;
  const before = f.actions.length;
  await f.runtime.recoverChatInput(f.input, "one");
  expect(f.actions.slice(before)).toEqual([]);
});
