import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CompanyDomain,
  type CallerContext,
  type DomainOptions,
} from "./index";
import { storeScopeId } from "../runtime/wasm-store";
import { runtimeScopeId } from "./org";
import { createDepartmentWithHead } from "./test-support";

const roots: string[] = [];
let sequence = 0;
const requestId = () => `org-test-${++sequence}`;
const owner: CallerContext = { type: "user", id: "test-owner", companyId: "" };

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function unitDomain(options: DomainOptions) {
  const domain = new CompanyDomain(options);
  const commit = domain.store.commit.bind(domain.store);
  domain.store.commit = async (directory, message) => {
    if (directory.startsWith(join(options.root, "agents") + "/")) return;
    return commit(directory, message);
  };
  return domain;
}

async function fixture(extra: Partial<DomainOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "company-org-domain-"));
  roots.push(root);
  const provisions: string[] = [];
  const domains: CompanyDomain[] = [];
  const domain = unitDomain({
    root,
    provisionAgent: async (input) => {
      provisions.push(input.agentId);
      return { sessionId: input.sessionId ?? `test-session-${input.agentId}` };
    },
    ...extra,
  });
  domains.push(domain);
  return { root, domain, provisions, domains };
}

async function company(options: Partial<DomainOptions> = {}) {
  const f = await fixture(options);
  const org = await f.domain.createCompany(owner, {
    name: "Organization fixture",
    requestId: requestId(),
  });
  const user = { ...owner, companyId: org.company.id };
  const hr: CallerContext = {
    type: "agent",
    id: `${org.company.id}-hr`,
    companyId: org.company.id,
  };
  return { ...f, organization: org, user, hr };
}

const file = (root: string, ...parts: string[]) => join(root, ...parts);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();

describe("Decoupled organization model", () => {
  test("move invariant scope ids match the runtime binding scope", () => {
    expect(runtimeScopeId("c-example", "c-example-hr")).toBe(
      storeScopeId({ companyId: "c-example", agentId: "c-example-hr" }),
    );
  });

  test("createCompany writes organization.yaml and roster v2 without legacy person fields", async () => {
    const { root, domain, user, hr, organization } = await company();
    const directory = domain.store.company(user.companyId);
    expect(
      await domain.store.exists(file(directory, "groups.yaml")),
    ).toBe(false);
    const org = await domain.store.yaml(file(directory, "organization.yaml"));
    expect(org.schema).toBe("company-org/v1");
    expect(org.nodes).toHaveLength(1);
    expect(org.nodes[0]).toMatchObject({
      id: "headquarters",
      name: "总部",
      kind: "company",
      parentId: null,
      status: "active",
    });
    expect(org.placements).toHaveLength(2);
    expect(
      org.placements.map((placement: any) => placement.personId).sort(),
    ).toEqual([hr.id, `${user.companyId}-secretary`].sort());
    const roster = await domain.store.yaml(file(directory, "roster.yaml"));
    expect(roster.schema).toBe("company-people/v2");
    expect(roster.members).toHaveLength(2);
    for (const member of roster.members) {
      expect(member).not.toHaveProperty("groupId");
      expect(member).not.toHaveProperty("role");
      expect(member.status).toBe("active");
      expect(typeof member.joinedAt).toBe("string");
    }
    const agent = await domain.store.yaml(
      file(root, "agents", hr.id, "agent.yaml"),
    );
    expect(agent).not.toHaveProperty("groupId");
    expect(agent.role).toBe("hr");
    const view = await domain.organization(user);
    expect(view.groups[0].name).toBe("总部");
    const hrView = view.agents.find((a: any) => a.agentId === hr.id)!;
    expect(hrView.groupId).toBe("headquarters");
    expect(hrView.orgPath).toEqual([{ id: "headquarters", name: "总部" }]);
    expect(hrView.placement!.nodeId).toBe("headquarters");
    expect((await domain.organization(hr)).agents.length).toBe(
      organization.agents.length,
    );
  });

  test("createGroup/createMember only write the organization and derive groupId/orgPath", async () => {
    const { root, domain, user, hr } = await company();
    await domain.createGroup(hr, {
      id: "platform",
      name: "平台部",
      kind: "division",
      requestId: requestId(),
    });
    await domain.createOrgNode(hr, {
      id: "backend",
      name: "后端组",
      parentId: "platform",
      kind: "team",
      requestId: requestId(),
    });
    await domain.createMember(hr, {
      agentId: "developer",
      name: "开发",
      groupId: "backend",
      role: "developer",
      responsibilities: "交付后端",
      requestId: requestId(),
    });
    const agent = await domain.store.yaml(
      file(root, "agents/developer/agent.yaml"),
    );
    expect(agent).not.toHaveProperty("groupId");
    const roster = await domain.store.yaml(
      file(root, "companys", user.companyId, "roster.yaml"),
    );
    expect(roster.members.find((m: any) => m.agentId === "developer")).toEqual({
      agentId: "developer",
      status: "active",
      joinedAt: expect.any(String),
    });
    const view = await domain.organization(user);
    const node = view.organization.nodes.find((n: any) => n.id === "backend")!;
    expect(node.parentId).toBe("platform");
    const member = view.agents.find((a: any) => a.agentId === "developer")!;
    expect(member.groupId).toBe("backend");
    expect(member.orgPath.map((entry: any) => entry.name)).toEqual([
      "平台部",
      "后端组",
    ]);
    expect(
      view.agents.find((a: any) => a.agentId === "developer" )!.placement!.title,
    ).toBeUndefined();
    const members = await domain.members(user);
    expect(members.find((m: any) => m.agentId === "developer")).toMatchObject({
      groupId: "backend",
      status: "active",
    });
  });

  test("createMember resumes after a partial write leaves the person without a roster entry", async () => {
    const { domain, hr, user } = await company();
    const putYaml = domain.store.putYaml.bind(domain.store);
    let failed = false;
    domain.store.putYaml = async (
      path: string,
      data: any,
      expectedVersion?: number,
    ) => {
      if (path.endsWith("/roster.yaml") && !failed) {
        failed = true;
        throw new Error("simulated roster write failure");
      }
      return putYaml(path, data, expectedVersion);
    };
    const input = {
      agentId: "developer-2",
      name: "开发二号",
      groupId: "headquarters",
      role: "developer",
      responsibilities: "交付",
    };
    await expect(
      domain.createMember(hr, { ...input, requestId: requestId() }),
    ).rejects.toThrow("simulated roster write failure");
    domain.store.putYaml = putYaml;
    const created = await domain.createMember(hr, {
      ...input,
      requestId: requestId(),
    });
    expect(created.agentId).toBe("developer-2");
    const view = await domain.organization(user);
    expect(
      view.agents.find((a: any) => a.agentId === "developer-2"),
    ).toMatchObject({ status: "active", groupId: "headquarters" });
    expect(
      (await domain.members(user)).find(
        (member) => member.agentId === "developer-2",
      ),
    ).toMatchObject({ status: "active", groupId: "headquarters" });
  });
});

