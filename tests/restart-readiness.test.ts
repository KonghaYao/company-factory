import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";
import { createApplication } from "../src/server/app";
import {
  RestartReadiness,
  RestartReadinessError,
  type RestartReadinessDomain,
  type RestartReadinessNotices,
  type RestartReadinessRuntime,
  type RestartBusyReason,
} from "../src/server/restart-readiness";
import type { WorkNotice } from "../src/server/agent-work-notices";
import type { InFlightDelivery } from "../src/domain";
import type { RuntimeWorkState } from "../src/runtime";

const company = {
  id: "c-1",
  name: "Fixture Company",
  initialization_status: "complete",
};
const roster = [
  {
    agentId: "c-1-dev",
    name: "Developer",
    status: "active" as const,
    sessionId: "session-dev",
  },
  {
    agentId: "c-1-old",
    name: "Archived Person",
    status: "archived" as const,
    sessionId: "session-old",
  },
];
const otherCompany = {
  id: "c-2",
  name: "Other Company",
  initialization_status: "complete",
};
const otherRoster = [
  {
    agentId: "c-2-dev",
    name: "Other Developer",
    status: "active" as const,
    sessionId: "session-other",
  },
];

type WorkOverrides = Partial<RuntimeWorkState>;
function work(
  companyId: string,
  agentId: string,
  overrides: WorkOverrides = {},
): RuntimeWorkState {
  return {
    companyId,
    agentId,
    sessionId: `session-${agentId}`,
    bound: true,
    operation: false,
    pendingAdmissions: 0,
    status: "idle",
    running: false,
    promptInFlight: 0,
    activeTurn: null,
    queueCount: 0,
    interactions: [],
    tasks: [],
    ...overrides,
  };
}
function notice(agentId: string, id = "notice-1"): WorkNotice {
  return {
    id,
    kind: "createIssue",
    issueId: "task-1",
    issueVersion: 1,
    agentId,
    status: "saved",
    at: "2026-11-02T18:00:00.000Z",
  };
}
function delivery(
  companyId: string,
  recipientId: string,
  messageId = "message-1",
): InFlightDelivery {
  return {
    companyId,
    messageId,
    threadId: "thread-1",
    recipientId,
    startedAt: "2026-11-02T18:00:00.000Z",
  };
}

