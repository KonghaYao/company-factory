import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyDomain, type CallerContext } from "./index";

function requestId() {
  return randomUUID();
}

describe("secretary role, dispatch and Issue metadata search", () => {
  let root: string;
  let domain: CompanyDomain;
  let user: CallerContext;
  let hr: CallerContext;
  let supervisor: CallerContext;
  let secretary: CallerContext;
  let dev: CallerContext;
  let preview: CallerContext;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-secretary-"));
    domain = new CompanyDomain({
      root,
      provisionAgent: async (agent) => ({
        sessionId: `unit-only-session-${agent.agentId}`,
      }),
    });
    const commit = domain.store.commit.bind(domain.store);
    spyOn(domain.store, "commit").mockImplementation(async (dir, message) => {
      if (dir.startsWith(join(root, "agents") + "/")) return;
      return commit(dir, message);
    });
    user = { type: "user", id: "owner", companyId: "" };
    const created = await domain.createCompany(user, {
      name: "Secretary Company",
      requestId: requestId(),
    });
    user = { ...user, companyId: created.company.id };
    const context = (role: string): CallerContext => ({
      type: "agent",
      id: created.agents.find((agent) => agent.role === role)!.agentId,
      companyId: user.companyId,
    });
    hr = context("hr");
    supervisor = context("task-supervisor");
    secretary = context("secretary");
    for (const [agentId, role, name] of [
      ["dev-1", "developer", "Developer"],
      ["preview-1", "preview", "Preview"],
    ] as const)
      await domain.createMember(hr, {
        agentId,
        name,
        groupId: "headquarters",
        role,
        responsibilities: "Delivery",
        requestId: requestId(),
      });
    dev = { type: "agent", id: "dev-1", companyId: user.companyId };
    preview = { type: "agent", id: "preview-1", companyId: user.companyId };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("new Companies include a headquarters secretary with issue.create, issue.assign and issue.search", async () => {
    const org = await domain.organization(user);
    const member = org.agents.find((agent) => agent.role === "secretary");
    expect(member).toBeDefined();
    expect(member!.agentId).toBe(`${user.companyId}-secretary`);
    expect(member!.placement?.nodeId).toBe("headquarters");
    expect(org.company.roles.secretary.permissions).toEqual([
      "issue.create",
      "issue.assign",
      "issue.search",
    ]);
  });

  test("secretary creates and dispatches in one mutation with creator and history", async () => {
    const issue = await domain.createIssue(secretary, {
      title: "Ship the release",
      summary: "Delivery owner needed",
      assigneeAgentId: dev.id,
      type: "software-change",
      pipeline: "software-delivery",
      reason: "Developer owns delivery",
      requestId: requestId(),
    });
    expect(issue.agent_id).toBe(dev.id);
    expect(issue.status).toBe("triage");
    expect(issue.type).toBe("software-change");
    expect(issue.pipeline).toBe("software-delivery");
    expect(issue.created_by_type).toBe("agent");
    expect(issue.created_by_id).toBe(secretary.id);
    expect(issue.history).toHaveLength(1);
    expect(issue.history[0]).toMatchObject({
      from: supervisor.id,
      to: dev.id,
      by: secretary.id,
      reason: "Developer owns delivery",
    });
    expect(await domain.getIssue(secretary, { issueId: issue.id })).toMatchObject({
      id: issue.id,
      agent_id: dev.id,
    });
    await domain.addComment(secretary, {
      issueId: issue.id,
      body: "Following up from the intake notes.",
      requestId: requestId(),
    });
    await expect(
      domain.updateIssue(secretary, {
        issueId: issue.id,
        version: issue.version,
        patch: { status: "plan" },
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "not_current_owner" });
    await expect(
      domain.updateTodos(secretary, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "Do the work" }],
        note: "Try to take over",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "not_current_owner" });
    await expect(
      domain.cancelIssue(secretary, {
        issueId: issue.id,
        version: issue.version,
        reason: "Try to cancel",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "not_current_owner" });
    await expect(
      domain.getIssue(preview, { issueId: issue.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await domain.listIssues(secretary)).map((item) => item.id)).toContain(
      issue.id,
    );
    expect(
      (await domain.workspace(secretary, { agentId: secretary.id })).issues.map(
        (item) => item.id,
      ),
    ).toContain(issue.id);
  });

  test("creator-only reassignment cannot target self or another creator's Issue", async () => {
    const created = await domain.createIssue(secretary, {
      title: "Reassignable work",
      assigneeAgentId: dev.id,
      reason: "Developer owns delivery",
      requestId: requestId(),
    });
    const reassigned = await domain.assignIssue(secretary, {
      issueId: created.id,
      version: created.version,
      agentId: preview.id,
      reason: "Preview takes over integration",
      requestId: requestId(),
    });
    expect(reassigned.agent_id).toBe(preview.id);
    expect(reassigned.history.at(-1)).toMatchObject({
      from: dev.id,
      to: preview.id,
      by: secretary.id,
    });
    await expect(
      domain.assignIssue(secretary, {
        issueId: created.id,
        version: reassigned.version,
        agentId: secretary.id,
        reason: "Self assignment",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const ownedByUser = await domain.createIssue(user, {
      title: "Owner-created work",
      assigneeAgentId: hr.id,
      reason: "HR owns intake",
      requestId: requestId(),
    });
    await expect(
      domain.assignIssue(secretary, {
        issueId: ownedByUser.id,
        version: ownedByUser.version,
        agentId: dev.id,
        reason: "Try to reassign someone else's Issue",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("dispatch requires issue.assign and never targets archived members", async () => {
    const company = await domain.organization(user);
    await domain.setRolePermissions(hr, {
      role: "developer",
      permissions: ["issue.create"],
      version: company.company.version,
      requestId: requestId(),
    });
    await expect(
      domain.createIssue(dev, {
        title: "No dispatch permission",
        assigneeAgentId: hr.id,
        reason: "Try to dispatch",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      domain.createIssue(secretary, {
        title: "Self dispatch",
        assigneeAgentId: secretary.id,
        reason: "Try to self assign",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await domain.createMember(hr, {
      agentId: "archive-me",
      name: "Archive Me",
      groupId: "headquarters",
      role: "developer",
      responsibilities: "Temporary",
      requestId: requestId(),
    });
    const archiveTarget = await domain.organization(user);
    await domain.archiveMember(user, {
      agentId: "archive-me",
      version: archiveTarget.organization.version,
      requestId: requestId(),
    });
    await expect(
      domain.createIssue(secretary, {
        title: "Archived target",
        assigneeAgentId: "archive-me",
        reason: "Try archived",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "member_archived" });
  });

  test("setRolePermissions accepts issue.assign and issue.search, rejects unknown permissions", async () => {
    const company = await domain.organization(user);
    const updated = await domain.setRolePermissions(hr, {
      role: "preview",
      permissions: ["issue.create", "issue.assign", "issue.search"],
      version: company.company.version,
      requestId: requestId(),
    });
    expect(updated.roles.preview.permissions).toEqual([
      "issue.create",
      "issue.assign",
      "issue.search",
    ]);
    await expect(
      domain.setRolePermissions(hr, {
        role: "preview",
        permissions: ["issue.read_all"],
        version: updated.version,
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("searchIssues returns metadata only, requires issue.search, and cannot read unrelated bodies", async () => {
    const searchable = await domain.createIssue(user, {
      title: "Searchable payments policy",
      summary: "Shared payment summary",
      body: "BODY_ONLY_SECRET",
      requestId: requestId(),
    });
    const cancelled = await domain.createIssue(user, {
      title: "Searchable cancelled work",
      summary: "Old cancelled summary",
      requestId: requestId(),
    });
    const cancelledNow = await domain.getIssue(user, { issueId: cancelled.id });
    await domain.cancelIssue(user, {
      issueId: cancelled.id,
      version: cancelledNow.version,
      reason: "No longer needed",
      requestId: requestId(),
    });

    const result = await domain.searchIssues(secretary, {
      query: "SEARCHABLE",
    });
    expect(result.total).toBe(2);
    const item = result.items.find((entry) => entry.id === searchable.id)!;
    expect(item).toMatchObject({
      id: searchable.id,
      title: "Searchable payments policy",
      summary: "Shared payment summary",
      created_by_type: "user",
      created_by_id: user.id,
    });
    expect(Object.keys(item)).not.toContain("body");
    expect(Object.keys(item)).not.toContain("comments");
    expect(Object.keys(item)).not.toContain("decisions");
    await expect(
      domain.getIssue(secretary, { issueId: searchable.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      domain.searchIssues(dev, { query: "searchable" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      domain.searchIssues(secretary, { query: "   " }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.searchIssues(secretary, { query: "searchable", status: ["cancel"] }),
    ).resolves.toMatchObject({ total: 1 });
    await expect(
      domain.searchIssues(secretary, { query: "BODY_ONLY_SECRET" }),
    ).resolves.toMatchObject({ total: 0 });
    await expect(
      domain.searchIssues(secretary, { query: "searchable", limit: 1 }),
    ).resolves.toMatchObject({ total: 2, truncated: true });
    await expect(
      domain.searchIssues(user, { query: "searchable" }),
    ).resolves.toMatchObject({ total: 2 });
  });
});
