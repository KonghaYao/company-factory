import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server/app";
import { schemas } from "../src/server/operations";
import { isAvatarColor } from "../src/domain";

// Real HTTP/MCP adapters and Company storage; runtime provisioning and Agent
// Git are replaced. No live Company home or Peri Session is used.
describe("Member avatar color HTTP/MCP contract", () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let server: ReturnType<typeof Bun.serve>;
  let root: string;
  let base: string;
  let cookie: string;
  let companyId: string;
  let requestSeq = 0;
  const requestId = (label: string) => `${label}-${++requestSeq}`;

  async function action(
    operation: string,
    input: Record<string, unknown> = {},
  ) {
    return fetch(base + "/api/action", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        companyId,
        module: "company_org",
        operation,
        input,
      }),
    });
  }
  async function mcp(method: string, params: Record<string, unknown> = {}) {
    const hr = await application.domain.getAgentInternal(`${companyId}-hr`);
    const response = await fetch(base + "/company_org/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(params.name ? { "Mcp-Name": String(params.name) } : {}),
        authorization: `Bearer ${hr.authToken}`,
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
              name: "member-avatar-color-test",
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
  async function getCompany() {
    const response = await fetch(base + `/api/companies/${companyId}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-avatar-http-"));
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = reservation.port;
    reservation.stop();
    base = `http://127.0.0.1:${port}`;
    const token = randomBytes(32).toString("hex");
    application = await createApplication({ root, baseUrl: base, webToken: token });
    spyOn(application.runtime, "provision").mockImplementation(async (agent) => ({
      sessionId: `unit-only-${agent.agentId}`,
    }));
    const commit = application.domain.store.commit.bind(application.domain.store);
    spyOn(application.domain.store, "commit").mockImplementation(
      async (directory, message) => {
        if (directory.startsWith(join(root, "agents") + "/")) return;
        return commit(directory, message);
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
    const created = await action("createCompany", {
      name: "Avatar HTTP",
      requestId: requestId("create"),
    });
    expect(created.status).toBe(200);
    companyId = (await created.json()).company.id;
  });
  afterAll(async () => {
    await application?.close();
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  test("updateMember schema accepts only palette ids", () => {
    const baseInput = {
      agentId: "member",
      expectedVersion: 1,
      requestId: "avatar-schema",
    };
    expect(
      schemas.updateMember!.safeParse({ ...baseInput, avatarColor: "rose" })
        .success,
    ).toBe(true);
    expect(
      schemas.updateMember!.safeParse({ ...baseInput, avatarColor: "chartreuse" })
        .success,
    ).toBe(false);
    expect(
      schemas.updateMember!.safeParse({ ...baseInput, avatarColor: null }).success,
    ).toBe(false);
    expect(schemas.updateMember!.safeParse(baseInput).success).toBe(true);
    expect(
      schemas.createMember!.safeParse({
        agentId: "member",
        name: "Member",
        role: "developer",
        responsibilities: "Delivery",
        requestId: "avatar-create-schema",
      }).success,
    ).toBe(true);
  });

  test("owner HTTP updateMember persists the color and the Company projection returns it", async () => {
    const before = await getCompany();
    const hr = before.agents.find(
      (agent: any) => agent.agentId === `${companyId}-hr`,
    );
    const target = hr.avatarColor === "rose" ? "blue" : "rose";
    const response = await action("updateMember", {
      agentId: hr.agentId,
      avatarColor: target,
      expectedVersion: hr.version,
      requestId: requestId("owner-color"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("avatarColor");
    const after = await getCompany();
    expect(
      after.agents.find((agent: any) => agent.agentId === hr.agentId)
        ?.avatarColor,
    ).toBe(target);
    const company = await application.domain.store.yaml(
      join(root, "companys", companyId, "company.yaml"),
    );
    expect(company.memberColors[hr.agentId]).toBe(target);
    expect(
      await application.domain.store.raw(
        join(root, "agents", hr.agentId, "agent.yaml"),
      ),
    ).not.toContain("avatarColor");
  });

  test("HTTP rejects invalid colors, stale versions and request-id reuse with another color", async () => {
    const view = await getCompany();
    const hr = view.agents.find(
      (agent: any) => agent.agentId === `${companyId}-hr`,
    );
    const invalid = await action("updateMember", {
      agentId: hr.agentId,
      avatarColor: "chartreuse",
      expectedVersion: hr.version,
      requestId: requestId("invalid-color"),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("invalid_input");
    const stale = await action("updateMember", {
      agentId: hr.agentId,
      avatarColor: "teal",
      expectedVersion: hr.version - 1,
      requestId: requestId("stale-color"),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("version_conflict");

    const request = requestId("reused-request");
    const first = await action("updateMember", {
      agentId: hr.agentId,
      name: "HR Renamed",
      requestId: request,
      expectedVersion: hr.version,
    });
    expect(first.status).toBe(200);
    const firstVersion = (await first.json()).version;
    const conflict = await action("updateMember", {
      agentId: hr.agentId,
      avatarColor: "teal",
      expectedVersion: firstVersion,
      requestId: request,
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("idempotency_conflict");
  });

  test("HR cannot set colors through updateMember or createMember", async () => {
    const view = await getCompany();
    const hr = view.agents.find(
      (agent: any) => agent.agentId === `${companyId}-hr`,
    );
    const update = await mcp("tools/call", {
      name: "updateMember",
      arguments: {
        agentId: hr.agentId,
        avatarColor: "rose",
        expectedVersion: hr.version,
        requestId: requestId("hr-update-color"),
      },
    });
    expect(update.result.isError).toBe(true);
    expect(JSON.parse(update.result.content[0].text).error.code).toBe(
      "forbidden",
    );

    const agentsBefore = await application.domain.store.ids(
      join(root, "agents"),
    );
    const created = await mcp("tools/call", {
      name: "createMember",
      arguments: {
        agentId: "api-color-forbidden",
        name: "Forbidden Color",
        role: "developer",
        responsibilities: "Must not be created",
        avatarColor: "rose",
        requestId: requestId("hr-create-color"),
      },
    });
    expect(created.result.isError).toBe(true);
    expect(JSON.parse(created.result.content[0].text).error.code).toBe(
      "forbidden",
    );
    expect(await application.domain.store.ids(join(root, "agents"))).toEqual(
      agentsBefore,
    );
    const roster = await application.domain.store.yaml(
      join(root, "companys", companyId, "roster.yaml"),
    );
    expect(
      roster.members.some(
        (member: any) => member.agentId === "api-color-forbidden",
      ),
    ).toBe(false);

    const allowed = await mcp("tools/call", {
      name: "createMember",
      arguments: {
        agentId: "api-color-default",
        name: "Default Color",
        role: "developer",
        responsibilities: "Default allocation",
        requestId: requestId("hr-create-default"),
      },
    });
    expect(allowed.result.isError).toBeUndefined();
    const stored = await application.domain.store.yaml(
      join(root, "companys", companyId, "company.yaml"),
    );
    expect(isAvatarColor(stored.memberColors["api-color-default"])).toBe(true);
  });
});
