import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyDomain } from "./index";
import { AgentService } from "../server/agent-service";

// Real domain/file/company-Git behavior. Session provisioning, runtime restart,
// and Agent Git are explicit test substitutes, not live WASM evidence.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "company-profile-test-"));
  const domain = new CompanyDomain({
    root,
    provisionAgent: async (input) => ({ sessionId: `unit-${input.agentId}` }),
  });
  const commit = domain.store.commit.bind(domain.store);
  spyOn(domain.store, "commit").mockImplementation(async (directory, message) => {
    if (directory.startsWith(join(root, "agents") + "/")) return;
    return commit(directory, message);
  });
  let user = { type: "user" as const, id: "owner", companyId: "" };
  const { company, agents } = await domain.createCompany(user, {
    name: "Profile fixture", requestId: "create",
    config: { instructions: "OLD_INSTRUCTIONS" },
  });
  user = { ...user, companyId: company.id };
  const agent = await domain.getAgent(user, { agentId: agents[0]!.agentId });
  const memoryPath = join(agent.directory, "CLAUDE.md");
  const runtime = {
    sessionBinding: async () => undefined,
    restart: async (_input: unknown) => ({ sessionId: agent.sessionId }),
  };
  const restart = spyOn(runtime, "restart");
  const service = new AgentService(domain, runtime as any);
  return {
    root, domain, user, agent, service, restart, memoryPath,
    memory: () => readFile(memoryPath, "utf8"),
    save: () => service.save(user, agent.agentId, {
      expectedVersion: agent.version,
      config: { instructions: "NEW_INSTRUCTIONS" }, requestId: "save",
    }),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

describe("Applied Agent profile and autonomous memory", () => {
  test("restart applies the same instructions to configuration and memory, preserving Session and free notes", async () => {
    const f = await fixture();
    try {
      await f.save();
      f.restart.mockImplementation(async () => {
        await writeFile(f.memoryPath, (await f.memory()) + "\nNEW_AGENT_OBSERVATION\n");
        return { sessionId: f.agent.sessionId };
      });
      await f.service.restart(f.user, f.agent.agentId);
      expect((f.restart.mock.calls[0]?.[0] as any).config.instructions).toBe("NEW_INSTRUCTIONS");
      const applied = await f.service.configuration(f.user, f.agent.agentId);
      expect(applied.pendingRestart).toBe(false);
      expect(applied.applied.instructions).toBe("NEW_INSTRUCTIONS");
      const memory = await f.memory();
      expect(memory).toContain("NEW_INSTRUCTIONS");
      expect(memory).not.toContain("OLD_INSTRUCTIONS");
      expect(memory).toContain("NEW_AGENT_OBSERVATION");
      expect((await f.domain.getAgent(f.user, { agentId: f.agent.agentId })).sessionId).toBe(f.agent.sessionId);
    } finally { await f.close(); }
  });

  test("editing a member does not publish pending instructions", async () => {
    const f = await fixture();
    try {
      await f.save();
      const before = await f.domain.getAgent(f.user, { agentId: f.agent.agentId });
      await f.domain.updateMember(f.user, {
        agentId: f.agent.agentId, version: before.version, requestId: "edit",
        name: "Renamed", responsibilities: "CURRENT_RESPONSIBILITIES",
      });
      expect((await f.service.configuration(f.user, f.agent.agentId)).pendingRestart).toBe(true);
      const memory = await f.memory();
      expect(memory).toContain("OLD_INSTRUCTIONS");
      expect(memory).not.toContain("NEW_INSTRUCTIONS");
      expect(memory).toContain("CURRENT_RESPONSIBILITIES");
    } finally { await f.close(); }
  });

  test("invalid managed markers reject a member edit before changing its facts", async () => {
    const f = await fixture();
    try {
      const damaged = (await f.memory()) + "\n<!-- company:profile:start -->\n";
      await writeFile(f.memoryPath, damaged);
      await expect(f.domain.updateMember(f.user, {
        agentId: f.agent.agentId, version: f.agent.version, requestId: "edit",
        responsibilities: "MUST_NOT_APPLY",
      })).rejects.toMatchObject({ code: "invalid_document", status: 409 });
      const after = await f.domain.getAgent(f.user, { agentId: f.agent.agentId });
      expect(after.version).toBe(f.agent.version);
      expect(after.responsibilities).toBe(f.agent.responsibilities);
      expect(await f.memory()).toBe(damaged);
    } finally { await f.close(); }
  });

  test("restart preflight rejects malformed memory without starting a new activation", async () => {
    const f = await fixture();
    try {
      await f.save();
      await writeFile(f.memoryPath, "<!-- company:profile:start -->\nunfinished");
      await expect(f.service.restart(f.user, f.agent.agentId)).rejects.toMatchObject({ code: "invalid_document" });
      expect(f.restart).not.toHaveBeenCalled();
      expect((await f.service.configuration(f.user, f.agent.agentId)).pendingRestart).toBe(true);
    } finally { await f.close(); }
  });

  test("runtime failure cannot publish saved instructions", async () => {
    const f = await fixture();
    try {
      await f.save();
      f.restart.mockImplementation(async () => { throw new Error("unit activation failure"); });
      await expect(f.service.restart(f.user, f.agent.agentId)).rejects.toThrow("unit activation failure");
      expect((await f.service.configuration(f.user, f.agent.agentId)).pendingRestart).toBe(true);
      expect(await f.memory()).toContain("OLD_INSTRUCTIONS");
    } finally { await f.close(); }
  });

  test("post-start memory failure never marks the configuration applied", async () => {
    const f = await fixture();
    try {
      await f.save();
      f.restart.mockImplementation(async () => {
        await writeFile(f.memoryPath, "<!-- company:profile:start -->\nchanged during restart");
        return { sessionId: f.agent.sessionId };
      });
      await expect(f.service.restart(f.user, f.agent.agentId)).rejects.toMatchObject({ code: "invalid_document" });
      const configuration = await f.service.configuration(f.user, f.agent.agentId);
      expect(configuration.pendingRestart).toBe(true);
      expect(configuration.applied.instructions).toBe("OLD_INSTRUCTIONS");
    } finally { await f.close(); }
  });

  test("a newer saved revision during restart is not mislabeled as the running configuration", async () => {
    const f = await fixture();
    try {
      await f.save();
      f.restart.mockImplementation(async () => {
        const current = await f.domain.getAgent(f.user, { agentId: f.agent.agentId });
        await f.domain.saveAgentConfiguration(f.user, {
          agentId: f.agent.agentId, version: current.version, requestId: "newer-save",
          config: { instructions: "LATER_INSTRUCTIONS" },
        });
        return { sessionId: f.agent.sessionId };
      });
      await expect(f.service.restart(f.user, f.agent.agentId)).rejects.toMatchObject({ code: "version_conflict" });
      const configuration = await f.service.configuration(f.user, f.agent.agentId);
      expect(configuration.pendingRestart).toBe(true);
      expect(configuration.applied.instructions).toBe("OLD_INSTRUCTIONS");
      expect(await f.memory()).not.toContain("LATER_INSTRUCTIONS");
    } finally { await f.close(); }
  });
});
