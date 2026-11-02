import {
  ChatActionError,
  ChatCloseIncompleteError,
  ChatManager,
  ChatUserAction,
  ChatViewRegistry,
  BareHarnessConfig,
  type ChatService,
  type ChatFactEnvelope,
  type ChatFactObserver,
  type ChatFactSource,
  type ChatSessionDirectoryEntry,
  type AcpMcpServer,
} from "@peri-code/sdk";
import { ChatReplica, type SessionView } from "@peri-code/sdk/view";
import { mkdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { InputReceiptCache, InputReceiptCacheError, PROMPT_ADMIT_WINDOW_MS, withinAdmissionWindow } from "./input-receipts";
import type { ModeTransport } from "./mode-transport";
import {
  PROMPT_ERROR_CODES,
  classifyAgentExecutionFailure,
  classifyPromptError,
  isAdmissionPromptError,
  isPersistencePromptError,
  promptErrorDefinition,
  type ClassifiedPromptError,
  type PromptDisposition,
  type PromptFailureRecord,
  type PromptRecovery,
} from "./prompt-errors";
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
import { agentExecutionFailureFromNotice } from "./diagnostic-events";
import type { DiagnosticsSink } from "./diagnostics";
import { redactRuntimeMessage } from "./redaction";
export { redactRuntimeMessage } from "./redaction";
export { PROMPT_ADMIT_WINDOW_MS };
export {
  PROMPT_ERROR_CODES,
  classifyAgentExecutionFailure,
  classifyPromptError,
  promptErrorDefinition,
  type ClassifiedPromptError,
  type PromptDisposition,
  type PromptFailureRecord,
  type PromptRecovery,
};
import { createWorkspaceMcpServerFactory } from "./workspace";
import {
  ModelConfigurationError,
  modelInfoFromSettings,
  type ModelTier,
} from "./model-settings";
import {
  loadModelLibrary,
  publicModelLibraryView,
  resolveModel,
  type ModelResolutionMetadata,
} from "./model-library";
import {
  SystemPromptError,
  composeSystemInstructions,
} from "./system-prompt";
export {
  DEFAULT_MODEL_ALIAS,
  MODEL_PLACEHOLDER_BASE_URL,
  MODEL_TIERS,
  ModelConfigurationError,
  modelInfoFromSettings,
  type ModelTier,
} from "./model-settings";
export {
  MODEL_LIBRARY_VERSION,
  loadModelLibrary,
  modelLibraryPath,
  publicModelLibraryView,
  resolveModel,
  type ModelResolutionMetadata,
  type ModelLibraryState,
  type PublicModelLibrary,
  type ResolvedModel,
} from "./model-library";
export type { StoreProvider, StoreScope, WasmStoreConfiguration } from "./wasm-store";
export { FileStoreProvider } from "./wasm-store";
export {
  ExplicitFirstStoreProvider,
  SharedSqldProvider,
  sharedSqldProviderFromEnv,
} from "./local-sqld";
import { channelPair } from "./view-channel";
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
export interface EffectiveConfiguration {
  settings: unknown;
  configured: boolean;
  mcpServers: Record<string, AcpMcpServer>;
  configuration: Record<string, any>;
  role?: string;
  responsibilities?: string;
  systemPrompt?: string;
  model?: ModelResolutionMetadata;
}
/**
 * Bind-time snapshot reconciliation. A frozen snapshot that is already usable
 * never drifts. A legacy snapshot without `model` metadata is rebuilt from the
 * current library; a library-aware snapshot whose model was unusable is
 * repaired only when the current resolution is usable.
 */
export function reconcileEffectiveConfiguration(
  effective: EffectiveConfiguration,
  candidate: {
    settings: unknown;
    configured: boolean;
    model: ModelResolutionMetadata;
  },
): { effective: EffectiveConfiguration; repaired: boolean } {
  if (effective.model && effective.configured)
    return { effective, repaired: false };
  if (effective.model && !candidate.configured)
    return { effective, repaired: false };
  return {
    effective: {
      ...effective,
      settings: candidate.settings,
      configured: candidate.configured,
      model: candidate.model,
    },
    repaired: true,
  };
}
/** User input plus this turn's explicit metadata; never host role context. */
export function composeUserSendText(payload: {
  text: string;
  issueId?: string;
  references?: unknown[];
}) {
  return [
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
}
/** Atomically persist a host-only snapshot: parent 0700, file 0600. */
export async function writeEffectiveConfiguration(
  snapshotPath: string,
  effective: EffectiveConfiguration,
) {
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
interface BoundAgent {
  input: RuntimeAgent;
  manager: InstanceType<typeof ChatManager>;
  chat: ChatService;
  replica: ChatReplica;
  configured: boolean;
  modelAlias: ModelTier | null;
  model: string | null;
  modelMeta: ModelResolutionMetadata | null;
  error?: string;
  nextCursor: string | null;
  replacesSessionId?: string;
  /** direct prompt 整轮 RPC 的进行中 admission。 */
  promptInFlight: Map<string, { startedAt: string }>;
  /** 最近一次 prompt/notice 失败；新 admission 时清空。 */
  promptFailure?: PromptFailureRecord;
}
interface InputAdmission {
  accepted: true;
  mode: "prompt";
  inputId: string;
  requestId: string;
  sessionId: string | null;
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
/** 关闭失败的可诊断摘要；不展开完整栈，避免可重试场景刷屏。 */
function summarizeCloseFailure(error: unknown): string {
  if (error instanceof ChatCloseIncompleteError)
    return error.failures
      .map((failure) =>
        failure instanceof Error
          ? `${failure.name}: ${failure.message}`
          : String(failure),
      )
      .join(" | ");
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
  /** 每个 Chat 的脱敏代理保持同一对象身份：ViewRegistry 按身份拒绝重复 attach。 */
  private viewSources = new Map<
    string,
    { chat: ChatService; source: ChatFactSource & { readonly id: string } }
  >();
  private agents = new Map<string, BoundAgent>();
  /** chatId → 当前 activation 的 direct prompt transport（由 wasm 模块回调登记）。 */
  private promptTransports = new Map<string, ModeTransport>();
  private provisioned = new Map<
    string,
    { input: RuntimeAgent; sessionId: string }
  >();
  private locks = new Map<string, Promise<unknown>>();
  private deliveries = new InputReceiptCache<InputAdmission>();
  private initialized: Promise<void>;
  constructor(
    private options: {
      root: string;
      periBinary?: string;
      storeProvider?: StoreProvider;
      storesFile?: string;
      /** Explicit test/deployment override; defaults to COMPANY_MODEL_LIBRARY or <root>/model-library.yaml. */
      modelLibraryPath?: string;
      /** Optional diagnostics sink; omitted in tests that do not exercise diagnostics. */
      diagnostics?: DiagnosticsSink;
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
      const modules = createAgentWasmModules(
        {
          companyId: input.companyId,
          agentId: input.agentId,
          diagnostics: this.options.diagnostics,
        },
        {
          onTransport: (chatId, transport) => {
            // 同 chat 的重新 activation 覆盖旧 transport；旧对象随关闭释放。
            this.promptTransports.set(chatId, transport);
          },
        },
      );
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
                chatId: transportOptions?.chatId,
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
  private modelLibraryState() {
    return loadModelLibrary({
      root: this.options.root,
      environment: process.env,
      overridePath: this.options.modelLibraryPath,
    });
  }
  /** Owner-only browser projection of the model library; never returns values. */
  modelLibrary() {
    return publicModelLibraryView(this.modelLibraryState(), process.env);
  }
  private appliedRuntimeState(agentId: string) {
    const path = this.configurationPath(agentId);
    if (!existsSync(path))
      return {
        configured: false,
        modelAlias: null as ModelTier | null,
        model: null as string | null,
        modelMeta: null as ModelResolutionMetadata | null,
      };
    let snapshot: EffectiveConfiguration;
    try {
      snapshot = JSON.parse(readFileSync(path, "utf8")) as EffectiveConfiguration;
    } catch {
      return {
        configured: false,
        modelAlias: null as ModelTier | null,
        model: null as string | null,
        modelMeta: null as ModelResolutionMetadata | null,
      };
    }
    const current = () => {
      try {
        return resolveModel({
          config: snapshot.configuration ?? {},
          library: this.modelLibraryState(),
          environment: process.env,
        }).metadata;
      } catch {
        return null;
      }
    };

    if (snapshot.model) {
      if (snapshot.configured)
        return {
          configured: true,
          modelAlias: snapshot.model.activeAlias,
          model: snapshot.model.model,
          modelMeta: snapshot.model,
        };
      // The snapshot was frozen while no model was usable. Apply the same
      // library resolution bind() would use, display-only: never write here.
      const repaired = current();
      if (repaired?.configured)
        return {
          configured: true,
          modelAlias: repaired.activeAlias,
          model: repaired.model,
          modelMeta: repaired,
        };
      return {
        configured: false,
        modelAlias: snapshot.model.activeAlias,
        model: null,
        modelMeta: snapshot.model,
      };
    }

    // Legacy snapshot without model metadata: incompatible with the library
    // runtime. Show what bind() would rebuild; bind() writes it back.
    const resolved = current();
    if (resolved)
      return {
        configured: resolved.configured,
        modelAlias: resolved.activeAlias,
        model: resolved.model,
        modelMeta: resolved,
      };
    const info = modelInfoFromSettings(snapshot.settings);
    return { configured: false, ...info, modelMeta: null };
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
    // Model selection is a whitelisted profile resolution. Arbitrary config.settings
    // is reserved and must never be spread into PeriConfig. Only the trusted host
    // process environment is read for endpoint/credential values; an Agent-writable
    // `<agent>/.env` is never merged here.
    const resolved = resolveModel({
      config,
      library: this.modelLibraryState(),
      environment: process.env,
    });
    const settings = {
      config: {
        ...resolved.config,
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
    return {
      settings,
      configured: resolved.metadata.configured,
      model: resolved.metadata,
    };
  }
  private async bind(
    input: RuntimeAgent,
    sessionId?: string,
    refreshConfiguration = false,
    allowMissingReplacement = true,
  ) {
    await this.initialized;
    // 磁盘上的可信绑定优先于调用方可能过期的 sessionId；acquire 仍按绑定严格校验。
    const boundSessionId = await this.database.boundSessionId(input);
    if (!allowMissingReplacement && sessionId && boundSessionId !== sessionId)
      throw new RuntimeError("wasm_session_binding_mismatch", "provision 恢复确认与可信 Session 绑定不同；拒绝替代。");
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
      // A snapshot without model metadata predates the model library and is not
      // compatible with it: rebuild it from the library (never from <agent>/.env)
      // and write it back like an explicit restart. A library-aware snapshot whose
      // model was unusable is repaired only when the current resolution is usable;
      // an already-usable snapshot never silently drifts.
      const candidate = !effective.model || !effective.configured
        ? this.settings(input)
        : null;
      if (candidate) {
        const reconciled = reconcileEffectiveConfiguration(effective, candidate);
        effective = reconciled.effective;
        repairedConfiguration = reconciled.repaired;
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
      // the next explicit restart. This is a runtime rule; there is no OS sandbox.
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
        ...(input.systemPrompt !== undefined
          ? { systemPrompt: input.systemPrompt }
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
    const modelMeta = effective.model ?? null;
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
      role: effective.role ?? input.role,
      responsibilities: effective.responsibilities ?? input.responsibilities,
      systemPrompt: input.systemPrompt ?? effective.systemPrompt ?? "",
    };
    // 显式降级：仅关闭 Agent 的宿主 Workspace MCP；所有者文件视图不受影响。
    const workspaceEnabled = process.env.COMPANY_WORKSPACE !== "disabled";
    if (workspaceEnabled && !existsSync(this.binary) && this.binary.includes("/"))
      throw new RuntimeError("peri_not_installed", "官方 Peri 4.4.1 Workspace 二进制未配置；WASM 不回退 native ACP。");
    // 绑定仍可信但当前本地 sqld 已丢失该 Session（例如库重建）时，为同一 Agent
    // 创建新的固定 Session 并更新绑定；端点身份与 cwd/目录校验不放宽。
    let resumeSessionId = targetSessionId;
    if (targetSessionId && !(await store.getSession(targetSessionId))) {
      if (!allowMissingReplacement)
        throw new RuntimeError("wasm_session_missing", "provision 恢复确认的原 Session 不存在；拒绝自动重建。");
      console.warn(
        `[wasm_session_recovered] ${input.companyId}/${input.agentId}: bound session is absent in the current local sqld; creating a replacement session.`,
      );
      resumeSessionId = undefined;
    }
    // Instructions are frozen at session/new. Restarting an existing Session
    // must not rebuild or resend them; a replacement Session is a creation and
    // receives stable boundaries and a pointer to the current CLAUDE profile.
    const instructions = resumeSessionId
      ? undefined
      : composeSystemInstructions({
          agentId: appliedInput.agentId,
          companyId: appliedInput.companyId,
        });
    const chat = manager.createChat({
      workspace: {
        id: input.agentId,
        hostPath: input.directory,
        runtimePath: input.directory,
      },
      agent: { settings },
      session: {
        ...(instructions ? { instructions } : {}),
        mcpServers: {
          ...mcpServers,
          ...(workspaceEnabled
            ? {
                workspace: {
                  type: "acp",
                  server: createWorkspaceMcpServerFactory({
                    periBinary: this.binary,
                    directory: input.directory,
                    env: {
                      PATH: process.env.PATH,
                      LANG: process.env.LANG ?? "C.UTF-8",
                      HOME: process.env.HOME ?? "/tmp",
                    },
                  }),
                },
              }
            : {}),
        },
      },
    });
    const replica = new ChatReplica();
    const view = this.attachView(chat);
    const [server, client] = channelPair();
    view.sync(server);
    replica.connect(client);
    const bound: BoundAgent = {
      input: structuredClone(appliedInput),
      manager,
      chat,
      replica,
      configured,
      modelAlias: modelMeta?.activeAlias ?? modelInfo.modelAlias,
      model: modelMeta?.model ?? modelInfo.model,
      modelMeta,
      nextCursor: null,
      replacesSessionId: store.replacesSessionId,
      promptInFlight: new Map(),
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
      } else if (envelope.fact?.kind === "notice") {
        // Only the public failure message is extracted; event_json and value
        // payloads never reach the diagnostics sink.
        const failure = agentExecutionFailureFromNotice(envelope.fact);
        if (failure) {
          // AgentExecutionFailed 是同一轮失败的另一条事实；只保留一个投影，
          // 持久化文案优先，且不覆盖尚未解决的 admission 拒绝。
          this.recordNoticePromptFailure(bound, failure.message);
          const diagnostics = this.options.diagnostics;
          if (diagnostics) {
            const sessionId =
              typeof envelope.sessionId === "string"
                ? envelope.sessionId
                : bound.chat.sessionId ?? undefined;
            const chatId =
              typeof envelope.chatId === "string"
                ? envelope.chatId
                : bound.chat.id;
            diagnostics.record({
              event: "agent_execution_failed",
              companyId: input.companyId,
              agentId: input.agentId,
              ...(sessionId ? { sessionId } : {}),
              ...(chatId ? { chatId } : {}),
              ...(typeof envelope.bindingRevision === "number"
                ? { bindingRevision: envelope.bindingRevision }
                : {}),
              ...failure,
            });
          }
        }
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
        bound.replacesSessionId = staleSessionId;
        // The manifest is authoritative; do not retain a stale provisioning
        // receipt in this process after the confirmed replacement.
        if (this.provisioned.has(this.key(input)))
          this.provisioned.set(this.key(input), {
            input: structuredClone(input), sessionId: chat.sessionId!,
          });
      } else {
        await store.beginCreation();
        await chat.execute(
          ChatUserAction.createNewSession({
            title: input.name || input.agentId,
          }),
        );
        await store.bindSession(chat.sessionId!);
      }
      if (refreshConfiguration || repairedConfiguration)
        await writeEffectiveConfiguration(snapshotPath, effective);
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
        e instanceof ModelConfigurationError ||
        e instanceof SystemPromptError
      )
        throw e;
      // bind 阶段的 SDK chat 动作错误（如 binding_conflict）同样不得被折叠。
      const action = toChatActionRuntimeError(e);
      if (action) throw action;
      throw new RuntimeError("wasm_activation_failed", "WASM Session 激活失败；请检查本地 sqld、模型与 MCP 配置。未回退 native ACP，未自动替换 Session。");
    }
  }
  private async closeBound(bound: BoundAgent) {
    // SDK 契约：ChatCloseIncompleteError 表示资源与所有权已保留，可重试。
    // 典型场景：空闲 Chat 的宿主存储流被 sqld 以 400 过期；重试会重建流。
    let closeFailure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await bound.manager.closeChat(bound.chat.id);
        closeFailure = undefined;
        break;
      } catch (error) {
        closeFailure = error;
        if (!(error instanceof ChatCloseIncompleteError) || attempt > 0) break;
        console.warn(
          "[runtime] closeBound chat close retry:",
          summarizeCloseFailure(error),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (closeFailure !== undefined) {
      console.error("[runtime] closeBound chat close failed", closeFailure);
      bound.error = "WASM/Workspace/view 关闭未获确认；保留 handle 供重试。";
      throw new RuntimeError("wasm_cleanup_unconfirmed", bound.error);
    }
    const [view, replica] = await Promise.allSettled([
      this.views.dispose(bound.chat.id), bound.replica.dispose(),
    ]);
    if (view.status === "rejected")
      console.error("[runtime] closeBound view dispose failed", view.reason);
    if (replica.status === "rejected")
      console.error("[runtime] closeBound replica dispose failed", replica.reason);
    if (view.status === "rejected" || replica.status === "rejected") {
      bound.error = "WASM/Workspace/view 关闭未获确认；保留 handle 供重试。";
      throw new RuntimeError("wasm_cleanup_unconfirmed", bound.error);
    }
    this.viewSources.delete(bound.chat.id);
    this.promptTransports.delete(bound.chat.id);
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
      // Retrying a partially completed business provision must confirm the
      // exact persisted Session; it must not create another identity on loss.
      const bound = await this.bind(input, input.sessionId, true, !input.sessionId);
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
  async restart(input: RuntimeAgent, options: { force?: boolean } = {}) {
    return this.serialized(input, async () => {
      const existing = this.agents.get(this.key(input));
      const sessionId = existing?.chat.sessionId ?? input.sessionId;
      if (!sessionId)
        throw new RuntimeError(
          "missing_session",
          "Cannot restart without a fixed Session binding.",
        );
      let forcedCloseFailure: unknown;
      if (existing) {
        try {
          await this.closeBound(existing);
        } catch (error) {
          if (!options.force) throw error;
          // 显式 force：关闭未确认时允许放弃旧 handle，但绝不假装清理成功。
          // 旧 Manager 从注册表移除，避免新 activation 再次尝试同一关闭。
          forcedCloseFailure = error;
          this.promptTransports.delete(existing.chat.id);
          this.managers.delete(this.key(input));
          this.agents.delete(this.key(input));
          const [view, replica] = await Promise.allSettled([
            this.views.dispose(existing.chat.id),
            existing.replica.dispose(),
          ]);
          if (view.status === "rejected" || replica.status === "rejected")
            console.warn(
              "[runtime] force restart left view/replica cleanup unconfirmed",
            );
          this.viewSources.delete(existing.chat.id);
        }
        if (!forcedCloseFailure) {
          this.promptTransports.delete(existing.chat.id);
          this.agents.delete(this.key(input));
        }
      }
      try {
        await this.bind(input, sessionId, true);
      } catch (error) {
        if (forcedCloseFailure !== undefined) {
          const failure =
            error instanceof Error ? error.message : String(error);
          throw new RuntimeError(
            "close_incomplete",
            "强制重建未完成；上一个运行时的关闭仍未确认。",
            503,
            {
              disposition: "unknown",
              recovery: "rebuild",
              uncertain: true,
              errors: [
                summarizeCloseFailure(forcedCloseFailure),
                summarizeCloseFailure(failure),
              ],
            },
            { cause: error },
          );
        }
        throw error;
      }
      return this.snapshot(input);
    });
  }
  /**
   * 事实源 → 只读视图的脱敏代理。
   *
   * Yjs 帧是文档增量，无法逐帧脱敏；因此所有投影（服务端 replica 与浏览器
   * WebSocket）都从同一个代理读取事实，`database.redact` 是唯一入口。
   */
  private redactedSource(source: ChatService): ChatFactSource & { readonly id: string } {
    const redact = (envelope: ChatFactEnvelope): ChatFactEnvelope => ({
      ...envelope,
      fact: this.database.redact(envelope.fact),
    });
    return {
      id: source.id,
      get binding() {
        return source.binding;
      },
      subscribeFacts: (observer: ChatFactObserver) =>
        source.subscribeFacts({
          onBinding: (binding, replay) =>
            observer.onBinding(binding, replay.map(redact)),
          onFact: (envelope) => observer.onFact(redact(envelope)),
          onClosed: (reason) => observer.onClosed(reason),
        }),
    };
  }
  /** 同 Chat 的所有同步连接共享一个脱敏 View。 */
  attachView(source: ChatService) {
    let entry = this.viewSources.get(source.id);
    if (!entry || entry.chat !== source) {
      entry = { chat: source, source: this.redactedSource(source) };
      this.viewSources.set(source.id, entry);
    }
    return this.views.attach(entry.source);
  }
  /**
   * 按 Agent scope 解析活动 Chat；地址可以是句柄 chatId 或固定 sessionId。
   * 未激活或清理未确认时返回 undefined，绝不跨 Agent 命中。
   */
  chatForScope(
    input: { companyId: string; agentId: string },
    address?: string,
  ): ChatService | undefined {
    const bound = this.agents.get(this.key(input));
    if (!bound || bound.error) return undefined;
    if (!address) return bound.chat;
    return bound.chat.id === address || bound.chat.sessionId === address
      ? bound.chat
      : undefined;
  }
  /** DELETE 句柄前判定：运行中的会话（含 direct prompt admission）不允许“重启”。 */
  chatRunning(input: { companyId: string; agentId: string }) {
    const bound = this.agents.get(this.key(input));
    return Boolean(
      bound?.replica.read().running ||
      (bound?.promptInFlight.size ?? 0) > 0,
    );
  }
  /**
   * 句柄三态：ready / not_found / unavailable。
   *
   * `chatForScope` 对 cleanup 未确认的句柄返回 undefined；HTTP 层必须能区分
   * “从来没登记”与“运行时/清理未确认”，不能一律 410。
   */
  scopeChatState(
    input: { companyId: string; agentId: string },
    address?: string,
  ): "ready" | "not_found" | "unavailable" {
    const bound = this.agents.get(this.key(input));
    if (!bound) return "not_found";
    if (bound.error) return "unavailable";
    if (!address) return "ready";
    return bound.chat.id === address || bound.chat.sessionId === address
      ? "ready"
      : "not_found";
  }
  /** 已持久化的固定 Session；只读，不 wake。 */
  boundSession(input: { companyId: string; agentId: string }) {
    return this.database.boundSessionId(input);
  }
  /** Current Session identity and the last replacement, without activating it. */
  sessionBinding(input: { companyId: string; agentId: string }) {
    return this.database.boundSessionInfo(input);
  }
  /** 取得或激活该 Agent 的固定 Chat 句柄。 */
  async wakeChat(input: RuntimeAgent) {
    return (await this.wake(input)).chat;
  }
  /** 目录只读事实；不 wake、不启动 WASM。 */
  async chatDirectory(
    input: RuntimeAgent,
  ): Promise<(ChatSessionDirectoryEntry & { projectId: string })[]> {
    const bound = this.agents.get(this.key(input));
    const sessionId =
      bound?.chat.sessionId ?? (await this.database.boundSessionId(input));
    if (!sessionId) return [];
    const stamps = await this.directoryStamps(input.directory);
    return [
      {
        sessionId,
        title: input.name ?? null,
        cwd: input.directory,
        messageCount: bound?.replica.read().entries.length ?? 0,
        createdAt: stamps.createdAt,
        updatedAt: stamps.updatedAt,
        projectId: input.agentId,
      },
    ];
  }
  private async directoryStamps(directory: string) {
    try {
      const info = await stat(join(directory, "agent.yaml"));
      return {
        createdAt: info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
      };
    } catch {
      const epoch = new Date(0).toISOString();
      return { createdAt: epoch, updatedAt: epoch };
    }
  }
  /** 分类后的 prompt 错误 → HTTP 可映射的 RuntimeError；原文只保留为 cause。 */
  private promptRuntimeError(error: unknown, requestId?: string): RuntimeError {
    const classified = classifyPromptError(error);
    return new RuntimeError(
      classified.code,
      classified.message,
      classified.status,
      {
        disposition: classified.disposition,
        recovery: classified.recovery,
        uncertain: classified.uncertain,
        ...(requestId ? { requestId } : {}),
      },
      { cause: error },
    );
  }
  /**
   * 单一 promptFailure 槽位。
   *
   * - 持久化失败优先于通用执行/传输失败；
   * - admission 拒绝不能被后到的执行 notice 改写；
   * - 同一轮的多条事实只保留一条，避免 snapshot 重复。
   */
  private recordPromptFailure(
    bound: BoundAgent,
    failure: ClassifiedPromptError,
    requestId?: string,
  ) {
    const previous = bound.promptFailure;
    if (previous) {
      if (
        isPersistencePromptError(previous.code) &&
        !isPersistencePromptError(failure.code)
      )
        return;
      if (
        isAdmissionPromptError(previous.code) &&
        !isPersistencePromptError(failure.code)
      )
        return;
      if (previous.code === failure.code) {
        if (!previous.requestId && requestId) {
          bound.promptFailure = { ...previous, requestId };
          this.options?.onChange?.(bound.input);
        }
        return;
      }
    }
    bound.promptFailure = {
      ...(requestId ? { requestId } : {}),
      code: failure.code,
      message: failure.message,
      disposition: failure.disposition,
      recovery: failure.recovery,
      at: new Date().toISOString(),
    };
    // 失败没有新的 Yjs 消息可依赖；显式通知宿主刷新 runtime snapshot。
    this.options?.onChange?.(bound.input);
  }
  private recordNoticePromptFailure(bound: BoundAgent, message: string) {
    this.recordPromptFailure(
      bound,
      classifyAgentExecutionFailure(message),
    );
  }
  private promptTransport(bound: BoundAgent): ModeTransport | undefined {
    return this.promptTransports.get(bound.chat.id);
  }
  /** 与 REST send 相同的模型配置前置；不注入角色/配置正文。 */
  validateSendText(input: RuntimeAgent, text: string) {
    const bound = this.agents.get(this.key(input));
    if (!bound || bound.error)
      throw new RuntimeError(
        "not_ready",
        "Agent 会话尚未就绪，消息未发送。",
        409,
      );
    if (!bound.configured) {
      const alias = bound.modelAlias ?? "sonnet";
      const profile = bound.modelMeta?.profile ?? "default";
      const missing = bound.modelMeta?.missing?.length
        ? ` Missing: ${bound.modelMeta.missing.join(", ")}.`
        : "";
      throw new RuntimeError(
        "model_not_configured",
        `Model profile "${profile}" has no usable model, apiKey or baseUrl for alias "${alias}". Configure $COMPANY_HOME/model-library.yaml, then explicitly restart this Agent.${missing} No model input was sent.`,
        409,
      );
    }
    return text;
  }
  snapshot(input: { companyId: string; agentId: string; sessionId?: string }) {
    const bound = this.agents.get(this.key(input));
    const view = bound?.replica.read();
    const applied = bound ? null : this.appliedRuntimeState(input.agentId);
    const modelMeta = bound?.modelMeta ?? applied?.modelMeta ?? null;
    const hasTierDetail = Boolean(
      modelMeta?.tiers && modelMeta?.tierProviders && modelMeta?.tierSources,
    );
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
      replacesSessionId: bound?.replacesSessionId ?? null,
      // 旧派生字段：仅为兼容既有前端保留；恢复判断请用下方契约事实。
      busy: Boolean(
        view?.running ||
        (bound?.promptInFlight.size ?? 0) > 0 ||
        view?.tasks.some((t) => ["running", "in_progress"].includes(t.status)),
      ),
      status: view?.activeTurnStatus ?? "idle",
      /** direct prompt 的进行中 admission 数；整轮 RPC 仍由事件投影完成态。 */
      promptInFlight: bound?.promptInFlight.size ?? 0,
      /** 异步失败投影；只含固定中文文案与稳定分类，不含上游原文。 */
      promptFailure: bound?.promptFailure ?? null,
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
      modelAlias:
        bound?.modelAlias ??
        applied?.modelAlias ??
        modelMeta?.activeAlias ??
        null,
      model: bound?.model ?? applied?.model ?? modelMeta?.model ?? null,
      modelProfile: modelMeta?.profile ?? null,
      modelProvider: modelMeta?.provider ?? null,
      modelMissing: modelMeta?.missing ?? [],
      modelError: modelMeta?.error ?? null,
      modelSource: modelMeta?.source ?? null,
      modelLibraryRevision: modelMeta?.libraryRevision ?? null,
      // Per-tier detail is non-secret. Older frozen snapshots keep their active
      // chain and are not rebuilt just to fill these fields.
      modelTiers: hasTierDetail ? modelMeta!.tiers : null,
      modelTierProviders: hasTierDetail ? modelMeta!.tierProviders : null,
      modelTierSources: hasTierDetail ? modelMeta!.tierSources : null,
      modelResolvedAt: modelMeta?.resolvedAt ?? null,
      modelTierNotice:
        modelMeta && !hasTierDetail ? "重启后显示四档明细" : null,
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
        // 用户输入主路径是 ACP session/prompt；queue 仅为 legacy/诊断保留。
        queue: false,
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
  /**
   * 用户输入主路径：ACP `session/prompt` 整轮 RPC。
   *
   * 受理语义：
   * - 按 requestId 去重；同文本复用同一 admission，不重复 prompt；
   * - 750ms 内同步 reject → 分类后的 HTTP 错误；
   * - 窗口外仍返回 202，执行失败只投影到 `promptFailure`，绝不自动重发。
   */
  async send(
    input: RuntimeAgent,
    payload: {
      text: string;
      requestId?: string;
      issueId?: string;
      references?: unknown[];
    },
  ): Promise<InputAdmission> {
    const text = composeUserSendText(payload);
    const requestId = payload.requestId ?? randomUUID();
    const key = `${this.key(input)}/${requestId}`;
    const fingerprint = createHash("sha256").update(text).digest("hex");
    try {
      return await this.deliveries.run(key, fingerprint, async () => {
        let bound: BoundAgent;
        try {
          bound = await this.wake(input);
          this.validateSendText(input, text);
        } catch (error) {
          // Activation/configuration can have its own uncertainty, but this
          // prompt has not reached the transport and may safely be retried.
          const failure = (error ?? {}) as { code?: string; message?: string; status?: number; details?: Record<string, unknown> };
          throw new RuntimeError(
            failure.code ?? "not_ready",
            failure.message ?? "Agent 未就绪，输入未发送。",
            failure.status ?? 503,
            { ...failure.details, disposition: "not_sent" },
            { cause: error },
          );
        }
        const transport = this.promptTransport(bound);
        if (!transport) {
          throw new RuntimeError(
            "not_ready",
            "会话 transport 尚未加载，消息未发送。",
            409,
            { disposition: "not_sent", recovery: "none", uncertain: false },
          );
        }
        // 需要重建的失败未解决前拒绝新 admission：否则一次新发送会清空
        // promptFailure，把“必须先重启”的约束静默抹掉（UI 轮询还有时间窗）。
        const pendingFailure = bound.promptFailure;
        if (pendingFailure?.recovery === "rebuild") {
          const definition = promptErrorDefinition(pendingFailure.code);
          throw new RuntimeError(
            pendingFailure.code,
            pendingFailure.message,
            definition?.status ?? 503,
            {
              // 本次输入确定没有到达 transport；不能用旧失败的 unknown 污染
              // receipt 缓存（unknown 会永久占用容量并毒化同一 requestId）。
              disposition: "rejected",
              recovery: "rebuild",
              uncertain:
                definition?.uncertain ?? pendingFailure.disposition === "unknown",
            },
          );
        }
        // 新 admission 清空旧 failure；同一 requestId 的重放不会走到这里。
        bound.promptFailure = undefined;
        this.options?.onChange?.(input);
        bound.promptInFlight.set(requestId, {
          startedAt: new Date().toISOString(),
        });
        // direct prompt 不产生 live user_message_chunk；先同步投影本地回合，
        // 否则 SDK 视图没有 activeTurn，后续 assistant chunk 会被丢弃。
        const projected = transport.announceExternalUserTurn?.(text) ?? false;
        const work = Promise.resolve().then(() => transport.prompt(text));
        void work.then(
          () => {
            bound.promptInFlight.delete(requestId);
            // prompt RPC 在整轮结束时 resolve；SDK 对第二回合起的 done
            // 可能因 requestId 不匹配而忽略，这里兜底关闭本地回合。
            if (projected) transport.finishExternalUserTurn?.();
          },
          (error) => {
            bound.promptInFlight.delete(requestId);
            if (projected) transport.finishExternalUserTurn?.();
            this.recordPromptFailure(
              bound,
              classifyPromptError(error),
              requestId,
            );
          },
        );
        const outcome = await withinAdmissionWindow(
          work,
          PROMPT_ADMIT_WINDOW_MS,
        );
        if (outcome.state === "rejected") {
          bound.promptInFlight.delete(requestId);
          throw this.promptRuntimeError(outcome.error, requestId);
        }
        // 窗口内成功或窗口先到都返回 202；完成态只由事件投影体现。
        return {
          accepted: true as const,
          mode: "prompt" as const,
          inputId: requestId,
          requestId,
          sessionId: bound.chat.sessionId,
        };
      });
    } catch (error) {
      if (error instanceof InputReceiptCacheError)
        throw new RuntimeError(error.code, error.message,
          error.code === "idempotency_conflict" ? 409 : 503,
          { disposition: "not_sent" });
      throw error;
    }
  }
  /**
   * LEGACY：旧 queue 用户入口的 stranded 修复。用户 send 已切到 direct prompt，
   * 不再调用此方法；queue 方法保留供回滚/诊断。
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

  /**
   * LEGACY：仅保留给旧 queue 路径/回滚。用户 send 不再调用，也不自动 forceSend。
   */
  async recoverChatInput(input: RuntimeAgent, inputId: string) {
    const bound = this.agents.get(this.key(input));
    if (bound) await this.recoverStrandedInput(bound, inputId);
  }
  private inputIsStranded(bound: BoundAgent, inputId: string) {
    const view = bound.replica.read();
    const queue = view.inputQueue;
    if (!queue || queue.activeRequestId || queue.items.length !== 1) return false;
    if (view.running || view.executionBlocked || view.closed) return false;
    if (view.pendingInteractions.length > 0) return false;
    // cancelled/error 同样是已结算的终态；否则“停止后再发送”会永久留在队列里。
    if (
      view.activeTurnStatus &&
      !["completed", "cancelled", "error", "idle"].includes(
        view.activeTurnStatus,
      )
    )
      return false;
    const item = queue.items.find((entry) => entry.inputId === inputId);
    return item?.state === "queued";
  }
  async deliver(
    input: RuntimeAgent,
    message: {
      text: string;
      messageId: string;
      threadId: string;
      requestId?: string;
      attempt?: number;
    },
  ) {
    try {
      const receipt = await this.send(input, {
        text: `[Company IM ${message.threadId}/${message.messageId}]\n${message.text}`,
        requestId: message.requestId ?? message.messageId,
      });
      // "delivered" 表示 direct prompt admission；整轮完成态由事件投影体现。
      return {
        status: "delivered" as const,
        inputId: receipt.inputId,
        sessionId: receipt.sessionId,
      };
    } catch (e) {
      const details = (e as { details?: Record<string, unknown> } | null)?.details;
      const rawDisposition = details?.disposition;
      const disposition:
        | "rejected"
        | "not_sent"
        | "unknown"
        | undefined =
        rawDisposition === "rejected" ||
        rawDisposition === "not_sent" ||
        rawDisposition === "unknown"
          ? rawDisposition
          : undefined;
      const uncertain = details?.uncertain === true;
      const code = (e as { code?: unknown } | null)?.code;
      return {
        status: uncertain ? ("unknown" as const) : ("failed" as const),
        error: redactRuntimeMessage(
          e instanceof Error ? e.message : String(e),
        ),
        ...(typeof code === "string" ? { code } : {}),
        ...(disposition ? { disposition } : {}),
        uncertain,
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
    const transport = this.promptTransport(bound);
    if (bound.promptInFlight.size > 0 && transport) {
      // direct prompt 是 local RPC，不是 mailbox attempt；必须发送非 targeted
      // session/cancel。ModeTransport.cancel 只带 sessionId。
      return this.executeControl(
        async () => {
          await transport.cancel();
          // direct prompt 的 done 事件可能因 requestId 不匹配被 SDK 忽略，
          // 取消确认后主动关闭本地回合。
          transport.finishExternalUserTurn?.();
          return { requestId: randomUUID(), status: "requested" as const };
        },
        {
          code: "cancel_failed",
          message:
            "停止请求未获 SDK 确认；请刷新运行时状态后再决定是否重试。",
        },
      );
    }
    return this.executeControl(
      () => bound.chat.execute(ChatUserAction.cancel()),
      {
        code: "cancel_failed",
        message:
          "停止请求未获 SDK 确认；请刷新运行时状态后再决定是否重试。",
      },
    );
  }
  /** LEGACY：旧 queue 撤回；用户入口已停止调用，保留供回滚/诊断。 */
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
  /** LEGACY：旧 queue 立即投递；用户入口已停止调用，保留供回滚/诊断。 */
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
      this.provisioned.clear();
      this.promptTransports.clear();
      this.deliveries.clear();
      this.database.clear();
    })();
    this.shutdownPromise = shutdown;
    void shutdown.catch(() => { this.shutdownPromise = undefined; });
    return shutdown;
  }
}
