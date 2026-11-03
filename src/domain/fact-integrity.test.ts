import { afterAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CompanyDomain, type CallerContext, type DomainOptions } from "./index";
import { createDepartmentWithHead } from "./test-support";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const owner: CallerContext = { type: "user", id: "test-owner", companyId: "" };
let requestSequence = 0;
const requestId = () => `fact-test-${++requestSequence}`;

// These tests exercise real Company files and Git. The runtime binding and
// isolated Agent Git are explicit doubles, as in the existing domain suite.
function domainWith(options: DomainOptions) {
  const domain = new CompanyDomain(options);
  const commit = domain.store.commit.bind(domain.store);
  domain.store.commit = async (directory, message) => {
    if (directory.startsWith(join(options.root, "agents") + "/")) return;
    return commit(directory, message);
  };
  return domain;
}
async function fixture(extra: Partial<DomainOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "company-fact-integrity-"));
  roots.push(root);
  const domain = domainWith({
    root,
    provisionAgent: async (input) => ({
      sessionId: input.sessionId ?? `test-session-${input.agentId}`,
    }),
    ...extra,
  });
  return { root, domain };
}
async function company(extra: Partial<DomainOptions> = {}) {
  const f = await fixture(extra);
  const org = await f.domain.createCompany(owner, {
    name: "Fact fixture",
    requestId: requestId(),
  });
  const user = { ...owner, companyId: org.company.id };
  const head = await createDepartmentWithHead(
    f.domain,
    { type: "agent", id: `${org.company.id}-hr`, companyId: org.company.id },
    {
      nodeId: "delivery",
      headId: `${org.company.id}-head`,
      nodeName: "Delivery",
      headName: "Delivery Head",
    },
  );
  return { ...f, org, user, head };
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("Company mutation completion", () => {
  test("replay after real Git failure completes the original mutation and leaves unrelated later edits alone", async () => {
    const changes: string[] = [];
    const { domain, user, root } = await company({
      onChange: (event) => changes.push(event.kind),
    });
    const directory = domain.store.company(user.companyId);
    const hook = join(directory, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o700);
    const head = git(directory, "rev-parse", "HEAD");
    const input = { title: "One real mutation", requestId: "commit-failure" };
    await expect(domain.createIssue(user, input)).rejects.toThrow();
    await expect(domain.createIssue(user, input)).rejects.toThrow();
    expect(git(directory, "rev-parse", "HEAD")).toBe(head);
    expect(await domain.listIssues(user)).toHaveLength(1);
    expect(changes.filter((kind) => kind === "createIssue")).toHaveLength(0);

    await unlink(hook);
    const restarted = domainWith({ ...domain.options, root });
    const issue = await restarted.createIssue(user, input);
    expect(issue.id).toBe("1");
    expect(issue.version).toBe(1);
    expect(await restarted.listIssues(user)).toHaveLength(1);
    expect(git(directory, "rev-parse", "HEAD")).not.toBe(head);
    expect(git(directory, "status", "--porcelain")).toBe("");
    expect(changes.filter((kind) => kind === "createIssue")).toHaveLength(1);

    const completeHead = git(directory, "rev-parse", "HEAD");
    await writeFile(
      join(directory, "knowledgebase/manual.md"),
      "Uncommitted owner edit\n",
    );
    expect(await restarted.createIssue(user, input)).toEqual(issue);
    expect(git(directory, "rev-parse", "HEAD")).toBe(completeHead);
    expect(git(directory, "status", "--porcelain")).toContain("manual.md");
    await expect(
      restarted.createIssue(user, { ...input, title: "Different" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("replay republishes an interrupted resource invalidation without duplicating business writes", async () => {
    let failNotice = true;
    let notices = 0;
    const { domain, user } = await company({
      onChange: (event) => {
        if (event.kind !== "createIssue") return;
        if (failNotice) {
          failNotice = false;
          throw new Error("Fixture observer failure");
        }
        notices++;
      },
    });
    const input = {
      title: "Committed before observer failed",
      requestId: "observer-failure",
    };
    await expect(domain.createIssue(user, input)).rejects.toThrow(
      "Fixture observer failure",
    );
    const directory = domain.store.company(user.companyId);
    const head = git(directory, "rev-parse", "HEAD");
    expect(git(directory, "status", "--porcelain")).toBe("");
    expect((await domain.createIssue(user, input)).id).toBe("1");
    expect(notices).toBe(1);
    expect(await domain.listIssues(user)).toHaveLength(1);
    expect(git(directory, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("Initialization recovery", () => {
  test("a retry finishes Agent Git after the roster was already saved without provisioning again", async () => {
    const provisioned: string[] = [];
    const { domain, root } = await fixture({
      provisionAgent: async (input) => {
        provisioned.push(input.agentId);
        return { sessionId: `confirmed-${input.agentId}` };
      },
    });
    const commit = domain.store.commit.bind(domain.store);
    let failed = false;
    let hrCommits = 0;
    domain.store.commit = async (directory, message) => {
      if (
        directory.startsWith(join(root, "agents") + "/") &&
        directory.endsWith("-hr")
      ) {
        hrCommits++;
        if (!failed) {
          failed = true;
          throw new Error("Fixture interrupted Agent Git");
        }
      }
      return commit(directory, message);
    };
    const input = { name: "Finish Agent Git", requestId: "retry-agent-commit" };
    await expect(domain.createCompany(owner, input)).rejects.toThrow(
      "Fixture interrupted Agent Git",
    );
    const result = await domain.createCompany(owner, input);
    expect(result.agents).toHaveLength(2);
    expect(provisioned.filter((id) => id.endsWith("-hr"))).toHaveLength(1);
    expect(provisioned.filter((id) => id.endsWith("-secretary"))).toHaveLength(
      1,
    );
    expect(hrCommits).toBe(2);
  });

  test("a cold identical retry repairs a missing roster using the original credential and fixed Session", async () => {
    const provisions: {
      agentId: string;
      sessionId?: string;
      authToken: string;
    }[] = [];
    const { domain, root } = await fixture({
      provisionAgent: async (input) => {
        provisions.push({
          agentId: input.agentId,
          sessionId: input.sessionId,
          authToken: input.authToken,
        });
        return {
          sessionId: input.sessionId ?? `confirmed-${provisions.length}`,
        };
      },
    });
    const put = domain.store.putYaml.bind(domain.store);
    let interrupted = false;
    domain.store.putYaml = async (path, data, version) => {
      if (
        path.endsWith("/roster.yaml") &&
        data.members?.length === 1 &&
        !interrupted
      ) {
        interrupted = true;
        throw Object.assign(new Error("Fixture one-shot roster EIO"), {
          code: "EIO",
        });
      }
      return put(path, data, version);
    };
    const input = { name: "Resume exactly", requestId: "resume-roster" };
    await expect(domain.createCompany(owner, input)).rejects.toMatchObject({
      code: "EIO",
    });
    const [companyId] = await domain.store.ids(join(root, "companys"));
    const agentId = `${companyId}-hr`;
    const before = await domain.getAgentInternal(agentId);
    const memory = await readFile(join(before.directory, "CLAUDE.md"), "utf8");

    const restarted = domainWith(domain.options);
    const org = await restarted.createCompany(owner, input);
    const after = await restarted.getAgentInternal(agentId);
    expect(org.agents).toHaveLength(2);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.authToken).toBe(before.authToken);
    expect(await readFile(join(after.directory, "CLAUDE.md"), "utf8")).toBe(
      memory,
    );
    const confirmations = provisions.filter((p) => p.agentId === agentId);
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]).toEqual({
      agentId,
      sessionId: before.sessionId,
      authToken: before.authToken,
    });
    const replay = await restarted.createCompany(owner, input);
    expect(replay.agents).toHaveLength(2);
    expect(provisions).toHaveLength(3);
    await expect(
      restarted.createCompany(owner, { ...input, name: "Different intent" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("a preexisting Agent with mismatched Company identity is never adopted by initialization recovery", async () => {
    let attempts = 0;
    const { domain, root } = await fixture({
      provisionAgent: async (input) => {
        attempts++;
        return { sessionId: `confirmed-${input.agentId}` };
      },
    });
    const put = domain.store.putYaml.bind(domain.store);
    let interrupted = false;
    domain.store.putYaml = async (path, data, version) => {
      if (
        path.endsWith("/roster.yaml") &&
        data.members?.length === 1 &&
        !interrupted
      ) {
        interrupted = true;
        throw new Error("Fixture roster failure");
      }
      return put(path, data, version);
    };
    const input = { name: "Identity recovery", requestId: "identity-check" };
    await expect(domain.createCompany(owner, input)).rejects.toThrow();
    const [id] = await domain.store.ids(join(root, "companys"));
    const existing = await domain.getAgentInternal(`${id}-hr`);
    await put(join(existing.directory, "agent.yaml"), {
      ...existing,
      companyId: "another-company",
    });
    await expect(
      domainWith(domain.options).createCompany(owner, input),
    ).rejects.toMatchObject({ code: "already_exists" });
    expect(attempts).toBe(1);
    expect(
      (await domain.store.yaml(join(domain.store.company(id!), "roster.yaml")))
        .members,
    ).toEqual([]);
  });
});

async function previewFixture() {
  const f = await company();
  const { domain, user } = f;
  const hr: CallerContext = {
    type: "agent",
    id: `${user.companyId}-hr`,
    companyId: user.companyId,
  };
  const preview: CallerContext = {
    type: "agent",
    id: "fixture-preview",
    companyId: user.companyId,
  };
  const reviewer: CallerContext = {
    type: "agent",
    id: "fixture-reviewer",
    companyId: user.companyId,
  };
  for (const [member, role] of [
    [preview, "preview"],
    [reviewer, "reviewer"],
  ] as const)
    await domain.createMember(hr, {
      agentId: member.id,
      role,
      groupId: "headquarters",
      name: role,
      responsibilities: "Test fixture",
      requestId: requestId(),
    });
  const issues = [];
  for (let i = 0; i < 2; i++) {
    let issue = await domain.createIssue(user, {
      title: `Issue ${i}`,
      requestId: requestId(),
    });
    issue = await domain.updateIssue(user, {
      issueId: issue.id,
      version: issue.version,
      requestId: requestId(),
      patch: {
        status: "ready_preview",
        plan_ref: `plan-${i}`,
        worktree: `/fixture/worktree-${i}`,
        code_ref: `sha-${i}`,
      },
    });
    issue = await domain.assignIssue(user, {
      issueId: issue.id,
      version: issue.version,
      agentId: preview.id,
      reason: "Preview handoff",
      requestId: requestId(),
    });
    issues.push(issue);
  }
  const batch = await domain.savePreview(preview, {
    id: "batch",
    issue_ids: ["1", "2"],
    branch: "preview/test",
    environment_url: "http://localhost:4000",
    code_refs: { "1": "sha-0", "2": "sha-1" },
    checklist: { "1": ["works"], "2": ["works"] },
    requestId: requestId(),
  });
  const removeFirst = () => ({
    id: batch.id,
    version: batch.version,
    issue_ids: ["2"],
    code_refs: { "2": "sha-1" },
    checklist: { "2": ["works"] },
    requestId: requestId(),
  });
  return { ...f, preview, reviewer, batch, removeFirst };
}

describe("Preview affected-Issue invariants", () => {
  test("the former Preview owner cannot remove a handed-off Issue or partially update the remaining members", async () => {
    const { domain, user, preview, reviewer, batch, removeFirst } =
      await previewFixture();
    const issue = await domain.getIssue(user, { issueId: "1" });
    await domain.assignIssue(user, {
      issueId: issue.id,
      version: issue.version,
      agentId: reviewer.id,
      reason: "Reviewer handoff",
      requestId: requestId(),
    });
    const before = await domain.listIssues(user);
    await expect(
      domain.savePreview(preview, removeFirst()),
    ).rejects.toMatchObject({ code: "not_current_owner", status: 403 });
    expect(await domain.listIssues(user)).toEqual(before);
    expect(await domain.getPreview(user, { batchId: batch.id })).toEqual(batch);
  });

  test("acceptance and verification cannot lose their current batch; an explicit Issue revision allows removal", async () => {
    const { domain, user, preview, batch, removeFirst } =
      await previewFixture();
    let result = await domain.acceptPreview(user, {
      batchId: batch.id,
      issueId: "1",
      version: batch.version,
      codeRef: "sha-0",
      passed: true,
      evidence: "Explicit user fixture acceptance",
      requestId: requestId(),
    });
    for (const stage of ["accepted", "verifying", "ready_merge"] as const) {
      if (stage === "verifying") {
        result = await domain.recordVerification(preview, {
          batchId: batch.id,
          issueId: "1",
          version: result.preview.version,
          codeRef: "sha-0",
          kind: "ci",
          passed: true,
          evidence: "Fixture CI",
          requestId: requestId(),
        });
      } else if (stage === "ready_merge") {
        result = await domain.recordVerification(preview, {
          batchId: batch.id,
          issueId: "1",
          version: result.preview.version,
          codeRef: "sha-0",
          kind: "review",
          passed: true,
          evidence: "Fixture review",
          requestId: requestId(),
        });
        result.issue = await domain.updateIssue(preview, {
          issueId: "1",
          version: result.issue.version,
          patch: { status: "ready_merge" },
          requestId: requestId(),
        });
      }
      expect(result.issue.status).toBe(stage);
      await expect(
        domain.savePreview(preview, {
          ...removeFirst(),
          version: result.preview.version,
        }),
      ).rejects.toMatchObject({ code: "preview_evidence_in_use", status: 409 });
      expect(await domain.getIssue(user, { issueId: "1" })).toEqual(
        result.issue,
      );
      expect(await domain.getPreview(user, { batchId: batch.id })).toEqual(
        result.preview,
      );
    }
    await domain.updateIssue(preview, {
      issueId: "1",
      version: result.issue.version,
      patch: { status: "code" },
      requestId: requestId(),
    });
    await domain.savePreview(preview, {
      ...removeFirst(),
      version: result.preview.version,
    });
    const removed = await domain.getIssue(user, { issueId: "1" });
    expect(removed.status).toBe("code");
    expect(removed.preview_batch).toBeNull();
  });
});
