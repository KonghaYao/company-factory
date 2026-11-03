import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompanyDomain,
  type CallerContext,
  type DomainOptions,
  type Issue,
} from "./index";

// Real temp-directory storage and Git; only runtime provisioning and Agent Git
// commits are replaced. No test touches the live Company home.
function unitDomain(options: DomainOptions) {
  const domain = new CompanyDomain(options);
  const commit = domain.store.commit.bind(domain.store);
  spyOn(domain.store, "commit").mockImplementation(async (dir, message) => {
    if (dir.startsWith(join(domain.store.root, "agents") + "/")) return;
    return commit(dir, message);
  });
  return domain;
}

describe("Issue todos and append-only progress updates", () => {
  let root: string;
  let domain: CompanyDomain;
  let user: CallerContext;
  let hr: CallerContext;
  let supervisor: CallerContext;
  let issueCounter = 0;
  const company = () => domain.store.company(user.companyId);

  async function newIssue(title = `Issue ${++issueCounter}`) {
    return domain.createIssue(user, { title });
  }
  async function current(issueId: string) {
    return domain.getIssue(user, { issueId });
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-task-progress-"));
    domain = unitDomain({
      root,
      provisionAgent: async (agent) => ({
        sessionId: `fixture-${agent.agentId}`,
      }),
    });
    const writes = new Set([
      "createCompany",
      "createMember",
      "archiveMember",
      "createIssue",
      "updateIssue",
      "assignIssue",
      "cancelIssue",
      "updateTodos",
      "addUpdate",
    ]);
    domain = new Proxy(domain, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" && writes.has(String(key))
          ? (ctx: CallerContext, input: any) =>
              value.call(target, ctx, { requestId: randomUUID(), ...input })
          : typeof value === "function"
            ? value.bind(target)
            : value;
      },
    }) as CompanyDomain;
    const created = await domain.createCompany(
      { type: "user", id: "local-user", companyId: "" },
      { name: "Progress fixture", requestId: "create-company" },
    );
    user = { type: "user", id: "local-user", companyId: created.company.id };
    hr = {
      type: "agent",
      id: `${created.company.id}-hr`,
      companyId: user.companyId,
    };
    supervisor = {
      type: "agent",
      id: `${created.company.id}-supervisor`,
      companyId: user.companyId,
    };
  });
  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(root, { recursive: true, force: true });
  });

  test("new Issues expose explicit empty todos and latest_update", async () => {
    const issue = await newIssue();
    expect(issue.todos).toEqual([]);
    expect(issue.latest_update).toBeNull();
    const read = await current(issue.id);
    expect(read.todos).toEqual([]);
    expect(read.latest_update).toBeNull();
    expect(read.version).toBe(issue.version);
  });

  test("todos add, update, reopen, reorder, remove and never reuse an id", async () => {
    const issue = await newIssue();
    const initialVersion = issue.version;
    let result = await domain.updateTodos(user, {
      issueId: issue.id,
      version: initialVersion,
      changes: [
        { op: "add", text: "First" },
        { op: "add", text: "Second", status: "in_progress" },
        { op: "add", text: "Third" },
      ],
    });
    expect(result.update).toBeNull();
    expect(result.issue.version).toBe(initialVersion + 1);
    expect(result.issue.todos!.map((item) => item.id)).toEqual([
      `${issue.id}-T1`,
      `${issue.id}-T2`,
      `${issue.id}-T3`,
    ]);
    expect(result.issue.todos![0]).toMatchObject({
      text: "First",
      status: "pending",
      created_by_type: "user",
      created_by_id: user.id,
      updated_by_type: "user",
      updated_by_id: user.id,
    });
    expect(result.issue.todos![0]!.created_at).toEqual(
      result.issue.todos![0]!.updated_at,
    );
    expect(result.issue.todos![1]!.status).toBe("in_progress");
    expect(result.issue.todos![2]).not.toHaveProperty("done_at");

    const secondId = result.issue.todos![1]!.id;
    result = await domain.updateTodos(user, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "update", todoId: secondId, status: "done" }],
    });
    expect(result.issue.todos![1]!.status).toBe("done");
    expect(result.issue.todos![1]!.done_at).toBeTruthy();

    result = await domain.updateTodos(user, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "update", todoId: secondId, status: "pending" }],
    });
    expect(result.issue.todos![1]!.status).toBe("pending");
    expect(result.issue.todos![1]!.done_at).toBeUndefined();

    const ids = result.issue.todos!.map((item) => item.id);
    result = await domain.updateTodos(user, {
      issueId: issue.id,
      version: result.issue.version,
      order: [ids[2]!, ids[0]!, ids[1]!],
    });
    expect(result.issue.todos!.map((item) => item.id)).toEqual([
      ids[2]!,
      ids[0]!,
      ids[1]!,
    ]);

    result = await domain.updateTodos(user, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "update", todoId: ids[0]!, text: "First renamed" }],
      order: [ids[1]!, ids[0]!, ids[2]!],
    });
    expect(result.issue.todos!.map((item) => item.id)).toEqual([
      ids[1]!,
      ids[0]!,
      ids[2]!,
    ]);
    expect(result.issue.todos![1]!.text).toBe("First renamed");

    // Delete the highest id, then add again: the numeric suffix must not repeat.
    const removed = result.issue.todos!.find((item) => item.id === ids[2]!)!;
    result = await domain.updateTodos(user, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "remove", todoId: removed.id }],
    });
    result = await domain.updateTodos(user, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "add", text: "Fourth" }],
    });
    expect(result.issue.todos!.some((item) => item.id === removed.id)).toBe(
      false,
    );
    expect(result.issue.todos!.at(-1)!.id).toBe(`${issue.id}-T4`);

    await expect(
      domain.updateIssue(user, {
        issueId: issue.id,
        version: result.issue.version,
        patch: { todos: [] },
      }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  test("todo limits, malformed changes and stale order are rejected", async () => {
    const issue = await newIssue();
    let version = issue.version;
    await expect(
      domain.updateTodos(user, {
        issueId: issue.id,
        version,
        changes: Array.from({ length: 21 }, (_, i) => ({
          op: "add",
          text: `too many ${i}`,
        })),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateTodos(user, {
        issueId: issue.id,
        version,
        changes: [{ op: "add", text: "x".repeat(501) }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateTodos(user, {
        issueId: issue.id,
        version,
        changes: [{ op: "add", text: "line one\nline two" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateTodos(user, {
        issueId: issue.id,
        version,
        changes: [{ op: "update", todoId: `${issue.id}-T999`, text: "nope" }],
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(
      domain.updateTodos(user, {
        issueId: issue.id,
        version,
        changes: [{ op: "remove", todoId: `${issue.id}-T999` }],
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(
      domain.updateTodos(user, {
        issueId: issue.id,
        version,
        changes: [{ op: "add", text: "only one" }],
        order: [`${issue.id}-T1`, `${issue.id}-T2`],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateTodos(user, { issueId: issue.id, version }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    for (const count of [20, 20, 10]) {
      const result = await domain.updateTodos(user, {
        issueId: issue.id,
        version,
        changes: Array.from({ length: count }, (_, i) => ({
          op: "add",
          text: `item ${version}-${i}`,
        })),
      });
      version = result.issue.version;
    }
    expect((await current(issue.id)).todos).toHaveLength(50);
    await expect(
      domain.updateTodos(user, {
        issueId: issue.id,
        version,
        changes: [{ op: "add", text: "fifty first" }],
      }),
    ).rejects.toMatchObject({ code: "todo_limit", status: 400 });
    expect((await current(issue.id)).todos).toHaveLength(50);
  });

  test("version CAS serializes concurrent todo writes", async () => {
    const issue = await newIssue();
    const results = await Promise.allSettled([
      domain.updateTodos(user, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "concurrent A" }],
        requestId: "concurrent-a",
      }),
      domain.updateTodos(user, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "concurrent B" }],
        requestId: "concurrent-b",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "version_conflict",
      status: 409,
    });
    const final = await current(issue.id);
    expect(final.version).toBe(issue.version + 1);
    expect(final.todos).toHaveLength(1);
    await expect(
      domain.updateTodos(user, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "stale" }],
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  test("Agent todo writes require a note and snapshot it as an immutable update", async () => {
    const issue = await newIssue();
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "no note" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const result = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: issue.version,
      changes: [
        { op: "add", text: "a" },
        { op: "add", text: "b", status: "in_progress" },
      ],
      note: "Added the first two steps and started the second.",
      kind: "blocker",
    });
    expect(result.update).not.toBeNull();
    expect(result.update).toMatchObject({
      schema: "company-update/v1",
      issue_id: issue.id,
      author_type: "agent",
      author_id: supervisor.id,
      kind: "blocker",
      version: 1,
      status: issue.status,
      todo_counts: { total: 2, done: 0, in_progress: 1 },
    });
    expect(result.issue.latest_update).toMatchObject({
      id: result.update!.id,
      author_type: "agent",
      author_id: supervisor.id,
      kind: "blocker",
    });
    expect(result.issue.latest_update!.excerpt).toContain(
      "Added the first two steps",
    );
    const id = result.update!.id;
    const file = await domain.store.markdown(
      join(company(), "updates", issue.id, `${id}.md`),
    );
    expect(file.body).toContain("Added the first two steps");
    expect(file.todo_counts).toEqual({ total: 2, done: 0, in_progress: 1 });

    const latest = (await current(issue.id)).latest_update;
    expect(latest!.excerpt.length).toBeLessThanOrEqual(180);

    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version: result.issue.version,
        changes: [{ op: "add", text: "long note" }],
        note: "n".repeat(2001),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("user todo writes may omit a note; note and no-note paths both stay append-only", async () => {
    const issue = await newIssue();
    let result = await domain.updateTodos(user, {
      issueId: issue.id,
      version: issue.version,
      changes: [{ op: "add", text: "user step" }],
    });
    expect(result.update).toBeNull();
    expect(
      await domain.store.files(join(company(), "updates", issue.id)),
    ).toHaveLength(0);
    result = await domain.updateTodos(user, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "update", todoId: `${issue.id}-T1`, status: "done" }],
      note: "User completed the first step.",
      kind: "decision",
    });
    expect(result.update).toMatchObject({
      author_type: "user",
      author_id: user.id,
      kind: "decision",
      todo_counts: { total: 1, done: 1, in_progress: 0 },
    });
  });

  test("addUpdate appends without changing status, todos or decisions", async () => {
    const issue = await newIssue();
    const seeded = await domain.updateTodos(user, {
      issueId: issue.id,
      version: issue.version,
      changes: [{ op: "add", text: "keep me" }],
    });
    const before = seeded.issue;
    const first = await domain.addUpdate(user, {
      issueId: issue.id,
      version: before.version,
      body: "## Evidence\n\nTests pass.",
      kind: "progress",
    });
    expect(first.update.body).toContain("Tests pass");
    expect(first.issue.version).toBe(before.version + 1);
    expect(first.issue.status).toBe(before.status);
    expect(first.issue.todos).toEqual(before.todos);
    expect(first.issue.decisions).toEqual(before.decisions);
    expect(first.issue.latest_update!.excerpt).toBe("## Evidence Tests pass.");

    const second = await domain.addUpdate(user, {
      issueId: issue.id,
      version: first.issue.version,
      body: "Blocked on external evidence.",
      kind: "blocker",
    });
    const history = await domain.updates(user, {
      issueId: issue.id,
      limit: 10,
    });
    expect(history.items.map((item) => item.id)).toEqual([
      second.update.id,
      first.update.id,
    ]);
    expect(history.items[0]!.body).toBe("Blocked on external evidence.");
    expect(history.nextCursor).toBeNull();

    await expect(
      domain.addUpdate(user, {
        issueId: issue.id,
        version: second.issue.version,
        body: "x".repeat(4001),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("updates paginate newest first and validate cursor/limit", async () => {
    const issue = await newIssue();
    let version = issue.version;
    const ids: string[] = [];
    for (const body of ["one", "two", "three"]) {
      const result = await domain.addUpdate(user, {
        issueId: issue.id,
        version,
        body,
      });
      ids.push(result.update.id);
      version = result.issue.version;
    }
    const first = await domain.updates(user, { issueId: issue.id, limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[2]!, ids[1]!]);
    expect(first.nextCursor).toBe("2");
    const next = await domain.updates(user, {
      issueId: issue.id,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(next.items.map((item) => item.id)).toEqual([ids[0]!]);
    expect(next.nextCursor).toBeNull();

    await expect(
      domain.updates(user, { issueId: issue.id, limit: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updates(user, { issueId: issue.id, limit: 51 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    for (const cursor of ["-1", "1.5", "x", ""]) {
      await expect(
        domain.updates(user, { issueId: issue.id, cursor }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(
      domain.updates(user, { issueId: "missing-issue" }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  test("update limit is enforced without reading every record", async () => {
    const issue = await newIssue();
    const dir = join(company(), "updates", issue.id);
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 2000 }, (_, i) =>
        writeFile(join(dir, `${issue.id}-U${i + 1}.md`), "fixture"),
      ),
    );
    await expect(
      domain.addUpdate(user, {
        issueId: issue.id,
        version: issue.version,
        body: "one too many",
      }),
    ).rejects.toMatchObject({ code: "update_limit", status: 409 });
  }, 20000);

  test("read/write permissions follow owner, collaborator and archived-member rules", async () => {
    const issue = await newIssue();
    await expect(
      domain.updates(hr, { issueId: issue.id }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(
      domain.addUpdate(hr, {
        issueId: issue.id,
        version: issue.version,
        body: "not related",
      }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });

    const assigned = await domain.assignIssue(supervisor, {
      issueId: issue.id,
      version: issue.version,
      agentId: supervisor.id,
      collaborators: [hr.id],
    });
    expect((await domain.updates(hr, { issueId: issue.id })).items).toEqual([]);
    expect((await domain.getIssue(hr, { issueId: issue.id })).id).toBe(
      issue.id,
    );
    await expect(
      domain.addUpdate(hr, {
        issueId: issue.id,
        version: assigned.version,
        body: "collaborator cannot append",
      }),
    ).rejects.toMatchObject({ code: "not_current_owner", status: 403 });
    await expect(
      domain.updateTodos(hr, {
        issueId: issue.id,
        version: assigned.version,
        changes: [{ op: "add", text: "collaborator todo" }],
        note: "not owner",
      }),
    ).rejects.toMatchObject({ code: "not_current_owner", status: 403 });

    await domain.createMember(hr, {
      agentId: "archived-dev",
      name: "Archived Dev",
      groupId: "headquarters",
      role: "developer",
      responsibilities: "Fixture member",
    });
    let org = await domain.organization(user);
    await domain.archiveMember(hr, {
      agentId: "archived-dev",
      expectedVersion: org.organization.version,
    });
    const archived: CallerContext = {
      type: "agent",
      id: "archived-dev",
      companyId: user.companyId,
    };
    await expect(
      domain.getIssue(archived, { issueId: issue.id }),
    ).rejects.toMatchObject({ code: "member_archived", status: 403 });
    await expect(
      domain.updates(archived, { issueId: issue.id }),
    ).rejects.toMatchObject({ code: "member_archived", status: 403 });
  });

  test("canceled Issues reject todo changes but accept late evidence", async () => {
    const issue = await newIssue();
    const canceled = await domain.cancelIssue(supervisor, {
      issueId: issue.id,
      version: issue.version,
      reason: "No longer needed",
    });
    expect(canceled.status).toBe("cancel");
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version: canceled.version,
        changes: [{ op: "add", text: "revive" }],
        note: "should fail",
      }),
    ).rejects.toMatchObject({ code: "terminal_issue", status: 409 });
    const late = await domain.addUpdate(supervisor, {
      issueId: issue.id,
      version: canceled.version,
      body: "Post-cancel retrospective evidence.",
      kind: "decision",
    });
    expect(late.issue.status).toBe("cancel");
    expect(late.issue.todos).toEqual([]);
    expect(late.issue.latest_update!.excerpt).toContain("Post-cancel");
  });

  test("listIssues, workspace, re-instantiation and Company Git keep projections", async () => {
    const issue = await newIssue();
    const todo = await domain.updateTodos(user, {
      issueId: issue.id,
      version: issue.version,
      changes: [{ op: "add", text: "persisted todo" }],
    });
    const update = await domain.addUpdate(user, {
      issueId: issue.id,
      version: todo.issue.version,
      body: "persisted update body",
    });
    expect(
      await domain.store.isCommittedFile(
        company(),
        join(company(), "updates", issue.id, `${update.update.id}.md`),
      ),
    ).toBe(true);

    const listed = (await domain.listIssues(user)).find(
      (item) => item.id === issue.id,
    )!;
    expect(listed.todos).toHaveLength(1);
    expect(listed.latest_update!.id).toBe(update.update.id);

    const workspace = await domain.workspace(supervisor, {
      agentId: supervisor.id,
    });
    const wsIssue = workspace.issues.find((item) => item.id === issue.id)!;
    expect(wsIssue.todos![0]!.text).toBe("persisted todo");
    expect(wsIssue.latest_update!.excerpt).toBe("persisted update body");

    const reopened = new CompanyDomain({
      root,
      provisionAgent: async (agent) => ({
        sessionId: `fixture-reopened-${agent.agentId}`,
      }),
    });
    const persisted = await reopened.getIssue(user, { issueId: issue.id });
    expect(persisted.todos![0]!.text).toBe("persisted todo");
    expect(persisted.latest_update!.id).toBe(update.update.id);
    expect(
      (await reopened.updates(user, { issueId: issue.id })).items[0]!.body,
    ).toBe("persisted update body");
  });

  test("requestId replay returns the original result without appending twice", async () => {
    const issue = await newIssue();
    const input = {
      issueId: issue.id,
      version: issue.version,
      changes: [{ op: "add", text: "idempotent todo" }],
      note: "idempotent note",
      requestId: "idempotent-todos",
    };
    const first = await domain.updateTodos(supervisor, input);
    const replay = await domain.updateTodos(supervisor, input);
    expect(replay.issue.version).toBe(first.issue.version);
    expect(replay.issue.todos).toEqual(first.issue.todos);
    expect(replay.update!.id).toBe(first.update!.id);
    expect(
      await domain.store.files(join(company(), "updates", issue.id)),
    ).toHaveLength(1);
    await expect(
      domain.updateTodos(supervisor, {
        ...input,
        changes: [{ op: "add", text: "different input" }],
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect((await current(issue.id)).todos).toHaveLength(1);
  });

  test("legacy Issues read as empty progress and malformed stored progress is invalid_document", async () => {
    const issue = await newIssue();
    const {
      todos: _todos,
      latest_update: _latest,
      todo_seq: _seq,
      ...legacy
    } = issue;
    const path = join(company(), "tasks", "legacy.md");
    await domain.store.putMarkdown(path, { ...legacy, id: "legacy" });
    const read = await domain.getIssue(user, { issueId: "legacy" });
    expect(read.todos).toEqual([]);
    expect(read.latest_update).toBeNull();
    expect(read.progress).toBe("");

    await domain.store.putMarkdown(path, {
      ...legacy,
      id: "legacy",
      todos: "not-an-array" as unknown as Issue["todos"],
    });
    await expect(
      domain.getIssue(user, { issueId: "legacy" }),
    ).rejects.toMatchObject({ code: "invalid_document", status: 500 });
    await unlink(path);
  });
});
