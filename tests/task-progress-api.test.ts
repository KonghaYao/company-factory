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
describe("Task todo and comment-snapshot HTTP/MCP contract", () => {
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
      title: `API todos ${idle ? "idle " : ""}${++requestSeq}`,
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
        input: { name: "待办 API 公司", requestId: "api-company" },
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

  test("health still advertises exactly three modules and progress-record tools are unregistered", async () => {
    const health = await fetch(base + "/health");
    expect(health.status).toBe(200);
    const body = await health.json();
    expect(body.mcpModules).toEqual([
      "company_org",
      "company_tasks",
      "company_im",
    ]);
    expect(MODULE_OPERATIONS.company_tasks).toContain("updateTodos");
    expect(MODULE_OPERATIONS.company_tasks).not.toContain("updates");
    expect(MODULE_OPERATIONS.company_tasks).not.toContain("addUpdate");
    expect(READ_OPERATIONS.has("updates")).toBe(false);
    expect(READ_OPERATIONS.has("updateTodos")).toBe(false);
    expect(schemas.updates).toBeUndefined();
    expect(schemas.addUpdate).toBeUndefined();
  });

  test("updateTodos schema requires a note and ignores the retired kind", () => {
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
        requestId: "schema-no-note",
        changes: [{ op: "add", text: "one" }],
      }).success,
    ).toBe(false);
    expect(
      schemas.updateTodos!.safeParse({
        issueId: "1",
        expectedVersion: 1,
        requestId: "schema-bad-todos",
        changes: [{ op: "add", text: "x".repeat(501) }],
        note: "note",
      }).success,
    ).toBe(false);
  });

  test("the owner session cannot write todos", async () => {
    const created = await issue();
    const forbidden = await actionJson("updateTodos", {
      issueId: created.id,
      expectedVersion: created.version,
      requestId: requestId("owner-todos"),
      changes: [{ op: "add", text: "owner write" }],
      note: "Owner attempts a todo write.",
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("forbidden");
    expect((await read(created.id)).todos).toEqual([]);
  });

  test("the owner Agent writes todos and the server appends a snapshot comment", async () => {
    const created = await issue();
    const note = "Split the work and started the first step.";
    const written = await mcp(supervisorId, "tools/call", {
      name: "updateTodos",
      arguments: {
        issueId: created.id,
        expectedVersion: created.version,
        requestId: requestId("agent-with-note"),
        changes: [
          { op: "add", text: "agent step one" },
          { op: "add", text: "agent step two", status: "in_progress" },
        ],
        note,
      },
    });
    expect(written.result.isError).toBeUndefined();
    const payload = toolPayload(written);
    expect(payload.issue.todos.map((todo: any) => todo.text)).toEqual([
      "agent step one",
      "agent step two",
    ]);
    expect(payload.comment).toMatchObject({
      id: `${created.id}-C1`,
      issue_id: created.id,
      author_type: "agent",
      author_id: supervisorId,
      body: note,
    });
    expect(payload.comment.todo_snapshot).toEqual([
      { id: `${created.id}-T1`, text: "agent step one", status: "pending" },
      {
        id: `${created.id}-T2`,
        text: "agent step two",
        status: "in_progress",
      },
    ]);

    const detail = await read(created.id);
    expect(detail.todos).toHaveLength(2);
    expect(detail).not.toHaveProperty("latest_update");
    const comments = await actionJson("comments", { issueId: created.id });
    expect(comments.status).toBe(200);
    expect(comments.body.items).toHaveLength(1);
    expect(comments.body.items[0].body).toBe(note);
    expect(comments.body.items[0].todo_snapshot).toEqual(
      payload.comment.todo_snapshot,
    );
  });

  test("MCP discovery exposes updateTodos only and describes note/comment/snapshot", async () => {
    const discovery = await mcp(supervisorId, "tools/list");
    const tools = discovery.result.tools;
    const byName = new Map(tools.map((tool: any) => [tool.name, tool]));
    expect(byName.has("updateTodos")).toBe(true);
    expect(byName.has("updates")).toBe(false);
    expect(byName.has("addUpdate")).toBe(false);
    const updateTodos = byName.get("updateTodos") as any;
    expect(updateTodos.annotations.readOnlyHint).toBe(false);
    expect(updateTodos.description).toContain("note");
    expect(updateTodos.description).toContain("comment");
    expect(updateTodos.description).toContain("snapshot");
    expect(updateTodos.description).not.toContain("immutable update");
  });

  test("collaborators may read comments but cannot write todos; stale versions conflict", async () => {
    const created = await issue();
    const assigned = await actionJson("assignIssue", {
      issueId: created.id,
      expectedVersion: created.version,
      requestId: requestId("collaborator"),
      agentId: supervisorId,
      collaborators: [hrId],
    });
    expect(assigned.status).toBe(200);

    const written = await mcp(supervisorId, "tools/call", {
      name: "updateTodos",
      arguments: {
        issueId: created.id,
        expectedVersion: assigned.body.version,
        requestId: requestId("agent-todo"),
        changes: [{ op: "add", text: "visible todo" }],
        note: "Collaborators can read this.",
      },
    });
    expect(written.result.isError).toBeUndefined();
    const version = toolPayload(written).issue.version;

    const readable = await mcp(hrId, "tools/call", {
      name: "comments",
      arguments: { issueId: created.id },
    });
    expect(readable.result.isError).toBeUndefined();
    expect(toolPayload(readable).items).toHaveLength(1);
    expect(toolPayload(readable).items[0].todo_snapshot).toHaveLength(1);

    const collaboratorWrite = await mcp(hrId, "tools/call", {
      name: "updateTodos",
      arguments: {
        issueId: created.id,
        expectedVersion: version,
        requestId: requestId("collaborator-write"),
        changes: [{ op: "add", text: "not allowed" }],
        note: "Not the owner.",
      },
    });
    expect(collaboratorWrite.result.isError).toBe(true);
    expect(toolPayload(collaboratorWrite).error.code).toBe("not_current_owner");

    const stale = await mcp(supervisorId, "tools/call", {
      name: "updateTodos",
      arguments: {
        issueId: created.id,
        expectedVersion: assigned.body.version,
        requestId: requestId("stale"),
        changes: [{ op: "add", text: "stale" }],
        note: "Stale version.",
      },
    });
    expect(stale.result.isError).toBe(true);
    expect(toolPayload(stale).error.code).toBe("version_conflict");
    expect((await read(created.id)).todos).toHaveLength(1);
  });

  test("canceled Issues reject todo writes but accept ordinary comments", async () => {
    const created = await issue();
    const canceled = await actionJson("cancelIssue", {
      issueId: created.id,
      expectedVersion: created.version,
      requestId: requestId("cancel"),
      reason: "No longer needed",
    });
    expect(canceled.status).toBe(200);

    const rejected = await mcp(supervisorId, "tools/call", {
      name: "updateTodos",
      arguments: {
        issueId: created.id,
        expectedVersion: canceled.body.version,
        requestId: requestId("canceled-todos"),
        changes: [{ op: "add", text: "revive" }],
        note: "Canceled Issue.",
      },
    });
    expect(rejected.result.isError).toBe(true);
    expect(toolPayload(rejected).error.code).toBe("terminal_issue");

    const late = await actionJson("addComment", {
      issueId: created.id,
      requestId: requestId("late-comment"),
      body: "Post-cancel retrospective evidence.",
    });
    expect(late.status).toBe(200);
    expect(late.body).not.toHaveProperty("todo_snapshot");
    const comments = await actionJson("comments", { issueId: created.id });
    expect(comments.body.items.map((item: any) => item.body)).toEqual([
      "Post-cancel retrospective evidence.",
    ]);
  });
});
