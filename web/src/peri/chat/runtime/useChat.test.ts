import { describe, expect, test } from "bun:test";
import type { RuntimePromptFailure } from "../../../lib/types";
import {
  errorBanners,
  isPromptFailureBlocking,
  promptFailureBanner,
  promptFailureKey,
} from "./useChat";

function failure(overrides: Partial<RuntimePromptFailure> = {}): RuntimePromptFailure {
  return {
    requestId: "req-1",
    code: "prompt_failed",
    message: "服务端固定中文",
    disposition: "unknown",
    recovery: "reload",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("errorBanners recovery routing", () => {
  test("reload maps to reload-chat and stays non-dismissible", () => {
    const banners = errorBanners({
      listError: "",
      chatError: "会话绑定已过期",
      loadState: "ready",
      recovery: "reload",
    });
    expect(banners.chat?.action).toBe("reload-chat");
    expect(banners.chat?.dismissible).toBe(false);
  });

  test("rebuild maps to rebuild-chat and stays non-dismissible", () => {
    const banners = errorBanners({
      listError: "",
      chatError: "会话持久化状态不一致",
      loadState: "ready",
      recovery: "rebuild",
    });
    expect(banners.chat?.action).toBe("rebuild-chat");
    expect(banners.chat?.dismissible).toBe(false);
  });

  test("none stays dismissible and does not offer retry", () => {
    const banners = errorBanners({
      listError: "",
      chatError: "会话正忙",
      loadState: "ready",
      recovery: "none",
    });
    expect(banners.chat?.action).toBe("none");
    expect(banners.chat?.dismissible).toBe(true);
  });
});

describe("isPromptFailureBlocking", () => {
  test("execution_failed does not block and is dismissible with no recovery action", () => {
    const current = failure({
      code: "execution_failed",
      disposition: "unknown",
      recovery: "none",
    });
    expect(isPromptFailureBlocking(current)).toBe(false);

    const banner = promptFailureBanner(current);
    expect(banner?.action).toBe("none");
    expect(banner?.dismissible).toBe(true);
    expect(banner?.message).toContain("本轮结果不确定，不会自动重发");
    expect(promptFailureBanner(current, promptFailureKey(current))).toBeNull();
  });

  test("persistence_inconsistent blocks and always offers rebuild without dismiss", () => {
    const current = failure({
      code: "persistence_inconsistent",
      disposition: "unknown",
      recovery: "rebuild",
    });
    expect(isPromptFailureBlocking(current)).toBe(true);

    const banner = promptFailureBanner(current);
    expect(banner?.action).toBe("rebuild-chat");
    expect(banner?.dismissible).toBe(false);
    expect(promptFailureBanner(current, promptFailureKey(current))).not.toBeNull();
  });

  test("prompt_failed does not block and offers reload only", () => {
    const current = failure({
      code: "prompt_failed",
      disposition: "unknown",
      recovery: "reload",
    });
    expect(isPromptFailureBlocking(current)).toBe(false);

    const banner = promptFailureBanner(current);
    expect(banner?.action).toBe("reload-chat");
    expect(banner?.message).toContain("恢复：重新加载会话");
  });
});

describe("promptFailureBanner", () => {
  test("shows code, fixed Chinese detail and recovery", () => {
    const banner = promptFailureBanner(failure());
    expect(banner).not.toBeNull();
    expect(banner?.code).toBe("prompt_failed");
    expect(banner?.recovery).toBe("reload");
    expect(banner?.action).toBe("reload-chat");
    expect(banner?.dismissible).toBe(false);
    expect(banner?.message).toContain("[prompt_failed]");
    expect(banner?.message).toContain("恢复：重新加载会话");
    expect(banner?.message).not.toContain("重试");
  });

  test("persistence_inconsistent keeps the no-reload warning", () => {
    const banner = promptFailureBanner(failure({
      code: "persistence_inconsistent",
      recovery: "rebuild",
    }));
    expect(banner?.action).toBe("rebuild-chat");
    expect(banner?.message).toContain("重新加载无效，请重启会话；不要重发");
    expect(banner?.message).toContain("恢复：重启会话");
  });

  test("unknown code does not pass the runtime message through", () => {
    const banner = promptFailureBanner(failure({
      code: "future_prompt_code",
      message: "UPSTREAM_MESSAGE_MUST_NOT_LEAK",
      recovery: "none",
    }));
    expect(banner?.code).toBe("future_prompt_code");
    expect(banner?.message).not.toContain("UPSTREAM_MESSAGE_MUST_NOT_LEAK");
    expect(banner?.dismissible).toBe(true);
  });

  test("the same key is suppressed after dismissal, a new failure is visible again", () => {
    const current = failure();
    const key = promptFailureKey(current);
    expect(promptFailureBanner(current, key)).toBeNull();
    expect(promptFailureBanner(current, "older-key")).not.toBeNull();
    expect(promptFailureBanner({ ...current, at: "2026-01-01T00:00:01.000Z" }, key)).not.toBeNull();
  });
});