describe("Legacy organization compatibility", () => {
  async function legacyCompany() {
    const { root, domain } = await fixture();
    const companyId = "legacy-company";
    const user: CallerContext = { type: "user", id: "owner", companyId };
    const hr: CallerContext = {
      type: "agent",
      id: "legacy-hr",
      companyId,
    };
    const directory = file(root, "companys", companyId);
    const agentDirectory = file(root, "agents", "legacy-hr");
    await domain.store.putYaml(file(directory, "company.yaml"), {
      id: companyId,
      name: "Legacy",
      goal: "",
      roles: { hr: { permissions: [] } },
      created_at: "2026-01-01T00:00:00.000Z",
      version: 1,
    });
    await domain.store.putYaml(file(directory, "groups.yaml"), {
      version: 2,
      groups: [
        {
          id: "headquarters",
          name: "总部",
          responsibilities: "协调",
        },
        {
          id: "software-development",
          name: "软件开发部",
          responsibilities: "交付",
        },
      ],
    });
    await domain.store.putYaml(file(directory, "roster.yaml"), {
      version: 4,
      members: [
        { agentId: "legacy-hr", groupId: "headquarters", role: "hr" },
        {
          agentId: "legacy-dev",
          groupId: "software-development",
          role: "developer",
        },
      ],
    });
    await domain.store.putYaml(file(directory, "events/initialization.yaml"), {
      hash: "legacy",
      status: "complete",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await domain.store.initGit(directory);
    for (const [agentId, groupId, role] of [
      ["legacy-hr", "headquarters", "hr"],
      ["legacy-dev", "software-development", "developer"],
    ] as const) {
      const dir = file(root, "agents", agentId);
      await mkdir(dir, { recursive: true });
      await domain.store.putYaml(file(dir, "agent.yaml"), {
        agentId,
        companyId,
        groupId,
        role,
        name: agentId,
        responsibilities: role,
        systemPrompt: "",
        directory: dir,
        sessionId: `legacy-session-${agentId}`,
        config: {},
        effectiveConfig: {},
        configVersion: 1,
        appliedConfigVersion: 1,
        version: 1,
        authToken: "a".repeat(64),
      });
      await writeFile(file(dir, "CLAUDE.md"), "# Memory\n", "utf8");
      await writeFile(file(dir, ".mcp.json"), "{}\n", "utf8");
    }
    const groupsBefore = await domain.store.raw(file(directory, "groups.yaml"));
    const rosterBefore = await domain.store.raw(file(directory, "roster.yaml"));
    const agentBefore = await domain.store.raw(
      file(agentDirectory, "agent.yaml"),
    );
    const devAgentBefore = await domain.store.raw(
      file(root, "agents/legacy-dev/agent.yaml"),
    );
    return {
      root,
      domain,
      user,
      hr,
      directory,
      groupsBefore,
      rosterBefore,
      agentBefore,
      devAgentBefore,
    };
  }

  test("reads synthesize the two legacy roots without writing any file", async () => {
    const f = await legacyCompany();
    const org = await f.domain.organization(f.user);
    expect(org.groups.map((g: any) => g.id).sort()).toEqual([
      "headquarters",
      "software-development",
    ]);
    expect(
      org.organization.nodes.every((node: any) => node.parentId === null),
    ).toBe(true);
    expect(org.agents.map((a: any) => a.groupId).sort()).toEqual([
      "headquarters",
      "software-development",
    ]);
    expect(await f.domain.store.exists(file(f.directory, "organization.yaml"))).toBe(
      false,
    );
    expect(await f.domain.store.raw(file(f.directory, "roster.yaml"))).toBe(
      f.rosterBefore,
    );
    expect(
      await f.domain.store.raw(file(f.root, "agents/legacy-hr/agent.yaml")),
    ).toBe(f.agentBefore);
  });

  test("the first organization write upgrades organization.yaml and roster v2 only", async () => {
    const f = await legacyCompany();
    await f.domain.createGroup(f.hr, {
      id: "operations",
      name: "运营",
      requestId: requestId(),
    });
    const organization = await f.domain.store.yaml(
      file(f.directory, "organization.yaml"),
    );
    expect(organization.schema).toBe("company-org/v1");
    expect(organization.nodes.map((node: any) => node.id).sort()).toEqual([
      "headquarters",
      "operations",
      "software-development",
    ]);
    expect(
      organization.nodes.every((node: any) => node.parentId === null),
    ).toBe(true);
    expect(organization.placements).toHaveLength(2);
    const roster = await f.domain.store.yaml(
      file(f.directory, "roster.yaml"),
    );
    expect(roster.schema).toBe("company-people/v2");
    expect(roster.members).toHaveLength(2);
    for (const member of roster.members)
      expect(member).not.toHaveProperty("groupId");
    expect(await f.domain.store.raw(file(f.directory, "groups.yaml"))).toBe(
      f.groupsBefore,
    );
    expect(
      await f.domain.store.raw(file(f.root, "agents/legacy-hr/agent.yaml")),
    ).toBe(f.agentBefore);
  });

  test("a no-op move on a legacy Company still performs the first-write upgrade", async () => {
    const f = await legacyCompany();
    const current = await f.domain.organization(f.user);
    const moved = await f.domain.moveMember(f.hr, {
      agentId: "legacy-dev",
      nodeId: "software-development",
      expectedVersion: current.organization.version,
      requestId: requestId(),
    });
    expect(moved.organization.version).toBe(current.organization.version);
    expect(moved.placement).toMatchObject({
      personId: "legacy-dev",
      nodeId: "software-development",
    });
    expect(moved.integrity).toMatchObject({
      agentUnchanged: true,
      rosterUnchanged: true,
    });
    expect(
      await f.domain.store.exists(file(f.directory, "organization.yaml")),
    ).toBe(true);
    const roster = await f.domain.store.yaml(
      file(f.directory, "roster.yaml"),
    );
    expect(roster.schema).toBe("company-people/v2");
  });

  test("moveMember on a legacy Company upgrades the documents and passes its own invariants", async () => {
    const f = await legacyCompany();
    const current = await f.domain.organization(f.user);
    const moved = await f.domain.moveMember(f.hr, {
      agentId: "legacy-dev",
      nodeId: "headquarters",
      expectedVersion: current.organization.version,
      requestId: requestId(),
    });
    expect(moved.placement).toMatchObject({
      personId: "legacy-dev",
      nodeId: "headquarters",
      previousNodeId: "software-development",
    });
    expect(moved.integrity).toMatchObject({
      agentUnchanged: true,
      sessionUnchanged: true,
      tokenUnchanged: true,
      memoryUnchanged: true,
      mcpUnchanged: true,
      rosterUnchanged: true,
    });
    expect(
      await f.domain.store.raw(file(f.root, "agents/legacy-dev/agent.yaml")),
    ).toBe(f.devAgentBefore);
    const organization = await f.domain.store.yaml(
      file(f.directory, "organization.yaml"),
    );
    expect(
      organization.placements.find(
        (placement: any) => placement.personId === "legacy-dev",
      ),
    ).toMatchObject({ nodeId: "headquarters" });
    const roster = await f.domain.store.yaml(
      file(f.directory, "roster.yaml"),
    );
    expect(roster.schema).toBe("company-people/v2");
    expect(
      roster.members.find((member: any) => member.agentId === "legacy-dev"),
    ).not.toHaveProperty("groupId");
    expect(await f.domain.store.raw(file(f.directory, "groups.yaml"))).toBe(
      f.groupsBefore,
    );
  });
});

describe("moveMember", () => {
  async function moveFixture() {
    const f = await company();
    await createDepartmentWithHead(f.domain, f.hr, {
      nodeId: "delivery",
      headId: `${f.user.companyId}-head`,
      nodeName: "交付部",
      headName: "交付部长",
    });
    await f.domain.createGroup(f.hr, {
      id: "platform",
      name: "平台部",
      kind: "division",
      requestId: requestId(),
    });
    await f.domain.createMember(f.hr, {
      agentId: "dev-1",
      name: "开发一",
      groupId: "headquarters",
      role: "developer",
      responsibilities: "交付",
      requestId: requestId(),
    });
    const dev: CallerContext = {
      type: "agent",
      id: "dev-1",
      companyId: f.user.companyId,
    };
    const agent = await f.domain.getAgent(f.user, { agentId: "dev-1" });
    const scope = storeScopeId({
      companyId: f.user.companyId,
      agentId: "dev-1",
    });
    const binding = file(
      f.root,
      "runtime",
      "wasm-stores",
      `${scope}.json`,
    );
    const effective = file(
      f.root,
      "runtime",
      "effective-config",
      "dev-1.json",
    );
    await mkdir(file(f.root, "runtime", "wasm-stores"), { recursive: true });
    await mkdir(file(f.root, "runtime", "effective-config"), { recursive: true });
    await mkdir(file(f.root, "runtime", "workspace", scope, "home"), {
      recursive: true,
    });
    await writeFile(
      binding,
      JSON.stringify({
        backend: "wasm-sqld-v1",
        sessionId: agent.sessionId,
        cwd: agent.directory,
      }),
    );
    await writeFile(effective, JSON.stringify({ model: "fixture", role: "developer" }));
    git(agent.directory, "init");
    git(agent.directory, "config", "user.email", "fixture@localhost");
    git(agent.directory, "config", "user.name", "Fixture");
    await writeFile(file(agent.directory, "tracked.txt"), "fixture\n");
    git(agent.directory, "add", ".");
    git(agent.directory, "commit", "-m", "fixture");
    return { ...f, dev, agent, binding, effective, scope };
  }

  test("user and HR move a member while every person/runtime fact stays byte-identical", async () => {
    const f = await moveFixture();
    const companyDirectory = f.domain.store.company(f.user.companyId);
    let issue = await f.domain.createIssue(f.user, {
      title: "Keep ownership",
      requestId: requestId(),
    });
    issue = await f.domain.assignIssue(f.user, {
      issueId: issue.id,
      version: issue.version,
      agentId: "dev-1",
      reason: "fixture",
      requestId: requestId(),
    });
    const issueRaw = await f.domain.store.raw(
      file(companyDirectory, "tasks", `${issue.id}.md`),
    );
    const agentRaw = await readFile(file(f.agent.directory, "agent.yaml"), "utf8");
    const memoryRaw = await readFile(file(f.agent.directory, "CLAUDE.md"), "utf8");
    const mcpRaw = await readFile(file(f.agent.directory, ".mcp.json"), "utf8");
    const bindingRaw = await readFile(f.binding, "utf8");
    const effectiveRaw = await readFile(f.effective, "utf8");
    const rosterRaw = await readFile(
      file(companyDirectory, "roster.yaml"),
      "utf8",
    );
    const head = git(f.agent.directory, "rev-parse", "HEAD");
    const provisionsBefore = f.provisions.length;
    const current = await f.domain.organization(f.user);

    const moved = await f.domain.moveMember(f.hr, {
      agentId: "dev-1",
      nodeId: "platform",
      title: "后端工程师",
      expectedVersion: current.organization.version,
      requestId: requestId(),
    });
    expect(moved.placement).toMatchObject({
      personId: "dev-1",
      nodeId: "platform",
      previousNodeId: "headquarters",
      title: "后端工程师",
      movedBy: f.hr.id,
    });
    expect(moved.integrity).toEqual({
      agentUnchanged: true,
      sessionUnchanged: true,
      tokenUnchanged: true,
      memoryUnchanged: true,
      mcpUnchanged: true,
      bindingUnchanged: true,
      effectiveConfigUnchanged: true,
      workspaceUnchanged: true,
      agentGitUnchanged: true,
      rosterUnchanged: true,
    });
    expect(await readFile(file(f.agent.directory, "agent.yaml"), "utf8")).toBe(
      agentRaw,
    );
    expect(await readFile(file(f.agent.directory, "CLAUDE.md"), "utf8")).toBe(
      memoryRaw,
    );
    expect(await readFile(file(f.agent.directory, ".mcp.json"), "utf8")).toBe(
      mcpRaw,
    );
    expect(await readFile(f.binding, "utf8")).toBe(bindingRaw);
    expect(await readFile(f.effective, "utf8")).toBe(effectiveRaw);
    expect(await readFile(file(companyDirectory, "roster.yaml"), "utf8")).toBe(
      rosterRaw,
    );
    expect(git(f.agent.directory, "rev-parse", "HEAD")).toBe(head);
    expect(git(f.agent.directory, "status", "--porcelain")).toBe("");
    expect(f.provisions.length).toBe(provisionsBefore);
    const afterAgent = await f.domain.getAgent(f.user, { agentId: "dev-1" });
    expect(afterAgent.sessionId).toBe(f.agent.sessionId);
    expect(
      await f.domain.store.raw(file(companyDirectory, "tasks", `${issue.id}.md`)),
    ).toBe(issueRaw);
    const afterOrg = await f.domain.organization(f.user);
    expect(
      afterOrg.agents.find((a: any) => a.agentId === "dev-1")!.orgPath.map(
        (entry: any) => entry.id,
      ),
    ).toEqual(["platform"]);
    const changed = git(companyDirectory, "show", "--name-only", "--format=", "HEAD")
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(changed).toEqual(
      [
        "organization.yaml",
        expect.stringMatching(/^events\/requests\/[a-f0-9]{64}\.yaml$/),
      ].sort(),
    );

    const userMove = await f.domain.moveMember(f.user, {
      agentId: "dev-1",
      nodeId: "headquarters",
      expectedVersion: afterOrg.organization.version,
      requestId: requestId(),
    });
    expect(userMove.placement.nodeId).toBe("headquarters");
  });

  test("the same target is a no-op, request IDs and versions are enforced, other roles are forbidden", async () => {
    const f = await moveFixture();
    const current = await f.domain.organization(f.user);
    const input = {
      agentId: "dev-1",
      nodeId: "platform",
      expectedVersion: current.organization.version,
      requestId: "move-idempotent",
    };
    const first = await f.domain.moveMember(f.hr, input);
    const organizationRaw = await readFile(
      file(f.domain.store.company(f.user.companyId), "organization.yaml"),
      "utf8",
    );
    const noop = await f.domain.moveMember(f.hr, {
      ...input,
      expectedVersion: first.organization.version,
      requestId: "move-noop",
    });
    expect(noop.placement).toEqual(first.placement);
    expect(noop.organization.version).toBe(first.organization.version);
    expect(
      await readFile(
        file(f.domain.store.company(f.user.companyId), "organization.yaml"),
        "utf8",
      ),
    ).toBe(organizationRaw);

    const replay = await f.domain.moveMember(f.hr, input);
    expect(replay.placement).toEqual(first.placement);
    await expect(
      f.domain.moveMember(f.hr, {
        ...input,
        nodeId: "headquarters",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      f.domain.moveMember(f.hr, {
        ...input,
        nodeId: "headquarters",
        expectedVersion: current.organization.version,
        requestId: "move-stale",
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      f.domain.moveMember(f.dev, {
        agentId: "dev-1",
        nodeId: "headquarters",
        expectedVersion: first.organization.version,
        requestId: "move-forbidden",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.domain.moveMember(f.hr, {
        agentId: "missing",
        nodeId: "platform",
        expectedVersion: first.organization.version,
        requestId: "move-missing",
      }),
    ).rejects.toMatchObject({ code: "member_not_found" });
    await expect(
      f.domain.moveMember(f.hr, {
        agentId: "dev-1",
        nodeId: "missing",
        expectedVersion: first.organization.version,
        requestId: "move-node-missing",
      }),
    ).rejects.toMatchObject({ code: "node_not_found" });
  });

  test("rejects members and nodes that belong to another Company", async () => {
    const first = await company();
    const second = await company();
    await second.domain.createOrgNode(second.hr, {
      id: "only-second",
      name: "第二公司节点",
      requestId: requestId(),
    });
    await second.domain.createMember(second.hr, {
      agentId: "second-dev",
      name: "第二公司成员",
      groupId: "only-second",
      role: "developer",
      responsibilities: "交付",
      requestId: requestId(),
    });
    await first.domain.createMember(first.hr, {
      agentId: "first-dev",
      name: "第一公司成员",
      groupId: "headquarters",
      role: "developer",
      responsibilities: "交付",
      requestId: requestId(),
    });
    const current = await first.domain.organization(first.user);
    await expect(
      first.domain.moveMember(first.hr, {
        agentId: "second-dev",
        nodeId: "headquarters",
        expectedVersion: current.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "member_not_found" });
    await expect(
      first.domain.moveMember(first.hr, {
        agentId: "first-dev",
        nodeId: "only-second",
        expectedVersion: current.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "node_not_found" });
  });

  test("a retry after the organization write but before the request record no-ops", async () => {
    const f = await moveFixture();
    const current = await f.domain.organization(f.user);
    const input = {
      agentId: "dev-1",
      nodeId: "platform",
      expectedVersion: current.organization.version,
      requestId: "move-crash-recovery",
    };
    const first = await f.domain.moveMember(f.hr, input);
    const requests = file(
      f.domain.store.company(f.user.companyId),
      "events/requests",
    );
    for (const name of await f.domain.store.files(requests))
      await unlink(file(requests, name));
    const retry = await f.domain.moveMember(f.hr, input);
    expect(retry.placement).toEqual(first.placement);
    expect(retry.organization.version).toBe(first.organization.version);
  });

  test("an integrity violation restores the organization and reports the failed checks", async () => {
    const f = await moveFixture();
    const current = await f.domain.organization(f.user);
    const organizationPath = file(
      f.domain.store.company(f.user.companyId),
      "organization.yaml",
    );
    const organizationBefore = await readFile(organizationPath, "utf8");
    const put = f.domain.store.putYaml.bind(f.domain.store);
    let tampered = false;
    f.domain.store.putYaml = async (path, data, version) => {
      const result = await put(path, data, version);
      if (path.endsWith("/organization.yaml") && !tampered) {
        tampered = true;
        await appendFile(
          file(f.agent.directory, "agent.yaml"),
          "\n# external concurrent write\n",
        );
      }
      return result;
    };
    const requestsDirectory = file(
      f.domain.store.company(f.user.companyId),
      "events/requests",
    );
    const requestsBefore = await f.domain.store.files(requestsDirectory);
    await expect(
      f.domain.moveMember(f.hr, {
        agentId: "dev-1",
        nodeId: "platform",
        expectedVersion: current.organization.version,
        requestId: "move-integrity",
      }),
    ).rejects.toMatchObject({
      code: "integrity_violation",
      details: { failedChecks: expect.stringContaining("agentUnchanged") },
    });
    expect(await readFile(organizationPath, "utf8")).toBe(organizationBefore);
    expect(await f.domain.store.files(requestsDirectory)).toEqual(
      requestsBefore,
    );
  });
});

describe("Organization tree and member lifecycle", () => {
  test("validates parents, cycles, sibling order and depth", async () => {
    const { domain, hr, user } = await company();
    await domain.createOrgNode(hr, {
      id: "division-a",
      name: "事业部",
      kind: "division",
      requestId: requestId(),
    });
    await domain.createOrgNode(hr, {
      id: "team-a",
      name: "团队",
      parentId: "division-a",
      kind: "team",
      requestId: requestId(),
    });
    const org = await domain.organization(user);
    await expect(
      domain.createOrgNode(hr, {
        id: "dup-order",
        name: "重复顺序",
        order: 0,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateOrgNode(hr, {
        id: "division-a",
        parentId: "team-a",
        expectedVersion: org.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateOrgNode(hr, {
        id: "division-a",
        parentId: "division-a",
        expectedVersion: org.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    let version = org.organization.version;
    for (let i = 1; i <= 15; i++) {
      const parentId = i === 1 ? "headquarters" : `depth-${i - 1}`;
      await domain.createOrgNode(hr, {
        id: `depth-${i}`,
        name: `深度 ${i}`,
        parentId,
        requestId: requestId(),
      });
      version = (await domain.organization(user)).organization.version;
    }
    await expect(
      domain.createOrgNode(hr, {
        id: "too-deep",
        name: "过深",
        parentId: "depth-15",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(version).toBeGreaterThan(org.organization.version);
  });

  test("deletes only empty nodes unless an explicit reassignment moves all placements", async () => {
    const { domain, hr, user } = await company();
    await domain.createOrgNode(hr, {
      id: "platform",
      name: "平台部",
      kind: "division",
      requestId: requestId(),
    });
    await domain.createOrgNode(hr, {
      id: "backend",
      name: "后端组",
      parentId: "platform",
      kind: "team",
      requestId: requestId(),
    });
    await domain.createMember(hr, {
      agentId: "dev-1",
      name: "开发",
      groupId: "backend",
      role: "developer",
      responsibilities: "交付",
      requestId: requestId(),
    });
    let org = await domain.organization(user);
    await expect(
      domain.deleteOrgNode(hr, {
        id: "platform",
        expectedVersion: org.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "org_node_not_empty" });
    await expect(
      domain.deleteOrgNode(hr, {
        id: "platform",
        reassignTo: "backend",
        expectedVersion: org.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const deleted = await domain.deleteOrgNode(hr, {
      id: "platform",
      reassignTo: "headquarters",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    expect(deleted.removedNodeIds.sort()).toEqual(["backend", "platform"]);
    expect(deleted.movedPlacementCount).toBe(1);
    org = await domain.organization(user);
    expect(
      org.organization.nodes.some((node: any) =>
        ["platform", "backend"].includes(node.id),
      ),
    ).toBe(false);
    const member = org.agents.find((a: any) => a.agentId === "dev-1")!;
    expect(member.groupId).toBe("headquarters");
    expect(member.orgPath.map((entry: any) => entry.id)).toEqual([
      "headquarters",
    ]);
  });

  test("archives nodes only after members leave and refuses placements into archived nodes", async () => {
    const { domain, hr, user } = await company();
    await domain.createOrgNode(hr, {
      id: "old-team",
      name: "旧团队",
      requestId: requestId(),
    });
    await domain.createMember(hr, {
      agentId: "dev-1",
      name: "开发",
      groupId: "old-team",
      role: "developer",
      responsibilities: "交付",
      requestId: requestId(),
    });
    let org = await domain.organization(user);
    await expect(
      domain.archiveOrgNode(hr, {
        id: "old-team",
        expectedVersion: org.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "org_node_not_empty" });
    await domain.moveMember(hr, {
      agentId: "dev-1",
      nodeId: "headquarters",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    org = await domain.organization(user);
    const archived = await domain.archiveOrgNode(hr, {
      id: "old-team",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    expect(archived.status).toBe("archived");
    await expect(
      domain.createOrgNode(hr, {
        id: "child",
        name: "子节点",
        parentId: "old-team",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "node_archived" });
    const current = await domain.organization(user);
    await expect(
      domain.moveMember(hr, {
        agentId: "dev-1",
        nodeId: "old-team",
        expectedVersion: current.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "node_archived" });
  });

  test("archiving a node rejects active children or placements anywhere in its subtree", async () => {
    const { domain, hr, user } = await company();
    await domain.createOrgNode(hr, {
      id: "parent",
      name: "父节点",
      kind: "division",
      requestId: requestId(),
    });
    await domain.createOrgNode(hr, {
      id: "child",
      name: "子节点",
      parentId: "parent",
      kind: "team",
      requestId: requestId(),
    });
    await domain.createMember(hr, {
      agentId: "dev-1",
      name: "开发",
      groupId: "child",
      role: "developer",
      responsibilities: "交付",
      requestId: requestId(),
    });

    let org = await domain.organization(user);
    await expect(
      domain.archiveOrgNode(hr, {
        id: "parent",
        expectedVersion: org.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "org_node_not_empty" });
    await expect(
      domain.archiveOrgNode(hr, {
        id: "child",
        expectedVersion: org.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "org_node_not_empty" });

    await domain.moveMember(hr, {
      agentId: "dev-1",
      nodeId: "headquarters",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    org = await domain.organization(user);
    await expect(
      domain.archiveOrgNode(hr, {
        id: "parent",
        expectedVersion: org.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "org_node_not_empty" });

    const archivedChild = await domain.archiveOrgNode(hr, {
      id: "child",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    expect(archivedChild.status).toBe("archived");
    org = await domain.organization(user);
    const archivedParent = await domain.archiveOrgNode(hr, {
      id: "parent",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    expect(archivedParent.status).toBe("archived");
  });

  test("restoreMember only accepts archived members and leaves active placements to moveMember", async () => {
    const { domain, hr, user } = await company();
    await domain.createOrgNode(hr, {
      id: "team",
      name: "团队",
      requestId: requestId(),
    });
    await domain.createMember(hr, {
      agentId: "dev-1",
      name: "开发",
      groupId: "team",
      role: "developer",
      responsibilities: "交付",
      requestId: requestId(),
    });
    let org = await domain.organization(user);
    await expect(
      domain.restoreMember(hr, {
        agentId: "dev-1",
        nodeId: "headquarters",
        expectedVersion: org.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "member_not_archived" });
    org = await domain.organization(user);
    expect(
      org.agents.find((a: any) => a.agentId === "dev-1"),
    ).toMatchObject({ status: "active", groupId: "team" });

    await domain.archiveMember(hr, {
      agentId: "dev-1",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    org = await domain.organization(user);
    const restored = await domain.restoreMember(hr, {
      agentId: "dev-1",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    expect(restored.status).toBe("active");
    org = await domain.organization(user);
    expect(
      org.agents.find((a: any) => a.agentId === "dev-1"),
    ).toMatchObject({
      status: "active",
      groupId: null,
      placement: null,
      orgPath: [],
    });
  });

  test("archived members cannot be assigned work, collaborate, or receive new IM", async () => {
    const { domain, hr, user } = await company();
    await createDepartmentWithHead(domain, hr, {
      nodeId: "delivery",
      headId: `${user.companyId}-head`,
      nodeName: "交付部",
      headName: "交付部长",
    });
    await domain.createMember(hr, {
      agentId: "dev-1",
      name: "开发",
      groupId: "headquarters",
      role: "developer",
      responsibilities: "交付",
      requestId: requestId(),
    });
    const issue = await domain.createIssue(user, {
      title: "归档成员不可指派",
      requestId: requestId(),
    });
    let org = await domain.organization(user);
    await domain.archiveMember(hr, {
      agentId: "dev-1",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    const issueId = String(issue.id);
    await expect(
      domain.assignIssue(user, {
        issueId,
        agentId: "dev-1",
        expectedVersion: issue.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "member_archived" });
    await expect(
      domain.assignIssue(user, {
        issueId,
        agentId: hr.id,
        collaborators: ["dev-1"],
        expectedVersion: issue.version,
        reason: "fixture",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "member_archived" });
    await expect(
      domain.ask(hr, {
        agentId: "dev-1",
        body: "请回复",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "member_archived" });

    const members = await domain.members(user);
    expect(members.find((member) => member.agentId === "dev-1")).toMatchObject({
      status: "archived",
      groupId: null,
    });
  });

  test("archiveMember removes placement and access, keeps Agent facts, and restoreMember reattaches", async () => {
    const { root, domain, hr, user } = await company();
    await domain.createOrgNode(hr, {
      id: "team",
      name: "团队",
      leadPersonId: null,
      requestId: requestId(),
    });
    await domain.createMember(hr, {
      agentId: "dev-1",
      name: "开发",
      groupId: "team",
      role: "developer",
      responsibilities: "交付",
      requestId: requestId(),
    });
    const agentBefore = await readFile(
      file(root, "agents/dev-1/agent.yaml"),
      "utf8",
    );
    const agent = await domain.getAgent(user, { agentId: "dev-1" });
    const authToken = (await domain.getAgentInternal("dev-1")).authToken;
    const lead = await domain.createOrgNode(hr, {
      id: "lead-node",
      name: "负责人节点",
      leadPersonId: "dev-1",
      requestId: requestId(),
    });
    expect(lead.leadPersonId).toBe("dev-1");
    const dev: CallerContext = {
      type: "agent",
      id: "dev-1",
      companyId: user.companyId,
    };
    let org = await domain.organization(user);
    const archived = await domain.archiveMember(hr, {
      agentId: "dev-1",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    expect(archived.status).toBe("archived");
    org = await domain.organization(user);
    const archivedAgent = org.agents.find(
      (a: any) => a.agentId === "dev-1",
    )!;
    expect(archivedAgent.status).toBe("archived");
    expect(archivedAgent.groupId).toBeNull();
    expect(archivedAgent.placement).toBeNull();
    expect(
      org.organization.nodes.find((node: any) => node.id === "lead-node")!
        .leadPersonId,
    ).toBeNull();
    expect(await readFile(file(root, "agents/dev-1/agent.yaml"), "utf8")).toBe(
      agentBefore,
    );
    expect((await domain.getAgentInternal("dev-1")).sessionId).toBe(
      agent.sessionId,
    );
    expect(await domain.authenticateAgent(authToken)).toBeNull();
    await expect(
      domain.getAgent(dev, { agentId: "dev-1" }),
    ).rejects.toMatchObject({ code: "member_archived" });
    await expect(
      domain.moveMember(hr, {
        agentId: "dev-1",
        nodeId: "team",
        expectedVersion: org.organization.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "member_archived" });

    const restored = await domain.restoreMember(hr, {
      agentId: "dev-1",
      nodeId: "team",
      expectedVersion: org.organization.version,
      requestId: requestId(),
    });
    expect(restored.status).toBe("active");
    org = await domain.organization(user);
    expect(
      org.agents.find((a: any) => a.agentId === "dev-1"),
    ).toMatchObject({
      status: "active",
      groupId: "team",
    });
    expect(await readFile(file(root, "agents/dev-1/agent.yaml"), "utf8")).toBe(
      agentBefore,
    );
    expect(await domain.authenticateAgent(authToken)).toEqual(dev);
  });
});