interface HarnessOptions {
  companies?: Array<{ id: string; name: string; initialization_status?: string }>;
  rosters?: Record<
    string,
    Array<{
      agentId: string;
      name: string;
      status: "active" | "archived";
      sessionId?: string;
    }>
  >;
  workState?: (input: {
    companyId: string;
    agentId: string;
    sessionId?: string;
  }) => RuntimeWorkState;
  activeScopes?: () => Array<{ companyId: string; agentId: string }>;
  deliveries?: InFlightDelivery[];
  noticesInFlight?: (companyId: string) => WorkNotice[];
  listCompanies?: () => Promise<
    Array<{ id: string; name: string; initialization_status?: string }>
  >;
  organization?: RestartReadinessDomain["organization"];
  timeoutMs?: number;
  version?: string;
}
function harness(options: HarnessOptions = {}) {
  const companies = options.companies ?? [company];
  const rosters = options.rosters ?? {
    [company.id]: roster,
    [otherCompany.id]: otherRoster,
  };
  const domain: RestartReadinessDomain = {
    listCompanies:
      options.listCompanies ?? (async () => companies.map((item) => ({ ...item }))),
    organization:
      options.organization ??
      (async (ctx) => ({
        company: companies.find((item) => item.id === ctx.companyId),
        agents: rosters[ctx.companyId] ?? [],
      })),
    inFlightDeliveries: (companyId) =>
      (options.deliveries ?? [])
        .filter((item) => item.companyId === companyId)
        .map((item) => ({ ...item })),
  };
  const runtime: RestartReadinessRuntime = {
    workState:
      options.workState ??
      ((input) =>
        work(input.companyId, input.agentId, {
          sessionId: input.sessionId ?? `session-${input.agentId}`,
        })),
    activeScopes: options.activeScopes ?? (() => []),
  };
  const notices: RestartReadinessNotices = {
    inFlight: options.noticesInFlight ?? (() => []),
  };
  const readiness = new RestartReadiness({
    domain,
    runtime,
    notices,
    version: options.version ?? "9.9.9",
    now: () => new Date("2026-11-02T18:20:00.000Z"),
    timeoutMs: options.timeoutMs,
  });
  return { readiness, domain, runtime, notices };
}

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("restart readiness aggregation", () => {
  test("idle roster is safe, archived idle does not block, and offline is counted", async () => {
    const h = harness({
      workState: (input) => {
        if (input.agentId === "c-1-dev")
          return work(input.companyId, input.agentId, {
            sessionId: "session-dev",
            bound: false,
          });
        return work(input.companyId, input.agentId, { bound: false });
      },
    });
    const result = await h.readiness.check();
    expect(result).toEqual({
      safeToRestart: true,
      verified: true,
      checkedAt: "2026-11-02T18:20:00.000Z",
      serverVersion: "9.9.9",
      busy: [],
      counts: {
        companies: 1,
        activeAgents: 1,
        archivedAgents: 1,
        busyAgents: 0,
        idleAgents: 1,
        offlineAgents: 1,
      },
      errors: [],
    });
  });

  test("all execution facts merge into one busy Agent with stable reasons", async () => {
    const reasons: RestartBusyReason[] = [
      "active_turn",
      "prompt_in_flight",
      "prompt_admission",
      "agent_operation",
      "queued_input",
      "awaiting_input",
      "running_task",
      "im_delivery",
      "work_notice",
    ];
    const h = harness({
      workState: (input) =>
        input.agentId === "c-1-dev"
          ? work(input.companyId, input.agentId, {
              sessionId: "session-dev",
              status: "running",
              running: true,
              activeTurn: { turnId: "turn-3", status: "running" },
              promptInFlight: 1,
              pendingAdmissions: 1,
              operation: true,
              queueCount: 2,
              interactions: [
                { id: "interaction-1", kind: "permission", status: "pending" },
              ],
              tasks: [{ id: "task-1", status: "running" }],
            })
          : work(input.companyId, input.agentId),
      deliveries: [delivery(company.id, "c-1-dev")],
      noticesInFlight: (companyId) =>
        companyId === company.id ? [notice("c-1-dev")] : [],
    });
    const result = await h.readiness.check();
    expect(result.verified).toBe(true);
    expect(result.safeToRestart).toBe(false);
    expect(result.busy).toHaveLength(1);
    expect(result.busy[0]).toEqual({
      companyId: company.id,
      companyName: company.name,
      agentId: "c-1-dev",
      name: "Developer",
      status: "running",
      reasons,
      sessionId: "session-dev",
      turnId: "turn-3",
      threadId: "thread-1",
      archived: false,
    });
    expect(result.counts).toMatchObject({
      companies: 1,
      activeAgents: 1,
      archivedAgents: 1,
      busyAgents: 1,
      idleAgents: 0,
      offlineAgents: 0,
    });
  });

  test("archived Agent with live work still blocks restart", async () => {
    const h = harness({
      workState: (input) =>
        work(input.companyId, input.agentId, {
          status: input.agentId === "c-1-old" ? "running" : "idle",
          running: input.agentId === "c-1-old",
        }),
    });
    const result = await h.readiness.check();
    expect(result.safeToRestart).toBe(false);
    expect(result.busy).toHaveLength(1);
    expect(result.busy[0]).toMatchObject({
      agentId: "c-1-old",
      archived: true,
      status: "running",
      reasons: ["active_turn"],
    });
    expect(result.counts.busyAgents).toBe(1);
  });

  test("a delivery-only Agent is reported as delivering with its thread", async () => {
    const h = harness({
      deliveries: [delivery(company.id, "c-1-dev", "message-9")],
    });
    const result = await h.readiness.check();
    expect(result.safeToRestart).toBe(false);
    expect(result.busy[0]).toMatchObject({
      agentId: "c-1-dev",
      status: "delivering",
      reasons: ["im_delivery"],
      threadId: "thread-1",
      sessionId: "session-dev",
    });
  });

  test("a notice-only delivery is reported as delivering", async () => {
    const h = harness({
      noticesInFlight: (companyId) =>
        companyId === company.id ? [notice("c-1-dev")] : [],
    });
    const result = await h.readiness.check();
    expect(result.busy[0]).toMatchObject({
      agentId: "c-1-dev",
      status: "delivering",
      reasons: ["work_notice"],
    });
  });

  test("an operation-only lock is reported as binding", async () => {
    const h = harness({
      workState: (input) =>
        work(input.companyId, input.agentId, { operation: true }),
    });
    const result = await h.readiness.check();
    expect(result.safeToRestart).toBe(false);
    expect(result.busy.map((item) => item.agentId).sort()).toEqual([
      "c-1-dev",
      "c-1-old",
    ]);
    expect(result.busy[0]!.status).toBe("binding");
  });

  test("queue-only and task-only states get distinct statuses", async () => {
    const queued = harness({
      workState: (input) =>
        work(input.companyId, input.agentId, {
          queueCount: input.agentId === "c-1-dev" ? 1 : 0,
        }),
    });
    const queuedResult = await queued.readiness.check();
    expect(queuedResult.busy[0]).toMatchObject({
      agentId: "c-1-dev",
      status: "queued",
      reasons: ["queued_input"],
    });

    const tasked = harness({
      workState: (input) =>
        work(input.companyId, input.agentId, {
          tasks:
            input.agentId === "c-1-dev"
              ? [{ id: "task-1", status: "in_progress" }]
              : [],
        }),
    });
    const taskedResult = await tasked.readiness.check();
    expect(taskedResult.busy[0]).toMatchObject({
      agentId: "c-1-dev",
      status: "task_running",
      reasons: ["running_task"],
    });
  });

  test("initialization-incomplete Company is not blocked without live work", async () => {
    const h = harness({
      companies: [
        {
          id: "c-init",
          name: "Initializing Company",
          initialization_status: "initializing",
        },
      ],
      rosters: {},
    });
    const result = await h.readiness.check();
    expect(result).toEqual({
      safeToRestart: true,
      verified: true,
      checkedAt: "2026-11-02T18:20:00.000Z",
      serverVersion: "9.9.9",
      busy: [],
      counts: {
        companies: 1,
        activeAgents: 0,
        archivedAgents: 0,
        busyAgents: 0,
        idleAgents: 0,
        offlineAgents: 0,
      },
      errors: [],
    });
  });

  test("initialization-incomplete Company still blocks an active Provision lock", async () => {
    const h = harness({
      companies: [
        {
          id: "c-init",
          name: "Initializing Company",
          initialization_status: "initializing",
        },
      ],
      rosters: {},
      activeScopes: () => [{ companyId: "c-init", agentId: "c-init-hr" }],
      workState: (input) =>
        work(input.companyId, input.agentId, {
          bound: false,
          operation: true,
        }),
    });
    const result = await h.readiness.check();
    expect(result.verified).toBe(true);
    expect(result.safeToRestart).toBe(false);
    expect(result.busy).toEqual([
      {
        companyId: "c-init",
        companyName: "Initializing Company",
        agentId: "c-init-hr",
        name: "c-init-hr",
        status: "binding",
        reasons: ["agent_operation"],
        sessionId: "session-c-init-hr",
        turnId: null,
        threadId: null,
        archived: false,
      },
    ]);
  });

  test("bound work outside the roster is still reported", async () => {
    const h = harness({
      activeScopes: () => [{ companyId: company.id, agentId: "c-1-orphan" }],
      workState: (input) =>
        work(input.companyId, input.agentId, {
          status: input.agentId === "c-1-orphan" ? "running" : "idle",
          running: input.agentId === "c-1-orphan",
        }),
    });
    const result = await h.readiness.check();
    expect(result.busy.map((item) => item.agentId)).toContain("c-1-orphan");
    expect(result.busy.find((item) => item.agentId === "c-1-orphan")).toMatchObject(
      {
        name: "c-1-orphan",
        sessionId: "session-c-1-orphan",
        reasons: ["active_turn"],
        archived: false,
      },
    );
    expect(result.counts.activeAgents).toBe(1);
  });

  test("a source failure fails closed with a redacted error", async () => {
    const h = harness({
      workState: (input) => {
        if (input.agentId === "c-1-dev")
          throw new Error("read failed at https://secret.example/token=abc");
        return work(input.companyId, input.agentId);
      },
    });
    const result = await h.readiness.check();
    expect(result.safeToRestart).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "work_state_unavailable",
      agentId: "c-1-dev",
    });
    expect(result.errors[0]!.message).not.toContain("secret.example");
    expect(result.busy).toEqual([]);
  });

  test("listCompanies failure returns unverified", async () => {
    const h = harness({
      listCompanies: async () => {
        throw new Error("companies unreadable");
      },
    });
    const result = await h.readiness.check();
    expect(result).toMatchObject({
      safeToRestart: false,
      verified: false,
      busy: [],
      counts: {
        companies: 0,
        activeAgents: 0,
        archivedAgents: 0,
        busyAgents: 0,
        idleAgents: 0,
        offlineAgents: 0,
      },
    });
    expect(result.errors[0]!.code).toBe("companies_unavailable");
  });

  test("a slow source times out and fails closed", async () => {
    const h = harness({
      timeoutMs: 5,
      organization: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { company, agents: roster };
      },
    });
    const result = await h.readiness.check();
    expect(result.safeToRestart).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.busy).toEqual([]);
    expect(result.errors).toEqual([
      {
        code: "readiness_timeout",
        message: "重启检查超时，无法确认所有人员状态",
      },
    ]);
  });

  test("companyId filters the scan and unknown companies are 404", async () => {
    const h = harness({
      companies: [company, otherCompany],
      workState: (input) =>
        work(input.companyId, input.agentId, {
          status: "running",
          running: true,
        }),
    });
    const filtered = await h.readiness.check({ companyId: otherCompany.id });
    expect(filtered.counts.companies).toBe(1);
    expect(filtered.busy.map((item) => item.agentId)).toEqual(["c-2-dev"]);
    await expect(h.readiness.check({ companyId: "missing" })).rejects.toMatchObject(
      { code: "company_not_found", status: 404 },
    );
    await expect(
      h.readiness.check({ companyId: "missing" }),
    ).rejects.toBeInstanceOf(RestartReadinessError);
  });
});

