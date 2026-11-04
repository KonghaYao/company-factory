import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyDomain, type CallerContext, type DomainOptions } from "./index";
import { AVATAR_COLORS, type AvatarColor } from "./avatar";
import { createDepartmentWithHead } from "./test-support";

// 这些单测使用 provisioning/delivery 和 Agent Git 测试替身，不执行无沙箱的 Agent 命令。
// 公司文件与 Git 仍走真实存储；真实 Agent Git/Peri 证据由各自的隔离集成测试负责。
function unitDomain(options: DomainOptions) {
  const domain = new CompanyDomain(options);
  const commit = domain.store.commit.bind(domain.store);
  spyOn(domain.store, "commit").mockImplementation(async (dir, message) => {
    if (dir.startsWith(join(domain.store.root, "agents") + "/")) return;
    return commit(dir, message);
  });
  return domain;
}
describe("Company domain — files, permissions and business invariants", () => {
  let root: string, domain: CompanyDomain;
  let delivered = 0;
  let initialAgentIds: string[] = [];
  let user: CallerContext,
    hr: CallerContext,
    head: CallerContext,
    dev: CallerContext,
    preview: CallerContext;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-domain-"));
    domain = unitDomain({
      root,
      provisionAgent: async (i) => ({
        sessionId: `unit-only-session-${i.agentId}`,
      }),
      deliver: async () => {
        delivered++;
        return { status: "delivered", receipt: { unitTest: true } };
      },
    });
    const writes = new Set([
      "createCompany",
      "createGroup",
      "createMember",
      "updateMember",
      "setRolePermissions",
      "saveAgentConfiguration",
      "markAgentConfigurationApplied",
      "createIssue",
      "updateIssue",
      "assignIssue",
      "cancelIssue",
      "addComment",
      "updateComment",
      "askDecision",
      "answerDecision",
      "resolveDecision",
      "withdrawDecision",
      "savePreview",
      "acceptPreview",
      "recordVerification",
      "ask",
      "reply",
      "closeThread",
    ]);
    domain = new Proxy(domain, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" && writes.has(String(key))
          ? (ctx: any, input: any) =>
              value.call(target, ctx, { requestId: randomUUID(), ...input })
          : typeof value === "function"
            ? value.bind(target)
            : value;
      },
    });
    user = { type: "user", id: "local-user", companyId: "" };
    const created = await domain.createCompany(user, {
      name: "ACME",
      goal: "Build responsibly",
      requestId: "create-acme",
    });
    const { company } = created;
    initialAgentIds = created.agents.map((agent) => agent.agentId);
    user = { ...user, companyId: company.id };
    hr = { type: "agent", id: `${company.id}-hr`, companyId: company.id };
    head = await createDepartmentWithHead(domain, hr, {
      nodeId: "delivery",
      headId: `${company.id}-head`,
      nodeName: "交付部",
      headName: "Engineering Head",
      responsibilities: "Deliver software",
    });
    dev = { type: "agent", id: "dev-1", companyId: company.id };
    preview = { type: "agent", id: "preview-1", companyId: company.id };
  });
  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await rm(root, { recursive: true, force: true });
  });
  test("A01 initializes headquarters, files, role permissions and distinct bindings", async () => {
    expect(initialAgentIds.sort()).toEqual(
      [`${user.companyId}-hr`, `${user.companyId}-secretary`].sort(),
    );
    const org = await domain.organization(user);
    expect(org.groups[0]?.name).toBe("总部");
    expect(org.agents).toHaveLength(3);
    const a = await domain.getAgent(user, { agentId: hr.id });
    expect(a.sessionId).toBe(`unit-only-session-${hr.id}`);
    expect(await readFile(join(a.directory, "CLAUDE.md"), "utf8")).toContain(
      join(root, "companys", user.companyId, "knowledgebase"),
    );
    expect(
      await readFile(join(a.directory, ".gitignore"), "utf8"),
    ).not.toContain(".env");
    expect(domain.store.commit).toHaveBeenCalledWith(
      a.directory,
      "Provision HR with fixed Session",
    );
  });
  test("Company initialization is idempotent for identical inputs, rejects different reuse", async () => {
    expect(
      (
        await domain.createCompany({ ...user, companyId: "" }, {
          name: "ACME",
          goal: "Build responsibly",
          requestId: "create-acme",
        })
      ).agents,
    ).toHaveLength(3);
    await expect(
      domain.createCompany(user, {
        name: "Changed",
        requestId: "create-acme",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  test("A02 HR creates unique-department members; user cannot impersonate HR", async () => {
    await domain.createGroup(hr, {
      id: "engineering",
      name: "研发",
      responsibilities: "Deliver software",
    });
    await domain.createMember(hr, {
      agentId: "dev-1",
      name: "Developer",
      groupId: "engineering",
      role: "developer",
      responsibilities: "Code and plan",
    });
    await domain.createMember(hr, {
      agentId: "preview-1",
      name: "Preview",
      groupId: "engineering",
      role: "preview",
      responsibilities: "Integrate and coordinate acceptance",
    });
    await expect(
      domain.createMember(user, {
        agentId: "evil",
        name: "Wrong",
        groupId: "engineering",
        role: "developer",
        responsibilities: "No",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await domain.organization(user)).agents).toHaveLength(5);
  });
  test("Only the user edits a member definition and its dedicated system prompt", async () => {
    const before = await domain.getAgent(user, { agentId: "dev-1" });
    expect(before.systemPrompt).toBe("");
    const updated = await domain.updateMember(user, {
      agentId: "dev-1",
      name: "Developer Updated",
      responsibilities: "Own delivery and verification",
      systemPrompt: "Always verify with tests before reporting completion.",
      version: before.version,
    });
    expect(updated.name).toBe("Developer Updated");
    expect(updated.responsibilities).toBe("Own delivery and verification");
    expect(updated.systemPrompt).toBe(
      "Always verify with tests before reporting completion.",
    );
    expect(updated.version).toBe(before.version + 1);
    const stored = await domain.getAgentInternal("dev-1");
    expect(stored.systemPrompt).toBe(
      "Always verify with tests before reporting completion.",
    );
    const memoryPath = join(stored.directory, "CLAUDE.md");
    const memory = await readFile(memoryPath, "utf8");
    expect(memory).toContain("<!-- company:profile:start -->");
    expect(memory).toContain("<!-- company:profile:end -->");
    expect(memory).toContain("Own delivery and verification");
    expect(memory).toContain(
      "Always verify with tests before reporting completion.",
    );
    await writeFile(memoryPath, `${memory}\nFREE_MEMORY_SENTINEL\n`);
    const renamed = await domain.updateMember(user, {
      agentId: "dev-1",
      name: "Developer Renamed",
      version: updated.version,
    });
    const after = await readFile(memoryPath, "utf8");
    expect(after).toContain("FREE_MEMORY_SENTINEL");
    expect(after).toContain("Own delivery and verification");
    await expect(
      domain.updateMember(user, {
        agentId: "dev-1",
        responsibilities: "<!-- company:profile:end --> injected",
        version: renamed.version,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateMember(hr, {
        agentId: "dev-1",
        name: "Impersonated",
        version: renamed.version,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      domain.updateMember(user, {
        agentId: "dev-1",
        name: "Stale",
        version: before.version,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    const visibleToAgent = (await domain.organization(hr)).agents.find(
      (a) => a.agentId === "dev-1",
    );
    expect(visibleToAgent).not.toHaveProperty("systemPrompt");
  });
  test("avatar colors are user-only Company facts, not AgentRecord fields", async () => {
    const created = await domain.createMember(hr, {
      agentId: "color-1",
      name: "Color One",
      role: "developer",
      responsibilities: "Verify avatar color projection",
    });
    expect(created).not.toHaveProperty("avatarColor");
    const companyPath = join(root, "companys", user.companyId, "company.yaml");
    const companyBefore = await domain.store.yaml(companyPath);
    const initial = companyBefore.memberColors["color-1"];
    expect(AVATAR_COLORS as readonly string[]).toContain(initial);
    const target: AvatarColor = initial === "rose" ? "blue" : "rose";
    const other: AvatarColor =
      target === ("teal" as AvatarColor) ? "slate" : "teal";
    const updated = await domain.updateMember(user, {
      agentId: "color-1",
      avatarColor: target,
      version: created.version,
    });
    expect(updated.version).toBe(created.version + 1);
    const companyAfter = await domain.store.yaml(companyPath);
    expect(companyAfter.memberColors["color-1"]).toBe(target);
    expect(companyAfter.version).toBe(companyBefore.version + 1);
    expect(
      (await domain.organization(user)).agents.find(
        (a) => a.agentId === "color-1",
      )!.avatarColor,
    ).toBe(target);
    expect(
      (await domain.organization(hr)).agents.find(
        (a) => a.agentId === "color-1",
      )!.avatarColor,
    ).toBe(target);
    expect(
      (await domain.members(user)).find((m) => m.agentId === "color-1")!
        .avatarColor,
    ).toBe(target);
    expect(await readFile(join(created.directory, "agent.yaml"), "utf8")).not.toContain(
      "avatarColor",
    );
    await expect(
      domain.updateMember(hr, {
        agentId: "color-1",
        avatarColor: other,
        version: updated.version,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      domain.updateMember(user, {
        agentId: "color-1",
        avatarColor: "chartreuse",
        version: updated.version,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateMember(user, {
        agentId: "color-1",
        avatarColor: other,
        version: created.version,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    const requestId = "avatar-color-idempotency";
    const first = await domain.updateMember(user, {
      agentId: "color-1",
      avatarColor: other,
      version: updated.version,
      requestId,
    });
    await expect(
      domain.updateMember(user, {
        agentId: "color-1",
        avatarColor: target,
        version: first.version,
        requestId,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const replay = await domain.updateMember(user, {
      agentId: "color-1",
      avatarColor: other,
      version: updated.version,
      requestId,
    });
    expect(replay.version).toBe(first.version);
    await expect(
      domain.createMember(hr, {
        agentId: "color-forbidden",
        name: "Color Forbidden",
        role: "developer",
        responsibilities: "Must not be created",
        avatarColor: "rose",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await domain.store.exists(join(root, "agents", "color-forbidden"))).toBe(
      false,
    );
  });
  test("updateMember migrates a legacy lowercase claude.md to canonical CLAUDE.md", async () => {
    await domain.createMember(hr, {
      agentId: "legacy-memory",
      name: "Legacy Memory",
      groupId: "engineering",
      role: "developer",
      responsibilities: "Keep legacy memory",
    });
    const a = await domain.getAgent(user, { agentId: "legacy-memory" });
    for (const entry of await readdir(a.directory))
      if (/^claude\.md$/i.test(entry))
        await unlink(join(a.directory, entry));
    await writeFile(
      join(a.directory, "claude.md"),
      "# Legacy memory\nFREE_LEGACY_SENTINEL\n",
    );
    const updated = await domain.updateMember(user, {
      agentId: "legacy-memory",
      responsibilities: "Migrated responsibilities",
      systemPrompt: "MIGRATED_SYSTEM_PROMPT",
      version: a.version,
    });
    expect(updated.responsibilities).toBe("Migrated responsibilities");
    const entries = await readdir(a.directory);
    expect(entries).toContain("CLAUDE.md");
    expect(entries).not.toContain("claude.md");
    const memory = await readFile(join(a.directory, "CLAUDE.md"), "utf8");
    expect(memory).toContain("<!-- company:profile:start -->");
    expect(memory).toContain("Migrated responsibilities");
    expect(memory).toContain("MIGRATED_SYSTEM_PROMPT");
    expect(memory).toContain("FREE_LEGACY_SENTINEL");
  });
  test("HR may choose a model profile and alias but cannot grant provider or filesystem capabilities", async () => {
    const member = await domain.createMember(hr, {
      agentId: "tier-dev",
      name: "Tier Developer",
      groupId: "engineering",
      role: "developer",
      responsibilities: "Use the assigned profile",
      config: {
        modelProfile: "default",
        modelAlias: "opus",
        responsibilities: "Own tiered delivery",
        instructions: "Use the assigned alias",
      },
    });
    expect(member.config.modelProfile).toBe("default");
    expect(member.config.modelAlias).toBe("opus");
    expect(member.config.instructions).toBe("Use the assigned alias");

    await expect(
      domain.createMember(hr, {
        agentId: "invalid-alias",
        name: "Invalid Alias",
        groupId: "engineering",
        role: "developer",
        responsibilities: "Invalid",
        config: { modelAlias: "gpt-4" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(
      await domain.store.exists(join(root, "agents/invalid-alias/agent.yaml")),
    ).toBe(false);
  });
  test("HR cannot self-authorize provider secrets, endpoints or filesystem/MCP capabilities", async () => {
    for (const config of [
      { workspaceRoots: ["/proc"] },
      { apiKeyEnv: "HOST_SECRET" },
      { baseUrl: "https://example.invalid/exfiltrate" },
      { provider: "unapproved" },
      { mcp: { external: { command: "/bin/sh" } } },
      { settings: { arbitrary: true } },
    ]) {
      await expect(
        domain.createMember(hr, {
          agentId: "privilege-attempt",
          name: "Invalid",
          groupId: "engineering",
          role: "developer",
          responsibilities: "Test privilege boundary",
          config,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(
        await domain.store.exists(
          join(root, "agents/privilege-attempt/agent.yaml"),
        ),
      ).toBe(false);
    }
    const member = await domain.createMember(hr, {
      agentId: "safe-defined",
      name: "Safe",
      groupId: "engineering",
      role: "developer",
      responsibilities: "Allowed role definition",
      config: { modelProfile: "default", instructions: "Use tests" },
    });
    expect(member.config.instructions).toBe("Use tests");
  });
  test("Authentication derives actual identity and discovery redacts private fields", async () => {
    const privateAgent = await domain.getAgentInternal("dev-1");
    expect(await domain.authenticateAgent(privateAgent.authToken)).toEqual(dev);
    expect(await domain.authenticateAgent("x".repeat(64))).toBeNull();
    expect(
      await domain.getAgent(user, { agentId: "dev-1" }),
    ).not.toHaveProperty("authToken");
    expect((await domain.members(hr))[0]).not.toHaveProperty("sessionId");
    expect((await domain.organization(hr)).agents[0]).not.toHaveProperty(
      "directory",
    );
  });
  test("A03 saving configuration leaves effective snapshot untouched until explicit application", async () => {
    const old = await domain.getAgent(user, { agentId: "dev-1" });
    const saved = await domain.saveAgentConfiguration(user, {
      agentId: "dev-1",
      version: old.version,
      config: { modelProfile: "default" },
    });
    expect(saved.restartRequired).toBe(true);
    expect(saved.effectiveConfig.modelProfile).toBeUndefined();
    expect(saved.sessionId).toBe(old.sessionId);
    const applied = await domain.markAgentConfigurationApplied(user, {
      agentId: "dev-1",
      configVersion: saved.configVersion,
    });
    expect(applied.effectiveConfig.modelProfile).toBe("default");
    expect(applied.sessionId).toBe(old.sessionId);
  });
  test("User may save a model profile, alias and workspace roots without applying them", async () => {
    const before = await domain.getAgent(user, { agentId: "dev-1" });
    const saved = await domain.saveAgentConfiguration(user, {
      agentId: "dev-1",
      version: before.version,
      config: {
        modelProfile: "review-default",
        modelAlias: "fable",
        workspaceRoots: ["/tmp/company-e2e-project"],
      },
    });
    expect(saved.config.modelProfile).toBe("review-default");
    expect(saved.config.modelAlias).toBe("fable");
    expect(saved.config.workspaceRoots).toEqual([
      "/tmp/company-e2e-project",
    ]);
    expect(saved.effectiveConfig.modelAlias).toBeUndefined();
    expect(saved.restartRequired).toBe(true);
    expect(saved.sessionId).toBe(before.sessionId);
  });
  test("retired model fields are rejected on save while other unknown keys stay passthrough", async () => {
    const before = await domain.getAgent(user, { agentId: "dev-1" });
    for (const key of [
      "model",
      "models",
      "provider",
      "baseUrl",
      "apiKeyEnv",
    ] as const) {
      await expect(
        domain.saveAgentConfiguration(user, {
          agentId: "dev-1",
          version: before.version,
          config: { [key]: "legacy-attempt" },
        }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("config.modelProfile"),
      });
    }
    const saved = await domain.saveAgentConfiguration(user, {
      agentId: "dev-1",
      version: before.version,
      config: { customNote: "keep-passthrough" },
    });
    expect(saved.config.customNote).toBe("keep-passthrough");
  });
  test("Mutation request IDs and config shapes are required", async () => {
    await expect(
      domain.createIssue(user, {
        title: "No request ID",
        requestId: undefined,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.createMember(hr, {
        agentId: "bad-config",
        name: "Bad",
        groupId: "engineering",
        role: "developer",
        responsibilities: "Bad config",
        config: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
  test("A04 create permission is real role config; forbidden creates no file", async () => {
    await domain.createIssue(user, { title: "One", requestId: "one" });
    await domain.createIssue(head, { title: "Two", requestId: "two" });
    await expect(
      domain.createIssue(dev, { title: "Forbidden" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await domain.store.files(join(root, "companys", user.companyId, "tasks")),
    ).toHaveLength(2);
    const org = await domain.organization(user);
    await domain.setRolePermissions(hr, {
      role: "developer",
      permissions: ["issue.create"],
      version: org.company.version,
    });
    const issue = await domain.createIssue(dev, { title: "Permitted" });
    expect(issue.agent_id).toBe(head.id);
    expect(issue.status).toBe("triage");
  });
  test("Repeated request IDs are deduplicated; different payload conflicts", async () => {
    expect(
      (await domain.createIssue(user, { title: "One", requestId: "one" })).id,
    ).toBe("1");
    await expect(
      domain.createIssue(user, { title: "Different", requestId: "one" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  test("A05 comments persist and only authors can edit; comments never advance status", async () => {
    const c = await domain.addComment(user, {
      issueId: "1",
      body: "**Looks good**",
      requestId: "comment1",
    });
    await expect(
      domain.updateComment(head, {
        issueId: "1",
        commentId: c.id,
        version: c.version,
        body: "Hijack",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const edited = await domain.updateComment(user, {
      issueId: "1",
      commentId: c.id,
      version: c.version,
      body: "Updated",
    });
    expect(edited.version).toBe(2);
    expect((await domain.getIssue(user, { issueId: "1" })).status).toBe(
      "triage",
    );
    expect(
      await readFile(
        join(root, "companys", user.companyId, "comments/1", `${c.id}.md`),
        "utf8",
      ),
    ).toContain("Updated");
  });
  test("A07 assignments preserve flat Issue and Agent identity, stale writers fail", async () => {
    for (const issueId of ["1", "2"]) {
      let i = await domain.getIssue(user, { issueId });
      i = await domain.assignIssue(head, {
        issueId,
        version: i.version,
        agentId: dev.id,
        type: "software-change",
        pipeline: "software-delivery",
        reason: "Implement",
      });
      expect(i.agent_id).toBe(dev.id);
    }
    const issue = await domain.getIssue(dev, { issueId: "1" });
    await expect(
      domain.updateIssue(head, {
        issueId: "1",
        version: issue.version,
        patch: { status: "code" },
      }),
    ).rejects.toMatchObject({ code: "not_current_owner" });
    await domain.updateIssue(dev, {
      issueId: "1",
      version: issue.version,
      patch: { body: "Independent plan and code", status: "plan" },
    });
    await expect(
      domain.updateIssue(dev, {
        issueId: "1",
        version: issue.version,
        patch: { body: "Stale" },
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(
      (await domain.workspace(user, { agentId: dev.id })).issues,
    ).toHaveLength(3);
  });
  test("A08 exact question IDs, independent pending flags and withdrawn late answers", async () => {
    let i = await domain.getIssue(dev, { issueId: "1" });
    i = await domain.askDecision(dev, {
      issueId: "1",
      version: i.version,
      question: "Partial refunds?",
    });
    i = await domain.askDecision(dev, {
      issueId: "1",
      version: i.version,
      question: "Which currency?",
    });
    await expect(
      domain.answerDecision(user, {
        issueId: "1",
        questionId: "2-Q1",
        answer: "Yes",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    i = await domain.answerDecision(user, {
      issueId: "1",
      questionId: "1-Q1",
      answer: "Yes",
    });
    expect(i.decisions[0]?.status).toBe("pending");
    i = await domain.resolveDecision(dev, {
      issueId: "1",
      questionId: "1-Q1",
      version: i.version,
    });
    expect(i.needs_user).toBe(true);
    i = await domain.withdrawDecision(dev, {
      issueId: "1",
      questionId: "1-Q2",
      version: i.version,
    });
    expect(i.needs_user).toBe(false);
    i = await domain.answerDecision(user, {
      issueId: "1",
      questionId: "1-Q2",
      answer: "Late",
    });
    expect(i.decisions[1]?.status).toBe("withdrawn");
    expect(i.decisions[1]?.answers[0]?.late).toBe(true);
  });
  test("A08b decision options persist trimmed and pending projection is user-only", async () => {
    let i = await domain.getIssue(dev, { issueId: "1" });
    i = await domain.askDecision(dev, {
      issueId: "1",
      version: i.version,
      question: "Refund method?",
      options: [" Yes ", "No"],
    });
    const withOptions = i.decisions.find((q) => q.id === "1-Q3");
    expect(withOptions?.options).toEqual(["Yes", "No"]);
    expect(
      (await domain.getIssue(user, { issueId: "1" })).decisions.find(
        (q) => q.id === "1-Q3",
      )?.options,
    ).toEqual(["Yes", "No"]);

    i = await domain.askDecision(dev, {
      issueId: "1",
      version: i.version,
      question: "Legacy free-form question?",
    });
    const legacy = i.decisions.find((q) => q.id === "1-Q4");
    expect(legacy).toBeDefined();
    expect(Object.hasOwn(legacy!, "options")).toBe(false);

    const invalid = async (options: unknown) =>
      expect(
        domain.askDecision(dev, {
          issueId: "1",
          version: i.version,
          question: "Invalid options?",
          options,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    await invalid(["only one"]);
    await invalid(["1", "2", "3", "4", "5", "6", "7"]);
    await invalid(["   ", "No"]);
    await invalid(["Yes", "No\nThanks"]);
    await invalid(["Yes", "No\rThanks"]);
    await invalid(["Yes", " Yes "]);
    await invalid(["Yes", "x".repeat(201)]);
    await invalid(null);
    await invalid([]);
    await invalid("Yes,No");
    await invalid({ options: ["Yes", "No"] });

    const pending = await domain.listPendingDecisions(user);
    expect(pending.map((item) => item.decisionId).sort()).toEqual([
      "1-Q3",
      "1-Q4",
    ]);
    expect(pending.find((item) => item.decisionId === "1-Q3")).toMatchObject({
      issueId: "1",
      issueTitle: "One",
      agentId: dev.id,
      question: "Refund method?",
      options: ["Yes", "No"],
    });
    expect(
      Object.hasOwn(
        pending.find((item) => item.decisionId === "1-Q4")!,
        "options",
      ),
    ).toBe(false);
    expect(pending[0]).not.toHaveProperty("body");
    expect(pending[0]).not.toHaveProperty("comments");
    await expect(domain.listPendingDecisions(dev)).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });

    i = await domain.answerDecision(user, {
      issueId: "1",
      questionId: "1-Q3",
      answer: "Yes",
    });
    expect(
      (await domain.listPendingDecisions(user)).map(
        (item) => item.decisionId,
      ),
    ).toEqual(["1-Q4"]);
    expect(
      (await domain.getIssue(user, { issueId: "1" })).decisions.find(
        (q) => q.id === "1-Q3",
      ),
    ).toMatchObject({ status: "pending", answer: "Yes" });

    i = await domain.withdrawDecision(dev, {
      issueId: "1",
      questionId: "1-Q4",
      version: i.version,
    });
    expect(await domain.listPendingDecisions(user)).toEqual([]);
    expect(i.needs_user).toBe(false);
    expect(i.decisions.find((q) => q.id === "1-Q3")).toMatchObject({
      status: "pending",
      answer: "Yes",
    });
  });
  test("A09 IM persists, delivers once, replies distinct from delivery and does not create Issues", async () => {
    const before = (await domain.listIssues(user)).length;
    const ask = await domain.ask(dev, {
      recipientId: head.id,
      subject: "Question",
      body: "Can we clarify?",
      requestId: "im-one",
    });
    await new Promise((r) => setTimeout(r, 80));
    const repeat = await domain.ask(dev, {
      recipientId: head.id,
      subject: "Question",
      body: "Can we clarify?",
      requestId: "im-one",
    });
    expect(repeat.message.delivery_status).toBe("delivered");
    expect(delivered).toBe(1);
    const reply = await domain.reply(head, {
      threadId: ask.threadId,
      messageId: ask.messageId,
      body: "Yes",
      requestId: "im-reply",
    });
    expect(reply.message.reply_to).toBe(ask.messageId);
    const closed = await domain.closeThread(dev, {
      threadId: ask.threadId,
      version: ask.thread.version,
      status: "resolved",
    });
    const late = await domain.reply(head, {
      threadId: ask.threadId,
      messageId: ask.messageId,
      body: "A late note",
    });
    expect(late.message.late).toBe(true);
    expect(
      (await domain.thread(dev, { threadId: ask.threadId })).thread.status,
    ).toBe(closed.status);
    expect((await domain.listIssues(user)).length).toBe(before);
  });
  test("inbox is self-scoped for Agents and explicitly rejects cross-Agent reads", async () => {
    const sent = await domain.ask(dev, {
      recipientId: head.id,
      subject: "Inbox scope",
      body: "Only the recipient may read this.",
      requestId: "im-inbox-scope",
    });
    // Let the asynchronous post-save delivery settle before the shared temp root is removed.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const item = (await domain.inbox(head)).items.find(
        (entry) => entry.id === sent.messageId,
      );
      if (item?.delivery_status === "delivered") break;
      await Bun.sleep(10);
    }
    const own = await domain.inbox(dev, { agentId: dev.id });
    expect(own.items.every((item) => item.recipient_id === dev.id)).toBe(true);
    expect(own.items.some((item) => item.id === sent.messageId)).toBe(false);
    await expect(
      domain.inbox(dev, { agentId: head.id }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    const recipient = await domain.inbox(head);
    expect(recipient.items.some((item) => item.id === sent.messageId)).toBe(true);
    const ownerView = await domain.inbox(user, { agentId: head.id });
    expect(ownerView.items.map((item) => item.id)).toEqual(
      recipient.items.map((item) => item.id),
    );
  });
  test("A12 two independent Issues share Preview with per-Issue acceptance", async () => {
    for (const issueId of ["1", "2"]) {
      let i = await domain.getIssue(dev, { issueId });
      i = await domain.updateIssue(dev, {
        issueId,
        version: i.version,
        patch: {
          status: "ready_preview",
          plan_ref: `tasks/${issueId}/plan.md`,
          worktree: `/projects/issue-${issueId}`,
          code_ref: `commit-${issueId}`,
        },
      });
      await domain.assignIssue(head, {
        issueId,
        version: i.version,
        agentId: preview.id,
        reason: "Preview handoff",
      });
    }
    const batch = await domain.savePreview(preview, {
      id: "batch-1",
      issueIds: ["1", "2"],
      branch: "preview/batch-1",
      environmentUrl: "http://localhost:4000",
      codeRefs: { "1": "commit-1", "2": "commit-2" },
      checklist: { "1": ["refund works"], "2": ["validation works"] },
    });
    expect(batch.issue_ids).toHaveLength(2);
    const acceptance = await domain.acceptPreview(user, {
      batchId: batch.id,
      issueId: "1",
      version: batch.version,
      codeRef: "commit-1",
      passed: true,
      evidence: "Manually verified refund flow",
    });
    expect(acceptance.issue.status).toBe("accepted");
    expect((await domain.getIssue(user, { issueId: "2" })).status).toBe(
      "preview",
    );
  });
  test("A13 current-code acceptance then CI+review are required for ready_merge", async () => {
    let i = await domain.getIssue(preview, { issueId: "1" });
    await expect(
      domain.updateIssue(preview, {
        issueId: i.id,
        version: i.version,
        patch: { status: "ready_merge" },
      }),
    ).rejects.toMatchObject({ code: "missing_verification" });
    let b = await domain.getPreview(user, { batchId: "batch-1" });
    let r = await domain.recordVerification(preview, {
      batchId: b.id,
      issueId: i.id,
      version: b.version,
      codeRef: "commit-1",
      kind: "ci",
      passed: true,
      evidence: "CI execution log #123",
    });
    b = r.preview;
    r = await domain.recordVerification(preview, {
      batchId: b.id,
      issueId: i.id,
      version: b.version,
      codeRef: "commit-1",
      kind: "review",
      passed: true,
      evidence: "Reviewed diff commit-1; no blocking findings",
    });
    i = r.issue;
    i = await domain.updateIssue(preview, {
      issueId: i.id,
      version: i.version,
      patch: { status: "ready_merge" },
    });
    expect(i.status).toBe("ready_merge");
    await expect(
      domain.updateIssue(preview, {
        issueId: i.id,
        version: i.version,
        patch: { code_ref: "changed" },
      }),
    ).rejects.toMatchObject({ code: "stale_evidence" });
  });
  test("A14 cancel preserves files and cannot be revived", async () => {
    let i = await domain.getIssue(preview, { issueId: "2" });
    i = await domain.cancelIssue(preview, {
      issueId: i.id,
      version: i.version,
      reason: "No longer needed",
    });
    await expect(
      domain.updateIssue(preview, {
        issueId: i.id,
        version: i.version,
        patch: { status: "code" },
      }),
    ).rejects.toMatchObject({ code: "terminal_issue" });
    expect(i.plan_ref).not.toBeNull();
    expect(
      (
        await domain.addComment(preview, {
          issueId: i.id,
          body: "Late artifact retained as evidence",
        })
      ).body,
    ).toContain("Late");
  });
  test("Historical batches cannot accept or verify an Issue now in another batch", async () => {
    let i = await domain.createIssue(user, { title: "Batch provenance" });
    i = await domain.updateIssue(user, {
      issueId: i.id,
      version: i.version,
      patch: {
        status: "ready_preview",
        plan_ref: "tasks/4/plan.md",
        worktree: "/projects/issue-4",
        code_ref: "same-code",
      },
    });
    i = await domain.assignIssue(head, {
      issueId: i.id,
      version: i.version,
      agentId: preview.id,
      reason: "Preview",
    });
    const details = {
      issueIds: [i.id],
      branch: "preview/shared",
      environmentUrl: "http://localhost:4001",
      codeRefs: { [i.id]: "same-code" },
      checklist: { [i.id]: ["works"] },
    };
    const old = await domain.savePreview(preview, {
      id: "old-batch",
      ...details,
    });
    const current = await domain.savePreview(preview, {
      id: "current-batch",
      ...details,
    });
    await expect(
      domain.acceptPreview(user, {
        batchId: old.id,
        issueId: i.id,
        version: old.version,
        codeRef: "same-code",
        passed: true,
        evidence: "Old environment",
      }),
    ).rejects.toMatchObject({ code: "stale_preview" });
    await expect(
      domain.recordVerification(preview, {
        batchId: old.id,
        issueId: i.id,
        version: old.version,
        codeRef: "same-code",
        kind: "ci",
        passed: true,
        evidence: "Old environment CI",
      }),
    ).rejects.toMatchObject({ code: "stale_preview" });
    expect((await domain.getIssue(user, { issueId: i.id })).status).toBe(
      "preview",
    );
    expect((await domain.getIssue(user, { issueId: i.id })).preview_batch).toBe(
      current.id,
    );
  });
  test("Unknown YAML fields and concurrent unrelated updates survive patching", async () => {
    const path = join(root, "companys", user.companyId, "tasks/3.md");
    const raw = await readFile(path, "utf8");
    await writeFile(
      path,
      raw.replace(
        "title: Permitted",
        "title: Permitted\ncustom_note: preserve-me",
      ),
    );
    const i = await domain.getIssue(user, { issueId: "3" });
    await domain.updateIssue(head, {
      issueId: i.id,
      version: i.version,
      patch: { summary: "Updated only summary" },
    });
    expect(await readFile(path, "utf8")).toContain("custom_note: preserve-me");
  });
});

describe("Initialization and global identity concurrency", () => {
  test("Company IDs are generated from caller/request identity, not names or caller-selected IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "company-generated-id-"));
    const calls: string[] = [];
    const d = unitDomain({
      root,
      provisionAgent: async (i) => {
        calls.push(i.agentId);
        return { sessionId: `unit-${i.agentId}` };
      },
    });
    const user: CallerContext = { type: "user", id: "owner", companyId: "" };
    const input = { name: "中文公司 / 同名", goal: "可靠交付", requestId: "create-one" };
    try {
      for (const invalid of [
        { ...input, requestId: undefined },
        { ...input, name: " " },
        { ...input, id: "caller-selected" },
        { ...input, id: "../escape" },
      ])
        await expect(d.createCompany(user, invalid)).rejects.toMatchObject({
          code: "invalid_input",
        });
      await expect(
        d.createCompany({ ...user, id: "" }, input),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        d.createCompany({ type: "agent", id: "pretend-hr", companyId: "" }, input),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(calls).toHaveLength(0);
      expect(await d.store.ids(join(root, "companys"))).toHaveLength(0);
      const [first, replay] = await Promise.all([
        d.createCompany(user, input),
        d.createCompany({ ...user, companyId: "ignored-scope" }, {
          requestId: input.requestId,
          goal: input.goal,
          name: input.name,
        }),
      ]);
      expect(first.company.id).toMatch(/^c-[0-9a-f]{32}$/);
      expect(first.company.id.length).toBeLessThanOrEqual(85);
      expect(first.company.name).toBe(input.name);
      expect(replay.company.id).toBe(first.company.id);
      expect(first.agents.map((a) => a.agentId).sort()).toEqual([
        `${first.company.id}-hr`,
        `${first.company.id}-secretary`,
      ]);
      expect(first.agents.every((a) => a.companyId === first.company.id)).toBe(true);
      expect(calls).toHaveLength(2);
      for (const changed of [
        { name: "Changed" },
        { goal: "Changed" },
        { config: { modelProfile: "changed" } },
      ])
        await expect(
          d.createCompany(user, { ...input, ...changed }),
        ).rejects.toMatchObject({ code: "idempotency_conflict" });
      const second = await d.createCompany(user, { ...input, requestId: "create-two" });
      const otherCaller = await d.createCompany({ ...user, id: "another-owner" }, input);
      expect(new Set([first.company.id, second.company.id, otherCaller.company.id]).size).toBe(3);
      expect(calls).toHaveLength(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("Existing Company directories and IDs remain unchanged when creating a Company", async () => {
    const root = await mkdtemp(join(tmpdir(), "company-existing-id-"));
    const d = unitDomain({
      root,
      provisionAgent: async (i) => ({ sessionId: `unit-${i.agentId}` }),
    });
    const user: CallerContext = { type: "user", id: "owner", companyId: "legacy-acme" };
    const legacyPath = join(root, "companys", user.companyId);
    try {
      await d.store.putYaml(join(legacyPath, "company.yaml"), {
        id: user.companyId,
        name: "Existing Company",
        version: 1,
        custom_note: "keep-me",
      });
      await d.store.putYaml(join(legacyPath, "groups.yaml"), { groups: [] });
      await d.store.putYaml(join(legacyPath, "roster.yaml"), { members: [] });
      await d.store.putYaml(join(legacyPath, "events/initialization.yaml"), {
        status: "complete",
        hash: "legacy-initialization-hash",
      });
      await d.store.atomic(join(legacyPath, "knowledgebase/notes.md"), "现存资料\n");
      const before = await d.store.raw(join(legacyPath, "company.yaml"));
      const created = await d.createCompany(user, { name: "New Company", requestId: "new-company" });
      expect(created.company.id).not.toBe(user.companyId);
      expect((await d.organization(user)).company.id).toBe("legacy-acme");
      expect(await d.store.raw(join(legacyPath, "company.yaml"))).toBe(before);
      expect(await d.store.raw(join(legacyPath, "knowledgebase/notes.md"))).toBe("现存资料\n");
      expect((await d.listCompanies()).map((c) => c.id).sort()).toEqual([
        created.company.id,
        "legacy-acme",
      ].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("Partial provisioning failure is not success; identical retry reuses completed bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "company-init-"));
    const calls: string[] = [];
    let fail = true;
    const d = unitDomain({
      root,
      provisionAgent: async (i) => {
        calls.push(i.agentId);
        if (i.agentId.endsWith("-secretary") && fail) {
          fail = false;
          throw Object.assign(new Error("缺少显式存储端点配置：companyId、agentId、url、authToken"), {
            code: "wasm_store_not_configured", status: 503,
          });
        }
        return { sessionId: `unit-${i.agentId}` };
      },
    });
    const user: CallerContext = {
      type: "user",
      id: "owner",
      companyId: "",
    };
    const input = { name: "Retry", requestId: "fixed-init" };
    try {
      await expect(d.createCompany(user, input)).rejects.toMatchObject({
        code: "wasm_store_not_configured", status: 503,
      });
      const companyIds = await d.store.ids(join(root, "companys"));
      expect(companyIds).toHaveLength(1);
      const companyId = companyIds[0]!;
      const initPath = join(
        root,
        "companys",
        companyId,
        "events/initialization.yaml",
      );
      expect((await d.store.yaml(initPath)).status).toBe("failed");
      await expect(
        d.createCompany(user, { ...input, name: "Changed after failure" }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(calls).toHaveLength(2);
      const restarted = unitDomain(d.options);
      const [org, replay] = await Promise.all([
        restarted.createCompany(user, input),
        restarted.createCompany(user, input),
      ]);
      expect(org.company.id).toBe(companyId);
      expect(replay.company.id).toBe(companyId);
      expect(org.agents).toHaveLength(2);
      expect(calls.filter((a) => a === `${companyId}-hr`)).toHaveLength(1);
      expect(calls.filter((a) => a === `${companyId}-secretary`)).toHaveLength(2);
      expect((await d.store.yaml(initPath)).status).toBe("complete");
      expect(await d.store.ids(join(root, "companys"))).toEqual([companyId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("Global Agent ID lock prevents two companies from provisioning the same member", async () => {
    const root = await mkdtemp(join(tmpdir(), "company-global-id-"));
    let sharedProvisions = 0;
    const d = unitDomain({
      root,
      provisionAgent: async (i) => {
        if (i.agentId === "shared-agent") {
          sharedProvisions++;
          await new Promise((r) => setTimeout(r, 30));
        }
        return { sessionId: `unit-${i.agentId}` };
      },
    });
    try {
      const companyIds: string[] = [];
      for (const name of ["first", "second"]) {
        const { company } = await d.createCompany(
          { type: "user", id: "owner", companyId: "" },
          { name, requestId: `init-${name}` },
        );
        companyIds.push(company.id);
      }
      const result = await Promise.allSettled(
        companyIds.map((id) =>
          d.createMember(
            { type: "agent", id: `${id}-hr`, companyId: id },
            {
              agentId: "shared-agent",
              name: "Shared",
              groupId: "headquarters",
              role: "developer",
              responsibilities: "Only one company",
              requestId: `member-${id}`,
            },
          ),
        ),
      );
      expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(sharedProvisions).toBe(1);
      expect(
        (
          await d.organization({
            type: "user",
            id: "owner",
            companyId: companyIds[0]!,
          })
        ).agents.length +
          (
            await d.organization({
              type: "user",
              id: "owner",
              companyId: companyIds[1]!,
            })
          ).agents.length,
      ).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
