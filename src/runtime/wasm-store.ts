import { TursoStorage, type ChatDatabase, type ChatSessionDirectoryEntry } from "@peri-code/sdk";
import { constants, existsSync } from "node:fs";
import { mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

const BACKEND = "wasm-sqld-v1";
export interface StoreScope {
  companyId: string;
  agentId: string;
  directory: string;
  knowledgeDirectory?: string;
  projectRoots?: string[];
}
export interface WasmStoreConfiguration {
  url: string;
  authToken: string;
}
/** 只由宿主注入；不得从 Agent 配置或 .env 取得数据库管理员凭据。 */
export interface StoreProvider {
  resolve(scope: Readonly<StoreScope>): Promise<WasmStoreConfiguration>;
}
export class WasmStoreError extends Error {
  readonly status = 503;
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
const failure = (code: string, message: string) => new WasmStoreError(code, message);
const scopeKey = (scope: Pick<StoreScope, "companyId" | "agentId">) =>
  JSON.stringify([scope.companyId, scope.agentId]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const storeScopeId = (scope: Pick<StoreScope, "companyId" | "agentId">) => hash(scopeKey(scope));
function within(parent: string, child: string) {
  const path = relative(parent, child);
  return !path || (!path.startsWith("..") && !isAbsolute(path));
}
function connection(value: unknown): WasmStoreConfiguration & { identity: string } {
  const config = value as Partial<WasmStoreConfiguration> | null;
  if (!config || typeof config.url !== "string" || typeof config.authToken !== "string" || !config.authToken.trim())
    throw failure("wasm_store_not_configured", "需要配置 url 与非空 authToken；设置服务端 COMPANY_WASM_STORES_FILE（stores 或 default），或注入 StoreProvider。");
  // 不接受 URL 凭据、别名、非规范 IP 或任何外域；允许回环端点带数据库路径，
  // 以兼容 peri-loom 等按 /db/<tenant>/<database>/<branch> 路由的 Hrana 网关。
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/[A-Za-z0-9._~/-]*)?$/.test(config.url))
    throw failure("wasm_store_invalid_url", "sqld url 必须是明确回环 127.0.0.1 或 [::1] 的 HTTP 端点；可带数据库路径，但不得含用户信息、query 或 fragment。");
  let url: URL;
  try { url = new URL(config.url); } catch {
    throw failure("wasm_store_invalid_url", "sqld url 格式无效；请配置本地 HTTP 端点。");
  }
  if (url.port === "0") throw failure("wasm_store_invalid_url", "sqld url 必须使用有效监听端口。");
  // 允许不同 Agent 共用同一回环端点；identity 仍绑定解析后的 URL，防止既有 Session 静默换库。
  const identity = hash(url.href);
  return { url: url.href, authToken: config.authToken, identity };
}

export class FileStoreProvider implements StoreProvider {
  constructor(private options: { root: string; file?: string }) {}
  async resolve(scope: Readonly<StoreScope>): Promise<WasmStoreConfiguration> {
    if (!this.options.file)
      throw failure("wasm_store_not_configured", "未配置 COMPANY_WASM_STORES_FILE。查看 runtime/store-requests 中的 companyId、agentId，在宿主私有 JSON 中添加 stores: [{companyId, agentId, url, authToken}]，再重试相同创建请求。");
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let entries: unknown;
    let defaultEntry: unknown;
    try {
      const path = await realpath(resolve(this.options.file));
      const visible = [
        join(this.options.root, "agents"), join(this.options.root, "companys"),
        join(this.options.root, "runtime", "agents"), join(this.options.root, "runtime", "workspace"),
        scope.directory, scope.knowledgeDirectory, ...(scope.projectRoots ?? []),
        "/usr", "/bin", "/lib", "/lib64", "/etc/ssl", "/etc/alternatives",
      ];
      for (const candidate of visible) {
        if (!candidate) continue;
        const canonical = await realpath(candidate).catch(() => resolve(candidate));
        if (within(canonical, path))
          throw failure("wasm_store_config_exposed", "存储配置文件不能位于任何 Agent、知识库、Workspace runtime 或项目可见目录中。");
      }
      file = await open(resolve(this.options.file), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
        throw failure("wasm_store_config_permissions", "存储配置必须是宿主所有的普通文件，拒绝 group/world 权限；请由所有者设置为 0600。");
      const document = JSON.parse(await file.readFile("utf8"));
      entries = document?.stores;
      defaultEntry = document?.default;
    } catch (error) {
      if (error instanceof WasmStoreError) throw error;
      throw failure("wasm_store_config_invalid", "无法读取指定存储配置；检查文件路径、所有者、0600 权限与 JSON stores 数组。未连接数据库。");
    } finally {
      try { await file?.close(); } catch {
        throw failure("wasm_store_config_close_failed", "宿主存储配置文件关闭失败；未连接数据库。");
      }
    }
    if (entries === undefined && defaultEntry === undefined)
      throw failure("wasm_store_config_invalid", "存储配置需要 stores 数组或全局 default 对象；每条 stores 包含 companyId、agentId、url、authToken。");
    if (entries !== undefined && !Array.isArray(entries))
      throw failure("wasm_store_config_invalid", "stores 必须是数组，每条包含 companyId、agentId、url、authToken。");
    const fallback = defaultEntry === undefined ? undefined : connection(defaultEntry);
    const scopes = new Set<string>();
    let selected: WasmStoreConfiguration | undefined;
    for (const entry of entries ?? []) {
      if (!entry || typeof entry.companyId !== "string" || !entry.companyId || typeof entry.agentId !== "string" || !entry.agentId)
        throw failure("wasm_store_config_invalid", "每条存储配置都需要 companyId、agentId、url、authToken。");
      const key = scopeKey(entry), store = connection(entry);
      if (scopes.has(key))
        throw failure("wasm_store_conflict", "存储配置存在重复 scope；同一 companyId、agentId 只能有一条 url/authToken。");
      scopes.add(key);
      if (key === scopeKey(scope)) selected = { url: store.url, authToken: store.authToken };
    }
    if (!selected && fallback)
      selected = { url: fallback.url, authToken: fallback.authToken };
    if (!selected)
      throw failure("wasm_store_not_configured", "当前 scope 缺少存储配置。查看 runtime/store-requests 中的 companyId、agentId，补齐 url、authToken 或添加全局 default 后重试相同请求；不要手填公司 ID。");
    return selected;
  }
}

interface StoreBinding {
  backend: typeof BACKEND;
  companyId: string;
  agentId: string;
  cwd: string;
  storeIdentity: string;
  state: "creating" | "bound";
  sessionId?: string;
  /** Last confirmed replacement; never interpreted as another accessible Session. */
  replacesSessionId?: string;
}
export class ScopedWasmStore implements ChatDatabase {
  constructor(
    readonly storage: TursoStorage,
    readonly scope: StoreScope,
    readonly identity: string,
    private binding: StoreBinding | undefined,
    private path: string,
  ) {}
  get sessionId() { return this.binding?.sessionId; }
  get replacesSessionId() { return this.binding?.replacesSessionId; }
  /** SDK 0.4.0 起 TursoStorage 持有一条持久连接，关闭责任在宿主。 */
  close() { return this.storage.close(); }
  async listSessions(path?: string) {
    if (!this.sessionId || (path !== undefined && path !== this.scope.directory)) return [];
    const session = await this.getSession(this.sessionId);
    return session ? [session] : [];
  }
  async getSession(id: string): Promise<ChatSessionDirectoryEntry | null> {
    if (!this.sessionId || id !== this.sessionId) return null;
    try {
      const session = await this.storage.getSession(id);
      if (session && session.cwd !== this.scope.directory)
        throw failure("wasm_session_cwd_mismatch", "固定 Session 存在但工作目录不匹配；拒绝恢复或创建替代 Session。");
      return session;
    } catch (error) {
      if (error instanceof WasmStoreError) throw error;
      throw failure("wasm_store_unavailable", "无法读取此 Agent 的本地 sqld Session；请检查宿主端点、凭据和服务状态。");
    }
  }
  async beginCreation() {
    if (this.binding)
      throw failure("wasm_session_creation_unconfirmed", "此前 Session 创建尚无可信完成绑定；禁止自动创建替代 Session。请保留原库与 runtime/wasm-stores 元数据，人工处理未确认创建。");
    try {
      // 新 scope 不接管端点内的既有会话，也不手写 Peri schema。
      if ((await this.storage.listSessions(this.scope.directory)).length)
        throw failure("wasm_store_unbound_sessions", "新 scope 的端点已有未绑定 Session；拒绝自动接管或创建替代。请人工处理该 scope 的既有 Session，或为该 scope 配置独立端点。");
    } catch (error) {
      if (error instanceof WasmStoreError) throw error;
      throw failure("wasm_store_unavailable", "无法读取此 Agent 的本地 sqld；请检查宿主端点、凭据和服务状态。");
    }
    const binding: StoreBinding = {
      backend: BACKEND, companyId: this.scope.companyId, agentId: this.scope.agentId,
      cwd: this.scope.directory, storeIdentity: this.identity, state: "creating",
    };
    try { await writeFile(this.path, JSON.stringify(binding) + "\n", { mode: 0o600, flag: "wx" }); } catch {
      throw failure("wasm_store_binding_conflict", "无法独占写入 Session 创建标记；拒绝再次创建，请检查宿主 runtime/wasm-stores 元数据。");
    }
    this.binding = binding;
  }
  async bindSession(sessionId: string) {
    if (!sessionId || !this.binding || this.binding.state !== "creating")
      throw failure("wasm_store_binding_invalid", "Session 创建结果缺少可信绑定，未写入替代 Session。");
    await this.persist(
      { ...this.binding, state: "bound", sessionId },
      "Session 可能已创建，但宿主绑定未能持久化；保留原库与创建标记，禁止自动重新 provision。",
    );
  }
  /** 仅当磁盘绑定仍与调用方看到的一致时，替换为本 scope 的新固定 Session。 */
  async replaceBinding(expectedSessionId: string, sessionId: string) {
    const current = this.binding;
    if (!current || current.state !== "bound" || current.sessionId !== expectedSessionId)
      throw failure("wasm_session_binding_mismatch", "Session 绑定已变化；拒绝覆盖。");
    if (!sessionId)
      throw failure("wasm_store_binding_invalid", "新 Session 绑定缺少 Session ID。");
    await this.persist(
      { ...current, state: "bound", sessionId, replacesSessionId: expectedSessionId },
      "替代 Session 可能已创建，但宿主绑定未能持久化；拒绝静默覆盖。",
    );
  }
  private async persist(binding: StoreBinding, message: string) {
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(binding) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } catch {
      throw failure("wasm_store_binding_write_failed", message);
    }
    this.binding = binding;
  }
}

/** 只聚合已明确授权且有可信绑定的 scope；不扫描 native 数据库，不共享 Manager。 */
export class WasmStoreDirectory implements ChatDatabase {
  private stores = new Map<string, ScopedWasmStore>();
  private confidential = new Set<string>();
  constructor(private options: { root: string; provider: StoreProvider }) {}
  redact<T>(value: T): T {
    const clean = (item: any): any => {
      if (typeof item === "string") {
        for (const secret of this.confidential) item = item.replaceAll(secret, "[REDACTED_STORE]");
        return item;
      }
      if (Array.isArray(item)) return item.map(clean);
      if (item && typeof item === "object")
        return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, clean(entry)]));
      return item;
    };
    return clean(value);
  }
  /** 只读宿主可信绑定；缺失、不可读或未完成绑定时返回 undefined。 */
  async boundSessionInfo(scope: Pick<StoreScope, "companyId" | "agentId">): Promise<{ sessionId: string; replacesSessionId?: string } | undefined> {
    const path = join(this.options.root, "runtime", "wasm-stores", storeScopeId(scope) + ".json");
    try {
      const binding = JSON.parse(await readFile(path, "utf8"));
      if (binding?.backend === BACKEND && binding.companyId === scope.companyId &&
          binding.agentId === scope.agentId && binding.state === "bound" &&
          typeof binding.sessionId === "string" && binding.sessionId)
        return {
          sessionId: binding.sessionId,
          ...(typeof binding.replacesSessionId === "string" && binding.replacesSessionId
            ? { replacesSessionId: binding.replacesSessionId } : {}),
        };
    } catch {
      // 无副作用：读取失败不创建目录、不写文件，交由 acquire 报告具体错误。
    }
    return undefined;
  }
  async boundSessionId(scope: Pick<StoreScope, "companyId" | "agentId">): Promise<string | undefined> {
    return (await this.boundSessionInfo(scope))?.sessionId;
  }
  async acquire(scope: StoreScope, requestedSessionId?: string) {
    if (![scope.companyId, scope.agentId].every((id) => /^[a-zA-Z0-9_-]+$/.test(id)))
      throw failure("wasm_store_scope_invalid", "存储 scope 需要有效 companyId 与 agentId。");
    const directory = join(this.options.root, "runtime", "wasm-stores");
    const path = join(directory, storeScopeId(scope) + ".json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let binding: StoreBinding | undefined;
    try {
      binding = JSON.parse(await readFile(path, "utf8"));
      if (!binding || typeof binding !== "object" || Array.isArray(binding))
        throw failure("wasm_store_binding_invalid", "WASM backend 元数据格式无效；拒绝创建替代 Session。");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw failure("wasm_store_binding_invalid", "WASM backend 元数据不可读；拒绝替换既有 Session。");
    }
    if (!binding && (requestedSessionId || existsSync(join(this.options.root, "runtime", "agents", scope.agentId, "sessions.db"))))
      throw failure("legacy_session_backend", "该 Agent 有旧 Session 或 native sessions.db，但没有可信 wasm-sqld-v1 绑定；保留原数据，不迁移、不启动 native ACP、不创建替代 Session。");
    if (!binding && (this.stores.get(scopeKey(scope))?.sessionId || existsSync(join(this.options.root, "runtime", "effective-config", scope.agentId + ".json"))))
      throw failure("wasm_store_binding_missing", "Agent 已有运行配置或历史绑定，但 WASM backend manifest 缺失；拒绝自动创建替代 Session。请保留原数据与 Session ID。");
    if (binding && (binding.backend !== BACKEND || binding.companyId !== scope.companyId || binding.agentId !== scope.agentId || binding.cwd !== scope.directory || !/^[a-f0-9]{64}$/.test(binding.storeIdentity) || !["creating", "bound"].includes(binding.state) || (binding.state === "bound" && (typeof binding.sessionId !== "string" || !binding.sessionId))))
      throw failure("wasm_store_binding_invalid", "WASM backend/scope/cwd/Session 绑定不匹配；拒绝连接或自动创建。");
    if (binding?.state === "creating")
      throw failure("wasm_session_creation_unconfirmed", "此前 Session 创建未确认完成，禁止自动新建；请保留本地 sqld 与 runtime/wasm-stores 创建标记，人工恢复可信绑定。");
    if (requestedSessionId && binding?.sessionId !== requestedSessionId)
      throw failure("wasm_session_binding_mismatch", "请求的 Session 与此 Agent 的可信 WASM backend 绑定不同；未连接替代端点。");
    const requests = join(this.options.root, "runtime", "store-requests");
    await mkdir(requests, { recursive: true, mode: 0o700 });
    await writeFile(join(requests, storeScopeId(scope) + ".json"), JSON.stringify({ companyId: scope.companyId, agentId: scope.agentId, backend: BACKEND }) + "\n", { mode: 0o600 });
    let config: ReturnType<typeof connection>;
    try { config = connection(await this.options.provider.resolve(Object.freeze({ ...scope, projectRoots: scope.projectRoots ? [...scope.projectRoots] : undefined }))); } catch (error) {
      if (error instanceof WasmStoreError) throw error;
      throw failure("wasm_store_provider_failed", "宿主 StoreProvider 无法解析当前 companyId、agentId 的本地 url、authToken；未连接数据库。");
    }
    this.confidential.add(config.authToken);
    this.confidential.add(config.url);
    this.confidential.add(config.url.replace(/\/$/, ""));
    if (binding && binding.storeIdentity !== config.identity)
      throw failure("wasm_store_backend_changed", "配置端点与持久 backend 身份不同；拒绝将旧 Session 连接到新库或自动创建替代。凭据轮转不改变 backend 身份。");
    // 显式配置与宿主自动供给都允许不同 scope 共用同一回环端点；
    // Session 隔离由各 ScopedWasmStore 的 scope/cwd 绑定负责。
    const store = new ScopedWasmStore(new TursoStorage({ url: config.url, authToken: config.authToken, currentCwd: scope.directory, legacyCwd: scope.directory }), scope, config.identity, binding, path);
    this.stores.set(scopeKey(scope), store);
    return store;
  }
  /** 关闭所有目录实例；只移除关闭成功的实例，失败项保留供 shutdown 重试。 */
  async closeAll() {
    const entries = [...this.stores.entries()];
    const results = await Promise.allSettled(entries.map(([, store]) => store.close()));
    let failed = false;
    results.forEach((result, index) => {
      if (result.status === "rejected") failed = true;
      else this.stores.delete(entries[index][0]);
    });
    return failed;
  }
  async listSessions(path?: string) {
    const sessions = await Promise.all([...this.stores.values()].map((store) => store.listSessions(path)));
    return sessions.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getSession(id: string) {
    for (const store of this.stores.values()) {
      const session = await store.getSession(id);
      if (session) return session;
    }
    return null;
  }
}
