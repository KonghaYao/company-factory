import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server/app";

describe("owner-only runtime diagnostics endpoint", () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let server: ReturnType<typeof Bun.serve>;
  let root: string;
  let base: string;
  let cookie: string;
  let closed = false;

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(base + path, { headers });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-diagnostics-api-"));
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = reservation.port;
    reservation.stop();
    base = `http://127.0.0.1:${port}`;
    const token = randomBytes(32).toString("hex");
    application = await createApplication({
      root,
      baseUrl: base,
      webToken: token,
      diagnostics: {
        enabled: true,
        dir: join(root, "diagnostics"),
        appName: "company-factory-test",
      },
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: application.app.fetch,
    });
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterAll(async () => {
    if (!closed) await application?.close().catch(() => {});
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  test("requires the owner cookie; an agent bearer alone is rejected", async () => {
    expect((await get("/api/diagnostics/runtime")).status).toBe(401);
    expect(
      (
        await get("/api/diagnostics/runtime", {
          authorization: `Bearer ${"a".repeat(64)}`,
        })
      ).status,
    ).toBe(401);
  });

  test("returns a whitelisted read-only shape for the owner", async () => {
    const response = await get("/api/diagnostics/runtime?limit=50", { cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.returned).toBe(body.entries.length);
    expect(typeof body.generatedAt).toBe("string");
    expect(body.file.endsWith(".jsonl")).toBe(true);
    expect(body.maxBytesPerFile).toBe(1024 * 1024);
    expect(body.entries.some((entry: any) => entry.event === "process_start")).toBe(true);
  });

  test("rejects invalid limits", async () => {
    for (const limit of ["0", "abc", "1000", "-1", "1.5", ""]) {
      const response = await get(
        `/api/diagnostics/runtime?limit=${encodeURIComponent(limit)}`,
        { cookie },
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.code).toBe("invalid_limit");
    }
  });

  test("redacts free text recorded through the sink", async () => {
    application.diagnostics.record({
      event: "agent_execution_failed",
      companyId: "company-1",
      agentId: "agent-1",
      eventId: "api-redaction",
      message:
        "failure at https://host.example/x?token=secret with 0123456789abcdef0123456789abcdef",
    });
    const response = await get("/api/diagnostics/runtime?limit=200", { cookie });
    const body = (await response.json()) as any;
    const entry = body.entries.find((value: any) => value.eventId === "api-redaction");
    expect(entry).toBeTruthy();
    expect(entry.message).toContain("[url]");
    expect(entry.message).toContain("[redacted]");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("host.example");
    expect(serialized).not.toContain("0123456789abcdef0123456789abcdef");
  });

  test("never returns forged item/content/token fields from the file", async () => {
    const file = application.diagnostics.status().file!;
    await appendFile(
      file,
      JSON.stringify({
        level: 50,
        time: "2026-11-02T00:00:00.000Z",
        msg: "agent_execution_failed",
        message: "forged https://forged.example/x",
        items: [{ content: "SECRET_CONTENT" }],
        content: "SECRET_CONTENT",
        token: "SECRET_TOKEN",
      }) + "\n",
    );
    const response = await get("/api/diagnostics/runtime?limit=200", { cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    const serialized = JSON.stringify(body);
    for (const forbidden of ["SECRET_CONTENT", "SECRET_TOKEN", "forged.example", '"items"', '"content"'])
      expect(serialized).not.toContain(forbidden);
    expect(
      body.entries.some((entry: any) => entry.message === "forged [url]"),
    ).toBe(true);
  });

  test("closes cleanly and leaves the active file at mode 0600", async () => {
    const file = application.diagnostics.status().file!;
    await application.close();
    closed = true;
    const stats = await lstat(file);
    expect(stats.isFile()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("disabled diagnostics still answer 200 with an empty result", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "company-diagnostics-off-"));
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = reservation.port;
    reservation.stop();
    const otherBase = `http://127.0.0.1:${port}`;
    const otherToken = randomBytes(32).toString("hex");
    const other = await createApplication({
      root: otherRoot,
      baseUrl: otherBase,
      webToken: otherToken,
      diagnostics: { enabled: false },
    });
    const otherServer = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: other.app.fetch,
    });
    try {
      const login = await fetch(otherBase + "/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: otherToken }),
      });
      const otherCookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const response = await fetch(otherBase + "/api/diagnostics/runtime?limit=10", {
        headers: { cookie: otherCookie },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.enabled).toBe(false);
      expect(body.entries).toEqual([]);
      expect(body.returned).toBe(0);
    } finally {
      await other.close();
      otherServer.stop(true);
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});
