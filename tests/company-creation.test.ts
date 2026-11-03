import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server/app";
import { schemas } from "../src/server/operations";

// 真实 HTTP/MCP 适配器及公司存储；仅 provisioning 和 Agent Git 使用显式测试替身。
// 不启动真实 Peri，不代表真实 Session 或沙箱验证，也不访问实际用户数据。
describe("Company creation HTTP/MCP contract with unit provisioning", () => {
  let application: Awaited<ReturnType<typeof createApplication>>,
    server: ReturnType<typeof Bun.serve>,
    root: string,
    base: string,
    cookie: string;
  let companyId: string;
  let failSecretary = false;
  const provisions: string[] = [];
  const input = { name: "接口创建的中文公司", goal: "可靠交付", requestId: "http-create" };
  async function create(payload: Record<string, unknown>, scope?: string) {
    return fetch(base + "/api/action", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        module: "company_org",
        operation: "createCompany",
        ...(scope === undefined ? {} : { companyId: scope }),
        input: payload,
      }),
    });
  }
  async function mcp(
    method: string,
    params: Record<string, unknown> = {},
    agentId = `${companyId}-hr`,
    module = "company_org",
  ) {
    const agent = await application.domain.getAgentInternal(agentId);
    const response = await fetch(base + `/${module}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(params.name ? { "Mcp-Name": String(params.name) } : {}),
        ...(params.uri ? { "Mcp-Name": String(params.uri) } : {}),
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
              name: "company-creation-unit-test",
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
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-http-create-"));
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop();
    base = `http://127.0.0.1:${port}`;
    const token = randomBytes(32).toString("hex");
    application = await createApplication({ root, baseUrl: base, webToken: token });
    spyOn(application.runtime, "provision").mockImplementation(async (agent) => {
      provisions.push(agent.agentId);
      if (failSecretary && agent.agentId.endsWith("-secretary")) {
        failSecretary = false;
        throw Object.assign(new Error("单测：当前 companyId、agentId 缺少独立本地 url、authToken"), {
          code: "wasm_store_not_configured", status: 503,
        });
      }
      return { sessionId: `unit-only-${agent.agentId}` };
    });
    const commit = application.domain.store.commit.bind(application.domain.store);
    spyOn(application.domain.store, "commit").mockImplementation(async (dir, message) => {
      if (dir.startsWith(join(root, "agents") + "/")) return;
      return commit(dir, message);
    });
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: application.app.fetch });
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(async () => {
    await application?.close();
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  });
  test("HTTP creates without IDs and replays across Company scopes without provisioning twice", async () => {
    const response = await create(input);
    expect(response.status).toBe(200);
    const organization = await response.json();
    companyId = organization.company.id;
    expect(companyId).toMatch(/^c-[0-9a-f]{32}$/);
    expect(organization.company.name).toBe(input.name);
    expect(organization.agents.every((a: any) => a.companyId === companyId)).toBe(true);
    const replay = await create(input, "caller-selected-scope");
    expect(replay.status).toBe(200);
    expect((await replay.json()).company.id).toBe(companyId);
    expect(provisions).toHaveLength(2);
    const conflict = await create({ ...input, goal: "不同目标" });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("idempotency_conflict");
    const next = await create({ ...input, requestId: "http-create-next" });
    expect(next.status).toBe(200);
    expect((await next.json()).company.id).not.toBe(companyId);
    expect(provisions).toHaveLength(4);
  });
  test("MCP serves the shared company-assets skill as a read-only resource", async () => {
    // This gateway is strict MCP 2026-07-28: `initialize` belongs to the
    // legacy 2025-era handshake and is not a modern method. The modern
    // discovery handshake is `server/discover`.
    const initialized = await mcp("server/discover", {});
    expect(initialized.result?.supportedVersions).toContain("2026-07-28");
    expect(initialized.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name).toBe(
      "company_org",
    );

    const listed = await mcp("resources/list");
    const uris = listed.result.resources.map(
      (resource: { uri: string }) => resource.uri,
    );
    expect(uris).toContain("skill://company-assets/SKILL.md");
    expect(uris).toContain("skill://interview/SKILL.md");
    expect(uris).toContain("company://current/company_org");

    const read = await mcp("resources/read", {
      uri: "skill://company-assets/SKILL.md",
    });
    const content = read.result.contents[0];
    expect(content.mimeType).toBe("text/markdown");
    expect(content.text).toContain("name: company-assets");
    expect(content.text).toContain("# Company assets");
    expect(content.text).toContain("## 2. The boundary");
    expect(content.text).toContain("## 5. Company shared knowledge");
    expect(content.text).toContain("## 8. Host secrets");
    expect(content.text).toContain("mcp_read_resource");
    expect(content.text).not.toContain(".claude/skills");

    const interview = await mcp("resources/read", {
      uri: "skill://interview/SKILL.md",
    });
    const interviewContent = interview.result.contents[0];
    expect(interviewContent.mimeType).toBe("text/markdown");
    expect(interviewContent.text).toContain("name: interview");
    expect(interviewContent.text).toContain("# Interview");
    expect(interviewContent.text).toContain("（推荐）");
    expect(interviewContent.text).toContain("searchIssues");
    expect(interviewContent.text).toContain("Company Issues");
    expect(interviewContent.text).not.toContain("$ARGUMENTS");

    const secretaryRead = await mcp(
      "resources/read",
      { uri: "skill://company-assets/SKILL.md" },
      `${companyId}-secretary`,
    );
    expect(secretaryRead.result.contents[0].text).toContain("# Company assets");

    const agent = await application.domain.getAgentInternal(`${companyId}-hr`);
    const legacyInitialize = await fetch(base + "/company_org/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Mcp-Method": "initialize",
        authorization: `Bearer ${agent.authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy", version: "1.0.0" },
        },
      }),
    });
    expect(legacyInitialize.status).toBe(400);
    expect((await legacyInitialize.json()).error?.code).toBe(-32022);

    const unknown = await fetch(base + "/company_org/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "resources/read",
        "Mcp-Name": "skill://../owner-token/SKILL.md",
        authorization: `Bearer ${agent.authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "resources/read",
        params: {
          uri: "skill://../owner-token/SKILL.md",
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "company-creation-unit-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(unknown.status).toBe(200);
    const unknownBody = await unknown.json();
    expect(unknownBody.result?.contents).toBeUndefined();
    expect(JSON.stringify(unknownBody)).not.toContain("owner-token\n");

    const denied = await fetch(base + "/company_org/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "resources/read",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "resources/read",
        params: { uri: "skill://company-assets/SKILL.md" },
      }),
    });
    expect(denied.status).toBe(401);

    expect(application.mcp!.paths).toEqual([
      "/company_org/mcp",
      "/company_tasks/mcp",
      "/company_im/mcp",
    ]);
    const health = await fetch(base + "/health");
    expect((await health.json()).mcpModules).toEqual([
      "company_org",
      "company_tasks",
      "company_im",
    ]);
  });
  test("HTTP rejects caller-selected Company IDs without creating data", async () => {
    const before = await application.domain.store.ids(join(root, "companys"));
    for (const id of ["caller-selected", "../escape"]) {
      const response = await create({ ...input, id, requestId: "http-legacy-id" });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_input");
    }
    expect(await application.domain.store.ids(join(root, "companys"))).toEqual(before);
    expect(provisions).toHaveLength(4);
  });
  test("HTTP failure retry reuses completed bindings and still rejects changed payloads", async () => {
    failSecretary = true;
    const payload = { name: "重试公司", requestId: "http-retry" };
    const failed = await create(payload);
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.code).toBe("wasm_store_not_configured");
    const conflict = await create({ ...payload, name: "不同公司" });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("idempotency_conflict");
    const retried = await create(payload);
    expect(retried.status).toBe(200);
    const id = (await retried.json()).company.id;
    expect(provisions.filter((a) => a === `${id}-hr`)).toHaveLength(1);
    expect(provisions.filter((a) => a === `${id}-secretary`)).toHaveLength(2);
    expect((await create(payload)).status).toBe(200);
    expect(provisions).toHaveLength(7);
    expect(await application.domain.store.ids(join(root, "companys"))).toHaveLength(3);
  });
  test("MCP publishes organization tree, move and lifecycle tools with expected schemas", async () => {
    const discovery = await mcp("tools/list");
    const names = discovery.result.tools.map((tool: any) => tool.name);
    const taskDiscovery = await mcp(
      "tools/list",
      {},
      `${companyId}-hr`,
      "company_tasks",
    );
    const searchTool = taskDiscovery.result.tools.find(
      (tool: any) => tool.name === "searchIssues",
    );
    expect(searchTool).toBeDefined();
    expect(searchTool.annotations.readOnlyHint).toBe(true);
    const searched = await mcp(
      "tools/call",
      { name: "searchIssues", arguments: { query: "nothing-yet" } },
      `${companyId}-secretary`,
      "company_tasks",
    );
    expect(searched.result.isError).not.toBe(true);
    expect(JSON.parse(searched.result.content[0].text)).toMatchObject({
      items: [],
      total: 0,
      truncated: false,
    });
    for (const operation of [
      "createOrgNode",
      "updateOrgNode",
      "deleteOrgNode",
      "archiveOrgNode",
      "moveMember",
      "archiveMember",
      "restoreMember",
    ])
      expect(names).toContain(operation);
    expect(
      schemas.createMember!.safeParse({
        agentId: "member",
        name: "Member",
        role: "developer",
        responsibilities: "Delivery",
        requestId: "member-without-group",
      }).success,
    ).toBe(true);
    expect(
      schemas.moveMember!.safeParse({
        agentId: "member",
        nodeId: "team",
        expectedVersion: 1,
        requestId: "move-schema",
      }).success,
    ).toBe(true);
    expect(
      schemas.moveMember!.safeParse({
        agentId: "member",
        nodeId: "team",
        requestId: "move-schema",
      }).success,
    ).toBe(false);
  });
  test("MCP advertises generated IDs but still forbids Agents from creating companies", async () => {
    expect(schemas.createCompany!.safeParse(input).success).toBe(true);
    expect(schemas.createCompany!.safeParse({ ...input, config: {} }).success).toBe(true);
    expect(schemas.createCompany!.safeParse({ ...input, id: "legacy" }).success).toBe(false);
    const discovery = await mcp("tools/list");
    const tool = discovery.result.tools.find((t: any) => t.name === "createCompany");
    expect(tool.inputSchema.properties).not.toHaveProperty("id");
    expect(tool.inputSchema.required).toEqual(["name", "requestId"]);
    const denied = await mcp("tools/call", {
      name: "createCompany",
      arguments: { name: "Agent 不能创建公司", requestId: "agent-create-denied" },
    });
    expect(denied.result.isError).toBe(true);
    expect(JSON.parse(denied.result.content[0].text).error.code).toBe("forbidden");
    expect(provisions).toHaveLength(7);
  });
});