describe("restart readiness HTTP boundary", () => {
  const origin = "http://127.0.0.1:3000";
  const apps: Array<Awaited<ReturnType<typeof createApplication>>> = [];
  afterAll(async () => {
    for (const app of apps.splice(0)) await app.close();
  });
  async function application(readiness: RestartReadiness) {
    const root = await mkdtemp(join(tmpdir(), "company-readiness-"));
    roots.push(root);
    const app = await createApplication({
      root,
      baseUrl: origin,
      webToken: "fixture-owner-token-readiness",
      readiness,
    });
    apps.push(app);
    return app;
  }
  async function login(app: Awaited<ReturnType<typeof createApplication>>) {
    const response = await app.app.request(origin + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "fixture-owner-token-readiness" }),
    });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  }

  test("owner gets 200 for idle and 404 for an unknown company", async () => {
    const app = await application(harness().readiness);
    const health = await app.app.request(origin + "/health");
    expect(health.status).toBe(200);
    expect((await health.json()).version).toBe(packageJson.version);

    const unauthorized = await app.app.request(
      origin + "/api/restart-readiness",
    );
    expect(unauthorized.status).toBe(401);
    const bearer = await app.app.request(origin + "/api/restart-readiness", {
      headers: { authorization: "Bearer " + "a".repeat(40) },
    });
    expect(bearer.status).toBe(401);

    const cookie = await login(app);
    const safe = await app.app.request(origin + "/api/restart-readiness", {
      headers: { cookie },
    });
    expect(safe.status).toBe(200);
    expect(await safe.json()).toMatchObject({
      safeToRestart: true,
      verified: true,
      serverVersion: "9.9.9",
    });

    const missing = await app.app.request(
      origin + "/api/restart-readiness?companyId=missing",
      { headers: { cookie } },
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "company_not_found" },
    });
  });

  test("busy returns 409 with the Agent and reason", async () => {
    const app = await application(
      harness({
        workState: (input) =>
          work(input.companyId, input.agentId, {
            status: input.agentId === "c-1-dev" ? "running" : "idle",
            running: input.agentId === "c-1-dev",
          }),
      }).readiness,
    );
    const cookie = await login(app);
    const response = await app.app.request(
      origin + "/api/restart-readiness",
      { headers: { cookie } },
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      safeToRestart: false,
      verified: true,
      busy: [
        {
          agentId: "c-1-dev",
          name: "Developer",
          status: "running",
          reasons: ["active_turn"],
        },
      ],
    });
  });

  test("an unreadable source returns 503 verified=false", async () => {
    const app = await application(
      harness({
        workState: (input) => {
          if (input.agentId === "c-1-dev") throw new Error("unreadable");
          return work(input.companyId, input.agentId);
        },
      }).readiness,
    );
    const cookie = await login(app);
    const response = await app.app.request(
      origin + "/api/restart-readiness",
      { headers: { cookie } },
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      safeToRestart: false,
      verified: false,
      errors: [{ code: "work_state_unavailable" }],
    });
  });
});
