import { beforeAll, afterAll, describe, test, expect } from "bun:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createApplication } from "../src/server/app";
import { storeScopeId } from "../src/runtime/wasm-store";
import type { CallerContext, Issue } from "../src/domain";

const binary =
  process.env.PERI_BINARY ?? join(process.cwd(), ".tools/peri/peri");
const storesFile = process.env.COMPANY_TEST_INTEGRATION_STORES_FILE;
const enabled = process.platform === "linux" && existsSync(binary) && Boolean(storesFile);
if (!enabled)
  console.warn(
    "真实 WASM 集成套件 SKIP：需要 Linux bubblewrap、官方 Peri 和 COMPANY_TEST_INTEGRATION_STORES_FILE；为每个 Agent 预配独立专用空 sqld，套件不安装或启动 sqld。Domain doubles 不是 SDK 证据。",
  );
(enabled ? describe : describe.skip)(
  "Real single-server / SDK WASM / per-Agent local sqld / official Workspace bridge integration",
  () => {
    let application: Awaited<ReturnType<typeof createApplication>>,
      server: ReturnType<typeof Bun.serve>,
      root: string,
      base: string,
      cookie: string;
    let user: CallerContext,
      hr: CallerContext,
      supervisor: CallerContext,
      dev: CallerContext,
      preview: CallerContext;
    const requestId = () => crypto.randomUUID();
    async function api(path: string, body?: unknown) {
      const res = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: { cookie, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json();
      if (!res.ok)
        throw Object.assign(new Error(data.error?.message), data.error);
      return data;
    }
    async function call(
      module: string,
      operation: string,
      input: Record<string, unknown>,
      ctx = user,
    ) {
      const payload = { requestId: requestId(), ...input };
      if (ctx.type === "user")
        return api("/api/action", {
          module,
          operation,
          companyId: ctx.companyId,
          input: payload,
        });
      const args: any = { ...payload };
      if (args.version !== undefined) {
        args.expectedVersion = args.version;
        delete args.version;
      }
      const { data } = await mcp(ctx.id, module, "tools/call", {
        name: operation,
        arguments: args,
      });
      if (data.error)
        throw Object.assign(new Error(data.error.message), data.error);
      const result = JSON.parse(data.result.content[0].text);
      if (data.result.isError)
        throw Object.assign(new Error(result.error.message), result.error);
      return result;
    }
    async function mcp(
      agentId: string,
      module: string,
      method: string,
      params: Record<string, unknown> = {},
    ) {
      const a = await application.domain.getAgentInternal(agentId);
      const response = await fetch(`${base}/${module}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(params.name ? { "Mcp-Name": String(params.name) } : {}),
          ...(params.uri ? { "Mcp-Name": String(params.uri) } : {}),
          authorization: `Bearer ${a.authToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId(),
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "company-integration-test",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const data = await response.json();
      if (response.status !== 200) console.log("MCPFAIL", JSON.stringify(data));
      return { response, data };
    }
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "company-real-"));
      // Pick a kernel-assigned port before assembling the endpoint URLs.
      const reservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("reserved"),
      });
      const port = reservation.port;
      reservation.stop();
      base = `http://127.0.0.1:${port}`;
      application = await createApplication({
        root,
        baseUrl: base,
        periBinary: binary,
        storesFile,
        webToken: "integration-test-owner-only",
      });
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: application.app.fetch,
      });
      const boot = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "integration-test-owner-only" }),
      });
      cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
      const { company } = await api("/api/action", {
        module: "company_org",
        operation: "createCompany",
        input: {
          name: "Integration Company",
          requestId: "initialize",
        },
      });
      user = { type: "user", id: "owner", companyId: company.id };
      hr = { type: "agent", id: `${company.id}-hr`, companyId: company.id };
      supervisor = {
        type: "agent",
        id: `${company.id}-supervisor`,
        companyId: company.id,
      };
      dev = { type: "agent", id: "integrated-dev", companyId: company.id };
      preview = { type: "agent", id: "integrated-preview", companyId: company.id };
    }, 120000);
    afterAll(async () => {
      await application?.close();
      server?.stop();
      console.log(`Real integration artifacts: ${root}`);
    }, 30000);
    test("A01 real Sessions, HQ, tracked files and Git history", async () => {
      const org = await api(`/api/companies/${user.companyId}`);
      expect(org.groups[0].name).toBe("总部");
      expect(org.agents).toHaveLength(2);
      for (const a of org.agents) {
        expect(a.sessionId).toMatch(/^[0-9a-f-]{36}$/);
        const chat = await api(
          `/api/agents/${a.agentId}/chat?companyId=${user.companyId}`,
        );
        expect(chat.sessionId).toBe(a.sessionId);
        expect(chat.view.session).toBeTruthy();
        expect(
          (await application.domain.store.history(a.directory)).length,
        ).toBeGreaterThan(0);
        expect(
          await readFile(join(a.directory, ".gitignore"), "utf8"),
        ).not.toContain(".env");
      }
      expect(
        existsSync(join(root, "runtime/agents", hr.id, "sessions.db")),
      ).toBe(false);
      const identities = new Set<string>();
      for (const agent of org.agents) {
        const binding = JSON.parse(await readFile(join(root, "runtime", "wasm-stores", storeScopeId({ companyId: user.companyId, agentId: agent.agentId }) + ".json"), "utf8"));
        expect(binding.backend).toBe("wasm-sqld-v1");
        expect(binding.sessionId).toBe(agent.sessionId);
        expect(binding.state).toBe("bound");
        expect(binding.url).toBeUndefined();
        expect(binding.authToken).toBeUndefined();
        expect(binding.storeIdentity).toMatch(/^[a-f0-9]{64}$/);
        identities.add(binding.storeIdentity);
      }
      // 显式端点可独立，也可由宿主配置为同一共享端点；scope/session 绑定仍各自持久化。
      expect(identities.size).toBeGreaterThan(0);
    }, 30000);
    test("A02 authenticated HR creates one-department members via MCP, no user impersonation", async () => {
      let r = await mcp(hr.id, "company_org", "tools/call", {
        name: "createGroup",
        arguments: {
          id: "engineering",
          name: "工程部",
          requestId: requestId(),
        },
      });
      expect(r.response.status).toBe(200);
      expect(r.data.result.isError).not.toBe(true);
      for (const [ctx, role] of [
        [dev, "developer"],
        [preview, "preview"],
      ] as const) {
        r = await mcp(hr.id, "company_org", "tools/call", {
          name: "createMember",
          arguments: {
            agentId: ctx.id,
            name: role,
            groupId: "engineering",
            role,
            responsibilities: role,
            requestId: requestId(),
          },
        });
        expect(r.data.result.isError).not.toBe(true);
        expect(
          (await application.domain.getAgentInternal(ctx.id)).sessionId,
        ).toMatch(/^[0-9a-f-]{36}$/);
      }
      await expect(
        call("company_org", "createMember", {
          agentId: "impersonated",
          name: "Bad",
          groupId: "engineering",
          role: "developer",
          responsibilities: "Bad",
          caller: hr,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }, 30000);
    test("A03 saved config does not hot-load; restart preserves real Session and applies configuration", async () => {
      const old = await application.domain.getAgent(user, { agentId: dev.id });
      const saved = await api(`/api/agents/${dev.id}/configuration`, {
        companyId: user.companyId,
        configuration: {
          model: "changed-but-not-credentialed",
          responsibilities: "New explicit role guidance",
        },
        expectedVersion: old.version,
        requestId: requestId(),
      });
      expect(saved.pendingRestart).toBe(true);
      expect(saved.applied.model).not.toBe("changed-but-not-credentialed");
      await api(`/api/agents/${dev.id}/chat?companyId=${user.companyId}`);
      expect(
        (await application.domain.getAgent(user, { agentId: dev.id }))
          .effectiveConfig.model,
      ).not.toBe("changed-but-not-credentialed");
      const restarted = await api(`/api/agents/${dev.id}/restart`, {
        companyId: user.companyId,
      });
      expect(restarted.sessionId).toBe(old.sessionId);
      expect(
        (await application.domain.getAgent(user, { agentId: dev.id }))
          .effectiveConfig.model,
      ).toBe("changed-but-not-credentialed");
      const chats = await Promise.all(
        Array.from({ length: 5 }, () =>
          api(`/api/agents/${dev.id}/chat?companyId=${user.companyId}`),
        ),
      );
      expect(new Set(chats.map((x) => x.sessionId)).size).toBe(1);
    }, 30000);
    test("A04/05 user+supervisor create, role deny writes no file, comments and CAS persist", async () => {
      const one: any = await call("company_tasks", "createIssue", {
        title: "Independent one",
        body: "Initial body",
      });
      expect(one.agent_id).toBe(supervisor.id);
      expect(one.status).toBe("triage");
      const two = await mcp(supervisor.id, "company_tasks", "tools/call", {
        name: "createIssue",
        arguments: { title: "Independent two", requestId: requestId() },
      });
      expect(two.data.result.isError).not.toBe(true);
      const before = await readdir(join(root, "companys", user.companyId, "tasks"));
      const denied = await mcp(dev.id, "company_tasks", "tools/call", {
        name: "createIssue",
        arguments: {
          title: "Not authorized",
          role: "task-supervisor",
          requestId: requestId(),
        },
      });
      expect(denied.data.result.isError).toBe(true);
      expect(await readdir(join(root, "companys", user.companyId, "tasks"))).toEqual(
        before,
      );
      const comment: any = await call("company_tasks", "addComment", {
        issueId: "1",
        body: "**User comment**",
      });
      await call("company_tasks", "updateComment", {
        issueId: "1",
        commentId: comment.id,
        body: "Edited by original author",
        expectedVersion: comment.version,
      });
      expect(
        (await application.domain.getIssue(user, { issueId: "1" })).status,
      ).toBe("triage");
      await expect(
        call(
          "company_tasks",
          "updateComment",
          {
            issueId: "1",
            commentId: comment.id,
            body: "Steal",
            expectedVersion: 2,
          },
          supervisor,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(
        await readFile(
          join(root, "companys", user.companyId, "comments/1", comment.id + ".md"),
          "utf8",
        ),
      ).toContain("Edited by original author");
    });
    test("A07/08 same fixed Session for multiple Issues and exact question processing", async () => {
      for (const issueId of ["1", "2"]) {
        let i = await application.domain.getIssue(user, { issueId });
        await call(
          "company_tasks",
          "assignIssue",
          {
            issueId,
            agentId: dev.id,
            expectedVersion: i.version,
            reason: "Implement independent Issue",
            type: "software-change",
            pipeline: "software-delivery",
          },
          supervisor,
        );
      }
      let i = await application.domain.getIssue(dev, { issueId: "1" });
      i = (await call(
        "company_tasks",
        "askDecision",
        {
          issueId: "1",
          question: "Whole or partial?",
          expectedVersion: i.version,
        },
        dev,
      )) as Issue;
      i = (await call(
        "company_tasks",
        "askDecision",
        {
          issueId: "1",
          question: "Which currency?",
          expectedVersion: i.version,
        },
        dev,
      )) as Issue;
      i = (await call("company_tasks", "answerDecision", {
        issueId: "1",
        questionId: "1-Q1",
        answer: "Whole",
      })) as Issue;
      expect(i.needs_user).toBe(true);
      i = (await call(
        "company_tasks",
        "resolveDecision",
        { issueId: "1", questionId: "1-Q1", expectedVersion: i.version },
        dev,
      )) as Issue;
      expect(i.needs_user).toBe(true);
      expect(i.decisions[1]?.status).toBe("pending");
      const a = await application.domain.getAgent(user, { agentId: dev.id });
      expect(
        (await api(`/api/agents/${dev.id}/chat?companyId=${user.companyId}`))
          .sessionId,
      ).toBe(a.sessionId);
      expect(
        (await application.domain.workspace(user, { agentId: dev.id })).issues,
      ).toHaveLength(2);
    });
    test("A09 IM persisted, idempotent and failed delivery is not falsely delivered without model credentials", async () => {
      const args = {
        toAgentId: preview.id,
        text: "Please coordinate both Issues.",
        subject: "Preview coordination",
        requestId: requestId(),
      };
      const r = await mcp(dev.id, "company_im", "tools/call", {
        name: "ask",
        arguments: args,
      });
      expect(r.data.result.isError).not.toBe(true);
      const receipt = JSON.parse(r.data.result.content[0].text);
      expect(receipt.message.delivery_status).toBe("saved");
      const repeated = await mcp(dev.id, "company_im", "tools/call", {
        name: "ask",
        arguments: args,
      });
      expect(JSON.parse(repeated.data.result.content[0].text).messageId).toBe(
        receipt.messageId,
      );
      let thread = await application.domain.thread(user, {
        threadId: receipt.threadId,
      });
      const deadline = Date.now() + 15000;
      while (
        thread.items[0]?.delivery_status === "saved" &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
        thread = await application.domain.thread(user, {
          threadId: receipt.threadId,
        });
      }
      expect(thread.items[0]?.delivery_status).toBe("failed");
      expect(thread.items[0]?.delivery_error).toContain("PERI_MODEL");
      const reply = await mcp(preview.id, "company_im", "tools/call", {
        name: "reply",
        arguments: {
          threadId: receipt.threadId,
          messageId: receipt.messageId,
          text: "Noted by explicit authenticated test caller.",
          requestId: requestId(),
        },
      });
      expect(reply.data.result.isError).not.toBe(true);
      expect(
        (await application.domain.thread(user, { threadId: receipt.threadId }))
          .items,
      ).toHaveLength(2);
      expect((await application.domain.listIssues(user)).length).toBe(2);
    });
    test("A10/11 real default Workspace full tree, knowledge search, edit/diff/conflict and protected paths", async () => {
      const a = await application.domain.getAgent(user, { agentId: dev.id });
      await mkdir(join(a.directory, "node_modules"), { recursive: true });
      await writeFile(join(a.directory, "notes.md"), "before\n");
      await writeFile(
        join(root, "companys", user.companyId, "knowledgebase/policy.md"),
        "Knowledge-needle is a normal Markdown file.\n",
      );
      const prefix = `/api/agents/${dev.id}`;
      const tree = await api(prefix + `/files?companyId=${user.companyId}`);
      expect(tree.entries.some((x: any) => x.name === "node_modules")).toBe(
        true,
      );
      expect(tree.entries.some((x: any) => x.name === ".env")).toBe(true);
      let file = await api(
        prefix + `/files/read?companyId=${user.companyId}&path=notes.md`,
      );
      file = await api(prefix + "/files/save", {
        companyId: user.companyId,
        path: "notes.md",
        content: "after\n",
        expectedVersion: file.version,
      });
      expect(file.content).toBe("after\n");
      const diff = await api(
        prefix + `/files/diff?companyId=${user.companyId}&path=notes.md`,
      );
      expect(diff.modified).toBe("after\n");
      expect(diff.base).toBeTruthy();
      await writeFile(join(a.directory, "notes.md"), "external\n");
      await expect(
        api(prefix + "/files/save", {
          companyId: user.companyId,
          path: "notes.md",
          content: "unsaved draft",
          expectedVersion: file.version,
        }),
      ).rejects.toMatchObject({ code: "version_conflict" });
      expect(await readFile(join(a.directory, "notes.md"), "utf8")).toBe(
        "external\n",
      );
      const knowledge = await api(
        prefix +
          `/files/search?companyId=${user.companyId}&q=Knowledge-needle&path=` +
          encodeURIComponent(join(root, "companys", user.companyId, "knowledgebase")),
      );
      expect(JSON.stringify(knowledge)).toContain("Knowledge-needle");
      await symlink(
        join(a.directory, "agent.yaml"),
        join(a.directory, "identity-link.yaml"),
      );
      const identity = await api(
        prefix + `/files/read?companyId=${user.companyId}&path=identity-link.yaml`,
      );
      await expect(
        api(prefix + "/files/save", {
          companyId: user.companyId,
          path: "identity-link.yaml",
          content: "tamper",
          expectedVersion: identity.version,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        api(
          prefix +
            `/files/read?companyId=${user.companyId}&path=` +
            encodeURIComponent(join(root, "companys", user.companyId, "tasks/1.md")),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    }, 30000);
    test("A12/13 two independent real worktrees share Preview; exact-code user acceptance+CI+Review gate ready_merge", async () => {
      const repo = join(root, "projects/fixture");
      await mkdir(repo, { recursive: true });
      await writeFile(
        join(repo, "README.md"),
        "Acceptance fixture, not AI-generated output.\n",
      );
      await application.domain.store.commit(
        repo,
        "Initialize executable acceptance fixture",
      );
      const run = async (args: string[]) => {
        const p = Bun.spawn(["git", ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });
        if ((await p.exited) !== 0)
          throw new Error(await new Response(p.stderr).text());
        return (await new Response(p.stdout).text()).trim();
      };
      const refs: Record<string, string> = {};
      const check: Record<string, string[]> = {};
      for (const issueId of ["1", "2"]) {
        const worktree = join(root, "projects", `issue-${issueId}`);
        await run([
          "-C",
          repo,
          "worktree",
          "add",
          "-b",
          `issue-${issueId}`,
          worktree,
        ]);
        await writeFile(
          join(worktree, `feature-${issueId}.txt`),
          `Issue ${issueId}\n`,
        );
        await application.domain.store.commit(
          worktree,
          `Implement fixture Issue ${issueId}`,
        );
        refs[issueId] = await run(["-C", worktree, "rev-parse", "HEAD"]);
        const a = await application.domain.getAgent(user, { agentId: dev.id });
        const plan = join(a.directory, "tasks", issueId, "plan.md");
        await mkdir(join(plan, ".."), { recursive: true });
        await writeFile(
          plan,
          `# Plan ${issueId}\n\nVerify fixture output for Issue ${issueId}.\n`,
        );
        let issue = await application.domain.getIssue(user, { issueId });
        await call(
          "company_tasks",
          "updateIssue",
          {
            issueId,
            expectedVersion: issue.version,
            patch: {
              status: "ready_preview",
              plan_ref: plan,
              worktree,
              code_ref: refs[issueId],
            },
          },
          dev,
        );
        issue = await application.domain.getIssue(user, { issueId });
        await call(
          "company_tasks",
          "assignIssue",
          {
            issueId,
            expectedVersion: issue.version,
            agentId: preview.id,
            reason: "Joint preview",
            collaborators: [dev.id],
          },
          supervisor,
        );
        check[issueId] = [`Fixture Issue ${issueId} is reachable`];
      }
      // Build a REAL joint branch, not a static unrelated preview response.
      await run(["-C", repo, "checkout", "-b", "preview/joint"]);
      await run([
        "-C",
        repo,
        "merge",
        "--no-ff",
        "issue-1",
        "-m",
        "Integrate Issue 1",
      ]);
      await run([
        "-C",
        repo,
        "merge",
        "--no-ff",
        "issue-2",
        "-m",
        "Integrate Issue 2",
      ]);
      const integratedCommit = await run(["-C", repo, "rev-parse", "HEAD"]);
      refs["1"] = integratedCommit;
      refs["2"] = integratedCommit;
      const environment = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (req) => {
          const id = /^\/issue-([12])$/.exec(new URL(req.url).pathname)?.[1];
          return id
            ? new Response(
                await readFile(join(repo, `feature-${id}.txt`), "utf8"),
                { headers: { "X-Preview-Commit": integratedCommit } },
              )
            : new Response("Not found", { status: 404 });
        },
      });
      try {
        const environmentUrl = `http://127.0.0.1:${environment.port}`;
        expect(await (await fetch(environmentUrl + "/issue-1")).text()).toBe(
          "Issue 1\n",
        );
        expect(await (await fetch(environmentUrl + "/issue-2")).text()).toBe(
          "Issue 2\n",
        );
        let batch: any = await call(
          "company_tasks",
          "savePreview",
          {
            id: "joint",
            owner_id: preview.id,
            issue_ids: ["1", "2"],
            branch: "preview/joint",
            code_refs: refs,
            environment_url: environmentUrl,
            checklist: check,
          },
          preview,
        );
        const accepted: any = await call("company_tasks", "acceptPreview", {
          batchId: "joint",
          issueId: "1",
          version: batch.version,
          codeRef: refs["1"],
          passed: true,
          evidence:
            "HTTP fixture response verified; explicit test user acceptance",
        });
        batch = accepted.preview;
        expect(
          (await application.domain.getIssue(user, { issueId: "2" })).status,
        ).toBe("preview");
        let i = await application.domain.getIssue(user, { issueId: "1" });
        await expect(
          call(
            "company_tasks",
            "updateIssue",
            {
              issueId: "1",
              version: i.version,
              patch: { status: "ready_merge" },
            },
            preview,
          ),
        ).rejects.toMatchObject({ code: "missing_verification" });
        const ciSource = `import {readFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {strict as assert} from 'node:assert';assert.equal(readFileSync('feature-1.txt','utf8'),'Issue 1\\n');assert.equal(readFileSync('feature-2.txt','utf8'),'Issue 2\\n');assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),${JSON.stringify(integratedCommit)});console.log('Both integrated Issue outputs verified at '+${JSON.stringify(integratedCommit)});`;
        const ci = Bun.spawn([process.execPath, "-e", ciSource], {
          cwd: repo,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await ci.exited).toBe(0);
        const ciLog = await new Response(ci.stdout).text();
        const changedFiles = (
          await run(["-C", repo, "diff", "HEAD~2", "--name-only"])
        ).split("\n");
        expect(changedFiles).toContain("feature-1.txt");
        expect(changedFiles).toContain("feature-2.txt");
        const diffReview = await run([
          "-C",
          repo,
          "show",
          "--stat",
          integratedCommit,
        ]);
        expect(diffReview).toContain("feature-2.txt");
        for (const kind of ["ci", "review"]) {
          const result: any = await call(
            "company_tasks",
            "recordVerification",
            {
              batchId: "joint",
              issueId: "1",
              version: batch.version,
              codeRef: refs["1"],
              kind,
              passed: true,
              evidence:
                kind === "ci"
                  ? `Bun integrated artifact assertions exit 0: ${ciLog}`
                  : `Scripted fixture code review at ${integratedCommit}: git diff confirms only independent feature-1.txt/feature-2.txt changes; contents match each Issue. ${diffReview}. This is test evidence, not a human or model review.`,
            },
            preview,
          );
          batch = result.preview;
        }
        i = await application.domain.getIssue(user, { issueId: "1" });
        i = (await call(
          "company_tasks",
          "updateIssue",
          {
            issueId: "1",
            version: i.version,
            patch: { status: "ready_merge" },
          },
          preview,
        )) as Issue;
        expect(i.status).toBe("ready_merge");
        expect(
          (
            await application.domain.comments(user, { issueId: "1" })
          ).items.some((c) => c.body.includes("CI")),
        ).toBe(true);
      } finally {
        environment.stop();
      }
    }, 30000);
    test("A14 cancel preserves output and cannot revive; A15 actual MCP surface and security", async () => {
      let i = await application.domain.getIssue(user, { issueId: "2" });
      i = (await call(
        "company_tasks",
        "cancelIssue",
        { issueId: "2", version: i.version, reason: "User changed scope" },
        preview,
      )) as Issue;
      expect(i.worktree).toBeTruthy();
      await expect(
        call(
          "company_tasks",
          "updateIssue",
          { issueId: "2", version: i.version, patch: { status: "code" } },
          preview,
        ),
      ).rejects.toMatchObject({ code: "terminal_issue" });
      expect(application.mcp!.paths).toEqual([
        "/company_org/mcp",
        "/company_tasks/mcp",
        "/company_im/mcp",
      ]);
      const discovery = await mcp(hr.id, "company_org", "tools/list");
      expect(discovery.response.status).toBe(200);
      expect(
        discovery.data.result.tools.some((x: any) => x.name === "createMember"),
      ).toBe(true);
      const resources = await mcp(hr.id, "company_org", "resources/read", {
        uri: "company://current/company_org",
      });
      expect(resources.data.result.contents[0].text).not.toContain("authToken");
      const forged = await fetch(base + "/company_tasks/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: supervisor }),
      });
      expect(forged.status).toBe(401);
      const csrf = await fetch(base + "/api/action", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://attacker.invalid",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(csrf.status).toBe(403);
    });
    test("A04/A06 real HTTP user role grant, MCP allowed creation, parallel scoped read isolation", async () => {
      const org = await api(`/api/companies/${user.companyId}`);
      await call("company_org", "setRolePermissions", {
        role: "developer",
        permissions: ["issue.create"],
        expectedVersion: org.company.version,
      });
      const granted: any = await call(
        "company_tasks",
        "createIssue",
        { title: "Granted role creates through real MCP" },
        dev,
      );
      expect(granted.status).toBe("triage");
      expect(granted.agent_id).toBe(supervisor.id);
      const views = await Promise.all(
        [dev.id, supervisor.id, preview.id, hr.id, dev.id].map((agentId) =>
          api(`/api/agents/${agentId}/workspace?companyId=${user.companyId}`),
        ),
      );
      expect(views.map((v) => v.agentId)).toEqual([
        dev.id,
        supervisor.id,
        preview.id,
        hr.id,
        dev.id,
      ]);
      expect(views.every((v) => v.companyId === user.companyId)).toBe(true);
      const anonymous = await fetch(base + "/api/companies");
      expect(anonymous.status).toBe(401);
    });
    test("A15 actual MCP 0728 subscriptions stream resource invalidations after durable mutation", async () => {
      const a = await application.domain.getAgentInternal(supervisor.id);
      const controller = new AbortController();
      const method = "subscriptions/listen";
      const response = await fetch(`${base}/company_tasks/mcp`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          authorization: `Bearer ${a.authToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId(),
          method,
          params: {
            notifications: {
              resourceSubscriptions: ["company://current/company_tasks"],
            },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "company-subscription-test",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const reader = response.body!.getReader();
      let text = new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain("acknowledged");
      try {
        await call("company_tasks", "addComment", {
          issueId: "1",
          body: "Subscription evidence after file commit",
        });
        const deadline = Date.now() + 5000;
        while (
          !text.includes("notifications/resources/updated") &&
          Date.now() < deadline
        ) {
          const packet = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("MCP invalidation timed out")),
                5000,
              ),
            ),
          ]);
          text += new TextDecoder().decode(packet.value);
        }
        expect(text).toContain("notifications/resources/updated");
        expect(text).toContain("company://current/company_tasks");
      } finally {
        controller.abort();
        await reader.cancel().catch(() => {});
      }
    }, 10000);
  },
);
