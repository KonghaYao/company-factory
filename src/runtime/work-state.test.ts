import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeriRuntime } from "./index";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), "company-work-state-"));
  roots.push(root);
  const runtime = new PeriRuntime({ root, periBinary: "/bin/true" });
  await (runtime as any).initialized;
  return runtime;
}

describe("runtime work state", () => {
  test("unbound scopes are immediate, idle facts without waking", async () => {
    const runtime = await runtimeFixture();
    expect(
      runtime.workState({ companyId: "c-1", agentId: "c-1-dev" }),
    ).toEqual({
      companyId: "c-1",
      agentId: "c-1-dev",
      sessionId: null,
      bound: false,
      operation: false,
      pendingAdmissions: 0,
      status: "idle",
      running: false,
      promptInFlight: 0,
      activeTurn: null,
      queueCount: 0,
      interactions: [],
      tasks: [],
    });
    expect(runtime.activeScopes()).toEqual([]);
  });

  test("bound execution facts and operation locks are exposed read-only", async () => {
    const runtime = await runtimeFixture();
    const view = {
      activeTurnId: "turn-1",
      activeTurnStatus: "running",
      running: true,
      turns: [
        { turnId: "turn-0", status: "completed" },
        { turnId: "turn-1", status: "running" },
      ],
      inputQueue: {
        generation: "g",
        revision: 1,
        items: [{ inputId: "i-1", state: "queued" }],
      },
      pendingInteractions: [
        { id: "pending-1", kind: "permission", status: "pending" },
        { id: "done-1", kind: "elicitation", status: "resolved" },
      ],
      tasks: [
        { taskId: "task-1", status: "running", title: "secret title" },
        { taskId: "task-2", status: "completed", title: "done" },
      ],
    };
    (runtime as any).agents.set("c-1/dev", {
      input: { companyId: "c-1", agentId: "dev", directory: "/tmp" },
      chat: { sessionId: "session-1" },
      replica: { read: () => view },
      promptInFlight: new Map([
        ["request-1", { startedAt: "2026-11-02T18:00:00.000Z" }],
        ["request-2", { startedAt: "2026-11-02T18:00:01.000Z" }],
      ]),
    });
    (runtime as any).locks.set("c-1/dev", Promise.resolve());
    (runtime as any).locks.set("c-2/hr", Promise.resolve());
    (runtime as any).locks.set("c-1/dev", Promise.resolve());
    void (runtime as any).deliveries.run(
      "c-1/dev/request-3",
      "fingerprint",
      () => new Promise(() => {}),
    );

    expect(
      runtime.workState({ companyId: "c-1", agentId: "dev" }),
    ).toEqual({
      companyId: "c-1",
      agentId: "dev",
      sessionId: "session-1",
      bound: true,
      operation: true,
      pendingAdmissions: 1,
      status: "running",
      running: true,
      promptInFlight: 2,
      activeTurn: { turnId: "turn-1", status: "running" },
      queueCount: 1,
      interactions: [
        { id: "pending-1", kind: "permission", status: "pending" },
      ],
      tasks: [
        { id: "task-1", status: "running" },
        { id: "task-2", status: "completed" },
      ],
    });
    expect(runtime.activeScopes()).toEqual([
      { companyId: "c-1", agentId: "dev" },
      { companyId: "c-2", agentId: "hr" },
    ]);
    expect(
      runtime.workState({
        companyId: "c-1",
        agentId: "dev",
        sessionId: "fallback-session",
      }).sessionId,
    ).toBe("session-1");
  });
});
