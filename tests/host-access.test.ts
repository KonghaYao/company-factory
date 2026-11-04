import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server/app";

// Any hostname may reach the workbench (e.g. a Tailscale address). Credentials,
// not Host/Origin, protect every data route.
const foreign = "http://100.105.157.106:3400";

describe("Host-agnostic HTTP edge with credential authentication", () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let root: string;
  let token: string;
  let cookie: string;
  let companyId: string;

  const request = (
    path: string,
    init: RequestInit = {},
    base = foreign,
  ) => application.app.fetch(new Request(base + path, init));
  const jsonPost = (path: string, body: unknown, headers = {}) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-host-access-"));
    const staticRoot = join(root, "web");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><p>workbench</p>");
    token = randomBytes(32).toString("hex");
    application = await createApplication({
      root,
      baseUrl: "http://127.0.0.1:3000",
      webToken: token,
      staticRoot,
    });
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
    const login = await jsonPost("/api/login", { token });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const created = await jsonPost(
      "/api/action",
      {
        companyId: "",
        module: "company_org",
        operation: "createCompany",
        input: { name: "Host Access", requestId: "host-access-create" },
      },
      { cookie },
    );
    expect(created.status).toBe(200);
    companyId = (await created.json()).company.id;
  });

  afterAll(async () => {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  });

  test("arbitrary Host reaches the SPA shell instead of returning forbidden", async () => {
    const response = await request("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("workbench");
  });

  test("arbitrary Host still requires the owner cookie for data routes", async () => {
    const anonymous = await request("/api/companies");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    const owner = await request("/api/companies", { headers: { cookie } });
    expect(owner.status).toBe(200);
    expect((await owner.json()).companies.map((company: any) => company.id)).toContain(
      companyId,
    );
  });

  test("cross-origin owner requests are no longer rejected by Origin or Sec-Fetch-Site", async () => {
    const response = await jsonPost(
      "/api/action",
      {
        companyId,
        module: "company_org",
        operation: "organization",
        input: {},
      },
      {
        cookie,
        origin: "https://attacker.invalid",
        "sec-fetch-site": "cross-site",
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).company.id).toBe(companyId);
  });

  test("login still compares COMPANY_WEB_TOKEN and issues a locked-down cookie", async () => {
    const rejected = await jsonPost("/api/login", { token: "wrong-token" });
    expect(rejected.status).toBe(401);
    const accepted = await jsonPost("/api/login", { token });
    expect(accepted.status).toBe(200);
    const setCookie = accepted.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  test("forged Agent Bearer is rejected on arbitrary Host while a valid one works", async () => {
    const mcp = async (authorization?: string) =>
      request("/company_tasks/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "host-access-test",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
    const forged = await mcp(`Bearer ${randomBytes(32).toString("hex")}`);
    expect(forged.status).toBe(401);
    const hr = await application.domain.getAgentInternal(`${companyId}-hr`);
    const valid = await mcp(`Bearer ${hr.authToken}`);
    expect(valid.status).toBe(200);
    const data = await valid.json();
    expect(data.result.tools.some((tool: any) => tool.name === "listIssues")).toBe(
      true,
    );
  });
});
