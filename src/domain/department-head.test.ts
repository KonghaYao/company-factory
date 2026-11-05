import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyDomain, type CallerContext } from "./index";
import { createDepartmentWithHead } from "./test-support";
import { roleCardFor } from "./prompt-library";

const requestId = () => randomUUID();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "company-department-head-"));
  const domain = new CompanyDomain({
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
  const user: CallerContext = { type: "user", id: "owner", companyId: "" };
  const created = await domain.createCompany(user, {
    name: "Department Head Company",
    requestId: requestId(),
  });
  const scopedUser = { ...user, companyId: created.company.id };
  const hr: CallerContext = {
    type: "agent",
    id: `${created.company.id}-hr`,
    companyId: created.company.id,
  };
  return { root, domain, created, user: scopedUser, hr };
}

describe("Department heads are derived from organization node leads", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  test("a new Company creates only HR and the secretary and exposes an empty department-head role", async () => {
    const f = await fixture();
    roots.push(f.root);
    expect(f.created.agents.map((agent) => agent.agentId).sort()).toEqual([
      `${f.created.company.id}-hr`,
      `${f.created.company.id}-secretary`,
    ]);
    expect(f.created.company.roles["department-head"]).toEqual({
      permissions: [],
    });
    expect(f.created.company.roles["task-supervisor"]).toBeUndefined();
    expect(f.created.company.roles.secretary.permissions).toEqual([
      "issue.create",
      "issue.assign",
      "issue.search",
    ]);
  });

  test("creating an Issue without a department head fails with invalid_state", async () => {
    const f = await fixture();
    roots.push(f.root);
    await expect(
      f.domain.createIssue(f.user, {
        title: "No owner yet",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_state",
      message:
        "Company has no department head; create a department and its head first",
    });
    await expect(
      f.domain.createIssue(f.user, {
        title: "Explicit dispatch without a default owner",
        assigneeAgentId: `${f.created.company.id}-secretary`,
        requestId: requestId(),
      }),
    ).resolves.toMatchObject({
      agent_id: `${f.created.company.id}-secretary`,
      history: [],
    });
  });

  test("HR creates a department and its head, then the head becomes the default owner", async () => {
    const f = await fixture();
    roots.push(f.root);
    const head = await createDepartmentWithHead(f.domain, f.hr, {
      nodeId: "delivery",
      headId: `${f.created.company.id}-head`,
      nodeName: "交付部",
      headName: "交付部长",
      responsibilities: "Lead delivery and dispatch",
    });
    const org = await f.domain.organization(f.user);
    const node = org.organization.nodes.find((item) => item.id === "delivery")!;
    expect(node.leadPersonId).toBe(head.id);
    expect(org.agents.find((agent) => agent.agentId === head.id)).toMatchObject(
      {
        role: "department-head",
        responsibilities: "Lead delivery and dispatch",
        orgPath: [
          { id: "headquarters", name: "总部" },
          { id: "delivery", name: "交付部" },
        ],
      },
    );
    const issue = await f.domain.createIssue(f.user, {
      title: "Default department owner",
      requestId: requestId(),
    });
    expect(issue.agent_id).toBe(head.id);
    expect(issue.history).toEqual([]);
  });

  test("a head dispatches, searches, reassigns company-wide, cannot self-assign, and loses authority when archived", async () => {
    const f = await fixture();
    roots.push(f.root);
    const head = await createDepartmentWithHead(f.domain, f.hr, {
      nodeId: "delivery",
      headId: `${f.created.company.id}-head`,
      nodeName: "交付部",
      headName: "交付部长",
    });
    for (const [agentId, name] of [
      ["dev-a", "Developer A"],
      ["dev-b", "Developer B"],
    ] as const)
      await f.domain.createMember(f.hr, {
        agentId,
        name,
        groupId: "delivery",
        role: "developer",
        responsibilities: "Delivery",
        requestId: requestId(),
      });
    const devA: CallerContext = {
      type: "agent",
      id: "dev-a",
      companyId: f.user.companyId,
    };
    const devB: CallerContext = {
      type: "agent",
      id: "dev-b",
      companyId: f.user.companyId,
    };

    const dispatched = await f.domain.createIssue(head, {
      title: "Head dispatches",
      assigneeAgentId: devA.id,
      reason: "Developer A owns delivery",
      requestId: requestId(),
    });
    expect(dispatched.agent_id).toBe(devA.id);
    expect(dispatched.history).toMatchObject([
      { from: head.id, to: devA.id, by: head.id },
    ]);
    const found = await f.domain.searchIssues(head, { query: "dispatches" });
    expect(found.items.map((item) => item.id)).toEqual([dispatched.id]);
    await expect(
      f.domain.createIssue(head, {
        title: "Self dispatch",
        assigneeAgentId: head.id,
        reason: "Not allowed",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const userIssue = await f.domain.createIssue(f.user, {
      title: "User issue assigned to head by default",
      requestId: requestId(),
    });
    const reassigned = await f.domain.assignIssue(head, {
      issueId: userIssue.id,
      version: userIssue.version,
      agentId: devB.id,
      reason: "Cross-department coordination",
      requestId: requestId(),
    });
    expect(reassigned.agent_id).toBe(devB.id);
    await expect(
      f.domain.assignIssue(head, {
        issueId: userIssue.id,
        version: reassigned.version,
        agentId: head.id,
        reason: "Self assignment",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const beforeArchive = await f.domain.organization(f.user);
    await f.domain.archiveMember(f.hr, {
      agentId: head.id,
      expectedVersion: beforeArchive.organization.version,
      requestId: requestId(),
    });
    const afterArchive = await f.domain.organization(f.user);
    expect(
      afterArchive.organization.nodes.find((item) => item.id === "delivery")
        ?.leadPersonId,
    ).toBeNull();
    await expect(
      f.domain.createIssue(f.user, {
        title: "No head after archive",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      f.domain.assignIssue(head, {
        issueId: userIssue.id,
        version: reassigned.version,
        agentId: devA.id,
        reason: "Archived head tries to reassign",
        requestId: requestId(),
      }),
    ).rejects.toMatchObject({ code: "member_archived" });
  });

  test("role cards describe the HR department-head flow and no longer fall back to the old supervisor", () => {
    expect(roleCardFor("hr")).toContain("leadPersonId");
    expect(roleCardFor("hr")).toContain("成立部门");
    expect(roleCardFor("hr")).toContain("不把常规选项反复交用户");
    expect(roleCardFor("secretary")).toContain("leadPersonId");
    expect(roleCardFor("secretary")).toContain("最近有效祖先负责人");
    expect(roleCardFor("secretary")).toContain("不要默认逐题访谈");
    expect(roleCardFor("secretary")).not.toContain("任务主管");
    expect(roleCardFor("department-head")).toContain("名为部长不等于有权");
    expect(roleCardFor("department-head")).toContain("active 节点 lead");
    expect(roleCardFor("department-head")).toContain(
      "验收前的普通自检不是正式 CI/Review",
    );
    expect(roleCardFor("task-supervisor")).toBe(roleCardFor("colleague"));
    expect(roleCardFor("task-supervisor")).not.toBe(roleCardFor("department-head"));
  });
});
