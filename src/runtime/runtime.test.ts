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
import { existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { PeriRuntime, WorkspaceViewAdapter, composeUserSendText, reconcileEffectiveConfiguration, writeEffectiveConfiguration, sharedSqldProviderFromEnv, type RuntimeAgent, type StoreProvider } from "./index";
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
const realRuntime = existsSync(binary) && sqldUrl && sqldToken ? describe : describe.skip;
const testModelLibrary = `version: 2
activeProfile: default
providers:
  host-openai:
    type: openai
    baseUrlEnv: COMPANY_TEST_MODEL_BASE_URL
    apiKeyEnv: COMPANY_TEST_MODEL_API_KEY
profiles:
  default:
    activeAlias: sonnet
    tiers:
      sonnet:
        provider: host-openai
        modelEnv: COMPANY_TEST_MODEL_ID
`;
describe("user send text stays free of host profile injection", () => {
  test("keeps the original text plus only this turn's Issue/reference metadata", () => {
    const plain = composeUserSendText({ text: "请只回复：prompt-clean" });
    expect(plain).toBe("请只回复：prompt-clean");
    const withMeta = composeUserSendText({
      text: "请只回复：prompt-clean",
      issueId: "issue-1",
      references: [{ path: "src/a.ts", start: 1 }],
    });
    expect(withMeta).toContain(
      "[Company Issue context: issue-1; same fixed Session]",
    );
    expect(withMeta).toContain("[File references]");
    expect(withMeta.endsWith("请只回复：prompt-clean")).toBe(true);
    expect(withMeta).not.toContain("[Company effective configuration");
    expect(withMeta).not.toContain("[Agent system prompt]");
    expect(withMeta).not.toContain("Role:");
  });
});
realRuntime(
  "REAL SDK 0.3.0 WASM + local sqld + isolated official Peri 4.4.1 Workspace（非 live-model 验收）",
  () => {
    let root: string;
    let input: RuntimeAgent;
    let runtime: PeriRuntime;
    let workspace: WorkspaceViewAdapter;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "company-real-peri-"));
      await writeFile(join(root, "model-library.yaml"), testModelLibrary, {
        mode: 0o600,
      });
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
        join(directory, "CLAUDE.md"),
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
        name: "Developer",
        role: "developer",
        responsibilities: "BASE_RESPONSIBILITIES_SENTINEL",
        systemPrompt: "PER_AGENT_SYSTEM_PROMPT_SENTINEL",
        config: { modelProfile: "default" },
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
        config: { ...input.config, modelAlias: "opus" },
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
      process.env.COMPANY_TEST_MODEL_BASE_URL =
        `http://127.0.0.1:${provider.port}/v1`;
      process.env.COMPANY_TEST_MODEL_API_KEY = "not-a-real-key";
      process.env.COMPANY_TEST_MODEL_ID = "fixture";
      const configured = {
        ...input,
        systemPrompt: "PER_AGENT_SYSTEM_PROMPT_SENTINEL",
        config: {
          modelProfile: "default",
          modelAlias: "sonnet",
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
        expect(JSON.stringify(requests)).not.toContain(
          "NEW_APPLIED_ROLE_SENTINEL",
        );
        expect(JSON.stringify(requests)).not.toContain(
          "PER_AGENT_SYSTEM_PROMPT_SENTINEL",
        );
        expect(JSON.stringify(requests)).not.toContain(
          "BASE_RESPONSIBILITIES_SENTINEL",
        );
        expect(JSON.stringify(requests)).not.toContain(
          "[Company effective configuration",
        );
        expect(JSON.stringify(requests)).not.toContain("[Agent system prompt]");
        expect(JSON.stringify(requests)).not.toContain("Role:");
        const sent = requests[0] as {
          messages?: { role?: string; content?: unknown }[];
        };
        const userMessage = [...(sent.messages ?? [])]
          .reverse()
          .find((message) => message.role === "user");
        expect(userMessage?.content).toBe(
          "[Company Issue context: 1; same fixed Session]\n\nReply once for protocol verification.",
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
        const imLimit = Date.now() + 5000;
        while (requests.length < 2 && Date.now() < imLimit)
          await new Promise((r) => setTimeout(r, 50));
        const imBody = requests[1] as
          | { messages?: { role?: string; content?: unknown }[] }
          | undefined;
        if (imBody) {
          const imMessage = [...(imBody.messages ?? [])]
            .reverse()
            .find((message) => message.role === "user");
          expect(imMessage?.content).toBe(
            "[Company IM thread-local/message-local]\nA colleague asks a question.",
          );
          expect(JSON.stringify(imBody)).not.toContain(
            "[Company effective configuration",
          );
        }
        await runtime.stop(configured);
      } finally {
        provider.stop(true);
        delete process.env.COMPANY_TEST_MODEL_BASE_URL;
        delete process.env.COMPANY_TEST_MODEL_API_KEY;
        delete process.env.COMPANY_TEST_MODEL_ID;
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
      const configured = { ...input, config: { modelProfile: "default" } };
      const priorHost = {
        COMPANY_TEST_MODEL_API_KEY: process.env.COMPANY_TEST_MODEL_API_KEY,
        COMPANY_TEST_MODEL_ID: process.env.COMPANY_TEST_MODEL_ID,
        COMPANY_TEST_MODEL_BASE_URL:
          process.env.COMPANY_TEST_MODEL_BASE_URL,
      };
      const setHostEnv = (generation: string) => {
        process.env.COMPANY_TEST_MODEL_API_KEY = `host-${generation}-key`;
        process.env.COMPANY_TEST_MODEL_ID = `fixture-${generation}`;
        process.env.COMPANY_TEST_MODEL_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
      };
      const restoreHostEnv = () => {
        for (const [name, value] of Object.entries(priorHost))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      };
      const writeMaliciousAgentEnv = () =>
        writeFile(
          envPath,
          `OPENAI_API_KEY=attacker-key\nOPENAI_DEFAULT_SONNET_MODEL=attacker-model\nOPENAI_BASE_URL=http://127.0.0.1:1/v1\n`,
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
        join(input.directory, "CLAUDE.md"),
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
    test("explicit external Git project roots work", async () => {
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
      directory: "/unused-without-connect",
    });
    const first = await factory(), second = await factory();
    expect(first).not.toBe(second);
    expect(typeof first.connect).toBe("function");
    expect(typeof first.close).toBe("function");
    await first.close!();
    await second.close!();
  });
});

describe("冻结快照重建辅助函数（不启动 SDK）", () => {
  const inputFor = (root: string): RuntimeAgent => ({
    agentId: "dev",
    companyId: "acme",
    directory: join(root, "agents", "dev"),
    knowledgeDirectory: join(root, "companys", "acme", "knowledgebase"),
    config: { modelProfile: "default" },
  });
  const prepare = async () => {
    const root = await mkdtemp(join(tmpdir(), "company-runtime-rebuild-"));
    const snapshotPath = join(
      root,
      "runtime",
      "effective-config",
      "dev.json",
    );
    await mkdir(join(root, "runtime", "effective-config"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(root, "model-library.yaml"), testModelLibrary, {
      mode: 0o600,
    });
    return { root, snapshotPath };
  };
  const withModelEnvironment = async (
    run: () => Promise<void>,
  ) => {
    const saved = { ...process.env };
    try {
      process.env.COMPANY_TEST_MODEL_BASE_URL = "https://unit.invalid/v1";
      process.env.COMPANY_TEST_MODEL_API_KEY = "unit-test-secret";
      process.env.COMPANY_TEST_MODEL_ID = "unit-model";
      await run();
    } finally {
      for (const key of [
        "COMPANY_TEST_MODEL_BASE_URL",
        "COMPANY_TEST_MODEL_API_KEY",
        "COMPANY_TEST_MODEL_ID",
      ])
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
  };

  test("legacy snapshot without model metadata is rewritten with 0600 and correct metadata", async () => {
    const { root, snapshotPath } = await prepare();
    const legacy = {
      settings: {
        config: {
          active_alias: "sonnet",
          providers: [
            {
              id: "company-model",
              type: "openai",
              apiKey: "not-configured-no-model-calls",
              baseUrl: "http://127.0.0.1:9/v1",
              models: { sonnet: "unconfigured" },
            },
          ],
        },
      },
      configured: false,
      mcpServers: {},
      configuration: { modelProfile: "default" },
    };
    await writeFile(snapshotPath, JSON.stringify(legacy));
    const runtime = new PeriRuntime({ root, periBinary: binary, storeProvider });
    try {
      await withModelEnvironment(async () => {
        // bind() computes its rebuild candidate through this same private resolver.
        const candidate = (runtime as any).settings(inputFor(root));
        const { effective, repaired } = reconcileEffectiveConfiguration(
          JSON.parse(await readFile(snapshotPath, "utf8")),
          candidate,
        );
        expect(repaired).toBe(true);
        await writeEffectiveConfiguration(snapshotPath, effective);

        const persisted = JSON.parse(await readFile(snapshotPath, "utf8"));
        expect(persisted.configured).toBe(true);
        expect(persisted.model).toMatchObject({
          source: "profile",
          profile: "default",
          activeAlias: "sonnet",
          provider: "host-openai",
          model: "unit-model",
          configured: true,
          error: null,
        });
        expect(persisted.configuration).toEqual({ modelProfile: "default" });
        expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600);
        // The snapshot carries host-only settings (including the credential), but
        // the non-secret model metadata must never include it.
        expect(JSON.stringify(persisted.model)).not.toContain(
          "unit-test-secret",
        );
      });
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a completed configured snapshot does not drift when the library changes", async () => {
    const { root, snapshotPath } = await prepare();
    const runtime = new PeriRuntime({ root, periBinary: binary, storeProvider });
    try {
      await withModelEnvironment(async () => {
        const input = inputFor(root);
        const first = (runtime as any).settings(input);
        const completed = {
          settings: first.settings,
          configured: true,
          mcpServers: {},
          configuration: { modelProfile: "default" },
          model: first.model,
        };
        await writeFile(snapshotPath, JSON.stringify(completed), {
          mode: 0o600,
        });
        const before = await readFile(snapshotPath, "utf8");

        process.env.COMPANY_TEST_MODEL_ID = "drifted-model";
        const changed = (runtime as any).settings(input);
        expect(changed.model.model).toBe("drifted-model");
        const result = reconcileEffectiveConfiguration(completed, changed);
        expect(result.repaired).toBe(false);
        expect(result.effective).toBe(completed);
        expect(await readFile(snapshotPath, "utf8")).toBe(before);
      });
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Locate an executable sqld for the isolated bind test; skip when unavailable. */
function findSqldBinary(): string | undefined {
  const explicit = process.env.COMPANY_SQLD_BINARY?.trim();
  if (explicit) return explicit;
  // The shared-sqld provider spawns with a minimal PATH, which a version-manager
  // shim cannot resolve; prefer a real installed binary when present.
  const installs = join(homedir(), ".local/share/mise/installs/http-sqld");
  try {
    for (const version of readdirSync(installs).sort().reverse()) {
      const candidate = join(installs, version, "sqld");
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  const which = Bun.which("sqld");
  if (!which) return undefined;
  const probe = spawnSync(which, ["--version"], {
    env: { PATH: "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir() },
    timeout: 5000,
  });
  return probe.status === 0 ? which : undefined;
}
const sqldBinary = findSqldBinary();
const bindRebuildSqld =
  process.platform !== "win32" && sqldBinary ? describe : describe.skip;

/**
 * These tests run the real `provision`/`wake` bind path against an isolated
 * disposable sqld under a temp COMPANY_HOME, with Workspace disabled. They are
 * not live-model tests and never touch `~/.company` or the shared sqld.
 */
bindRebuildSqld("bind 真正重建 legacy 快照（隔离 sqld，非 live）", () => {
  const envKeys = [
    "COMPANY_SQLD_BINARY",
    "COMPANY_SQLD_ROOT",
    "COMPANY_SQLD_PORT",
    "COMPANY_SQLD_START_TIMEOUT_MS",
    "COMPANY_WORKSPACE",
    "BIND_TEST_BASE",
    "BIND_TEST_KEY",
    "BIND_TEST_MODEL",
  ] as const;
  let base: string;
  let provider: NonNullable<ReturnType<typeof sharedSqldProviderFromEnv>>;
  const saved = new Map<string, string | undefined>();

  const prepare = async (root: string): Promise<RuntimeAgent> => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(
      join(root, "model-library.yaml"),
      `version: 2
activeProfile: default
providers:
  host-openai:
    type: openai
    baseUrlEnv: BIND_TEST_BASE
    apiKeyEnv: BIND_TEST_KEY
profiles:
  default:
    activeAlias: sonnet
    tiers:
      sonnet:
        provider: host-openai
        modelEnv: BIND_TEST_MODEL
`,
      { mode: 0o600 },
    );
    const directory = join(root, "agents", "dev");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "CLAUDE.md"), "# dev\n");
    return {
      agentId: "dev",
      companyId: "acme",
      directory,
      knowledgeDirectory: join(root, "companys", "acme", "knowledgebase"),
      name: "Developer",
      role: "developer",
      responsibilities: "BASE_RESPONSIBILITIES_SENTINEL",
      systemPrompt: "PER_AGENT_SYSTEM_PROMPT_SENTINEL",
      config: { modelProfile: "default" },
    };
  };
  const newRuntime = (root: string) =>
    new PeriRuntime({
      root,
      periBinary: "/nonexistent/peri",
      storeProvider: provider,
    });
  const snapshotPath = (root: string) =>
    join(root, "runtime", "effective-config", "dev.json");

  beforeAll(async () => {
    for (const key of envKeys) saved.set(key, process.env[key]);
    base = await mkdtemp(join(tmpdir(), "company-bind-rebuild-"));
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const value =
          typeof address === "object" && address ? address.port : 0;
        server.close(() => resolvePort(value));
      });
    });
    await mkdir(join(base, "host", "sqld", "shared"), {
      recursive: true,
      mode: 0o700,
    });
    process.env.COMPANY_SQLD_BINARY = sqldBinary!;
    process.env.COMPANY_SQLD_ROOT = join(base, "host");
    process.env.COMPANY_SQLD_PORT = String(port);
    process.env.COMPANY_SQLD_START_TIMEOUT_MS = "15000";
    process.env.COMPANY_WORKSPACE = "disabled";
    process.env.BIND_TEST_BASE = "https://unit.invalid/v1";
    process.env.BIND_TEST_KEY = "unit-bind-secret";
    process.env.BIND_TEST_MODEL = "unit-model";
    provider = sharedSqldProviderFromEnv()!;
    expect(provider).toBeDefined();
  });

  afterAll(async () => {
    try {
      await provider.close();
    } finally {
      for (const key of envKeys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (base) await rm(base, { recursive: true, force: true });
    }
  });

  test("legacy 快照在 wake/bind 后写回且 0600，元数据正确", async () => {
    const root = join(base, "legacy");
    const input = await prepare(root);
    let runtime: PeriRuntime | undefined;
    try {
      runtime = newRuntime(root);
      const { sessionId } = await runtime.provision(input);
      const path = snapshotPath(root);
      const provisioned = JSON.parse(await readFile(path, "utf8"));
      expect(provisioned.configured).toBe(true);
      expect(provisioned.model).toMatchObject({
        source: "profile",
        profile: "default",
        activeAlias: "sonnet",
        provider: "host-openai",
        model: "unit-model",
        configured: true,
        error: null,
      });
      await runtime.shutdown();
      runtime = undefined;

      // A snapshot from before the model library: no model metadata at all.
      await writeFile(
        path,
        JSON.stringify({
          settings: provisioned.settings,
          configured: false,
          mcpServers: {},
          configuration: { modelProfile: "default" },
        }),
        { mode: 0o600 },
      );
      runtime = newRuntime(root);
      await runtime.wake({ ...input, sessionId });

      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(persisted.configured).toBe(true);
      expect(persisted.model).toMatchObject({
        source: "profile",
        profile: "default",
        activeAlias: "sonnet",
        provider: "host-openai",
        model: "unit-model",
        configured: true,
        error: null,
      });
      expect(persisted.configuration).toEqual({ modelProfile: "default" });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      // The snapshot carries host-only settings, but the non-secret model
      // metadata must never include the credential value.
      expect(JSON.stringify(persisted.model)).not.toContain("unit-bind-secret");
    } finally {
      await runtime?.shutdown().catch(() => {});
    }
  });

  test("已完整快照在模型环境变化后不漂移", async () => {
    const root = join(base, "stable");
    const input = await prepare(root);
    let runtime: PeriRuntime | undefined;
    try {
      runtime = newRuntime(root);
      const { sessionId } = await runtime.provision(input);
      const path = snapshotPath(root);
      const before = await readFile(path, "utf8");
      await runtime.shutdown();
      runtime = undefined;

      process.env.BIND_TEST_MODEL = "drifted-model";
      runtime = newRuntime(root);
      const bound = await runtime.wake({ ...input, sessionId });
      expect(bound.model).toBe("unit-model");
      expect(await readFile(path, "utf8")).toBe(before);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      process.env.BIND_TEST_MODEL = "unit-model";
      await runtime?.shutdown().catch(() => {});
    }
  });

  test("系统提示词只在 Session 创建时冻结；后续发送保持干净", async () => {
    const root = join(base, "prompt-budget");
    const input = await prepare(root);
    const requests: any[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json();
        requests.push(body);
        const chunks = [
          {
            id: "isolated-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "ISOLATED_REPLY" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "isolated-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ];
        return new Response(
          chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") +
            "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const savedBase = process.env.BIND_TEST_BASE;
    const savedKey = process.env.BIND_TEST_KEY;
    const savedModel = process.env.BIND_TEST_MODEL;
    process.env.BIND_TEST_BASE = `http://127.0.0.1:${provider.port}/v1`;
    process.env.BIND_TEST_KEY = "unit-bind-secret";
    process.env.BIND_TEST_MODEL = "fixture";
    let runtime: PeriRuntime | undefined;
    const waitForRequest = async (count: number) => {
      const limit = Date.now() + 15000;
      while (requests.length < count && Date.now() < limit)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(requests.length).toBeGreaterThanOrEqual(count);
    };
    const userContent = (body: any) =>
      [...(body?.messages ?? [])]
        .reverse()
        .find((message: any) => message.role === "user")?.content;
    const systemContent = (body: any) =>
      (body?.messages ?? []).find((message: any) => message.role === "system")
        ?.content ?? "";
    // 每轮成功后 Peri 会额外发起 prediction 请求；它同样带 messages，
    // 不能按数组下标把它当成用户 prompt。
    const isPredictionRequest = (body: any) => {
      const wire = JSON.stringify(body ?? {});
      return wire.includes("请根据以上对话预测用户下一步输入")
        || wire.includes("<prediction_directive>")
        || wire.includes("预测输入助手");
    };
    const waitForUserRequest = async (text: string) => {
      const limit = Date.now() + 15000;
      while (Date.now() < limit) {
        const match = requests.find(
          (body) => !isPredictionRequest(body) && userContent(body) === text,
        );
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`request with user content ${text} was not observed`);
    };
    try {
      runtime = newRuntime(root);
      const { sessionId } = await runtime.provision(input);
      const configured = { ...input, sessionId };
      await runtime.send(configured, {
        text: "ISOLATED_FIRST_USER_SENTINEL",
        requestId: "isolated-first",
      });
      await waitForRequest(1);
      expect(systemContent(requests[0])).not.toContain(
        "BASE_RESPONSIBILITIES_SENTINEL",
      );
      expect(systemContent(requests[0])).not.toContain(
        "PER_AGENT_SYSTEM_PROMPT_SENTINEL",
      );
      expect(systemContent(requests[0])).toContain("CLAUDE.md");
      expect(systemContent(requests[0])).toContain("You decide how to decompose work");
      expect(JSON.stringify(requests[0])).not.toContain(
        "[Company effective configuration",
      );
      expect(JSON.stringify(requests[0])).not.toContain(
        "[Agent system prompt]",
      );
      expect(userContent(requests[0])).toBe("ISOLATED_FIRST_USER_SENTINEL");
      await runtime.stop(configured);

      await runtime.restart({
        ...configured,
        responsibilities: "NEW_APPLIED_RESPONSIBILITIES_SENTINEL",
        systemPrompt: "NEW_APPLIED_SYSTEM_PROMPT_SENTINEL",
      });
      expect(runtime.snapshot(configured).sessionId).toBe(sessionId);
      await runtime.send(configured, {
        text: "ISOLATED_SECOND_USER_SENTINEL",
        requestId: "isolated-second",
      });
      const secondRequest = await waitForUserRequest(
        "ISOLATED_SECOND_USER_SENTINEL",
      );
      expect(systemContent(secondRequest)).not.toContain(
        "BASE_RESPONSIBILITIES_SENTINEL",
      );
      expect(systemContent(secondRequest)).not.toContain(
        "PER_AGENT_SYSTEM_PROMPT_SENTINEL",
      );
      expect(JSON.stringify(secondRequest)).not.toContain(
        "NEW_APPLIED_RESPONSIBILITIES_SENTINEL",
      );
      expect(JSON.stringify(secondRequest)).not.toContain(
        "NEW_APPLIED_SYSTEM_PROMPT_SENTINEL",
      );
      expect(JSON.stringify(secondRequest)).not.toContain(
        "[Company effective configuration",
      );
      expect(userContent(secondRequest)).toBe("ISOLATED_SECOND_USER_SENTINEL");
      expect(runtime.snapshot(configured).sessionId).toBe(sessionId);
    } finally {
      provider.stop(true);
      if (savedBase === undefined) delete process.env.BIND_TEST_BASE;
      else process.env.BIND_TEST_BASE = savedBase;
      if (savedKey === undefined) delete process.env.BIND_TEST_KEY;
      else process.env.BIND_TEST_KEY = savedKey;
      if (savedModel === undefined) delete process.env.BIND_TEST_MODEL;
      else process.env.BIND_TEST_MODEL = savedModel;
      await runtime?.shutdown().catch(() => {});
    }
  }, 40000);
});

describe("已冻结的 effective-config 快照按模型库重算显示状态", () => {
  test("旧快照无模型元数据时 snapshot 用模型库重算并显示 configured:true", async () => {
    const root = await mkdtemp(join(tmpdir(), "company-runtime-state-"));
    const agentId = "dev";
    const directory = join(root, "runtime", "effective-config");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(root, "model-library.yaml"),
      `version: 2
activeProfile: default
providers:
  host-openai:
    type: openai
    baseUrlEnv: OPENAI_BASE_URL
    apiKeyEnv: OPENAI_API_KEY
profiles:
  default:
    activeAlias: sonnet
    tiers:
      sonnet:
        provider: host-openai
        modelEnv: OPENAI_DEFAULT_SONNET_MODEL
`,
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, `${agentId}.json`),
      JSON.stringify({
        settings: {
          config: {
            active_alias: "sonnet",
            providers: [
              {
                id: "company-model",
                type: "openai",
                apiKey: "not-configured-no-model-calls",
                baseUrl: "http://127.0.0.1:9/v1",
                models: {
                  fable: "unconfigured",
                  opus: "unconfigured",
                  sonnet: "unconfigured",
                  haiku: "unconfigured",
                },
              },
            ],
          },
        },
        configured: false,
        mcpServers: {},
        configuration: { modelProfile: "default", modelAlias: "sonnet" },
      }),
    );
    const savedEnvironment = { ...process.env };
    const scrubModelEnvironment = () => {
      for (const key of Object.keys(process.env))
        if (/^(?:OPENAI_|ANTHROPIC_|PERI_MODEL_)/.test(key))
          delete process.env[key];
    };
    const runtime = new PeriRuntime({
      root,
      periBinary: binary,
      storeProvider,
    });
    try {
      scrubModelEnvironment();
      expect(runtime.snapshot({ companyId: "acme", agentId }).configured).toBe(
        false,
      );

      process.env.OPENAI_API_KEY = "unit-test-openai-key";
      process.env.OPENAI_BASE_URL = "https://openai.invalid/v1";
      process.env.OPENAI_DEFAULT_SONNET_MODEL = "composer-2.5";

      const snapshot = runtime.snapshot({ companyId: "acme", agentId });
      expect(snapshot.configured).toBe(true);
      expect(snapshot.modelAlias).toBe("sonnet");
      expect(snapshot.model).toBe("composer-2.5");
      expect(snapshot.modelProfile).toBe("default");
      expect(snapshot.modelProvider).toBe("host-openai");
      expect(snapshot.modelError).toBeNull();
      expect(snapshot.modelLibraryRevision).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.modelTiers).toEqual({
        fable: "composer-2.5",
        opus: "composer-2.5",
        sonnet: "composer-2.5",
        haiku: "composer-2.5",
      });
      expect(snapshot.modelTierProviders).toEqual({
        fable: "host-openai",
        opus: "host-openai",
        sonnet: "host-openai",
        haiku: "host-openai",
      });
      expect(snapshot.modelTierSources).toEqual({
        fable: "fallback",
        opus: "fallback",
        sonnet: "bound",
        haiku: "fallback",
      });
      expect(snapshot.modelResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(snapshot.modelTierNotice).toBeNull();
      expect(JSON.stringify(snapshot)).not.toContain("unit-test-openai-key");
      expect(JSON.stringify(snapshot)).not.toContain(
        "https://openai.invalid/v1",
      );
      // Display-only projection: the frozen snapshot stays on disk.
      const persisted = JSON.parse(
        await readFile(join(directory, `${agentId}.json`), "utf8"),
      );
      expect(persisted.configured).toBe(false);
      expect(persisted.model).toBeUndefined();
    } finally {
      scrubModelEnvironment();
      Object.assign(process.env, savedEnvironment);
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("旧快照缺少 tierSources 时保留活动链路并提示，不重写快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "company-runtime-legacy-"));
    const agentId = "dev";
    const directory = join(root, "runtime", "effective-config");
    await mkdir(directory, { recursive: true });
    const legacyModel = {
      source: "profile",
      profile: "default",
      activeAlias: "sonnet",
      provider: "host-openai",
      model: "legacy-model",
      tiers: {
        fable: "legacy-model",
        opus: "legacy-model",
        sonnet: "legacy-model",
        haiku: "legacy-model",
      },
      tierProviders: {
        fable: "host-openai",
        opus: "host-openai",
        sonnet: "host-openai",
        haiku: "host-openai",
      },
      configured: true,
      missing: [],
      error: null,
      libraryRevision: "a".repeat(64),
      resolvedAt: "2026-01-02T03:04:05.000Z",
    };
    const snapshotPath = join(directory, `${agentId}.json`);
    await writeFile(
      snapshotPath,
      JSON.stringify({
        settings: {
          config: {
            active_alias: "sonnet",
            providers: [
              {
                id: "host-openai",
                type: "openai",
                apiKey: "unit-legacy-secret",
                baseUrl: "https://legacy.invalid/v1",
              },
            ],
            profiles: {},
          },
        },
        configured: true,
        mcpServers: {},
        configuration: { modelProfile: "default" },
        model: legacyModel,
      }),
    );
    const before = await readFile(snapshotPath, "utf8");
    const runtime = new PeriRuntime({ root, periBinary: binary, storeProvider });
    try {
      const snapshot = runtime.snapshot({ companyId: "acme", agentId });
      expect(snapshot.configured).toBe(true);
      expect(snapshot.modelAlias).toBe("sonnet");
      expect(snapshot.model).toBe("legacy-model");
      expect(snapshot.modelProfile).toBe("default");
      expect(snapshot.modelTiers).toBeNull();
      expect(snapshot.modelTierProviders).toBeNull();
      expect(snapshot.modelTierSources).toBeNull();
      expect(snapshot.modelTierNotice).toBe("重启后显示四档明细");
      expect(snapshot.modelResolvedAt).toBe("2026-01-02T03:04:05.000Z");
      expect(JSON.stringify(snapshot)).not.toContain("unit-legacy-secret");
      expect(JSON.stringify(snapshot)).not.toContain(
        "https://legacy.invalid/v1",
      );
      expect(await readFile(snapshotPath, "utf8")).toBe(before);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
