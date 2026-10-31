import { test, expect } from "bun:test";
import { api, errorCauseCode, scoped } from "./api";
test("every scoped browser query includes the full Company/Agent identity", () => {
  expect(
    scoped({ companyId: "one", agentId: "dev" }, "files/read", {
      path: "notes/a b.md",
    }),
  ).toBe("/api/agents/dev/files/read?companyId=one&path=notes%2Fa+b.md");
});
test("runtime error fact is readable in a successful snapshot, not mistaken for HTTP failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        busy: false,
        error: "Model is not configured",
        sessionId: "actual-id",
      }),
      { status: 200 },
    )) as any;
  try {
    expect((await api("/snapshot")).error).toBe("Model is not configured");
  } finally {
    globalThis.fetch = original;
  }
});
test("HTTP failure carries domain error code and never returns a success result", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "version_conflict", message: "Disk changed" },
      }),
      { status: 409 },
    )) as any;
  try {
    await expect(api("/save")).rejects.toMatchObject({
      code: "version_conflict",
      message: "Disk changed",
      status: 409,
    });
  } finally {
    globalThis.fetch = original;
  }
});
test("HTTP status and SDK disposition details survive the API boundary", async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, code, details] of [
      [400, "invalid_action", { requestId: "r400", disposition: "rejected" }],
      [409, "not_ready", { requestId: "r409", disposition: "rejected" }],
      [503, "closed", { requestId: "r503", disposition: "rejected" }],
      [
        500,
        "answer_failed",
        {
          requestId: "r500",
          disposition: "unknown",
          causeCode: "unknown_interaction",
        },
      ],
    ] as const) {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ error: { code, message: "failure", details } }),
          { status },
        )) as any;
      const failure = await api("/action").catch((error) => error);
      expect(failure).toMatchObject({ code, status, details });
      expect(errorCauseCode(failure)).toBe(
        code === "answer_failed" ? "unknown_interaction" : undefined,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
