import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyDomain, type CallerContext, type Issue } from "./index";
import { AgentContextView, CONTEXT_PAGE_BYTES } from "./agent-context";
import { schemas } from "../server/operations";

describe("Agent context is a bounded index of current facts", () => {
  let root: string, domain: CompanyDomain, view: AgentContextView;
  let user: CallerContext, supervisor: CallerContext, hr: CallerContext;
  let unansweredThreadId: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-context-view-"));
    domain = new CompanyDomain({
      root,
      provisionAgent: async (a) => ({ sessionId: "fixture-" + a.agentId }),
    });
    const commit = domain.store.commit.bind(domain.store);
    spyOn(domain.store, "commit").mockImplementation((dir, message) =>
      dir.startsWith(join(root, "agents") + "/")
        ? Promise.resolve()
        : commit(dir, message),
    );
    const org = await domain.createCompany(
      { type: "user", id: "owner", companyId: "" },
      { name: "Context fixture", requestId: "create" },
    );
    user = { type: "user", id: "owner", companyId: org.company.id };
    supervisor = {
      type: "agent",
      id: org.agents.find((a) => a.role === "task-supervisor")!.agentId,
      companyId: user.companyId,
    };
    hr = {
      type: "agent",
      id: org.agents.find((a) => a.role === "hr")!.agentId,
      companyId: user.companyId,
    };
    const seed = await domain.createIssue(user, {
      title: "seed",
      requestId: "seed",
    });
    // File fixtures exercise the production reader. Mutations have independent
    // integration tests; 75 commits would not improve the pagination assertion.
    for (let i = 1; i <= 75; i++) {
      const issue: Issue = {
        ...seed,
        id: String(i),
        title: "中文标题".repeat(150),
        summary: "工作摘要".repeat(1000),
        progress: "进度".repeat(1000),
        status: i <= 65 ? "code" : "cancel",
        body: "FULL_BODY_SENTINEL " + "历史正文".repeat(4300),
      };
      await domain.store.putMarkdown(
        join(domain.store.company(user.companyId), "tasks", i + ".md"),
        issue,
      );
    }
    const asked = await domain.ask(supervisor, {
      recipientId: hr.id,
      subject: "Waiting for a colleague",
      body: "UNANSWERED_MESSAGE_SENTINEL",
      requestId: "outgoing-request",
    });
    unansweredThreadId = asked.threadId;
    const issue = await domain.getIssue(user, { issueId: "1" });
    await domain.updateIssue(user, {
      issueId: issue.id,
      version: issue.version,
      patch: { plan_ref: "plans/1.md", worktree: "worktrees/1" },
      requestId: "preview-deliverables",
    });
    // A second real batch replaces the Issue's only current Preview reference.
    // The first batch must remain discoverable through an Agent read surface.
    const oldPreview = await domain.savePreview(user, {
      id: "P1",
      owner_id: supervisor.id,
      issue_ids: [issue.id],
      branch: "preview/old",
      code_refs: { [issue.id]: "old-code" },
      environment_url: "https://preview.example.test/old",
      checklist: { [issue.id]: ["Show the result"] },
      body: "OLD_PREVIEW_BODY_SENTINEL",
      requestId: "old-preview",
    });
    await domain.savePreview(user, {
      ...oldPreview,
      id: "P2",
      version: 0,
      branch: "preview/current",
      code_refs: { [issue.id]: "current-code" },
      body: "CURRENT_PREVIEW_BODY_SENTINEL",
      requestId: "current-preview",
    });
    // Large Unicode/escaped summaries stress all three byte budgets together.
    for (let i = 3; i <= 45; i++) {
      await domain.store.putMarkdown(
        join(domain.store.company(user.companyId), "previews", `P${i}.md`),
        {
          ...oldPreview,
          id: `P${i}`,
          branch: "😀\u0001".repeat(200),
          body: "PREVIEW_HISTORY_SENTINEL " + "details ".repeat(1000),
        },
      );
    }
    for (let i = 2; i <= 45; i++) {
      await domain.store.putMarkdown(
        join(domain.store.company(user.companyId), "im", "threads", `T${i}.md`),
        {
          ...asked.thread,
          id: `T${i}`,
          subject: "😀\u0001".repeat(200),
          status: i % 2 ? "resolved" : "open",
          body: "THREAD_HISTORY_SENTINEL " + "details ".repeat(1000),
        },
      );
    }
    await domain.store.putMarkdown(
      join(domain.store.company(user.companyId), "im", "threads", "T46.md"),
      {
        ...asked.thread,
        id: "T46",
        asker_id: hr.id,
        recipient_id: "unrelated-agent",
      },
    );
    await domain.store.putMarkdown(
      join(domain.store.company(user.companyId), "previews", "P01.md"),
      { ...oldPreview, id: "P01" },
    );
    await domain.store.putMarkdown(
      join(domain.store.company(user.companyId), "previews", "P46.md"),
      { ...oldPreview, id: "P46", owner_id: hr.id },
    );
    view = new AgentContextView(domain);
  });
  afterAll(async () => rm(root, { recursive: true, force: true }));
  test("all current items are reachable across bounded pages, without historical bodies", async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await view.issues(supervisor, {
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      const text = JSON.stringify(page);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CONTEXT_PAGE_BYTES);
      expect(text).not.toContain("FULL_BODY_SENTINEL");
      ids.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(65);
    expect(new Set(ids).size).toBe(65);
    expect(ids[0]).toBe("1");
    expect(ids.at(-1)).toBe("65");
    const full = await domain.getIssue(supervisor, { issueId: "1" });
    expect(full.body).toContain("FULL_BODY_SENTINEL");
  });
  test("history and status are explicit, cursors cannot be reused across filters or Agents", async () => {
    const cancelled = await view.issues(supervisor, {
      status: ["cancel"],
      includeHistory: true,
    });
    expect(cancelled.items).toHaveLength(10);
    const first = await view.issues(supervisor, { limit: 1 });
    await expect(
      view.issues(supervisor, {
        cursor: first.nextCursor,
        includeHistory: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      view.issues(hr, { cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((await view.issues(hr)).items).toHaveLength(0);
  });
  test("empty identity cannot bypass the domain's Agent scope", async () => {
    await expect(domain.listIssues(hr, { agentId: "" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      domain.listIssues(hr, { agentId: supervisor.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await domain.listIssues(user)).length).toBe(75); // owner workbench compatibility
  });
  test("workspace exposes a bounded profile and lookup routes, not every historical body", async () => {
    const result = await view.workspace(supervisor, {
      agentId: supervisor.id,
      limit: 50,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      CONTEXT_PAGE_BYTES,
    );
    expect(result.nextCursor).not.toBeNull();
    expect(result.profile.memory).toBe("CLAUDE.md");
    expect(result).not.toHaveProperty("agent");
    expect(JSON.stringify(result)).not.toContain("FULL_BODY_SENTINEL");
  });
  test("an unanswered outgoing request remains discoverable without an inbox reply", async () => {
    expect((await domain.inbox(supervisor)).items).toHaveLength(0);
    const workspace = await view.workspace(supervisor, {});
    const thread = workspace.threads.find(
      (row) => row.id === unansweredThreadId,
    );
    expect(thread).toMatchObject({
      asker_id: supervisor.id,
      recipient_id: hr.id,
      status: "open",
      detail: { operation: "thread", threadId: unansweredThreadId },
    });
    const detail = await domain.thread(supervisor, thread!.detail);
    expect(detail.items[0].body).toBe("UNANSWERED_MESSAGE_SENTINEL");
    expect(JSON.stringify(workspace)).not.toContain(
      "UNANSWERED_MESSAGE_SENTINEL",
    );
  });
  test("historical Previews retain a discoverable detail entry after replacement", async () => {
    expect(
      (await domain.getIssue(supervisor, { issueId: "1" })).preview_batch,
    ).toBe("P2");
    const workspace = await view.workspace(supervisor, {});
    const old = workspace.previews.find((row) => row.id === "P1");
    expect(old).toMatchObject({
      owner_id: supervisor.id,
      issue_count: 1,
      detail: { operation: "getPreview", batchId: "P1" },
    });
    const detail = await domain.getPreview(supervisor, old!.detail);
    expect(detail.body).toBe("OLD_PREVIEW_BODY_SENTINEL");
    expect(JSON.stringify(workspace)).not.toContain(
      "OLD_PREVIEW_BODY_SENTINEL",
    );
  });
  test("independent cursors reach every visible thread and Preview within the combined byte budget", async () => {
    const threadIds: string[] = [];
    const previewIds: string[] = [];
    let threadCursor: string | undefined, previewCursor: string | undefined;
    let moreThreads = true,
      morePreviews = true;
    do {
      const result = await view.workspace(supervisor, {
        limit: 50,
        ...(threadCursor ? { threadCursor } : {}),
        ...(previewCursor ? { previewCursor } : {}),
      });
      const encoded = JSON.stringify(result);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(
        CONTEXT_PAGE_BYTES,
      );
      expect(result.issues.length).toBeGreaterThan(0);
      expect(encoded).not.toContain("FULL_BODY_SENTINEL");
      expect(encoded).not.toContain("THREAD_HISTORY_SENTINEL");
      expect(encoded).not.toContain("PREVIEW_HISTORY_SENTINEL");
      if (moreThreads) {
        threadIds.push(...result.threads.map((row) => row.id));
        threadCursor = result.nextThreadCursor ?? undefined;
        moreThreads = Boolean(threadCursor);
      }
      if (morePreviews) {
        previewIds.push(...result.previews.map((row) => row.id));
        previewCursor = result.nextPreviewCursor ?? undefined;
        morePreviews = Boolean(previewCursor);
      }
    } while (moreThreads || morePreviews);
    expect(threadIds).toEqual(
      Array.from({ length: 45 }, (_, i) => `T${i + 1}`),
    );
    expect(previewIds).toEqual([
      "P01",
      ...Array.from({ length: 45 }, (_, i) => `P${i + 1}`),
    ]);
  });
  test("workspace schema preserves separate cursors and rejects cross-index or cross-Agent reuse", async () => {
    const first = await view.workspace(supervisor, { limit: 1 });
    const input = schemas.workspace.parse({
      limit: 1,
      cursor: first.nextCursor,
      threadCursor: first.nextThreadCursor,
      previewCursor: first.nextPreviewCursor,
    }) as Record<string, unknown>;
    const second = await view.workspace(supervisor, input);
    expect(second.issues[0].id).toBe("2");
    expect(second.threads[0].id).toBe("T2");
    expect(first.previews[0].id).toBe("P01");
    expect(second.previews[0].id).toBe("P1");
    const issueOnly = await view.issues(supervisor, {
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(issueOnly.items).toEqual(second.issues);
    const threadsOnly = await view.workspace(supervisor, {
      limit: 1,
      threadCursor: first.nextThreadCursor,
    });
    expect(threadsOnly.issues[0].id).toBe("1");
    expect(threadsOnly.previews[0].id).toBe("P01");
    expect(threadsOnly.threads[0].id).toBe("T2");
    await expect(
      view.workspace(supervisor, { threadCursor: first.nextPreviewCursor }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      view.workspace(supervisor, { previewCursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      view.workspace(hr, { threadCursor: first.nextThreadCursor }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      view.workspace(hr, { previewCursor: first.nextPreviewCursor }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
  test("Issue summaries expose todo counts and a short latest-update excerpt only", async () => {
    const issue = await domain.getIssue(supervisor, { issueId: "1" });
    const note =
      "short progress ".repeat(20) + "UPDATE_FULL_BODY_SENTINEL";
    const updated = await domain.updateTodos(supervisor, {
      issueId: issue.id,
      version: issue.version,
      changes: [
        {
          op: "add",
          text: "TODO_FULL_TEXT_SENTINEL " + "work ".repeat(20),
        },
      ],
      note,
      requestId: "context-progress-summary",
    });
    expect(updated.issue.todos![0]!.status).toBe("pending");
    const page = await view.issues(supervisor, { limit: 50 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      CONTEXT_PAGE_BYTES,
    );
    const row = page.items.find((item) => item.id === issue.id)!;
    expect(row.todos).toEqual({ total: 1, done: 0, in_progress: 0 });
    expect(row.latest_update).toMatchObject({
      id: updated.update!.id,
      kind: "progress",
    });
    expect(row.latest_update!.excerpt).toContain("short progress");
    expect(row.latest_update!.excerpt.length).toBeLessThanOrEqual(180);
    const encoded = JSON.stringify(page);
    expect(encoded).not.toContain("TODO_FULL_TEXT_SENTINEL");
    expect(encoded).not.toContain("UPDATE_FULL_BODY_SENTINEL");
    // Full records remain reachable through getIssue.
    const full = await domain.getIssue(supervisor, { issueId: issue.id });
    expect(full.todos![0]!.text).toContain("TODO_FULL_TEXT_SENTINEL");
  });
});
