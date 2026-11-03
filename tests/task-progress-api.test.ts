import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server/app";
import {
  MODULE_OPERATIONS,
  READ_OPERATIONS,
  schemas,
} from "../src/server/operations";

// Real Hono/MCP adapters and Company storage; only runtime provisioning and
// Agent Git are replaced. No live Company home or Peri Session is used.
describe("Task progress HTTP/MCP contract", () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let server: ReturnType<typeof Bun.serve>;
  let root: string;
  let base: string;
  let cookie: string;
  let companyId: string;
  let supervisorId: string;
  let hrId: string;
  let requestSeq = 0;
  const requestId = (label: string) => `${label}-${++requestSeq}`;

  async function action(
    operation: string,
    input: Record<string, unknown> = {},
    module = "company_tasks",
  ) {
    return fetch(base + "/api/action", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ companyId, module, operation, input }),
    });
  }
  async function actionJson(
    operation: string,
    input: Record<string, unknown> = {},
  ) {
    const response = await action(operation, input);
    return { status: response.status, body: await response.json() };
  }
  async function mcp(
    agentId: string,
    method: string,
    params: Record<string, unknown> = {},
  ) {
    const agent = await application.domain.getAgentInternal(agentId);
    const response = await fetch(base + "/company_tasks/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(params.name ? { "Mcp-Name": String(params.name) } : {}),
        authorization: `Bearer ${agent.authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "task-progress-contract-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  function toolPayload(json: any) {
    return JSON.parse(json.result.content[0].text);
  }
  async function issue(idle = false) {
    const result = await actionJson("createIssue", {
      title: `API progress ${idle ? "idle " : ""}${++requestSeq}`,
      requestId: requestId("create-issue"),
    });
    expect(result.status).toBe(200);
    return result.body as any;
  }
  async function read(issueId: string) {
    const result = await actionJson("getIssue", { issueId });
    expect(result.status).toBe(200);
    return result.body as any;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-task-progress-api-"));
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
    });
    spyOn(application.runtime, "provision").mockImplementation(
      async (agent) => ({
        sessionId: `unit-only-${agent.agentId}`,
      }),
    );
    const commit = application.domain.store.commit.bind(
      application.domain.store,
    );
    spyOn(application.domain.store, "commit").mockImplementation(
      async (dir, message) => {
        if (dir.startsWith(join(root, "agents") + "/")) return;
        return commit(dir, message);
      },
    );
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
    const created = await fetch(base + "/api/action", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        module: "company_org",
        operation: "createCompany",
        input: { name: "进展 API 公司", requestId: "api-company" },
      }),
    });
    expect(created.status).toBe(200);
    const organization = await created.json();
    companyId = organization.company.id;
    supervisorId = `${companyId}-supervisor`;
    hrId = `${companyId}-hr`;
  });
  afterAll(async () => {
    await application?.close();
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  test("health still advertises exactly three modules and the three new tools are registered", async () => {
    const health = await fetch(base + "/health");
    expect(health.status).toBe(200);
    const body = await health.json();
    expect(body.mcpModules).toEqual([
      "company_org",
      "company_tasks",
      "company_im",
    ]);
    expect(MODULE_OPERATIONS.company_tasks).toEqual(
      expect.arrayContaining(["updates", "addUpdate", "updateTodos"]),
    );
    expect(READ_OPERATIONS.has("updates")).toBe(true);
    expect(READ_OPERATIONS.has("addUpdate")).toBe(false);
    expect(READ_OPERATIONS.has("updateTodos")).toBe(false);
  });

  test("owner /api/action updates todos, appends updates and reads newest-first pages", async () => {
    const created = await issue();
    const added = await actionJson("updateTodos", {
      issueId: created.id,
      expectedVersion: created.version,
      requestId: requestId("owner-todos"),
      changes: [
        { op: "add", text: "HTTP step one" },
        { op: "add", text: "HTTP step two", status: "in_progress" },
      ],
    });
    expect(added.status).toBe(200);
    expect(added.body.update).toBeNull();
    expect(added.body.issue.todos.map((t: any) => t.id)).toEqual([
      `${created.id}-T1`,
      `${created.id}-T2`,
    ]);

    const detail = await read(created.id);
    expect(detail.todos).toHaveLength(2);
    expect(detail.latest_update).toBeNull();

    const first = await actionJson("addUpdate", {
      issueId: created.id,
      expectedVersion: added.body.issue.version,
      requestId: requestId("owner-update-1"),
      body: "First append",
    });
    expect(first.status).toBe(200);
    expect(first.body.update.id).toBe(`${created.id}-U1`);
    const second = await actionJson("addUpdate", {
      issueId: created.id,
      expectedVersion: first.body.issue.version,
      requestId: requestId("owner-update-2"),
      body: "Second append",
      kind: "blocker",
    });
    expect(second.status).toBe(200);
    expect(second.body.issue.latest_update.kind).toBe("blocker");

    const page = await actionJson("updates", { issueId: created.id, limit: 1 });
    expect(page.status).toBe(200);
    expect(page.body.items[0].body).toBe("Second append");
    expect(page.body.nextCursor).toBe("1");
    const next = await actionJson("updates", {
      issueId: created.id,
      cursor: page.body.nextCursor,
      limit: 1,
    });
    expect(next.body.items[0].body).toBe("First append");
    expect(next.body.nextCursor).toBeNull();

    const stale = await actionJson("updateTodos", {
      issueId: created.id,
      expectedVersion: created.version,
      requestId: requestId("owner-stale"),
      changes: [{ op: "add", text: "stale" }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
  });

  test("MCP publishes schemas, read-only hints and operation-specific guidance", async () => {
    const discovery = await mcp(supervisorId, "tools/list");
    const tools = discovery.result.tools;
    const byName = new Map(tools.map((tool: any) => [tool.name, tool]));
    for (const name of ["updates", "addUpdate", "updateTodos"])
      expect(byName.has(name)).toBe(true);
    expect((byName.get("updates") as any).annotations.readOnlyHint).toBe(true);
    expect((byName.get("addUpdate") as any).annotations.readOnlyHint).toBe(
      false,
    );
    expect((byName.get("updateTodos") as any).annotations.readOnlyHint).toBe(
      false,
    );
    expect((byName.get("updateTodos") as any).description).toContain("note");
    expect((byName.get("addUpdate") as any).description).toContain(
      "does not change status",
    );
    expect((byName.get("updates") as any).description).toContain(
      "Newest-first",
    );

    expect(
      schemas.updateTodos!.safeParse({
        issueId: "1",
        expectedVersion: 1,
        requestId: "schema-todos",
        changes: [
          { op: "add", text: "one" },
          { op: "update", todoId: "1-T1", status: "done" },
          { op: "remove", todoId: "1-T2" },
        ],
        order: ["1-T1"],
        note: "note",
        kind: "progress",
      }).success,
    ).toBe(true);
    expect(
      schemas.updateTodos!.safeParse({
        issueId: "1",
        expectedVersion: 1,
        requestId: "schema-bad-todos",
        changes: [{ op: "add", text: "x".repeat(501) }],
      }).success,
    ).toBe(false);
    expect(
      schemas.addUpdate!.safeParse({
        issueId: "1",
        expectedVersion: 1,
        requestId: "schema-update",
        body: "body",
      }).success,
    ).toBe(true);
    expect(
      schemas.addUpdate!.safeParse({
        issueId: "1",
        expectedVersion: 1,
        requestId: "schema-bad-update",
        body: "x".repeat(4001),
      }).success,
    ).toBe(false);
    expect(
      schemas.updates!.safeParse({ issueId: "1", limit: 50 }).success,
    ).toBe(true);
    expect(
      schemas.updates!.safeParse({ issueId: "1", limit: 51 }).success,
    ).toBe(false);
  });

  test("owner Agent must attach a note; collaborators may read but not write", async () => {
    const created = await issue();
    const noNote = await mcp(supervisorId, "tools/call", {
      name: "updateTodos",
      arguments: {
        issueId: created.id,
        expectedVersion: created.version,
        requestId: requestId("agent-no-note"),
        changes: [{ op: "add", text: "no note" }],
      },
    });
    expect(noNote.result.isError).toBe(true);
    expect(toolPayload(noNote).error.code).toBe("invalid_input");

    const withNote = await mcp(supervisorId, "tools/call", {
      name: "updateTodos",
      arguments: {
        issueId: created.id,
        expectedVersion: created.version,
        requestId: requestId("agent-with-note"),
        changes: [{ op: "add", text: "agent step" }],
        note: "Agent split the work.",
      },
    });
    expect(withNote.result.isError).toBeUndefined();
    const payload = toolPayload(withNote);
    expect(payload.issue.todos[0].text).toBe("agent step");
    expect(payload.update.author_type).toBe("agent");
    expect(payload.update.author_id).toBe(supervisorId);
    expect(payload.update.todo_counts).toEqual({
      total: 1,
      done: 0,
      in_progress: 0,
    });

    const forbidden = await mcp(hrId, "tools/call", {
      name: "updates",
      arguments: { issueId: created.id },
    });
    expect(forbidden.result.isError).toBe(true);
    expect(toolPayload(forbidden).error.code).toBe("forbidden");

    const assigned = await actionJson("assignIssue", {
      issueId: created.id,
      expectedVersion: payload.issue.version,
      requestId: requestId("collaborator"),
      agentId: supervisorId,
      collaborators: [hrId],
    });
    expect(assigned.status).toBe(200);
    const readable = await mcp(hrId, "tools/call", {
      name: "updates",
      arguments: { issueId: created.id },
    });
    expect(readable.result.isError).toBeUndefined();
    expect(toolPayload(readable).items).toHaveLength(1);

    const collaboratorWrite = await mcp(hrId, "tools/call", {
      name: "addUpdate",
      arguments: {
        issueId: created.id,
        expectedVersion: assigned.body.version,
        requestId: requestId("collaborator-write"),
        body: "not allowed",
      },
    });
    expect(collaboratorWrite.result.isError).toBe(true);
    expect(toolPayload(collaboratorWrite).error.code).toBe("not_current_owner");
  });

  test("MCP updates pagination remains newest-first for a collaborator", async () => {
    const created = await issue();
    const assigned = await actionJson("assignIssue", {
      issueId: created.id,
      expectedVersion: created.version,
      requestId: requestId("paginate-collaborator"),
      agentId: supervisorId,
      collaborators: [hrId],
    });
    let version = assigned.body.version;
    for (const body of ["first", "second", "third"]) {
      const appended = await actionJson("addUpdate", {
        issueId: created.id,
        expectedVersion: version,
        requestId: requestId("paginate-update"),
        body,
      });
      expect(appended.status).toBe(200);
      version = appended.body.issue.version;
    }
    const page = await mcp(hrId, "tools/call", {
      name: "updates",
      arguments: { issueId: created.id, limit: 2 },
    });
    const payload = toolPayload(page);
    expect(payload.items.map((item: any) => item.body)).toEqual([
      "third",
      "second",
    ]);
    expect(payload.nextCursor).toBe("2");
    const next = await mcp(hrId, "tools/call", {
      name: "updates",
      arguments: {
        issueId: created.id,
        limit: 2,
        cursor: payload.nextCursor,
      },
    });
    expect(toolPayload(next).items.map((item: any) => item.body)).toEqual([
      "first",
    ]);
    expect(toolPayload(next).nextCursor).toBeNull();
  });
});
