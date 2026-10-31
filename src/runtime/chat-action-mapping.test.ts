import { expect, spyOn, test } from "bun:test";
import {
  ChatActionError,
  ChatActionValidationError,
  ChatBusyError,
  ChatClosedError,
  ChatNotReadyError,
  SessionBindingConflictError,
} from "@peri-code/sdk";
import {
  RuntimeError,
  chatActionStatus,
  chatControlFailure,
  redactRuntimeMessage,
  toChatActionRuntimeError,
} from "./index";

const fallback = {
  code: "send_failed",
  message: "输入提交未获 SDK 确认；可能已入队，请先刷新会话与队列，不要自动重试。",
};

test("SDK chat action codes map to 400/409/503; other failures stay 500", () => {
  expect(chatActionStatus("invalid_action")).toBe(400);
  expect(chatActionStatus("busy")).toBe(409);
  expect(chatActionStatus("binding_conflict")).toBe(409);
  expect(chatActionStatus("not_ready")).toBe(409);
  expect(chatActionStatus("closed")).toBe(503);
  expect(chatActionStatus("send_failed")).toBe(500);
  expect(chatActionStatus("answer_failed")).toBe(500);
  expect(chatActionStatus("cancel_failed")).toBe(500);
  expect(chatActionStatus("take_back_failed")).toBe(500);
  expect(chatActionStatus("force_send_failed")).toBe(500);
  expect(chatActionStatus("history_failed")).toBe(500);
});

test("SDK action errors keep code, disposition and requestId without exposing cause", () => {
  const cases: Array<[ChatActionError, string, number]> = [
    [
      new ChatActionValidationError("req-invalid", "bad payload"),
      "invalid_action",
      400,
    ],
    [new ChatBusyError("req-busy", "still running"), "busy", 409],
    [new ChatNotReadyError("req-not-ready", "not bound"), "not_ready", 409],
    [new ChatClosedError("req-closed", "closed"), "closed", 503],
    [
      new SessionBindingConflictError("req-bind", "owned elsewhere", "owner-1"),
      "binding_conflict",
      409,
    ],
  ];
  for (const [error, code, status] of cases) {
    const mapped = toChatActionRuntimeError(error);
    expect(mapped).toBeInstanceOf(RuntimeError);
    expect(mapped!.code).toBe(code);
    expect(mapped!.status).toBe(status);
    expect(mapped!.details).toEqual({
      requestId: error.requestId,
      disposition: error.disposition,
    });
    expect(Object.keys(mapped!.details!)).not.toContain("cause");
    expect(mapped!.cause).toBe(error);
  }
});

test("answer_failed keeps the nested SDK causeCode but never serializes the cause", () => {
  const cause = Object.assign(new Error("Interaction is no longer pending"), {
    code: "unknown_interaction",
  });
  const error = new ChatActionError(
    "req-answer",
    "answer_failed",
    "Interaction answer was rejected",
    "unknown",
    { cause },
  );
  const mapped = toChatActionRuntimeError(error)!;
  expect(mapped.code).toBe("answer_failed");
  expect(mapped.status).toBe(500);
  expect(mapped.details).toEqual({
    requestId: "req-answer",
    disposition: "unknown",
    causeCode: "unknown_interaction",
  });
  expect(mapped.cause).toBe(error);
  expect(JSON.stringify(mapped.details)).not.toContain(
    "Interaction is no longer pending",
  );
});

test("structurally matching action errors from another SDK instance keep their disposition", () => {
  const plain = {
    requestId: "req-plain",
    code: "busy",
    disposition: "rejected",
    message: "Chat is busy",
  };
  const mapped = toChatActionRuntimeError(plain)!;
  expect(mapped.code).toBe("busy");
  expect(mapped.status).toBe(409);
  expect(mapped.details).toEqual({
    requestId: "req-plain",
    disposition: "rejected",
  });
  expect(
    toChatActionRuntimeError({ code: "busy", disposition: "rejected" }),
  ).toBeNull();
  expect(toChatActionRuntimeError(new Error("plain failure"))).toBeNull();
});

test("non-contract failures use the operation code, 500 and a sanitized diagnostic", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const original = new Error(
      "connect https://internal.example/path?token=0123456789abcdef0123456789abcdef failed",
    );
    const failure = chatControlFailure(original, fallback);
    expect(failure).toBeInstanceOf(RuntimeError);
    expect(failure.code).toBe("send_failed");
    expect(failure.status).toBe(500);
    expect(failure.message).toBe(fallback.message);
    expect(failure.details).toEqual({ disposition: "unknown" });
    expect(failure.cause).toBe(original);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).not.toContain("https://internal.example");
    expect(logged).not.toContain("0123456789abcdef0123456789abcdef");
  } finally {
    warn.mockRestore();
  }
});

test("SDK messages and diagnostics redact URLs and long tokens", () => {
  const message =
    "closed for https://host.example/path?token=secret and 0123456789abcdef0123456789abcdef";
  const redacted = redactRuntimeMessage(message);
  expect(redacted).toContain("[url]");
  expect(redacted).toContain("[redacted]");
  expect(redacted).not.toContain("host.example");
  expect(redacted).not.toContain("0123456789abcdef0123456789abcdef");
  expect(redactRuntimeMessage("x".repeat(500)).length).toBeLessThanOrEqual(241);
  const error = new ChatActionError(
    "req-redact",
    "closed",
    message,
    "rejected",
  );
  expect(toChatActionRuntimeError(error)!.message).toBe(redacted);
});

test("RuntimeError keeps the legacy two-argument 503 contract", () => {
  const error = new RuntimeError("wasm_control_failed", "legacy");
  expect(error.status).toBe(503);
  expect(error.details).toBeUndefined();
  expect(error.cause).toBeUndefined();
});
