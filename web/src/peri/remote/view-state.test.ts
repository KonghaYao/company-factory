import { describe, expect, test } from "bun:test";
import { RemoteActionError, type RemoteDisposition } from "./actions";
import {
  derivePhase,
  describeActionFailure,
  type ChatRecovery,
} from "./view-state";

interface Case {
  code: string;
  recovery: ChatRecovery;
  uncertain: boolean;
  blocked: boolean;
  disposition?: RemoteDisposition;
  includes?: string;
}

const CASES: Case[] = [
  { code: "stale_session", recovery: "reload", uncertain: false, blocked: true },
  { code: "chat_not_found", recovery: "reload", uncertain: false, blocked: true },
  { code: "session_restore_failed", recovery: "reload", uncertain: false, blocked: true },
  { code: "prompt_failed", recovery: "reload", uncertain: true, blocked: true, disposition: "unknown" },
  { code: "session_closed", recovery: "rebuild", uncertain: false, blocked: true },
  { code: "runtime_unavailable", recovery: "rebuild", uncertain: false, blocked: true },
  {
    code: "persistence_pending",
    recovery: "rebuild",
    uncertain: true,
    blocked: true,
    disposition: "unknown",
    includes: "重新加载无效，请重启会话；不要重发",
  },
  {
    code: "persistence_inconsistent",
    recovery: "rebuild",
    uncertain: true,
    blocked: true,
    disposition: "unknown",
    includes: "重新加载无效，请重启会话；不要重发",
  },
  { code: "close_incomplete", recovery: "rebuild", uncertain: true, blocked: true, disposition: "unknown" },
  { code: "closed", recovery: "rebuild", uncertain: false, blocked: true },
  { code: "queue_closed", recovery: "rebuild", uncertain: false, blocked: true },
  { code: "queue_stale", recovery: "reload", uncertain: false, blocked: true },
  { code: "queue_unavailable", recovery: "rebuild", uncertain: false, blocked: true },
  { code: "session_busy", recovery: "none", uncertain: false, blocked: false },
  { code: "session_closing", recovery: "none", uncertain: false, blocked: false },
  { code: "prompt_superseded", recovery: "none", uncertain: false, blocked: false },
  { code: "invalid_prompt", recovery: "none", uncertain: false, blocked: false },
  { code: "idempotency_conflict", recovery: "none", uncertain: false, blocked: false, disposition: "not_sent" },
  { code: "queue_full", recovery: "none", uncertain: false, blocked: false },
  { code: "queue_identity_conflict", recovery: "none", uncertain: false, blocked: false },
  { code: "execution_failed", recovery: "none", uncertain: true, blocked: false, disposition: "unknown" },
  { code: "prompt_not_admitted", recovery: "none", uncertain: false, blocked: false, disposition: "not_sent" },
  {
    code: "input_receipt_capacity",
    recovery: "none",
    uncertain: false,
    blocked: false,
    disposition: "not_sent",
    includes: "消息未发送",
  },
  { code: "not_sent", recovery: "none", uncertain: false, blocked: false, disposition: "not_sent" },
];

describe("describeActionFailure", () => {
  for (const item of CASES) {
    test(`${item.code} → ${item.recovery}`, () => {
      const failure = describeActionFailure(
        new RemoteActionError(item.code, "UPSTREAM_MESSAGE_MUST_NOT_LEAK", item.disposition ?? "rejected"),
      );
      expect(failure.recovery).toBe(item.recovery);
      expect(failure.uncertain).toBe(item.uncertain);
      expect(failure.blocked).toBe(item.blocked);
      expect(failure.code).toBe(item.code);
      expect(failure.message.length).toBeGreaterThan(0);
      expect(failure.message).not.toContain("UPSTREAM_MESSAGE_MUST_NOT_LEAK");
      if (item.includes) expect(failure.message).toContain(item.includes);
    });
  }

  test("unknown code and internal_error are uncertain but not blocked, and never say retry", () => {
    for (const code of ["internal_error", "some_future_code"]) {
      const failure = describeActionFailure(
        new RemoteActionError(code, "raw upstream detail", "rejected"),
      );
      expect(failure.recovery).toBe("none");
      expect(failure.uncertain).toBe(true);
      expect(failure.blocked).toBe(false);
      expect(failure.message).not.toContain("重试");
      expect(failure.message).not.toContain("raw upstream detail");
    }
  });

  test("server-provided recovery wins over the local code table", () => {
    const failure = describeActionFailure(
      new RemoteActionError("execution_failed", "upstream", "unknown", {
        recovery: "rebuild",
        uncertain: true,
      }),
    );
    expect(failure.recovery).toBe("rebuild");
    expect(failure.blocked).toBe(true);
    expect(failure.uncertain).toBe(true);
    expect(failure.message).not.toContain("upstream");
  });

  test("server-provided none unblocks even when the local table suggests rebuild", () => {
    const failure = describeActionFailure(
      new RemoteActionError("session_closed", "upstream", "rejected", { recovery: "none" }),
    );
    expect(failure.recovery).toBe("none");
    expect(failure.blocked).toBe(false);
  });

  test("non-RemoteActionError is treated as an unknown internal failure without blocking", () => {
    const failure = describeActionFailure(new Error("socket exploded"));
    expect(failure.recovery).toBe("none");
    expect(failure.uncertain).toBe(true);
    expect(failure.blocked).toBe(false);
    expect(failure.message).not.toContain("socket exploded");
  });
});

describe("derivePhase", () => {
  const base = {
    hasActive: true,
    loadState: "ready" as const,
    uncertain: false,
    executionBlocked: false,
    running: false,
    cancelPending: false,
    historyReady: true,
  };

  test("reload and rebuild both block a ready session", () => {
    expect(derivePhase({ ...base, recovery: "reload" })).toBe("blocked");
    expect(derivePhase({ ...base, recovery: "rebuild" })).toBe("blocked");
  });

  test("none does not block an idle ready session", () => {
    expect(derivePhase({ ...base, recovery: "none" })).toBe("idle");
  });

  test("execution_failed with an uncertain result does not block when recovery is none", () => {
    const failure = describeActionFailure(
      new RemoteActionError("execution_failed", "upstream", "unknown"),
    );
    expect(derivePhase({
      ...base,
      recovery: failure.recovery,
      uncertain: failure.uncertain,
    })).toBe("idle");
  });
});
