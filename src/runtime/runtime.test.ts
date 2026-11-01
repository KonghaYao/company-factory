import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  link,
  rm,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxCommand } from "./sandbox";
import { PeriRuntime, WorkspaceViewAdapter, type RuntimeAgent, type StoreProvider } from "./index";
import { storeScopeId } from "./wasm-store";
import { createWorkspaceMcpServerFactory } from "./workspace";

const binary = process.env.PERI_BINARY ?? resolve(".tools/peri/peri");
// 用户预先提供专用空 sqld；测试不会安装、启动或复用默认共享数据库。
const sqldUrl = process.env.COMPANY_TEST_SQLD_URL;
const sqldToken = process.env.COMPANY_TEST_SQLD_TOKEN;
const storeProvider: StoreProvider = {
  async resolve() {
    if (!sqldUrl || !sqldToken) throw new Error("需要专用 COMPANY_TEST_SQLD_URL / COMPANY_TEST_SQLD_TOKEN");
    return { url: sqldUrl, authToken: sqldToken };
  },
};
const realRuntime = process.platform === "linux" && existsSync(binary) && sqldUrl && sqldToken ? describe : describe.skip;
realRuntime(
  "REAL SDK 0.3.0 WASM + local sqld + isolated official Peri 4.4.1 Workspace（非 live-model 验收）",
  () => {
    let root: string;
    let input: RuntimeAgent;
    let runtime: PeriRuntime;
    let workspace: WorkspaceViewAdapter;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "company-real-peri-"));
      const directory = join(root, "agents", "dev");
      const knowledgeDirectory = join(
        root,
        "companys",
        "acme",
        "knowledgebase",
      );
      await mkdir(directory, { recursive: true });
      await mkdir(knowledgeDirectory, { recursive: true });
      await writeFile(
        join(directory, "claude.md"),
        `# Developer\nKnowledge: ${knowledgeDirectory}\nUse Peri multitasks, and record observations before hypotheses.`,
      );
      await writeFile(join(directory, ".mcp.json"), '{"mcpServers":{}}\n');
      await writeFile(join(directory, "agent.yaml"), "agentId: dev\n");
      await writeFile(
        join(directory, ".env"),
        "# deliberately tracked\nEXAMPLE=1\n",
      );
      await writeFile(join(directory, "notes.txt"), "tracked notes v1\n");
      await mkdir(join(directory, "node_modules"));
      await writeFile(
        join(knowledgeDirectory, "domain.md"),
        "# Knowledge\nrefund-policy-unique: full refunds only\n",
      );
      spawnSync("git", ["init", directory]);
      spawnSync("git", ["-C", directory, "add", "-A"]);
      spawnSync("git", [
        "-C",
        directory,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "-m",
        "Initial memory",
      ]);
      input = {
        agentId: "dev",
        companyId: "acme",
        directory,
        knowledgeDirectory,
        config: { model: "no-provider-test", provider: "openai" },
      };
      runtime = new PeriRuntime({ root, periBinary: binary, storeProvider });
      workspace = new WorkspaceViewAdapter({
        periBinary: binary,
        home: join(root, "runtime", "home"),
      });
    });
    afterAll(async () => {
      await workspace?.shutdown();
      await runtime?.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    test("creates REAL WASM Session once, reuses it across Issues/restart and restores from the same local sqld", async () => {
      const [one, two] = await Promise.all([
        runtime.provision(input),
        runtime.provision(input),
      ]);
      expect(one.sessionId).toBe(two.sessionId);
      expect(one.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      input.sessionId = one.sessionId;
      const bindingPath = join(root, "runtime", "wasm-stores", storeScopeId(input) + ".json");
      const binding = JSON.parse(await readFile(bindingPath, "utf8"));
      expect(binding.backend).toBe("wasm-sqld-v1");
      expect(binding.sessionId).toBe(one.sessionId);
      expect(binding.state).toBe("bound");
      expect(JSON.stringify(binding)).not.toContain(sqldToken!);
      expect(existsSync(join(root, "runtime", "agents", input.agentId, "sessions.db"))).toBe(false);
      const effective = JSON.parse(await readFile(join(root, "runtime", "effective-config", "dev.json"), "utf8"));
      expect(effective.settings.config.meta_harness.WorkspaceMiddleware).toBe(false);
      expect(effective.mcpServers.workspace).toBeUndefined();
      expect(JSON.stringify(effective)).not.toContain(sqldToken!);
      expect((await runtime.database.getSession(one.sessionId))?.cwd).toBe(
        input.directory,
      );
      expect((await runtime.conversation(input)).view.readiness).toBe("ready");
      await runtime.restart({
        ...input,
        config: { ...input.config, model: "new-effective-model" },
      });
      expect(runtime.snapshot(input).sessionId).toBe(one.sessionId);
      expect(runtime.snapshot(input).busy).toBe(false);
      expect(runtime.snapshot(input).configured).toBe(false);
      await expect(
        runtime.send(input, {
          text: "This must NOT invoke a model",
          issueId: "1",
        }),
      ).rejects.toMatchObject({ code: "model_not_configured" });
      await runtime.shutdown();
      runtime = new PeriRuntime({ root, periBinary: binary, storeProvider });
      expect((await runtime.conversation(input)).sessionId).toBe(one.sessionId);
    }, 30000);
    test("REAL Peri send/delivery/view against clearly labelled LOCAL provider fixture (not live-model acceptance)", async () => {
      const requests: any[] = [];
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = await request.json();
          requests.push(body);
          const chunks = [
            {
              id: "local-fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "LOCAL_PROTOCOL_FIXTURE_REPLY",
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "local-fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
          ];
          return new Response(
            chunks
              .map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n")
              .join("") + "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      });
      process.env.COMPANY_TEST_FIXTURE_KEY = "not-a-real-key";
      const configured = {
        ...input,
        systemPrompt: "PER_AGENT_SYSTEM_PROMPT_SENTINEL",
        config: {
          provider: "openai",
          model: "fixture",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          apiKeyEnv: "COMPANY_TEST_FIXTURE_KEY",
          responsibilities: "NEW_APPLIED_ROLE_SENTINEL",
        },
      };
      try {
        await runtime.restart(configured);
        const one = await runtime.send(configured, {
          text: "Reply once for protocol verification.",
          issueId: "1",
          requestId: "local-send-once",
        });
        const duplicate = await runtime.send(configured, {
          text: "Reply once for protocol verification.",
          issueId: "1",
          requestId: "local-send-once",
        });
        expect(duplicate.inputId).toBe(one.inputId);
        const limit = Date.now() + 10000;
        let messages: any[] = [];
        while (Date.now() < limit) {
          messages = (await runtime.conversation(configured)).messages;
          if (
            messages.some((m) =>
              m.text.includes("LOCAL_PROTOCOL_FIXTURE_REPLY"),
            )
          )
            break;
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(
          messages.some((m) => m.text.includes("LOCAL_PROTOCOL_FIXTURE_REPLY")),
        ).toBe(true);
        expect(JSON.stringify(requests)).toContain("NEW_APPLIED_ROLE_SENTINEL");
        expect(JSON.stringify(requests)).toContain(
          "PER_AGENT_SYSTEM_PROMPT_SENTINEL",
        );
        expect(requests.length).toBe(1);
        expect(runtime.snapshot(configured).sessionId).toBe(input.sessionId!);
        const delivered = await runtime.deliver(configured, {
          threadId: "thread-local",
          messageId: "message-local",
          text: "A colleague asks a question.",
        });
        expect(delivered.status).toBe("delivered");
        expect(delivered.sessionId).toBe(input.sessionId!);
        await runtime.stop(configured);
      } finally {
        provider.stop(true);
        delete process.env.COMPANY_TEST_FIXTURE_KEY;
        await runtime.restart(input);
      }
    }, 30000);
    test("A03 trusted host model credentials stay frozen across cold wake; agent .env is ignored", async () => {
      const requests: { model: string; authorization: string | null }[] = [];
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body: any = await request.json();
          requests.push({
            model: body.model,
            authorization: request.headers.get("authorization"),
          });
          const text = "ENV_REPLY_" + body.model;
          const chunk = {
            id: crypto.randomUUID(),
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: text },
                finish_reason: null,
              },
            ],
          };
          const done = {
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          return new Response(
            "data: " +
              JSON.stringify(chunk) +
              "\n\ndata: " +
              JSON.stringify(done) +
              "\n\ndata: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      });
      const envPath = join(input.directory, ".env");
      const original = await readFile(envPath, "utf8");
      const configured = { ...input, config: { provider: "openai" } };
      const priorHost = {
        PERI_MODEL_API_KEY: process.env.PERI_MODEL_API_KEY,
        PERI_MODEL_ID: process.env.PERI_MODEL_ID,
        PERI_MODEL_BASE_URL: process.env.PERI_MODEL_BASE_URL,
      };
      const setHostEnv = (generation: string) => {
        process.env.PERI_MODEL_API_KEY = `host-${generation}-key`;
        process.env.PERI_MODEL_ID = `fixture-${generation}`;
        process.env.PERI_MODEL_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
      };
      const restoreHostEnv = () => {
        for (const [name, value] of Object.entries(priorHost))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      };
      const writeMaliciousAgentEnv = () =>
        writeFile(
          envPath,
          `PERI_MODEL_API_KEY=attacker-key\nPERI_MODEL_ID=attacker-model\nPERI_MODEL_BASE_URL=http://127.0.0.1:1/v1\n`,
        );
      const sendAndObserve = async (id: string) => {
        const before = requests.length;
        await runtime.send(configured, {
          text: "Return fixture response.",
          requestId: id,
        });
        const limit = Date.now() + 10000;
        while (
          Date.now() < limit &&
          (requests.length === before || runtime.snapshot(configured).busy)
        ) {
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(requests.length).toBe(before + 1);
      };
      try {
        setHostEnv("first");
        await runtime.restart(configured);
        await sendAndObserve("env-first");
        expect(requests.at(-1)).toEqual({
          model: "fixture-first",
          authorization: "Bearer host-first-key",
        });
        await writeMaliciousAgentEnv();
        await runtime.shutdown();
        runtime = new PeriRuntime({ root, periBinary: binary, storeProvider });
        expect(runtime.snapshot(input).configured).toBe(true);
        await sendAndObserve("env-cold-wake");
        expect(requests.at(-1)).toEqual({
          model: "fixture-first",
          authorization: "Bearer host-first-key",
        });
        // Explicit restart still ignores the Agent-writable `.env`: the host
        // environment is unchanged, so the snapshot must remain on generation one.
        await runtime.restart(configured);
        await sendAndObserve("env-restart-ignores-agent-env");
        expect(requests.at(-1)).toEqual({
          model: "fixture-first",
          authorization: "Bearer host-first-key",
        });
        setHostEnv("second");
        await runtime.restart(configured);
        await sendAndObserve("env-explicit-restart");
        expect(requests.at(-1)).toEqual({
          model: "fixture-second",
          authorization: "Bearer host-second-key",
        });
        const snapshot = join(root, "runtime", "effective-config", "dev.json");
        expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
      } finally {
        provider.stop(true);
        restoreHostEnv();
        await writeFile(envPath, original);
        await runtime.restart(input);
      }
    }, 30000);
    test("default Workspace includes hidden/dependency files; exact bytes, real Git diff and commit", async () => {
      const files = await workspace.list(input);
      expect(files.entries.map((e: any) => e.name)).toContain(".env");
      expect(files.entries.map((e: any) => e.name)).toContain("node_modules");
      const env = await workspace.read(input, ".env");
      expect(env.content).toBe("# deliberately tracked\nEXAMPLE=1\n");
      // 所有者文件视图不再限制根目录，`.env` 也可以直接编辑。
      const envSaved = await workspace.save(
        input,
        ".env",
        "# rewritten\n",
        env.version,
      );
      expect(envSaved.content).toBe("# rewritten\n");
      const original = await workspace.read(input, "notes.txt");
      expect(original.content).toBe("tracked notes v1\n");
      const saved = await workspace.save(
        input,
        "notes.txt",
        "tracked notes v2\n",
        original.version,
      );
      expect(await readFile(join(input.directory, "notes.txt"), "utf8")).toBe(
        saved.content,
      );
      const diff = await workspace.diff(input, "notes.txt");
      expect(diff.original).toBe(original.content);
      expect(diff.modified).toBe(saved.content);
      expect(diff.base).toMatch(/^[0-9a-f]{40}$/);
      expect(
        (
          await workspace.commit(
            input,
            "Update example through official Workspace",
          )
        ).commit,
      ).toMatch(/^[0-9a-f]{40}$/);
    }, 30000);
    test("creates new nested files exclusively and refuses a stale create over an existing file", async () => {
      const created = await workspace.save(
        input,
        "new/nested/note.md",
        "created through official Workspace\n",
        "",
      );
      expect(created.content).toBe("created through official Workspace\n");
      await expect(
        workspace.save(input, "new/nested/note.md", "overwrite", ""),
      ).rejects.toMatchObject({ code: "version_conflict" });
    }, 30000);
    test("stale drafts preserve external edits; symlinks and hardlinks follow the host filesystem", async () => {
      const old = await workspace.read(input, "notes.txt");
      await writeFile(join(input.directory, "notes.txt"), "EXTERNAL\n");
      await expect(
        workspace.save(input, "notes.txt", "UNSAVED DRAFT", old.version),
      ).rejects.toMatchObject({ code: "version_conflict" });
      expect(await readFile(join(input.directory, "notes.txt"), "utf8")).toBe(
        "EXTERNAL\n",
      );
      await symlink("agent.yaml", join(input.directory, "identity-link"));
      const identity = await workspace.read(input, "identity-link");
      expect(identity.path.endsWith("agent.yaml")).toBe(true);
      await link(
        join(input.directory, "claude.md"),
        join(input.directory, "hard-link"),
      );
      const linked = await workspace.read(input, "hard-link");
      const rewritten = await workspace.save(
        input,
        "hard-link",
        "CORRUPTED\n",
        linked.version,
      );
      expect(rewritten.content).toBe("CORRUPTED\n");
      const outside = await workspace.read(
        input,
        join(root, "runtime", "effective-config", "dev.json"),
      );
      expect(outside.content).toContain("settings");
    }, 30000);
    test("unrestricted Workspace view reads and writes host paths outside the Agent", async () => {
      const other = join(root, "agents", "other");
      await mkdir(other, { recursive: true });
      await writeFile(join(other, ".mcp.json"), "OTHER-AGENT-TOKEN");
      const source = join(root, "companys", "acme", "company.yaml");
      await writeFile(source, "id: acme\n");
      const read = await workspace.tool(input, "Read", {
        file_path: join(other, ".mcp.json"),
      });
      expect(read.text).toContain("OTHER-AGENT-TOKEN");
      await workspace.tool(input, "Write", {
        file_path: source,
        content: "REWRITTEN\n",
      });
      expect(await readFile(source, "utf8")).toBe("REWRITTEN\n");
      await workspace.tool(input, "Bash", {
        command: `printf BASH-WRITTEN > '${source}'`,
      });
      expect(await readFile(source, "utf8")).toBe("BASH-WRITTEN");
      const env = await workspace.tool(input, "Bash", { command: "env" });
      expect(env.text).not.toContain("COMPANY_WEB_TOKEN=");
    }, 30000);
    test("explicit external Git project roots work; system/Company roots fail closed", async () => {
      for (const bad of ["/proc", "/dev", "/etc", "/", root])
        expect(() =>
          sandboxCommand(binary, [], {
            directory: input.directory,
            projectRoots: [bad],
          }),
        ).toThrow();
      const project = await mkdtemp(join(tmpdir(), "company-project-"));
      spawnSync("git", ["init", project]);
      try {
        const scoped = { ...input, config: { workspaceRoots: [project] } };
        expect(
          workspace
            .roots(scoped)
            .some((r) => r.path === project && r.kind === "project"),
        ).toBe(true);
        const file = await workspace.save(
          scoped,
          join(project, "code.ts"),
          "export const result = 42;\n",
          "",
        );
        expect(file.content).toContain("42");
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    }, 30000);
    test("company knowledge is searched by actual default Grep, and larger editor files survive output pagination", async () => {
      const found = await workspace.search(
        input,
        "refund-policy-unique",
        input.knowledgeDirectory,
      );
      expect(found.text).toContain("refund-policy-unique");
      const content = "line with 中文 and a tab\t".repeat(1300) + "\n";
      await writeFile(join(input.directory, "large.txt"), content);
      expect((await workspace.read(input, "large.txt")).content).toBe(content);
      const capabilities: any = await workspace.capabilities(input);
      expect(capabilities.tools.map((x: any) => x.name)).toContain("Bash");
      expect(capabilities.tools.map((x: any) => x.name)).toContain("Grep");
    }, 30000);
  },
);

// 只覆盖工厂所有权声明；不 connect，不启动官方进程，不冒充桥接运行证据。
describe("官方 Workspace ACP 工厂的 activation 所有权", () => {
  test("每次产生可独立关闭的新实例，不借用浏览器连接", async () => {
    const factory = createWorkspaceMcpServerFactory({
      periBinary: binary,
      scope: { directory: "/unused-without-connect" },
    });
    const first = await factory(), second = await factory();
    expect(first).not.toBe(second);
    expect(typeof first.connect).toBe("function");
    expect(typeof first.close).toBe("function");
    await first.close!();
    await second.close!();
  });
});
