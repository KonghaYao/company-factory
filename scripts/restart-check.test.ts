import { describe, expect, test } from "bun:test";
import { requestRestartReadiness } from "./restart-check";

const baseUrl = "http://127.0.0.1:3000";
const token = "owner-token-for-check";

function fakeFetch(
  readiness: { status: number; body: unknown },
  loginStatus = 200,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/login"))
      return new Response(JSON.stringify({ ok: loginStatus === 200 }), {
        status: loginStatus,
        headers:
          loginStatus === 200
            ? { "set-cookie": "company_session=fixture; HttpOnly; Path=/" }
            : {},
      });
    return new Response(JSON.stringify(readiness.body), {
      status: readiness.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("restart check exit mapping", () => {
  test("safe is 0 and the owner token is never placed in a URL", async () => {
    const fake = fakeFetch({
      status: 200,
      body: {
        safeToRestart: true,
        verified: true,
        checkedAt: "2026-11-02T18:20:00.000Z",
        serverVersion: "1.0.0",
        busy: [],
        counts: {},
        errors: [],
      },
    });
    const outcome = await requestRestartReadiness({
      baseUrl,
      token,
      fetchImpl: fake.fetchImpl,
    });
    expect(outcome.code).toBe(0);
    expect(outcome.result?.serverVersion).toBe("1.0.0");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.url).toBe(baseUrl + "/api/login");
    expect(fake.calls[1]!.url).toBe(baseUrl + "/api/restart-readiness");
    expect(fake.calls[1]!.init?.headers).toEqual({
      cookie: "company_session=fixture",
    });
    for (const call of fake.calls) {
      expect(call.url).not.toContain(token);
      expect(JSON.stringify(call.init?.headers ?? {})).not.toContain(token);
    }
  });

  test("busy is 2 and includes the company filter", async () => {
    const fake = fakeFetch({
      status: 409,
      body: {
        safeToRestart: false,
        verified: true,
        checkedAt: "2026-11-02T18:20:00.000Z",
        serverVersion: "1.0.0",
        busy: [
          {
            companyId: "c-1",
            companyName: "Company",
            agentId: "dev",
            name: "Developer",
            status: "running",
            reasons: ["active_turn"],
            sessionId: null,
            turnId: "turn-1",
            threadId: null,
            archived: false,
          },
        ],
        counts: {},
        errors: [],
      },
    });
    const outcome = await requestRestartReadiness({
      baseUrl,
      token,
      companyId: "c-1",
      fetchImpl: fake.fetchImpl,
    });
    expect(outcome.code).toBe(2);
    expect(outcome.result?.busy[0]?.reasons).toEqual(["active_turn"]);
    expect(fake.calls[1]!.url).toBe(
      baseUrl + "/api/restart-readiness?companyId=c-1",
    );
  });

  test("503 and login failure are UNVERIFIED (3)", async () => {
    const unavailable = await requestRestartReadiness({
      baseUrl,
      token,
      fetchImpl: fakeFetch({
        status: 503,
        body: { safeToRestart: false, verified: false, busy: [], errors: [] },
      }).fetchImpl,
    });
    expect(unavailable.code).toBe(3);
    expect(unavailable.httpStatus).toBe(503);

    const loginFailed = await requestRestartReadiness({
      baseUrl,
      token,
      fetchImpl: fakeFetch({ status: 200, body: {} }, 401).fetchImpl,
    });
    expect(loginFailed.code).toBe(3);
    expect(loginFailed.httpStatus).toBe(401);
  });

  test("200 with an incomplete body is never treated as safe", async () => {
    const outcome = await requestRestartReadiness({
      baseUrl,
      token,
      fetchImpl: fakeFetch({
        status: 200,
        body: { safeToRestart: true },
      }).fetchImpl,
    });
    expect(outcome.code).toBe(3);
  });
});
