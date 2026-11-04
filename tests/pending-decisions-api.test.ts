import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server/app";
import { createDepartmentWithHead } from "../src/domain/test-support";
import {
  MODULE_OPERATIONS,
  READ_OPERATIONS,
  schemas,
} from "../src/server/operations";

// Real Hono/MCP adapters and Company storage; only runtime provisioning and
// Agent Git are replaced. No live Company home or Peri Session is used.
describe("Pending decision inbox HTTP/MCP contract", () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let server: ReturnType<typeof Bun.serve>;
  let root: string;
  let base: string;
  let cookie: string;
  let companyId: string;
  let headId: string;
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
    module = "company_tasks",
  ) {
    const response = await action(operation, input, module);
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
              name: "pending-decisions-contract-test",
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
  async function issue(title: string) {
    const result = await actionJson("createIssue", {
      title,
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
  async function ask(issueId: string, question: string, options?: string[]) {
    const current = await read(issueId);
    const written = await mcp(headId, "tools/call", {
      name: "askDecision",
      arguments: {
        issueId,
        question,
        ...(options ? { options } : {}),
        expectedVersion: current.version,
        requestId: requestId("ask"),
      },
    });
    expect(written.result.isError).toBeUndefined();
    return toolPayload(written);
  }
  async function pending(query?: string) {
    const response = await fetch(
      base + "/api/decisions/pending" + (query ?? `?companyId=${companyId}`),
      { headers: { cookie } },
    );
    return { status: response.status, body: await response.json() };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-pending-decisions-api-"));
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
        input: { name: "待裁定 API 公司", requestId: "api-company" },
      }),
    });
    expect(created.status).toBe(200);
    const organization = await created.json();
    companyId = organization.company.id;
    const head = await createDepartmentWithHead(
      application.domain,
      { type: "agent", id: `${companyId}-hr`, companyId },
      {
        nodeId: "delivery",
        headId: `${companyId}-head`,
        nodeName: "Delivery",
        headName: "Delivery Head",
      },
    );
    headId = head.id;
  });
  afterAll(async () => {
    await application?.close();
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  test("askDecision schema accepts optional concrete options within 2–6 single-line choices", () => {
    const schema = schemas.askDecision!;
    const baseInput = {
      issueId: "1",
      question: "Which plan?",
      expectedVersion: 1,
      requestId: "ask-schema",
    };
    expect(schema.safeParse(baseInput).success).toBe(true);
    expect(
      schema.safeParse({ ...baseInput, options: ["Plan A", "Plan B"] }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...baseInput, options: ["Only"] }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        ...baseInput,
        options: ["1", "2", "3", "4", "5", "6", "7"],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...baseInput,
        options: ["Plan A", "x".repeat(201)],
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...baseInput, options: null }).success).toBe(
      false,
    );
    // The projection is owner HTTP-only, not an MCP tool or MCP read operation.
    expect(MODULE_OPERATIONS.company_tasks).not.toContain(
      "listPendingDecisions",
    );
    expect(READ_OPERATIONS.has("listPendingDecisions")).toBe(false);
    expect(schemas.listPendingDecisions).toBeUndefined();
  });

  test("owner GET returns the minimal pending projection with trimmed options", async () => {
    const created = await issue("Pending inbox A");
    const withOptions = await ask(created.id, "Which plan?", [
      " Plan A ",
      "Plan B",
    ]);
    await ask(created.id, "Any extra context?");
    const current = await read(created.id);

    const response = await pending();
    expect(response.status).toBe(200);
    const items = (response.body.items as any[]).filter(
      (item) => item.issueId === created.id,
    );
    expect(items).toHaveLength(2);
    const concrete = items.find(
      (item) => item.decisionId === `${created.id}-Q1`,
    )!;
    expect(concrete).toEqual({
      issueId: created.id,
      issueTitle: "Pending inbox A",
      issueStatus: "triage",
      agentId: headId,
      decisionId: `${created.id}-Q1`,
      question: "Which plan?",
      options: ["Plan A", "Plan B"],
      updatedAt: current.updated_at,
    });
    expect(Object.keys(concrete).sort()).toEqual([
      "agentId",
      "decisionId",
      "issueId",
      "issueStatus",
      "issueTitle",
      "options",
      "question",
      "updatedAt",
    ]);
    const legacy = items.find(
      (item) => item.decisionId === `${created.id}-Q2`,
    )!;
    expect(Object.hasOwn(legacy, "options")).toBe(false);
    expect(Object.keys(legacy).sort()).toEqual([
      "agentId",
      "decisionId",
      "issueId",
      "issueStatus",
      "issueTitle",
      "question",
      "updatedAt",
    ]);
    expect(withOptions.decisions[0].options).toEqual(["Plan A", "Plan B"]);
    for (const key of ["body", "comments", "history", "todos", "summary"]) {
      expect(concrete).not.toHaveProperty(key);
    }
  });

  test("an answer without expectedVersion hides the decision but leaves it pending until resolve", async () => {
    const pendingNow = await pending();
    const target = (pendingNow.body.items as any[]).find(
      (item) =>
        item.decisionId.endsWith("-Q1") && item.question === "Which plan?",
    )!;
    expect(target).toBeDefined();

    const answered = await actionJson("answerDecision", {
      issueId: target.issueId,
      questionId: target.decisionId,
      answer: "Plan A",
      requestId: requestId("answer"),
    });
    expect(answered.status).toBe(200);

    const after = await pending();
    expect(
      (after.body.items as any[]).some(
        (item) => item.decisionId === target.decisionId,
      ),
    ).toBe(false);
    const detail = await read(target.issueId);
    const decision = detail.decisions.find(
      (item: any) => item.id === target.decisionId,
    );
    expect(decision).toMatchObject({ status: "pending", answer: "Plan A" });
  });

  test("an answered decision stops needing the user while remaining pending until resolve", async () => {
    const created = await issue("Answered unresolved");
    const asked = await ask(created.id, "Ready to ship?");
    const decisionId = asked.decisions[0].id as string;

    const answered = await actionJson("answerDecision", {
      issueId: created.id,
      questionId: decisionId,
      answer: "Yes",
      requestId: requestId("answer-unresolved"),
    });
    expect(answered.status).toBe(200);
    expect(answered.body.needs_user).toBe(false);

    const detail = await read(created.id);
    expect(detail.needs_user).toBe(false);
    expect(
      detail.decisions.find((item: any) => item.id === decisionId),
    ).toMatchObject({ status: "pending", answer: "Yes" });

    const after = await pending();
    expect(
      (after.body.items as any[]).some(
        (item) =>
          item.issueId === created.id && item.decisionId === decisionId,
      ),
    ).toBe(false);
  });

  test("withdrawn decisions and canceled Issues are excluded from the inbox", async () => {
    const active = await issue("Pending inbox withdraw");
    await ask(active.id, "Withdraw me?");
    const current = await read(active.id);
    const withdrawn = await actionJson("withdrawDecision", {
      issueId: active.id,
      questionId: `${active.id}-Q1`,
      expectedVersion: current.version,
      requestId: requestId("withdraw"),
    });
    expect(withdrawn.status).toBe(200);

    const canceled = await issue("Pending inbox cancel");
    await ask(canceled.id, "Cancel me?");
    const cancelVersion = await read(canceled.id);
    const canceledResult = await actionJson("cancelIssue", {
      issueId: canceled.id,
      expectedVersion: cancelVersion.version,
      reason: "No longer needed",
      requestId: requestId("cancel"),
    });
    expect(canceledResult.status).toBe(200);

    const response = await pending();
    expect(
      (response.body.items as any[]).some(
        (item) => item.issueId === active.id || item.issueId === canceled.id,
      ),
    ).toBe(false);
  });

  test("an archived Agent's question remains listed and answerable by the owner", async () => {
    const created = await issue("Pending inbox archived agent");
    await ask(created.id, "Keep or drop?", ["Keep", "Drop"]);
    const companyResponse = await fetch(base + "/api/companies/" + companyId, {
      headers: { cookie },
    });
    expect(companyResponse.status).toBe(200);
    const organization = await companyResponse.json();
    const archived = await actionJson(
      "archiveMember",
      {
        agentId: headId,
        expectedVersion: organization.organization.version,
        requestId: requestId("archive"),
      },
      "company_org",
    );
    expect(archived.status).toBe(200);

    const listed = await pending();
    expect(listed.status).toBe(200);
    const item = (listed.body.items as any[]).find(
      (candidate) => candidate.issueId === created.id,
    )!;
    expect(item).toMatchObject({
      agentId: headId,
      decisionId: `${created.id}-Q1`,
      question: "Keep or drop?",
      options: ["Keep", "Drop"],
    });

    const answered = await actionJson("answerDecision", {
      issueId: created.id,
      questionId: `${created.id}-Q1`,
      answer: "Keep",
      requestId: requestId("answer-archived"),
    });
    expect(answered.status).toBe(200);
    const after = await pending();
    expect(
      (after.body.items as any[]).some(
        (candidate) => candidate.decisionId === item.decisionId,
      ),
    ).toBe(false);
  });

  test("the inbox route rejects missing owner sessions, Agent bearers and missing companyId", async () => {
    const anonymous = await fetch(
      base + "/api/decisions/pending?companyId=" + companyId,
    );
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe("unauthorized");

    const head = await application.domain
      .getAgentInternal(headId)
      .catch(() => undefined);
    const bearer = head?.authToken ?? randomBytes(32).toString("hex");
    const agentCall = await fetch(
      base + "/api/decisions/pending?companyId=" + companyId,
      { headers: { authorization: `Bearer ${bearer}` } },
    );
    expect(agentCall.status).toBe(401);
    expect((await agentCall.json()).error.code).toBe("unauthorized");

    const missing = await fetch(base + "/api/decisions/pending", {
      headers: { cookie },
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("company_required");
  });
});
