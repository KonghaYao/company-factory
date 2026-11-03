import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

describe("Issue todos and comment snapshots", () => {
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
      "addComment",
      "updateComment",
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

  test("new Issues expose explicit empty todos and no legacy update projection", async () => {
    const issue = await newIssue();
    expect(issue.todos).toEqual([]);
    expect(issue).not.toHaveProperty("latest_update");
    const read = await current(issue.id);
    expect(read.todos).toEqual([]);
    expect(read).not.toHaveProperty("latest_update");
    expect(read.version).toBe(issue.version);
    expect(await domain.store.exists(join(company(), "updates"))).toBe(false);
  });

  test("todos add, update, reopen, reorder, remove and never reuse an id", async () => {
    const issue = await newIssue();
    const initialVersion = issue.version;
    let result = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: initialVersion,
      changes: [
        { op: "add", text: "First" },
        { op: "add", text: "Second", status: "in_progress" },
        { op: "add", text: "Third" },
      ],
      note: "Split the work into three steps.",
    });
    expect(result.issue.version).toBe(initialVersion + 1);
    expect(result.comment.id).toBe(`${issue.id}-C1`);
    expect(result.issue.todos!.map((item) => item.id)).toEqual([
      `${issue.id}-T1`,
      `${issue.id}-T2`,
      `${issue.id}-T3`,
    ]);
    expect(result.issue.todos![0]).toMatchObject({
      text: "First",
      status: "pending",
      created_by_type: "agent",
      created_by_id: supervisor.id,
      updated_by_type: "agent",
      updated_by_id: supervisor.id,
    });
    expect(result.issue.todos![0]!.created_at).toEqual(
      result.issue.todos![0]!.updated_at,
    );
    expect(result.issue.todos![1]!.status).toBe("in_progress");
    expect(result.issue.todos![2]).not.toHaveProperty("done_at");

    const secondId = result.issue.todos![1]!.id;
    result = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "update", todoId: secondId, status: "done" }],
      note: "Finished the second step.",
    });
    expect(result.issue.todos![1]!.status).toBe("done");
    expect(result.issue.todos![1]!.done_at).toBeTruthy();

    result = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "update", todoId: secondId, status: "pending" }],
      note: "Reopened the second step.",
    });
    expect(result.issue.todos![1]!.status).toBe("pending");
    expect(result.issue.todos![1]!.done_at).toBeUndefined();

    const ids = result.issue.todos!.map((item) => item.id);
    result = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: result.issue.version,
      order: [ids[2]!, ids[0]!, ids[1]!],
      note: "Reordered the steps.",
    });
    expect(result.issue.todos!.map((item) => item.id)).toEqual([
      ids[2]!,
      ids[0]!,
      ids[1]!,
    ]);

    result = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "update", todoId: ids[0]!, text: "First renamed" }],
      order: [ids[1]!, ids[0]!, ids[2]!],
      note: "Renamed and reordered the steps.",
    });
    expect(result.issue.todos!.map((item) => item.id)).toEqual([
      ids[1]!,
      ids[0]!,
      ids[2]!,
    ]);
    expect(result.issue.todos![1]!.text).toBe("First renamed");

    // Delete the highest id, then add again: the numeric suffix must not repeat.
    const removed = result.issue.todos!.find((item) => item.id === ids[2]!)!;
    result = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "remove", todoId: removed.id }],
      note: "Removed the last step.",
    });
    result = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: result.issue.version,
      changes: [{ op: "add", text: "Fourth" }],
      note: "Added a replacement step.",
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
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version,
        changes: Array.from({ length: 21 }, (_, i) => ({
          op: "add",
          text: `too many ${i}`,
        })),
        note: "Too many changes.",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version,
        changes: [{ op: "add", text: "x".repeat(501) }],
        note: "Text too long.",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version,
        changes: [{ op: "add", text: "line one\nline two" }],
        note: "Multiline text.",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version,
        changes: [{ op: "update", todoId: `${issue.id}-T999`, text: "nope" }],
        note: "Missing todo.",
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version,
        changes: [{ op: "remove", todoId: `${issue.id}-T999` }],
        note: "Missing todo.",
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version,
        changes: [{ op: "add", text: "only one" }],
        order: [`${issue.id}-T1`, `${issue.id}-T2`],
        note: "Stale order.",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version,
        note: "No changes.",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    for (const count of [20, 20, 10]) {
      const result = await domain.updateTodos(supervisor, {
        issueId: issue.id,
        version,
        changes: Array.from({ length: count }, (_, i) => ({
          op: "add",
          text: `item ${version}-${i}`,
        })),
        note: `Added ${count} items.`,
      });
      version = result.issue.version;
    }
    expect((await current(issue.id)).todos).toHaveLength(50);
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version,
        changes: [{ op: "add", text: "fifty first" }],
        note: "One too many.",
      }),
    ).rejects.toMatchObject({ code: "todo_limit", status: 400 });
    expect((await current(issue.id)).todos).toHaveLength(50);
  });

  test("version CAS serializes concurrent todo writes and skips the losing comment", async () => {
    const issue = await newIssue();
    const results = await Promise.allSettled([
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "concurrent A" }],
        note: "Concurrent A.",
        requestId: "concurrent-a",
      }),
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "concurrent B" }],
        note: "Concurrent B.",
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
    const comments = await domain.comments(user, { issueId: issue.id });
    expect(comments.items).toHaveLength(1);
    expect(comments.items[0]!.body).toMatch(/^Concurrent [AB]\.$/);
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "stale" }],
        note: "Stale.",
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  test("every Agent todo write requires a note and appends a snapshot comment", async () => {
    const issue = await newIssue();
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "no note" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      domain.updateTodos(supervisor, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "long note" }],
        note: "n".repeat(2001),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const note = "Added the first two steps and started the second.";
    const result = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: issue.version,
      changes: [
        { op: "add", text: "a" },
        { op: "add", text: "b", status: "in_progress" },
      ],
      note,
      kind: "blocker",
    });
    expect(result.comment).toMatchObject({
      id: `${issue.id}-C1`,
      issue_id: issue.id,
      author_type: "agent",
      author_id: supervisor.id,
      version: 1,
      body: note,
    });
    const expectedSnapshot = result.issue.todos!.map(({ id, text, status }) => ({
      id,
      text,
      status,
    }));
    expect(result.comment.todo_snapshot).toEqual(expectedSnapshot);
    expect(result.comment.todo_snapshot).toEqual([
      { id: `${issue.id}-T1`, text: "a", status: "pending" },
      { id: `${issue.id}-T2`, text: "b", status: "in_progress" },
    ]);

    const file = await domain.store.markdown(
      join(
        company(),
        "comments",
        issue.id,
        `${result.comment.id}.md`,
      ),
    );
    expect(file.body).toBe(note);
    expect(file.todo_snapshot).toEqual(expectedSnapshot);
    const comments = await domain.comments(supervisor, { issueId: issue.id });
    expect(comments.items).toHaveLength(1);
    expect(comments.items[0]!.body).toBe(note);
    expect(comments.items[0]!.todo_snapshot).toEqual(expectedSnapshot);
  });

  test("updateComment edits the body and preserves the todo snapshot", async () => {
    const issue = await newIssue();
    const created = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: issue.version,
      changes: [{ op: "add", text: "keep snapshot" }],
      note: "Original note.",
    });
    const edited = await domain.updateComment(supervisor, {
      issueId: issue.id,
      commentId: created.comment.id,
      version: created.comment.version,
      body: "Edited note.",
    });
    expect(edited.body).toBe("Edited note.");
    expect(edited.version).toBe(created.comment.version + 1);
    expect(edited.todo_snapshot).toEqual(created.comment.todo_snapshot);
    const comments = await domain.comments(user, { issueId: issue.id });
    expect(comments.items[0]!.body).toBe("Edited note.");
    expect(comments.items[0]!.todo_snapshot).toEqual(
      created.comment.todo_snapshot,
    );
  });

  test("only the current responsible Agent may change todos", async () => {
    const issue = await newIssue();
    await expect(
      domain.updateTodos(user, {
        issueId: issue.id,
        version: issue.version,
        changes: [{ op: "add", text: "user todo" }],
        note: "Users cannot write todos.",
      }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });

    const assigned = await domain.assignIssue(supervisor, {
      issueId: issue.id,
      version: issue.version,
      agentId: supervisor.id,
      collaborators: [hr.id],
    });
    await expect(
      domain.updateTodos(hr, {
        issueId: issue.id,
        version: assigned.version,
        changes: [{ op: "add", text: "collaborator todo" }],
        note: "Not the owner.",
      }),
    ).rejects.toMatchObject({ code: "not_current_owner", status: 403 });

    await domain.createMember(hr, {
      agentId: "archived-dev",
      name: "Archived Dev",
      groupId: "headquarters",
      role: "developer",
      responsibilities: "Fixture member",
    });
    const org = await domain.organization(user);
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
      domain.updateTodos(archived, {
        issueId: issue.id,
        version: assigned.version,
        changes: [{ op: "add", text: "archived todo" }],
        note: "Archived member.",
      }),
    ).rejects.toMatchObject({ code: "member_archived", status: 403 });

    const written = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: assigned.version,
      changes: [{ op: "add", text: "owner todo" }],
      note: "The owner writes.",
    });
    expect(written.issue.todos!.map((item) => item.text)).toEqual([
      "owner todo",
    ]);
    expect(
      (await domain.comments(hr, { issueId: issue.id })).items,
    ).toHaveLength(1);
  });

  test("canceled Issues reject todo changes but accept ordinary comments", async () => {
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
    expect(
      (await domain.comments(supervisor, { issueId: issue.id })).items,
    ).toHaveLength(0);

    const late = await domain.addComment(supervisor, {
      issueId: issue.id,
      body: "Post-cancel retrospective evidence.",
    });
    expect(late).not.toHaveProperty("todo_snapshot");
    const comments = await domain.comments(supervisor, { issueId: issue.id });
    expect(comments.items.map((item) => item.id)).toEqual([late.id]);
    expect(comments.items[0]!.body).toBe(
      "Post-cancel retrospective evidence.",
    );
    expect((await current(issue.id)).todos).toEqual([]);
  });

  test("listIssues, workspace, re-instantiation and Company Git keep todos and comments", async () => {
    const issue = await newIssue();
    const todo = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: issue.version,
      changes: [{ op: "add", text: "persisted todo" }],
      note: "persisted note",
    });
    expect(todo.comment.todo_snapshot![0]!.text).toBe("persisted todo");
    expect(
      await domain.store.isCommittedFile(
        company(),
        join(company(), "comments", issue.id, `${todo.comment.id}.md`),
      ),
    ).toBe(true);

    const listed = (await domain.listIssues(user)).find(
      (item) => item.id === issue.id,
    )!;
    expect(listed.todos).toHaveLength(1);
    expect(listed).not.toHaveProperty("latest_update");

    const workspace = await domain.workspace(supervisor, {
      agentId: supervisor.id,
    });
    const wsIssue = workspace.issues.find((item) => item.id === issue.id)!;
    expect(wsIssue.todos![0]!.text).toBe("persisted todo");

    const reopened = new CompanyDomain({
      root,
      provisionAgent: async (agent) => ({
        sessionId: `fixture-reopened-${agent.agentId}`,
      }),
    });
    const persisted = await reopened.getIssue(user, { issueId: issue.id });
    expect(persisted.todos![0]!.text).toBe("persisted todo");
    const comments = await reopened.comments(user, { issueId: issue.id });
    expect(comments.items[0]!.body).toBe("persisted note");
    expect(comments.items[0]!.todo_snapshot).toEqual([
      {
        id: `${issue.id}-T1`,
        text: "persisted todo",
        status: "pending",
      },
    ]);
  });

  test("requestId replay returns the original comment without appending twice", async () => {
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
    expect(replay.comment.id).toBe(first.comment.id);
    expect(
      await domain.store.files(join(company(), "comments", issue.id)),
    ).toHaveLength(1);
    await expect(
      domain.updateTodos(supervisor, {
        ...input,
        changes: [{ op: "add", text: "different input" }],
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect((await current(issue.id)).todos).toHaveLength(1);
  });

  test("legacy latest_update and old update files are ignored without migration", async () => {
    const issue = await newIssue();
    const {
      todos: _todos,
      todo_seq: _seq,
      ...legacy
    } = issue;
    const path = join(company(), "tasks", "legacy.md");
    await domain.store.putMarkdown(path, {
      ...legacy,
      id: "legacy",
      latest_update: {
        id: "legacy-U1",
        created_at: "2026-01-01T00:00:00.000Z",
        author_type: "agent",
        author_id: supervisor.id,
        kind: "progress",
        excerpt: "stale projection",
      },
    });
    const updateDir = join(company(), "updates", "legacy");
    await mkdir(updateDir, { recursive: true });
    await writeFile(join(updateDir, "legacy-U1.md"), "not a valid record");
    const read = await domain.getIssue(user, { issueId: "legacy" });
    expect(read.todos).toEqual([]);
    expect(read).not.toHaveProperty("latest_update");
    expect(read.progress).toBe("");
    expect(
      (await domain.store.markdown(path)).latest_update,
    ).toMatchObject({ id: "legacy-U1" });

    await domain.store.putMarkdown(path, {
      ...legacy,
      id: "legacy",
      todos: "not-an-array" as unknown as Issue["todos"],
    });
    await expect(
      domain.getIssue(user, { issueId: "legacy" }),
    ).rejects.toMatchObject({ code: "invalid_document", status: 500 });
  });
});
