import {
  ChatActionError,
  ChatManager,
  ChatUserAction,
  ChatViewRegistry,
  BareHarnessConfig,
  type ChatService,
  type AcpMcpServer,
} from "@peri-code/sdk";
import { ChatReplica, type SessionView } from "@peri-code/sdk/view";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ProcessOwnershipStore } from "./session-store";
import {
  FileStoreProvider,
  WasmStoreDirectory,
  WasmStoreError,
  storeScopeId,
  type ScopedWasmStore,
  type StoreProvider,
} from "./wasm-store";
import { createAgentWasmModules } from "./wasm-runtime";
import { createWorkspaceMcpServerFactory } from "./workspace";
import {
  ModelConfigurationError,
  buildModelConfig,
  modelInfoFromSettings,
  resolveTrustedModelMatrix,
  type ModelTier,
} from "./model-settings";
export {
  DEFAULT_MODEL_ALIAS,
  MODEL_PLACEHOLDER_BASE_URL,
  MODEL_TIERS,
  ModelConfigurationError,
  buildModelConfig,
  modelInfoFromSettings,
  resolveModelMatrix,
  resolveTrustedModelMatrix,
  type ModelTier,
  type ResolvedModelMatrix,
} from "./model-settings";
export type { StoreProvider, StoreScope, WasmStoreConfiguration } from "./wasm-store";
export { FileStoreProvider } from "./wasm-store";
export {
  ExplicitFirstStoreProvider,
  SharedSqldProvider,
  sharedSqldProviderFromEnv,
} from "./local-sqld";
import { channelPair } from "./view-channel";
import { sandboxCommand } from "./sandbox";
export { WorkspaceViewAdapter } from "./workspace";
export interface RuntimeAgent {
  agentId: string;
  companyId: string;
  directory: string;
  knowledgeDirectory?: string;
  name?: string;
  role?: string;
  responsibilities?: string;
  systemPrompt?: string;
  groupId?: string;
  config?: Record<string, any>;
  configuration?: Record<string, any>;
  sessionId?: string;
}
interface EffectiveConfiguration {
  settings: unknown;
  configured: boolean;
  mcpServers: Record<string, AcpMcpServer>;
  configuration: Record<string, any>;
  role?: string;
  responsibilities?: string;
}
interface BoundAgent {
  input: RuntimeAgent;
  manager: InstanceType<typeof ChatManager>;
  chat: ChatService;
  replica: ChatReplica;
  configured: boolean;
  modelAlias: ModelTier | null;
  model: string | null;
  error?: string;
  nextCursor: string | null;
}
export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 503,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RuntimeError";
  }
}
/** SDK chat 动作码 → HTTP 状态；未知/内部错误一律 500，不得由状态反推 disposition。 */
const CHAT_ACTION_STATUS: Record<string, number> = {
  invalid_action: 400,
  busy: 409,
  binding_conflict: 409,
  not_ready: 409,
  closed: 503,
};
export function chatActionStatus(code: string): number {
  return CHAT_ACTION_STATUS[code] ?? 500;
}
/** 结构匹配 `{requestId, code, disposition}`，兼容多实例/多副本 SDK 抛出的同形错误。 */
function asChatActionError(error: unknown): ChatActionError | null {
  if (error instanceof ChatActionError) return error;
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    requestId?: unknown;
    code?: unknown;
    disposition?: unknown;
  };
  if (
    typeof candidate.requestId !== "string" ||
    typeof candidate.code !== "string" ||
    !["rejected", "unknown", "not_sent"].includes(String(candidate.disposition))
  )
    return null;
  return error as ChatActionError;
}
function causeCodeOf(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause as
    | { code?: unknown }
    | null
    | undefined;
  return typeof cause?.code === "string" && cause.code ? cause.code : undefined;
}
/** 诊断/透传前脱敏：去掉 URL 与 32+ 长 token，并限制长度。 */
export function redactRuntimeMessage(message: string, limit = 240): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const redacted = compact
    .replace(/https?:\/\/[^\s"'`]+/gi, "[url]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}
/**
 * SDK `ChatActionError` → `RuntimeError`：保留 code/disposition/requestId 与 causeCode，
 * 只把非秘密 details 交给 HTTP 层；cause 仅保留在内存，不序列化。
 */
export function toChatActionRuntimeError(
  error: unknown,
): RuntimeError | null {
  const action = asChatActionError(error);
  if (!action) return null;
  const details: Record<string, unknown> = {
    requestId: action.requestId,
    disposition: action.disposition,
  };
  const causeCode = causeCodeOf(error);
  if (causeCode) details.causeCode = causeCode;
  return new RuntimeError(
    action.code,
    redactRuntimeMessage(action.message),
    chatActionStatus(action.code),
    details,
    { cause: error },
  );
}
/** 控制动作失败：SDK 契约错误原样映射；其它异常使用动作码 + 500 + unknown。 */
export function chatControlFailure(
  error: unknown,
  fallback: { code: string; message: string },
): RuntimeError {
  const mapped = toChatActionRuntimeError(error);
  if (mapped) return mapped;
  const diagnostic =
    error instanceof Error
      ? `${error.name}${typeof (error as { code?: unknown }).code === "string" ? `/${(error as { code?: unknown }).code}` : ""}: ${error.message}`
      : String(error);
  console.warn(
    `[chat_control:${fallback.code}] ${redactRuntimeMessage(diagnostic)}`,
  );
  return new RuntimeError(
    fallback.code,
    fallback.message,
    500,
    { disposition: "unknown" },
    { cause: error },
  );
}
export class PeriRuntime {
  readonly binary: string;
  readonly database: WasmStoreDirectory;
  private machineId!: string;
  private managers = new Map<string, {
    manager: InstanceType<typeof ChatManager>;
    store: ScopedWasmStore;
    modules: ReturnType<typeof createAgentWasmModules>;
  }>();
  private accepting = true;
  private shutdownPromise?: Promise<void>;
  private storeLock: Promise<unknown> = Promise.resolve();
  private views = new ChatViewRegistry();
  private agents = new Map<string, BoundAgent>();
  private provisioned = new Map<
    string,
    { input: RuntimeAgent; sessionId: string }
  >();
  private locks = new Map<string, Promise<unknown>>();
  private deliveries = new Map<
    string,
    {
      fingerprint: string;
      result: Promise<{
        accepted: boolean;
        inputId: string;
        requestId: string;
        sessionId: string | null;
      }>;
    }
  >();
  private initialized: Promise<void>;
  constructor(
    private options: {
      root: string;
      periBinary?: string;
      storeProvider?: StoreProvider;
      storesFile?: string;
      privatePaths?: string[];
      onChange?: (scope: { companyId: string; agentId: string }) => void;
    },
  ) {
    this.binary =
      options.periBinary ??
      process.env.PERI_BINARY ??
      resolve(".tools/peri/peri");
    this.database = new WasmStoreDirectory({
      root: options.root,
      provider: options.storeProvider ?? new FileStoreProvider({
        root: options.root,
        file: options.storesFile ?? process.env.COMPANY_WASM_STORES_FILE,
      }),
    });
    this.initialized = this.initialize();
  }
  private async initialize() {
    const directory = join(this.options.root, "runtime");
    await mkdir(directory, { recursive: true });
    const machinePath = join(directory, "machine-id");
    const machineId = existsSync(machinePath)
      ? (await readFile(machinePath, "utf8")).trim()
      : randomUUID();
    if (!existsSync(machinePath))
      await writeFile(machinePath, machineId + "\n");
    this.machineId = machineId;
  }
  private async agentManager(input: RuntimeAgent, sessionId?: string) {
    // 串行登记 Manager，避免同进程内的并发 activation 替换与关闭竞争；不同 scope 可共用端点。
    const pending = this.storeLock.catch(() => {}).then(async () => {
      const store = await this.database.acquire({
        companyId: input.companyId,
        agentId: input.agentId,
        directory: input.directory,
        knowledgeDirectory: input.knowledgeDirectory,
        projectRoots: (input.configuration ?? input.config ?? {}).workspaceRoots,
      }, sessionId);
      const prior = this.managers.get(this.key(input));
      if (prior) {
        // 关闭 Manager 后再重新读取配置，允许凭据轮转，但不允许 endpoint 变化。
        let failed = false;
        try { await prior.manager.shutdown(); } catch { failed = true; }
        try { await prior.modules.close(); } catch { failed = true; }
        if (failed)
          throw new RuntimeError("wasm_cleanup_unconfirmed", "此前 Manager 或网络端口关闭未获确认；拒绝启动新 activation。");
        this.managers.delete(this.key(input));
      }
      const modules = createAgentWasmModules();
      const manager = new ChatManager({
        store: { storage: store.storage.storageConfig, machineId: this.machineId },
        database: store,
        kv: new ProcessOwnershipStore(),
        chatConfig: {
          runtime: {
            kind: "transport",
            // 公共 transport 分支只交回 agentConfig 快照；WASM 启动配置仍由它序列化。
            factory: (_path, transportOptions) => {
              const agentConfig = transportOptions?.agentConfig;
              if (agentConfig === undefined)
                throw new Error(
                  "WASM runtime requires a per-chat agentConfig snapshot",
                );
              return modules.startTransport({
                configJson: JSON.stringify(agentConfig),
                signal: transportOptions?.signal,
              });
            },
          },
        },
      });
      const entry = { manager, store, modules };
      this.managers.set(this.key(input), entry);
      return entry;
    });
    this.storeLock = pending;
    return pending;
  }
  private configurationPath(agentId: string) {
    return join(
      this.options.root,
      "runtime",
      "effective-config",
      agentId + ".json",
    );
  }
  private appliedRuntimeState(agentId: string) {
    const path = this.configurationPath(agentId);
    if (!existsSync(path))
      return {
        configured: false,
        modelAlias: null as ModelTier | null,
        model: null as string | null,
      };
    const snapshot = JSON.parse(
      readFileSync(path, "utf8"),
    ) as EffectiveConfiguration;
    return {
      configured: Boolean(snapshot.configured),
      ...modelInfoFromSettings(snapshot.settings),
    };
  }
  private key(input: { companyId: string; agentId: string }) {
    return `${input.companyId}/${input.agentId}`;
  }
  private async serialized<T>(
    input: { companyId: string; agentId: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.accepting)
      throw new RuntimeError("runtime_closing", "运行时已停止接收操作，请等待关闭完成。");
    const key = this.key(input);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  private settings(input: RuntimeAgent) {
    const config = input.configuration ?? input.config ?? {};
    // Model selection is a whitelisted matrix. Arbitrary config.settings is reserved
    // and must never be spread into PeriConfig. Only the trusted host process
    // environment is read; an Agent-writable `<agent>/.env` is never merged here.
    const matrix = resolveTrustedModelMatrix({
      config,
      hostEnvironment: process.env,
    });
    const settings = {
      config: {
        ...buildModelConfig(matrix),
        meta_harness: {
          ...BareHarnessConfig,
          "01_intro": true,
          "03_doing_tasks": true,
          "05_using_tools": true,
          "11_subagent": true,
          "12_ask_user": true,
          "13_skills": true,
          DefaultSystemPromptMiddleware: true,
          TodoMiddleware: true,
          PermissionMiddleware: true,
          HumanInTheLoopMiddleware: true,
          SubAgentMiddleware: true,
          McpMiddleware: true,
          WorkspaceMiddleware: false,
          SkillsMiddleware: true,
          ToolSearch: true,
          BuiltInSubagents: true,
        },
      },
    };
    return { settings, configured: matrix.configured };
  }
  private async bind(
    input: RuntimeAgent,
    sessionId?: string,
    refreshConfiguration = false,
  ) {
    await this.initialized;
    // 磁盘上的可信绑定优先于调用方可能过期的 sessionId；acquire 仍按绑定严格校验。
    const boundSessionId = await this.database.boundSessionId(input);
    const existing = this.agents.get(this.key(input));
    if (existing) {
      if (existing.error)
        throw new RuntimeError("wasm_cleanup_unconfirmed", "此前 activation 关闭未确认；必须先显式重启或 shutdown 完成资源回收。");
      const expectedSessionId = boundSessionId ?? sessionId;
      if (expectedSessionId && existing.chat.sessionId !== expectedSessionId)
        throw new RuntimeError("wasm_session_binding_mismatch", "活动 Session 与请求绑定不同。");
      return existing;
    }
    const { manager, store } = await this.agentManager(input, boundSessionId ?? sessionId);
    const targetSessionId = store.sessionId ?? sessionId;
    const staleSessionId = store.sessionId;
    const runtimeDirectory = join(
      this.options.root, "runtime", "workspace", storeScopeId(input),
    );
    await mkdir(join(runtimeDirectory, "home"), { recursive: true, mode: 0o700 });
    const memory = await readFile(join(input.directory, "claude.md"), "utf8");
    const snapshotPath = this.configurationPath(input.agentId);
    let effective: EffectiveConfiguration;
    let repairedConfiguration = false;
    if (!refreshConfiguration) {
      if (!targetSessionId)
        throw new RuntimeError("missing_session", "Agent 没有可信固定 Session；普通 wake 不创建会话。");
      if (!existsSync(snapshotPath))
        throw new RuntimeError(
          "missing_effective_configuration",
          "Applied runtime settings snapshot is missing; explicitly restart this Agent to assemble current settings.",
        );
      effective = JSON.parse(await readFile(snapshotPath, "utf8"));
      // 快照在模型环境可用前冻结时 Agent 永久不可用。仅在这种情况下用同一受信
      // 宿主环境重算模型矩阵（不读 <agent>/.env、不重读 .mcp.json），并像显式
      // 重启一样写回快照；快照本来可用时绝不自动漂移。
      if (!effective.configured) {
        const candidate = this.settings(input);
        if (candidate.configured) {
          effective = { ...effective, settings: candidate.settings, configured: true };
          repairedConfiguration = true;
        }
      }
    } else {
      let file: { mcpServers?: Record<string, AcpMcpServer> } = {};
      try {
        file = JSON.parse(
          await readFile(join(input.directory, ".mcp.json"), "utf8"),
        );
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      // The Agent-writable `.env` is intentionally NOT read for model settings.
      // Model provider/base URL/API key/model IDs come from the trusted host
      // environment (and user-owned agent.yaml config) only. Reading the file here
      // would let an Agent redirect the host credential to an arbitrary endpoint on
      // the next explicit restart. The sandbox also mounts this file read-only.
      const provider = this.settings(input);
      const configuration = structuredClone(
        input.configuration ?? input.config ?? {},
      );
      for (const [name, descriptor] of Object.entries(
        configuration.mcp ?? {},
      )) {
        if (
          ["company_org", "company_tasks", "company_im", "workspace"].includes(
            name,
          )
        )
          continue;
        const server = descriptor as any;
        if (server && typeof server === "object")
          (file.mcpServers ??= {})[name] = server.type
            ? server
            : { type: server.command ? "stdio" : "http", ...server };
      }
      effective = {
        ...provider,
        mcpServers: file.mcpServers ?? {},
        configuration,
        ...(input.role ? { role: input.role } : {}),
        ...(input.responsibilities
          ? { responsibilities: input.responsibilities }
          : {}),
      };
    }
    // Workspace 工厂仅注入当前 activation，不进入 JSON 配置快照。
    const settings = structuredClone(effective.settings) as any;
    if (!settings?.config || typeof settings.config !== "object")
      throw new RuntimeError("invalid_effective_configuration", "已生效 settings 格式无效；请显式重启 Agent。");
    settings.config.meta_harness = {
      ...settings.config.meta_harness,
      WorkspaceMiddleware: false,
    };
    effective.settings = settings;
    const configured = effective.configured;
    const modelInfo = modelInfoFromSettings(effective.settings);
    const mcpServers = { ...effective.mcpServers };
    if (Object.hasOwn(mcpServers, "workspace"))
      throw new RuntimeError("reserved_mcp_server", "workspace 是宿主保留 MCP 名称，不能通过 .mcp.json 替换。");
    for (const descriptor of Object.values(mcpServers)) {
      if (!descriptor || descriptor.type !== "http")
        throw new RuntimeError("wasm_mcp_transport_unsupported", "SDK 0.3.0 WASM 只接受外部 HTTP MCP；任意 stdio/SSE/ACP 描述符不会被静默忽略或直接 spawn。只有宿主官方 Workspace 使用独立桥。");
    }
    const appliedInput = {
      ...input,
      configuration: effective.configuration,
      role: effective.role,
      responsibilities: effective.responsibilities,
    };
    // 显式降级：仅关闭宿主 Workspace MCP；File/Git 仍由 fail-closed 沙箱决定。
    const workspaceEnabled = process.env.COMPANY_WORKSPACE !== "disabled";
    if (workspaceEnabled && !existsSync(this.binary) && this.binary.includes("/"))
      throw new RuntimeError("peri_not_installed", "官方 Peri 4.4.1 Workspace 二进制未配置；WASM 不回退 native ACP。");
    const scope = {
      directory: input.directory,
      companyHome: this.options.root,
      knowledgeDirectory: input.knowledgeDirectory,
      runtimeDirectory,
      projectRoots: effective.configuration.workspaceRoots,
      privatePaths: [
        this.options.storesFile ?? process.env.COMPANY_WASM_STORES_FILE,
        ...(this.options.privatePaths ?? []),
      ].filter((path): path is string => Boolean(path)),
    };
    // 这里只构造隔离参数；非 Linux / 缺少 bwrap 时，在创建 Session 前 fail closed。
    if (workspaceEnabled)
      sandboxCommand(this.binary, ["mcp-start", "workspace", "--stdio", "--workspace", input.directory], scope);
    // 绑定仍可信但当前本地 sqld 已丢失该 Session（例如库重建）时，为同一 Agent
    // 创建新的固定 Session 并更新绑定；端点身份与 scope/cwd 校验不放宽。
    let resumeSessionId = targetSessionId;
    if (targetSessionId && !(await store.getSession(targetSessionId))) {
      console.warn(
        `[wasm_session_recovered] ${input.companyId}/${input.agentId}: bound session is absent in the current local sqld; creating a replacement session.`,
      );
      resumeSessionId = undefined;
    }
    const chat = manager.createChat({
      workspace: {
        id: input.agentId,
        hostPath: input.directory,
        runtimePath: input.directory,
      },
      agent: { settings },
      session: {
        instructions: `${memory}\n\nInitial effective responsibilities: ${(input.configuration ?? input.config ?? {}).responsibilities ?? input.responsibilities ?? ""}\n${(input.configuration ?? input.config ?? {}).instructions ?? ""}\nThe host supplies current effective role context and the per-Agent system prompt with every new input; earlier role definitions are historical after an explicit restart.\n\nCompany member: ${input.agentId}; company: ${input.companyId}.\nKeep this one fixed Session across all Issues. Use Peri multitasks for concurrent work, not new Company members. Company business records must be changed with company_org/company_tasks/company_im, not filesystem writes.`,
        mcpServers: {
          ...mcpServers,
          ...(workspaceEnabled
            ? {
                workspace: {
                  type: "acp",
                  server: createWorkspaceMcpServerFactory({
                    periBinary: this.binary,
                    scope,
                    env: { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8" },
                  }),
                },
              }
            : {}),
        },
      },
    });
    const replica = new ChatReplica();
    const view = this.views.attach(chat);
    const [server, client] = channelPair();
    view.sync(server);
    replica.connect(client);
    const bound: BoundAgent = {
      input: structuredClone(appliedInput),
      manager,
      chat,
      replica,
      configured,
      modelAlias: modelInfo.modelAlias,
      model: modelInfo.model,
      nextCursor: null,
    };
    const observe = (envelope: any) => {
      if (envelope.fact?.kind === "history-page")
        bound.nextCursor = envelope.fact.nextCursor;
      else if (envelope.fact?.kind === "seed-config") {
        const value = envelope.fact.response;
        bound.nextCursor =
          typeof value?.nextCursor === "string" && value.nextCursor
            ? value.nextCursor
            : null;
      }
    };
    chat.subscribeFacts({
      onBinding: (_binding, replay) => replay.forEach(observe),
      onFact: observe,
      onClosed: () => {},
    });
    replica.subscribe(() => this.options.onChange?.(input));
    try {
      if (resumeSessionId) {
        await chat.execute(ChatUserAction.changeSessionTo(resumeSessionId));
        if (chat.sessionId !== resumeSessionId)
          throw new RuntimeError("wasm_session_binding_mismatch", "SDK 未恢复原 Session，拒绝替代绑定。");
      } else if (staleSessionId) {
        // 绑定存在但旧 Session 已不在当前库：直接创建替代 Session 并原子替换绑定，
        // 不走 beginCreation（已有绑定会被拒绝）。
        await chat.execute(
          ChatUserAction.createNewSession({
            title: input.name || input.agentId,
          }),
        );
        await store.replaceBinding(staleSessionId, chat.sessionId!);
      } else {
        await store.beginCreation();
        await chat.execute(
          ChatUserAction.createNewSession({
            title: input.name || input.agentId,
          }),
        );
        await store.bindSession(chat.sessionId!);
      }
      if (refreshConfiguration || repairedConfiguration) {
        await mkdir(resolve(snapshotPath, ".."), {
          recursive: true,
          mode: 0o700,
        });
        const temporary = snapshotPath + "." + randomUUID() + ".tmp";
        await writeFile(temporary, JSON.stringify(effective) + "\n", {
          mode: 0o600,
        });
        await rename(temporary, snapshotPath);
      }
      this.agents.set(this.key(input), bound);
      return bound;
    } catch (e) {
      // 即使关闭失败，也保留 handle 供 shutdown 重试；不把未确认清理算成功。
      bound.error = "WASM activation 未完成；需要显式关闭并恢复原绑定。";
      this.agents.set(this.key(input), bound);
      try {
        await this.closeBound(bound);
        this.agents.delete(this.key(input));
      } catch {
        throw new RuntimeError("wasm_cleanup_unconfirmed", "WASM/Workspace 关闭未确认；保留原 Session 与 Manager，需先完成关闭，禁止自动替代。");
      }
      if (
        e instanceof RuntimeError ||
        e instanceof WasmStoreError ||
        e instanceof ModelConfigurationError
      )
        throw e;
      // bind 阶段的 SDK chat 动作错误（如 binding_conflict）同样不得被折叠。
      const action = toChatActionRuntimeError(e);
      if (action) throw action;
      throw new RuntimeError("wasm_activation_failed", "WASM Session 激活失败；请检查本地 sqld、模型与 MCP 配置。未回退 native ACP，未自动替换 Session。");
    }
  }
  private async closeBound(bound: BoundAgent) {
    try {
      await bound.manager.closeChat(bound.chat.id);
      const results = await Promise.allSettled([
        this.views.dispose(bound.chat.id), bound.replica.dispose(),
      ]);
      if (results.some((result) => result.status === "rejected")) throw new Error();
    } catch {
      bound.error = "WASM/Workspace/view 关闭未获确认；保留 handle 供重试。";
      throw new RuntimeError("wasm_cleanup_unconfirmed", bound.error);
    }
  }
  async provision(input: RuntimeAgent) {
    return this.serialized(input, async () => {
      const prior = this.provisioned.get(this.key(input));
      if (prior) {
        if (input.sessionId && input.sessionId !== prior.sessionId)
          throw new RuntimeError("wasm_session_binding_mismatch", "provision 请求与已完成 Session 绑定不同。");
        const active = this.agents.get(this.key(input));
        if (active?.error)
          throw new RuntimeError("wasm_cleanup_unconfirmed", "已有 activation 关闭未确认，不能将 provision 重试报告为成功。");
        if (!active) {
          const { store } = await this.agentManager(input, prior.sessionId);
          if (!(await store.getSession(prior.sessionId)))
            throw new RuntimeError("wasm_session_missing", "已完成 provision 的原 Session 不存在或 cwd 不匹配；拒绝自动重建。");
        }
        return { sessionId: prior.sessionId };
      }
      const bound = await this.bind(input, input.sessionId, true);
      const sessionId = bound.chat.sessionId!;
      // 先持久化可信 binding，再关闭初次 activation；领域幂等重试恢复同一 Session。
      await this.closeBound(bound);
      this.agents.delete(this.key(input));
      this.provisioned.set(this.key(input), {
        input: structuredClone(input),
        sessionId,
      });
      return { sessionId };
    });
  }
  async wake(input: RuntimeAgent) {
    return this.serialized(input, async () => {
      if (
        !input.sessionId &&
        !this.agents.has(this.key(input)) &&
        !this.provisioned.has(this.key(input))
      )
        throw new RuntimeError(
          "missing_session",
          "Agent has no persisted Session binding.",
        );
      return this.bind(
        input,
        input.sessionId ?? this.provisioned.get(this.key(input))?.sessionId,
      );
    });
  }
  async restart(input: RuntimeAgent) {
    return this.serialized(input, async () => {
      const existing = this.agents.get(this.key(input));
      const sessionId = existing?.chat.sessionId ?? input.sessionId;
      if (!sessionId)
        throw new RuntimeError(
          "missing_session",
          "Cannot restart without a fixed Session binding.",
        );
      if (existing) {
        await this.closeBound(existing);
        this.agents.delete(this.key(input));
      }
      await this.bind(input, sessionId, true);
      return this.snapshot(input);
    });
  }
  snapshot(input: { companyId: string; agentId: string; sessionId?: string }) {
    const bound = this.agents.get(this.key(input));
    const view = bound?.replica.read();
    const applied = bound ? null : this.appliedRuntimeState(input.agentId);
    const activeTurn =
      view?.turns.find((turn) => turn.turnId === view.activeTurnId) ?? null;
    return this.database.redact({
      companyId: input.companyId,
      agentId: input.agentId,
      sessionId:
        bound?.chat.sessionId ??
        input.sessionId ??
        this.provisioned.get(this.key(input))?.sessionId ??
        null,
      // 旧派生字段：仅为兼容既有前端保留；恢复判断请用下方契约事实。
      busy: Boolean(
        view?.running ||
        view?.tasks.some((t) => ["running", "in_progress"].includes(t.status)),
      ),
      status: view?.activeTurnStatus ?? "idle",
      // 契约事实（只读）：区分运行中/被阻止/已关闭/未同步，并保留 turn 停止原因。
      running: Boolean(view?.running),
      executionBlocked: Boolean(view?.executionBlocked),
      closed: Boolean(view?.closed),
      closedReason: view?.closedReason ?? null,
      readiness: view?.readiness ?? "not-ready",
      activeTurn: activeTurn
        ? {
            turnId: activeTurn.turnId,
            status: activeTurn.status,
            stopReason: activeTurn.stopReason ?? null,
            error: activeTurn.error
              ? {
                  code: activeTurn.error.code,
                  message: activeTurn.error.message,
                }
              : null,
          }
        : null,
      queueState: view?.inputQueue
        ? {
            generation: view.inputQueue.generation,
            revision: view.inputQueue.revision,
            activeRequestId: view.inputQueue.activeRequestId ?? null,
            count: view.inputQueue.items.length,
          }
        : null,
      configured: bound?.configured ?? applied?.configured ?? false,
      // Non-secret diagnostics only; never expose apiKey/baseUrl.
      modelAlias: bound?.modelAlias ?? applied?.modelAlias ?? null,
      model: bound?.model ?? applied?.model ?? null,
      error:
        bound?.error ??
        view?.turns.find((t) => t.turnId === view.activeTurnId)?.error
          ?.message ??
        view?.closedReason?.message ??
        null,
      capabilities: {
        stop: Boolean(bound),
        commands: view?.session.availableCommands ?? [],
        skills: [],
        queue: Boolean(view?.inputQueue),
        attachments: false,
      },
      queue: view?.inputQueue?.items ?? [],
      interactions: view?.pendingInteractions ?? [],
      tasks: view?.tasks ?? [],
      plan: view?.plan ?? [],
    });
  }
  async conversation(input: RuntimeAgent, cursor?: string) {
    const bound = await this.wake(input);
    if (cursor) {
      if (cursor !== bound.nextCursor)
        throw new RuntimeError(
          "version_conflict",
          "History cursor belongs to an older binding or page; refresh this Agent history.",
        );
      const result: any = await this.executeControl(
        () =>
          bound.chat.execute(
            ChatUserAction.loadEarlierHistory({ limit: 50 }),
          ),
        {
          code: "history_failed",
          message:
            "加载更早历史未获 SDK 确认；请刷新会话核对后再决定是否重试。",
        },
      );
      bound.nextCursor =
        typeof result.nextCursor === "string" ? result.nextCursor : null;
    }
    // Let official replica's queued Yjs projection settle, never fabricate messages.
    await new Promise((r) => setTimeout(r, 0));
    const view = bound.replica.read();
    return this.database.redact({
      companyId: input.companyId,
      agentId: input.agentId,
      sessionId: bound.chat.sessionId,
      messages: this.messages(view),
      nextCursor: bound.nextCursor,
      view,
    });
  }
  private messages(view: SessionView) {
    return view.entries.map((entry) => ({
      id: entry.id,
      role: entry.role,
      text: entry.blocks
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n"),
      tools: entry.blocks
        .filter((b) => b.type === "tool_call")
        .map((b) => (b.type === "tool_call" ? b.tool : null)),
      status: entry.status,
      error: entry.error,
      createdAt: entry.createdAt,
    }));
  }
  async send(
    input: RuntimeAgent,
    payload: {
      text: string;
      requestId?: string;
      issueId?: string;
      references?: unknown[];
    },
  ) {
    const bound = await this.wake(input);
    if (!bound.configured) {
      const alias = bound.modelAlias ?? "sonnet";
      throw new RuntimeError(
        "model_not_configured",
        `Active model alias "${alias}" has no usable model, apiKey or baseUrl. Set PERI_MODEL_ID_${alias.toUpperCase()} (or PERI_MODEL_ID), PERI_MODEL_BASE_URL and PERI_MODEL_API_KEY, then explicitly restart this Agent. No model input was sent.`,
      );
    }
    const effective = bound.input.configuration ?? bound.input.config ?? {};
    const systemPrompt = String(
      input.systemPrompt ?? bound.input.systemPrompt ?? "",
    ).trim();
    const context = [
      "[Company effective configuration — applied by explicit restart]",
      `Role: ${input.role ?? bound.input.role ?? ""}`,
      `Responsibilities: ${input.responsibilities ?? effective.responsibilities ?? ""}`,
      systemPrompt ? `[Agent system prompt]\n${systemPrompt}` : "",
      effective.instructions ?? "",
      "Read current claude.md for learning memory; older role text in conversation is historical.",
    ]
      .filter(Boolean)
      .join("\n");
    const text = [
      context,
      payload.issueId
        ? `[Company Issue context: ${payload.issueId}; same fixed Session]`
        : "",
      payload.references?.length
        ? `[File references]\n${JSON.stringify(payload.references)}`
        : "",
      payload.text,
    ]
      .filter(Boolean)
      .join("\n\n");
    const requestId = payload.requestId ?? randomUUID();
    const key = `${this.key(input)}/${requestId}`;
    const fingerprint = JSON.stringify(payload);
    const previous = this.deliveries.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new RuntimeError(
          "idempotency_conflict",
          "The same input request ID was used with different content.",
        );
      return previous.result;
    }
    const result = this.executeControl(
      async () => {
        const receipt = bound.chat.execute(
          ChatUserAction.send({ text, requestId }),
        );
        await receipt.accepted;
        await this.recoverStrandedInput(bound, receipt.inputId);
        return {
          accepted: true,
          inputId: receipt.inputId,
          requestId: receipt.requestId,
          sessionId: bound.chat.sessionId,
        };
      },
      {
        code: "send_failed",
        message:
          "输入提交未获 SDK 确认；可能已入队，请先刷新会话与队列，不要自动重试。",
      },
    );
    this.deliveries.set(key, { fingerprint, result });
    return result;
  }
  /**
   * peri 的输入邮箱在“排队输入于 idle 边界被交接”后可能残留已取消的 active
   * attempt：之后的空闲输入会被提升为待投递却不再交接，用户看到的就是 prompt
   * 永远停在队列里。这里只在运行侧反复确认完全空闲、队列里只有这一条输入、
   * 且没有待回答交互时，补一次官方 force_send；正常排队（有轮次在跑）直接跳过。
   */
  private async recoverStrandedInput(bound: BoundAgent, inputId: string) {
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!this.inputIsStranded(bound, inputId)) return;
    }
    try {
      await bound.chat.execute(ChatUserAction.forceSend(inputId));
    } catch {
      // 投递仍留在队列；前端可继续用“立即投递”重试，不能因此回滚已受理的输入。
    }
  }

  private inputIsStranded(bound: BoundAgent, inputId: string) {
    const view = bound.replica.read();
    const queue = view.inputQueue;
    if (!queue || queue.activeRequestId) return false;
    if (view.running || view.executionBlocked || view.closed) return false;
    if (view.pendingInteractions.length > 0) return false;
    if (view.activeTurnStatus && !["completed", "idle"].includes(view.activeTurnStatus))
      return false;
    if (queue.items.length !== 1) return false;
    const item = queue.items[0];
    return item.inputId === inputId && item.state === "queued";
  }
  async deliver(
    input: RuntimeAgent,
    message: { text: string; messageId: string; threadId: string },
  ) {
    try {
      const receipt = await this.send(input, {
        text: `[Company IM ${message.threadId}/${message.messageId}]\n${message.text}`,
        requestId: message.messageId,
      });
      return {
        status: "delivered" as const,
        inputId: receipt.inputId,
        sessionId: receipt.sessionId,
      };
    } catch (e) {
      return {
        status: "failed" as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  private async executeControl<T>(
    operation: () => PromiseLike<T>,
    fallback: { code: string; message: string },
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw chatControlFailure(error, fallback);
    }
  }
  async stop(input: RuntimeAgent) {
    const bound = await this.wake(input);
    return this.executeControl(
      () => bound.chat.execute(ChatUserAction.cancel()),
      {
        code: "cancel_failed",
        message:
          "停止请求未获 SDK 确认；请刷新运行时状态后再决定是否重试。",
      },
    );
  }
  async takeBack(input: RuntimeAgent, inputId: string) {
    const bound = await this.wake(input);
    return this.executeControl(
      () => bound.chat.execute(ChatUserAction.takeBack(inputId)),
      {
        code: "take_back_failed",
        message:
          "撤回队列输入未获 SDK 确认；请刷新队列后再决定是否重试。",
      },
    );
  }
  async forceSend(input: RuntimeAgent, inputId: string) {
    const bound = await this.wake(input);
    return this.executeControl(
      () => bound.chat.execute(ChatUserAction.forceSend(inputId)),
      {
        code: "force_send_failed",
        message:
          "立即投递未获 SDK 确认；可能已入队，请刷新队列后再决定是否重试。",
      },
    );
  }
  async answer(input: RuntimeAgent, interactionId: string, answer: any) {
    const bound = await this.wake(input);
    return this.executeControl(
      () => bound.chat.execute(ChatUserAction.answer({ interactionId, answer })),
      {
        code: "answer_failed",
        message:
          "运行时回答未获 SDK 确认；请刷新运行时交互后再决定是否重试。",
      },
    );
  }
  shutdown() {
    this.accepting = false;
    if (this.shutdownPromise) return this.shutdownPromise;
    const shutdown = (async () => {
      await this.initialized;
      await Promise.allSettled([...this.locks.values()]);
      let failed = false;
      for (const bound of this.agents.values()) {
        try { await this.closeBound(bound); } catch { failed = true; }
      }
      for (const [key, entry] of this.managers) {
        let incomplete = false;
        try { await entry.manager.shutdown(); } catch { incomplete = true; }
        try { await entry.modules.close(); } catch { incomplete = true; }
        if (incomplete) failed = true;
        else this.managers.delete(key);
      }
      // TursoStorage 仅按请求访问 HTTP，无 close()/dispose() 契约，不伪造关闭。
      if (failed)
        throw new RuntimeError("wasm_cleanup_unconfirmed", "部分 WASM、Workspace 或 view 关闭未获确认；保留 handle，可重试 shutdown。");
      this.agents.clear();
      this.database.clear();
    })();
    this.shutdownPromise = shutdown;
    void shutdown.catch(() => { this.shutdownPromise = undefined; });
    return shutdown;
  }
}
