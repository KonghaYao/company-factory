import { describe, expect, test } from "bun:test";
import type { ChatUserAction } from "@peri-code/sdk";
import {
  ChatController,
  RemoteActionError,
  type ActionReceipt,
  type Chat,
  type ChatDisplayState,
  type ChatSummary,
  type ProjectSummary,
  type RemoteActions,
} from "./index";
import { nextDraftAfterSend } from "../chat/composer/ChatComposer";

const CHAT: Chat = {
  id: "session-1",
  title: "固定会话",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function displayState(overrides: Partial<ChatDisplayState> = {}): ChatDisplayState {
  return {
    chat: CHAT,
    sessionId: CHAT.id,
    bindingRevision: 1,
    running: false,
    executionBlocked: false,
    readiness: "ready",
    entries: [],
    toolCalls: [],
    turns: [],
    activeTurn: { turnId: null, status: null },
    session: {},
    tasks: [],
    plans: { current: [], byTurn: {} },
    interactions: [],
    pendingInteractions: [],
    inputQueue: null,
    ...overrides,
  };
}

function promptReceipt(requestId = "req-1"): ActionReceipt {
  return {
    requestId,
    chatId: CHAT.id,
    sessionId: CHAT.id,
    bindingRevision: 1,
    inputId: requestId,
    accepted: true,
    mode: "prompt",
    raw: {
      ok: true,
      requestId,
      chatId: CHAT.id,
      sessionId: CHAT.id,
      bindingRevision: 1,
      inputId: requestId,
      accepted: true,
      mode: "prompt",
    },
  };
}

function promptReceiptWithoutMode(requestId = "req-1"): ActionReceipt {
  const receipt = promptReceipt(requestId);
  const { mode: _mode, ...raw } = receipt.raw;
  const { mode: _receiptMode, ...withoutMode } = receipt;
  return { ...withoutMode, raw };
}

interface Harness {
  controller: ChatController;
  closeCalls: Array<{ address: string; options?: { force?: boolean } }>;
  waitCalls: () => number;
}

function makeController(
  execute: (action: ChatUserAction) => Promise<ActionReceipt>,
): Harness {
  let waits = 0;
  const closeCalls: Harness["closeCalls"] = [];
  const actions = {
    createHandle: async () => ({
      id: CHAT.id,
      sessionId: CHAT.id,
      bindingRevision: 1,
    }),
    execute: (_address: string, action: ChatUserAction) => execute(action),
    close: async (address: string, options?: { force?: boolean }) => {
      closeCalls.push({ address, ...(options ? { options } : {}) });
    },
    readPayload: async () => {
      throw new Error("not used");
    },
  } as unknown as RemoteActions;

  const controller = new ChatController({
    actions,
    list: async (): Promise<ChatSummary[]> => [],
    listProjects: async (): Promise<ProjectSummary[]> => [],
    createProject: async (): Promise<ProjectSummary> => ({
      id: "project-1",
      name: "项目",
      createdAt: CHAT.updatedAt,
      isDefault: false,
    }),
    syncUrl: () => "ws://test/sync",
  });

  const state = displayState();
  const active = {
    address: "chat-address",
    handleId: "chat-address",
    chat: CHAT,
    projection: {
      status: "synced",
      state: () => state,
      subscribe: () => () => {},
      dispose: async () => {},
    },
    sync: {
      status: "open",
      close: async () => {},
    },
    unsubscribe: () => {},
    everReady: true,
    delivery: {
      wait: () => {
        waits += 1;
        throw new Error("DeliveryTracker.wait must not be called for prompt mode");
      },
      settle: () => {},
      rejectAll: () => {},
    },
  };
  (controller as unknown as { active: unknown }).active = active;
  (controller as unknown as { view: unknown }).view = {
    selected: CHAT,
    state,
    phase: "idle",
    historyReady: true,
    loadState: "ready",
    liveSync: "synced",
    error: "",
    recovery: "none",
  };

  return { controller, closeCalls, waitCalls: () => waits };
}

describe("ChatController stop with prompt in flight", () => {
  test("sends cancel even before the replica projects running", async () => {
    const executed: string[] = [];
    const harness = makeController(async (action) => {
      executed.push(action.type);
      return { status: "requested" } as ActionReceipt;
    });
    expect(harness.controller.getState().state?.running).toBe(false);

    await harness.controller.stop({ promptInFlight: true });
    expect(executed).toEqual(["cancel"]);
  });

  test("stays a no-op when nothing is running and no prompt is in flight", async () => {
    const executed: string[] = [];
    const harness = makeController(async (action) => {
      executed.push(action.type);
      return { status: "requested" } as ActionReceipt;
    });
    expect(await harness.controller.stop()).toBe(true);
    expect(executed).toEqual([]);
  });
});

describe("ChatController prompt send", () => {
  test("202 prompt settles immediately without creating a DeliveryTracker", async () => {
    const harness = makeController(async () => promptReceipt());
    const outcome = await harness.controller.send("hello");

    expect(outcome.delivered).toBe(true);
    expect(outcome.sessionId).toBe(CHAT.id);
    expect(harness.waitCalls()).toBe(0);
    expect(nextDraftAfterSend("hello", "hello", outcome.delivered)).toBe("");
    expect(harness.controller.recoverableDraft("req-1")).toBe("hello");
  });

  test("receipt without mode defaults to prompt instead of legacy queue", async () => {
    const harness = makeController(async () => promptReceiptWithoutMode());
    const outcome = await harness.controller.send("hello");

    expect(outcome.delivered).toBe(true);
    expect(harness.waitCalls()).toBe(0);
    expect(harness.controller.recoverableDraft("req-1")).toBe("hello");
  });

  test("rejected HTTP failure keeps the draft and exposes no recovery draft", async () => {
    const harness = makeController(async () => {
      throw new RemoteActionError("session_busy", "UPSTREAM_MESSAGE", "rejected");
    });
    const outcome = await harness.controller.send("hello");

    expect(outcome.delivered).toBe(false);
    if (outcome.delivered) throw new Error("expected send to fail");
    expect(outcome.disposition).toBe("rejected");
    expect(outcome.blocked).toBeFalsy();
    expect(outcome.message).toContain("会话正忙");
    expect(outcome.message).not.toContain("UPSTREAM_MESSAGE");
    expect(nextDraftAfterSend("hello", "hello", outcome.delivered)).toBeNull();
    expect(harness.controller.recoverableDraft()).toBeNull();
  });

  test("unknown failure keeps input enabled, keeps the draft and never offers retry text", async () => {
    let calls = 0;
    const harness = makeController(async () => {
      calls += 1;
      throw new RemoteActionError("internal_error", "UPSTREAM_MESSAGE", "unknown");
    });
    const outcome = await harness.controller.send("hello");

    expect(outcome.delivered).toBe(false);
    if (outcome.delivered) throw new Error("expected send to fail");
    expect(outcome.disposition).toBe("unknown");
    // 没有 reload/rebuild 恢复入口时不阻断输入，否则用户会卡在无法恢复的错误上。
    expect(outcome.blocked).toBeFalsy();
    expect(outcome.message).not.toContain("重试");
    expect(nextDraftAfterSend("hello", "hello", outcome.delivered)).toBeNull();
    expect(harness.controller.getState().phase).not.toBe("blocked");
    expect(harness.controller.getState().recovery).toBe("none");

    // 不会自动重发；但用户再次发送应真正发出（execute 被再次调用）。
    expect(calls).toBe(1);
    const second = await harness.controller.send("继续");
    expect(calls).toBe(2);
    expect(second.delivered).toBe(false);
  });

  test("failure with a rebuild recovery entry blocks new sends until recovery runs", async () => {
    let calls = 0;
    const harness = makeController(async () => {
      calls += 1;
      throw new RemoteActionError("session_closed", "UPSTREAM_MESSAGE", "rejected");
    });
    const outcome = await harness.controller.send("hello");

    expect(outcome.delivered).toBe(false);
    if (outcome.delivered) throw new Error("expected send to fail");
    expect(outcome.blocked).toBe(true);
    expect(harness.controller.getState().phase).toBe("blocked");
    expect(harness.controller.getState().recovery).toBe("rebuild");

    const second = await harness.controller.send("继续");
    expect(second.delivered).toBe(false);
    if (second.delivered) throw new Error("expected send to fail");
    expect(second.blocked).toBe(true);
    expect(calls).toBe(1);
  });

  test("async promptFailure can offer the last submitted text only for the same request", async () => {
    const harness = makeController(async () => promptReceipt("req-42"));
    await harness.controller.send("需要恢复的原文");

    expect(harness.controller.recoverableDraft("req-42")).toBe("需要恢复的原文");
    expect(harness.controller.recoverableDraft("req-other")).toBeNull();
    // 只是内存读取，不自动写草稿、不自动重发。
    expect(harness.controller.recoverableDraft("req-42")).toBe("需要恢复的原文");
  });

  test("rebuildChat(force) issues DELETE with force=true", async () => {
    const harness = makeController(async () => promptReceipt());
    (harness.controller as unknown as {
      openChat: () => Promise<boolean>;
    }).openChat = async () => true;

    const rebuilt = await harness.controller.rebuildChat(true);

    expect(rebuilt).toBe(true);
    expect(harness.closeCalls).toEqual([
      { address: "chat-address", options: { force: true } },
    ]);
  });

  test("rebuildChat without force keeps the legacy DELETE", async () => {
    const harness = makeController(async () => promptReceipt());
    (harness.controller as unknown as {
      openChat: () => Promise<boolean>;
    }).openChat = async () => true;

    await harness.controller.rebuildChat();

    expect(harness.closeCalls).toEqual([
      { address: "chat-address", options: {} },
    ]);
  });
});
