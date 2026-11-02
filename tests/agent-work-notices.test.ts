import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server/app";
import { AgentWorkNotices } from "../src/server/agent-work-notices";
import type { CallerContext } from "../src/domain";

describe("Company fact notices through the HTTP/MCP boundary", () => {
  let root: string,
    app: Awaited<ReturnType<typeof createApplication>>,
    cookie: string;
  let companyId: string, supervisorId: string, hrId: string;
  const deliveries: { agentId: string; text: string; requestId: string }[] = [];
  let fail: "none" | "not_sent" | "unknown" = "none";
  const origin = "http://127.0.0.1:3000";
  async function action(
    operation: string,
    input: Record<string, unknown>,
    module = "company_tasks",
  ) {
    const response = await app.app.request(origin + "/api/action", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ module, operation, companyId, input }),
    });
    const data = await response.json();
    expect(response.status).toBe(200);
    return data;
  }
  async function settled(id: string, agentId = supervisorId) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await app.app.request(
        `${origin}/api/agents/${agentId}/notices/${id}?companyId=${companyId}`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(200);
      const record = await response.json();
      if (record.status !== "saved") return record;
      await Bun.sleep(10);
    }
    throw new Error("notification did not settle");
  }
  async function mcp(agentId: string, name: string, args: object) {
    const agent = await app.domain.getAgentInternal(agentId);
    const response = await app.app.request(origin + "/company_tasks/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + agent.authToken,
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "fact-notice-test",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const wire = await response.json();
    expect(wire.result.isError).not.toBe(true);
    return JSON.parse(wire.result.content[0].text);
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-notice-contract-"));
    app = await createApplication({
      root,
      baseUrl: origin,
      webToken: "fixture-owner-token-for-notices",
    });
    spyOn(app.runtime, "provision").mockImplementation(async (agent) => ({
      sessionId: "fixture-" + agent.agentId,
    }));
    const commit = app.domain.store.commit.bind(app.domain.store);
    spyOn(app.domain.store, "commit").mockImplementation((dir, message) =>
      dir.startsWith(join(root, "agents") + "/")
        ? Promise.resolve()
        : commit(dir, message),
    );
    // Only SDK admission is a double. HTTP/MCP identity, domain, files and Company Git are real.
    spyOn(app.agents, "send").mockImplementation(
      async (_caller, agentId, input) => {
        deliveries.push({
          agentId,
          text: String(input.text),
          requestId: String(input.requestId),
        });
        if (fail === "not_sent")
          throw Object.assign(new Error("Fixture model is not configured"), {
            code: "model_not_configured",
          });
        if (fail === "unknown")
          throw Object.assign(new Error("Fixture admission is unconfirmed"), {
            code: "send_failed",
            details: { disposition: "unknown" },
          });
        return {
          accepted: true,
          mode: "prompt",
          inputId: "input-" + input.requestId,
          requestId: String(input.requestId),
          sessionId: "fixture-" + agentId,
        };
      },
    );
    const login = await app.app.request(origin + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "fixture-owner-token-for-notices" }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const org = await action(
      "createCompany",
      { name: "Autonomous fixture", requestId: "company" },
      "company_org",
    );
    companyId = org.company.id;
    supervisorId = org.agents.find(
      (a: any) => a.role === "task-supervisor",
    ).agentId;
    hrId = org.agents.find((a: any) => a.role === "hr").agentId;
  });
  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  test("creating and assigning notifies the fixed Agent without choosing its next stage", async () => {
    const input = {
      title: "Agent decides the method",
      body: "DO_NOT_COPY_BODY",
      requestId: "new-task",
    };
    const created = await action("createIssue", input);
    expect((await settled(created.notification.id)).status).toBe("accepted");
    expect(deliveries.at(-1)!.agentId).toBe(supervisorId);
    expect(deliveries.at(-1)!.text).toContain("Decide your own next action");
    expect(deliveries.at(-1)!.text).not.toContain("DO_NOT_COPY_BODY");
    const before = deliveries.length;
    const replay = await action("createIssue", input);
    expect(replay.notification.id).toBe(created.notification.id);
    expect(deliveries).toHaveLength(before);
    const assigned = await action("assignIssue", {
      issueId: created.id,
      agentId: hrId,
      version: created.version,
      reason: "HR chooses how to handle it",
      requestId: "assign-task",
    });
    expect((await settled(assigned.notification.id, hrId)).status).toBe(
      "accepted",
    );
    expect(deliveries.at(-1)!.agentId).toBe(hrId);
    expect(assigned.status).toBe("triage");
    expect(assigned.pipeline).toBeNull();
    expect(assigned.plan_ref).toBeNull();
    const current = await action("getIssue", { issueId: created.id });
    expect(current.version).toBe(assigned.version);
    expect(current.status).toBe("triage");
  });
  test("an Agent's own successful creation does not create a self-notification loop", async () => {
    const before = deliveries.length;
    const created = await mcp(supervisorId, "createIssue", {
      title: "self-created",
      requestId: "self-task",
    });
    expect(created.agent_id).toBe(supervisorId);
    expect(created.notification).toBeUndefined();
    expect(deliveries).toHaveLength(before);
  });
  test("known non-admission can be retried without repeating the business mutation", async () => {
    fail = "not_sent";
    const input = { title: "retry safely", requestId: "retry-task" };
    const created = await action("createIssue", input);
    expect((await settled(created.notification.id)).status).toBe("failed");
    fail = "none";
    const retry = await action("createIssue", input);
    const admission = await settled(retry.notification.id);
    expect(admission.status).toBe("accepted");
    expect(admission.error).toBeNull();
    expect(retry.id).toBe(created.id);
    expect(retry.version).toBe(created.version);
  });
  test("a real notification Git failure stays retryable without repeating the committed Issue", async () => {
    await app.domain.store.locked("company:" + companyId, async () => {});
    const input = {
      title: "Git blocks admission",
      requestId: "notice-git-failure",
    };
    const committed = await app.domain.createIssue(
      { type: "user", id: "owner", companyId },
      input,
    );
    // The business request is committed; a real Git index lock now prevents
    // notification persistence from completing after its YAML was written.
    const indexLock = join(
      app.domain.store.company(companyId),
      ".git/index.lock",
    );
    await writeFile(indexLock, "fixture blocks subsequent Git writes\n", {
      flag: "wx",
    });
    const before = deliveries.length;
    let created: any;
    try {
      created = await action("createIssue", input);
      expect(created.id).toBe(committed.id);
      expect(created.notification.status).toBe("failed");
      expect((await settled(created.notification.id)).status).toBe("failed");
      expect(deliveries).toHaveLength(before);
      const replay = await action("createIssue", input);
      expect(replay.notification.status).toBe("failed");
      expect(replay.id).toBe(created.id);
      expect(replay.version).toBe(created.version);
      expect(deliveries).toHaveLength(before);
    } finally {
      await rm(indexLock, { force: true });
    }
    const retry = await action("createIssue", input);
    expect((await settled(retry.notification.id)).status).toBe("accepted");
    expect(deliveries).toHaveLength(before + 1);
    expect(retry.id).toBe(created.id);
    expect(retry.version).toBe(created.version);
    const issues = await action("listIssues", {});
    expect(
      issues.filter((issue: any) => issue.title === input.title),
    ).toHaveLength(1);
  });
  test("owner retry is scoped, deduplicated, and publishes admission facts", async () => {
    const owner: CallerContext = { type: "user", id: "owner", companyId };
    const events: Record<string, unknown>[] = [];
    const notices = new AgentWorkNotices(app.domain, app.agents, (event) =>
      events.push(event),
    );
    const input = { title: "explicit retry", requestId: "explicit-retry" };
    const issue = await app.domain.createIssue(owner, input);
    try {
      fail = "not_sent";
      const notice = (await notices.afterOperation(
        owner,
        "createIssue",
        input,
        issue,
      ))!;
      await notices.close();
      expect(events.at(-1)).toMatchObject({
        id: notice.id,
        status: "failed",
        inputId: null,
      });
      expect(events.at(-1)!.error).toContain("not configured");
      await expect(
        notices.retry(
          { type: "agent", id: supervisorId, companyId },
          supervisorId,
          notice.id,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(notices.retry(owner, hrId, notice.id)).rejects.toMatchObject(
        { code: "forbidden" },
      );
      const other = await app.domain.createCompany(
        { type: "user", id: "owner", companyId: "" },
        { name: "Another notice scope", requestId: "other-notice-company" },
      );
      await expect(
        notices.retry(
          { ...owner, companyId: other.company.id },
          supervisorId,
          notice.id,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      fail = "none";
      const before = deliveries.length;
      const retries = await Promise.all([
        notices.retry(owner, supervisorId, notice.id),
        notices.retry(owner, supervisorId, notice.id),
      ]);
      expect(retries.every((record) => record.id === notice.id)).toBe(true);
      await notices.close();
      expect(deliveries).toHaveLength(before + 1);
      expect(events.at(-1)).toMatchObject({
        id: notice.id,
        status: "accepted",
        inputId: "input-" + notice.id,
        error: null,
      });
      const accepted = await notices.retry(owner, supervisorId, notice.id);
      expect(accepted.status).toBe("accepted");
      expect(deliveries).toHaveLength(before + 1);
      expect(
        (await app.domain.getIssue(owner, { issueId: issue.id })).version,
      ).toBe(issue.version);
    } finally {
      await notices.close();
      fail = "none";
    }
  });
  test("a failed pre-admission fact read remains safely retryable", async () => {
    const owner: CallerContext = { type: "user", id: "owner", companyId };
    const input = {
      title: "read fails before send",
      requestId: "notice-read-failure",
    };
    const issue = await app.domain.createIssue(owner, input);
    const notices = new AgentWorkNotices(app.domain, app.agents, () => {});
    const read = spyOn(app.domain, "getIssue").mockRejectedValueOnce(
      Object.assign(new Error("Fixture Issue read failed"), { code: "EIO" }),
    );
    const before = deliveries.length;
    let notice;
    try {
      notice = (await notices.afterOperation(
        owner,
        "createIssue",
        input,
        issue,
      ))!;
      await notices.close();
      expect((await settled(notice.id)).status).toBe("failed");
      expect(deliveries).toHaveLength(before);
    } finally {
      read.mockRestore();
      await notices.close();
    }
    await notices.retry(owner, supervisorId, notice.id);
    await notices.close();
    expect((await settled(notice.id)).status).toBe("accepted");
    expect(deliveries).toHaveLength(before + 1);
  });
  test("explicit retry refuses unknown admission and rechecks cancellation before sending", async () => {
    const owner: CallerContext = { type: "user", id: "owner", companyId };
    const notices = new AgentWorkNotices(app.domain, app.agents, () => {});
    try {
      fail = "unknown";
      const uncertainInput = {
        title: "unknown retry",
        requestId: "unknown-retry",
      };
      const uncertainIssue = await app.domain.createIssue(
        owner,
        uncertainInput,
      );
      const uncertain = (await notices.afterOperation(
        owner,
        "createIssue",
        uncertainInput,
        uncertainIssue,
      ))!;
      await notices.close();
      const before = deliveries.length;
      await expect(
        notices.retry(owner, supervisorId, uncertain.id),
      ).rejects.toMatchObject({
        code: "notice_not_retryable",
        status: 409,
      });
      expect(deliveries).toHaveLength(before);

      fail = "not_sent";
      const input = { title: "cancel before retry", requestId: "cancel-retry" };
      const issue = await app.domain.createIssue(owner, input);
      const notice = (await notices.afterOperation(
        owner,
        "createIssue",
        input,
        issue,
      ))!;
      await notices.close();
      await app.domain.cancelIssue(owner, {
        issueId: issue.id,
        version: issue.version,
        reason: "Work withdrawn",
        requestId: "cancel-notice",
      });
      fail = "none";
      const count = deliveries.length;
      await notices.retry(owner, supervisorId, notice.id);
      await notices.close();
      expect((await settled(notice.id)).status).toBe("skipped");
      expect(deliveries).toHaveLength(count);
      await expect(
        notices.retry(owner, supervisorId, notice.id),
      ).rejects.toMatchObject({
        code: "notice_not_retryable",
      });
    } finally {
      await notices.close();
      fail = "none";
    }
  });
  test("unknown admission is visible and never blindly retried", async () => {
    fail = "unknown";
    const input = { title: "inspect queue first", requestId: "uncertain-task" };
    const created = await action("createIssue", input);
    expect((await settled(created.notification.id)).status).toBe("unknown");
    const before = deliveries.length;
    fail = "none";
    const replay = await action("createIssue", input);
    expect(replay.notification.status).toBe("unknown");
    expect(deliveries).toHaveLength(before);
  });
  test("owner HTTP inspection and explicit retry expose final admission without repeating work", async () => {
    fail = "not_sent";
    const created = await action("createIssue", {
      title: "visible retry",
      requestId: "visible-retry",
    });
    const id = created.notification.id;
    const base = `${origin}/api/agents/${supervisorId}`;
    const query = `?companyId=${companyId}`;
    expect((await settled(id)).status).toBe("failed");
    const list = await app.app.request(`${base}/notices${query}`, {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    expect(
      (await list.json()).some(
        (notice: any) => notice.id === id && notice.status === "failed",
      ),
    ).toBe(true);
    const workspace = await app.app.request(`${base}/workspace${query}`, {
      headers: { cookie },
    });
    expect(workspace.status).toBe(200);
    expect(
      (await workspace.json()).notices.some((notice: any) => notice.id === id),
    ).toBe(true);
    const wrongAgent = await app.app.request(
      `${origin}/api/agents/${hrId}/notices/${id}${query}`,
      { headers: { cookie } },
    );
    expect(wrongAgent.status).toBe(404);
    expect((await app.app.request(`${base}/notices${query}`)).status).toBe(401);
    fail = "none";
    const count = deliveries.length;
    const retried = await app.app.request(
      `${base}/notices/${id}/retry${query}`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(retried.status).toBe(200);
    expect((await settled(id)).status).toBe("accepted");
    expect(deliveries).toHaveLength(count + 1);
    expect((await action("getIssue", { issueId: created.id })).version).toBe(
      created.version,
    );

    fail = "unknown";
    const uncertain = await action("createIssue", {
      title: "unknown through HTTP",
      requestId: "unknown-http",
    });
    expect((await settled(uncertain.notification.id)).status).toBe("unknown");
    const refused = await app.app.request(
      `${base}/notices/${uncertain.notification.id}/retry${query}`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("notice_not_retryable");
    fail = "none";
  });
  test("exact user answers use the same fact-notice path and do not resolve decisions", async () => {
    const created = await action("createIssue", {
      title: "decision task",
      requestId: "decision-task",
    });
    await settled(created.notification.id);
    const asked = await action("askDecision", {
      issueId: created.id,
      version: created.version,
      question: "Which target?",
      requestId: "ask-exact",
    });
    const answered = await action("answerDecision", {
      issueId: created.id,
      questionId: asked.decisions[0].id,
      answer: "The original target",
      requestId: "answer-exact",
    });
    expect((await settled(answered.notification.id)).status).toBe("accepted");
    expect(answered.decisions[0].status).toBe("pending");
    expect(answered.needs_user).toBe(true);
    expect(deliveries.at(-1)!.text).toContain(asked.decisions[0].id);
  });
  test("MCP lists use the bounded Agent projection; owner HTTP remains compatible", async () => {
    const page = await mcp(supervisorId, "listIssues", { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeString();
    expect(page.items[0]).not.toHaveProperty("body");
    const workspace = await mcp(supervisorId, "workspace", {});
    expect(workspace.profile.memory).toBe("CLAUDE.md");
    const ownerList = await action("listIssues", {});
    expect(Array.isArray(ownerList)).toBe(true);
    expect(ownerList[0]).toHaveProperty("body");
  });
});
