import { constants, type Stats } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WasmStoreError,
  type StoreProvider,
  type StoreScope,
  type WasmStoreConfiguration,
} from "./wasm-store";

const SHARED_BACKEND = "local-sqld-shared-v1";
const MANIFEST_VERSION = 1;
const DEFAULT_PORT = 18081;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;

const failure = (code: string, message: string) => new WasmStoreError(code, message);
type Environment = Record<string, string | undefined>;

interface SharedConfig {
  binary: string;
  root: string;
  sharedDir: string;
  port: number;
  startTimeoutMs: number;
}
interface Manifest {
  backend: typeof SHARED_BACKEND;
  version: typeof MANIFEST_VERSION;
  port: number;
}
interface SharedState {
  config: SharedConfig;
  privateKey: KeyObject;
  manifest?: Manifest;
  dbPath: string;
}
interface Running {
  /** 本实例 spawn 的子进程；热重载后复用既有 sqld 时为空。 */
  child?: ChildProcess;
  port: number;
  /** 不是本实例 spawn、但已确认是本进程直接子进程的既有 sqld。 */
  adopted?: boolean;
}

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return !path || (!path.startsWith("..") && !isAbsolute(path));
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error: any) {
    if (error?.code !== "ENOENT") return absolute;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await canonicalPath(parent), basename(absolute));
  }
}

async function lstatIfExists(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw failure("shared_sqld_state_invalid", "无法检查共享 sqld 的宿主私有状态。");
  }
}

async function readPrivateFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw failure("shared_sqld_state_invalid", "共享 sqld 的宿主私有文件不可读；未返回存储配置。");
  });
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o7777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld 的宿主私有文件必须是所有者所有的普通 0600 文件。",
      );
    return await file.readFile("utf8");
  } catch (error) {
    if (error instanceof WasmStoreError) throw error;
    throw failure("shared_sqld_state_invalid", "共享 sqld 的宿主私有文件不可读；未返回存储配置。");
  } finally {
    try {
      await file.close();
    } catch {
      throw failure("shared_sqld_state_invalid", "共享 sqld 的宿主私有文件关闭失败。");
    }
  }
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { mode: 0o600, flag: "wx" });
  } catch {
    throw failure(
      "shared_sqld_state_invalid",
      "无法创建共享 sqld 的宿主私有文件；已存在的文件不会被覆盖。",
    );
  }
  const info = await lstat(path).catch(() => {
    throw failure("shared_sqld_state_invalid", "无法检查共享 sqld 的宿主私有文件。");
  });
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.nlink !== 1 ||
    (info.mode & 0o7777) !== 0o600 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw failure(
      "shared_sqld_state_invalid",
      "共享 sqld 的宿主私有文件权限不安全；需要所有者 0600 普通文件。",
    );
}

async function ensurePrivateDir(path: string): Promise<void> {
  let info = await lstatIfExists(path);
  if (!info) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error: any) {
      if (error?.code !== "EEXIST")
        throw failure(
          "shared_sqld_root_permissions",
          "无法创建 COMPANY_SQLD_ROOT 或其 sqld/shared 子目录；请由所有者手工准备 0700 目录。",
        );
    }
    info = await lstatIfExists(path);
  }
  if (!info)
    throw failure("shared_sqld_root_permissions", "无法检查 COMPANY_SQLD_ROOT 的宿主权限。");
  if (info.isSymbolicLink() || !info.isDirectory())
    throw failure(
      "shared_sqld_root_unsafe",
      "COMPANY_SQLD_ROOT 及其 sqld/shared 子目录必须是真实目录，不能是符号链接。",
    );
  if (
    (info.mode & 0o7777) !== 0o700 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw failure(
      "shared_sqld_root_permissions",
      "COMPANY_SQLD_ROOT 及其 sqld/shared 子目录必须是所有者所有的 0700 目录；不会自动 chmod。",
    );
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    let settled = false;
    const done = (available: boolean) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (!server.listening) {
        resolveAvailable(available);
        return;
      }
      server.close(() => resolveAvailable(available));
    };
    server.once("error", () => done(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => done(true));
  });
}

function healthy(port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolveHealthy) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolveHealthy(ok);
    };
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        res.resume();
        done(res.statusCode === 200);
      },
    );
    req.once("timeout", () => {
      req.destroy();
      done(false);
    });
    req.once("error", () => done(false));
    req.end();
  });
}

function exited(child: ChildProcess): boolean {
  return (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  );
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onExit = () => {
      if (timer) clearTimeout(timer);
      resolveExit(true);
    };
    timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", onExit);
    if (exited(child)) {
      child.removeListener("exit", onExit);
      if (timer) clearTimeout(timer);
      resolveExit(true);
    }
  });
}

async function stopChild(child: ChildProcess): Promise<boolean> {
  if (exited(child)) return true;
  try {
    child.kill("SIGTERM");
  } catch {
    // 继续等待退出事件；不把 kill 的返回值当作已退出。
  }
  if (await waitExit(child, STOP_GRACE_MS)) return true;
  try {
    child.kill("SIGKILL");
  } catch {
    // 同上。
  }
  return waitExit(child, KILL_GRACE_MS);
}

const delay = (ms: number) =>
  new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  code: string,
  name: string,
): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw))
    throw failure(code, `${name} 必须是 ${min}-${max} 的整数。`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw failure(code, `${name} 必须是 ${min}-${max} 的整数。`);
  return parsed;
}

const base64url = (value: string | Buffer) =>
  (typeof value === "string" ? Buffer.from(value) : value).toString("base64url");

/** 只在内存中签发；调用方负责不把 token 写入磁盘、日志、argv 或子进程环境。 */
function signToken(privateKey: KeyObject): string {
  const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const payload = base64url(
    JSON.stringify({ p: { rw: { ns: ["default"] } }, exp: expires }),
  );
  const input = `${header}.${payload}`;
  return `${input}.${base64url(sign(null, Buffer.from(input), privateKey))}`;
}

export class SharedSqldProvider implements StoreProvider {
  readonly root: string;
  private config?: SharedConfig;
  private statePromise?: Promise<SharedState>;
  private running?: Running;
  private initializing?: Promise<Running>;
  private closing?: Promise<void>;
  private closed = false;

  constructor(private readonly env: Environment = process.env) {
    this.root = resolve(
      env.COMPANY_SQLD_ROOT?.trim() || join(homedir(), ".company-host"),
    );
  }

  /** 仅交给宿主内的 Workspace/沙箱做可见性检查；不进入 health 或 HTTP 响应。 */
  get privatePaths(): string[] {
    return [this.root];
  }

  async resolve(_scope: Readonly<StoreScope>): Promise<WasmStoreConfiguration> {
    const running = await this.ensure();
    if (this.closed)
      throw failure("shared_sqld_closed", "共享 sqld 已关闭；未返回存储配置。");
    const state = await this.loadState();
    if (this.closed)
      throw failure("shared_sqld_closed", "共享 sqld 已关闭；未返回存储配置。");
    let authToken: string;
    try {
      authToken = signToken(state.privateKey);
    } catch {
      throw failure(
        "shared_sqld_token_failed",
        "无法签发共享 sqld 临时凭据；未返回存储配置。",
      );
    }
    return { url: `http://127.0.0.1:${running.port}`, authToken };
  }

  private ensure(): Promise<Running> {
    if (this.closed)
      return Promise.reject(
        failure("shared_sqld_closed", "共享 sqld 已关闭；未返回存储配置。"),
      );
    const pending = this.initializing;
    if (pending) return pending;
    const work = this.prepare();
    this.initializing = work;
    const clear = () => {
      if (this.initializing === work) this.initializing = undefined;
    };
    void work.then(clear, clear);
    return work;
  }

  private async prepare(): Promise<Running> {
    const state = await this.loadState();
    if (this.running) {
      if (await healthy(this.running.port)) return this.running;
      if (this.running.child) {
        const stopped = await stopChild(this.running.child);
        if (!stopped)
          throw failure(
            "shared_sqld_stop_failed",
            "共享 sqld 未确认退出；拒绝启动第二个共享实例。",
          );
      }
      this.running = undefined;
    }
    return this.start(state);
  }

  private loadState(): Promise<SharedState> {
    const existing = this.statePromise;
    if (existing) return existing;
    const work = this.readState();
    this.statePromise = work;
    void work.catch(() => {
      if (this.statePromise === work) this.statePromise = undefined;
    });
    return work;
  }

  private async readState(): Promise<SharedState> {
    try {
      const config = this.loadConfig();
      await this.verifyBinary(config.binary);
      await this.verifyRootLocation(config.root);
      await ensurePrivateDir(config.root);
      await ensurePrivateDir(join(config.root, "sqld"));
      await ensurePrivateDir(config.sharedDir);
      await this.verifyRootLocation(config.root);
      const manifest = await this.readManifest(config.sharedDir);
      if (manifest && manifest.port !== config.port)
        throw failure(
          "shared_sqld_state_conflict",
          "共享 sqld manifest 的端口与 COMPANY_SQLD_PORT 不一致；拒绝启动第二个库或自动迁移。",
        );
      const privateKey = await this.loadKeys(
        config.sharedDir,
        Boolean(manifest),
      );
      const dbPath = join(config.sharedDir, "db");
      await this.checkDatabase(dbPath, Boolean(manifest));
      return { config, privateKey, manifest, dbPath };
    } catch (error) {
      if (error instanceof WasmStoreError) throw error;
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld 宿主状态不可用；未返回存储配置。",
      );
    }
  }

  private loadConfig(): SharedConfig {
    if (this.config) return this.config;
    const binary = (this.env.COMPANY_SQLD_BINARY ?? "").trim();
    if (!binary)
      throw failure(
        "shared_sqld_disabled",
        "未设置 COMPANY_SQLD_BINARY；共享本地 sqld 自动供给未启用。",
      );
    if (!isAbsolute(binary))
      throw failure(
        "shared_sqld_binary_invalid",
        "COMPANY_SQLD_BINARY 必须是绝对路径的可执行文件。",
      );
    const rawRoot = (this.env.COMPANY_SQLD_ROOT ?? "").trim();
    if (rawRoot && !isAbsolute(rawRoot))
      throw failure("shared_sqld_root_unsafe", "COMPANY_SQLD_ROOT 必须是绝对路径。");
    const root = resolve(rawRoot || join(homedir(), ".company-host"));
    const config: SharedConfig = {
      binary,
      root,
      sharedDir: join(root, "sqld", "shared"),
      port: integer(
        this.env.COMPANY_SQLD_PORT,
        DEFAULT_PORT,
        1,
        65535,
        "shared_sqld_config_invalid",
        "COMPANY_SQLD_PORT",
      ),
      startTimeoutMs: integer(
        this.env.COMPANY_SQLD_START_TIMEOUT_MS,
        DEFAULT_START_TIMEOUT_MS,
        1_000,
        60_000,
        "shared_sqld_config_invalid",
        "COMPANY_SQLD_START_TIMEOUT_MS",
      ),
    };
    this.config = config;
    return config;
  }

  private async verifyBinary(binary: string): Promise<void> {
    const info = await stat(binary).catch(() => null);
    const executable = info?.isFile()
      ? await access(binary, constants.X_OK)
          .then(() => true)
          .catch(() => false)
      : false;
    if (!executable)
      throw failure(
        "shared_sqld_binary_invalid",
        "COMPANY_SQLD_BINARY 必须是存在且可执行的绝对文件。",
      );
  }

  private async verifyRootLocation(root: string): Promise<void> {
    const canonicalRoot = await canonicalPath(root);
    const protectedRoots = [
      fileURLToPath(new URL("../..", import.meta.url)),
      join(homedir(), ".company", "agents", "runtime"),
    ];
    for (const protectedRoot of protectedRoots) {
      const canonicalProtected = await canonicalPath(protectedRoot);
      if (
        within(canonicalProtected, canonicalRoot) ||
        within(canonicalRoot, canonicalProtected)
      )
        throw failure(
          "shared_sqld_root_unsafe",
          "COMPANY_SQLD_ROOT 不能位于项目目录或 ~/.company/agents/runtime 中，也不能包含它们。",
        );
    }
  }

  private async readManifest(directory: string): Promise<Manifest | undefined> {
    const path = join(directory, "manifest.json");
    const info = await lstatIfExists(path);
    if (!info) return undefined;
    let document: any;
    try {
      document = JSON.parse(await readPrivateFile(path));
    } catch (error) {
      if (error instanceof WasmStoreError) throw error;
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld manifest 格式无效；未返回存储配置。",
      );
    }
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      document.backend !== SHARED_BACKEND ||
      document.version !== MANIFEST_VERSION ||
      !Number.isInteger(document.port) ||
      document.port < 1 ||
      document.port > 65535
    )
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld manifest 格式无效；拒绝自动覆盖或重建。",
      );
    return {
      backend: SHARED_BACKEND,
      version: MANIFEST_VERSION,
      port: document.port,
    };
  }

  private async loadKeys(
    directory: string,
    manifestExists: boolean,
  ): Promise<KeyObject> {
    const keyPath = join(directory, "auth.key");
    const pubPath = join(directory, "auth.pub");
    const key = await lstatIfExists(keyPath);
    const pub = await lstatIfExists(pubPath);
    if (!key && !pub) {
      if (manifestExists)
        throw failure(
          "shared_sqld_state_invalid",
          "共享 sqld manifest 已存在但缺少 Ed25519 密钥；拒绝生成新密钥。",
        );
      return this.createKeys(keyPath, pubPath);
    }
    if (!key)
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld 的 auth.key 缺失但 auth.pub 存在；拒绝生成新密钥。",
      );
    const privateKey = await this.readPrivateKey(keyPath);
    if (!pub) {
      const pem = createPublicKey(privateKey)
        .export({ type: "spki", format: "pem" })
        .toString();
      await writePrivateFile(pubPath, pem);
      return privateKey;
    }
    await this.verifyPublicKey(pubPath, privateKey);
    return privateKey;
  }

  private async createKeys(
    keyPath: string,
    pubPath: string,
  ): Promise<KeyObject> {
    const pair = (() => {
      try {
        return generateKeyPairSync("ed25519");
      } catch {
        throw failure(
          "shared_sqld_state_invalid",
          "无法生成共享 sqld 的 Ed25519 密钥；未返回存储配置。",
        );
      }
    })();
    const privatePem = pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const publicPem = pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    await writePrivateFile(keyPath, privatePem);
    await writePrivateFile(pubPath, publicPem);
    try {
      return createPrivateKey(privatePem);
    } catch {
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld 的 Ed25519 私钥不可用；未返回存储配置。",
      );
    }
  }

  private async readPrivateKey(path: string): Promise<KeyObject> {
    const pem = await readPrivateFile(path);
    let key: KeyObject;
    try {
      key = createPrivateKey(pem);
    } catch {
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld 的 auth.key 不是有效 PEM 私钥；拒签凭据。",
      );
    }
    if (key.asymmetricKeyType !== "ed25519")
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld 的 auth.key 必须是 Ed25519 私钥。",
      );
    return key;
  }

  private async verifyPublicKey(
    path: string,
    privateKey: KeyObject,
  ): Promise<void> {
    const pem = await readPrivateFile(path);
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(pem);
    } catch {
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld 的 auth.pub 不是有效 PEM 公钥。",
      );
    }
    if (publicKey.asymmetricKeyType !== "ed25519")
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld 的 auth.pub 必须是 Ed25519 公钥。",
      );
    const derived = createPublicKey(privateKey).export({
      type: "spki",
      format: "der",
    });
    const stored = publicKey.export({ type: "spki", format: "der" });
    if (!Buffer.from(derived).equals(Buffer.from(stored)))
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld 的 auth.pub 与 auth.key 不匹配；拒绝签发凭据。",
      );
  }

  private async checkDatabase(
    path: string,
    manifestExists: boolean,
  ): Promise<void> {
    const info = await lstatIfExists(path);
    if (info?.isSymbolicLink())
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld 数据路径不能是符号链接。",
      );
    if (manifestExists && !info)
      throw failure(
        "shared_sqld_state_invalid",
        "共享 sqld manifest 已存在但数据目录缺失；拒绝创建空库代替。",
      );
  }

  /**
   * 热重载复用：只接受本进程直接子进程、且 binary/db-path/listen 完全一致的 sqld。
   * 不向候选进程发送任何凭据，也不终止无法确认归属的进程。
   */
  private async adoptRunning(state: SharedState): Promise<Running | undefined> {
    const { config } = state;
    const output = await new Promise<string>((resolveOutput) => {
      execFile(
        "ps",
        ["-ww", "-axo", "pid=,ppid=,command="],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => resolveOutput(error ? "" : stdout),
      );
    });
    if (!output) return undefined;
    const expected = `--db-path ${state.dbPath}`;
    const listen = `--http-listen-addr 127.0.0.1:${config.port}`;
    const matched = output.split("\n").some((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match || Number(match[2]) !== process.pid) return false;
      const command = match[3];
      return (
        command.includes(config.binary) &&
        command.includes(expected) &&
        command.includes(listen)
      );
    });
    if (!matched) return undefined;
    // 直接子进程身份已确认；健康检查只用于平滑刚重启的窗口，不作为归属依据。
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await healthy(config.port)) break;
      await delay(100);
    }
    return { port: config.port, adopted: true };
  }

  private async start(state: SharedState): Promise<Running> {
    const { config } = state;
    if (!(await portAvailable(config.port))) {
      // `bun --watch` 在同一进程内重跑模块，上一实例 spawn 的 sqld 仍是本进程的
      // 直接子进程。只承认命令、数据库路径与监听端口完全匹配的直接子进程；
      // 不终止、不连接也无法确认归属的进程。
      const adopted = await this.adoptRunning(state);
      if (adopted) {
        this.running = adopted;
        return adopted;
      }
      throw failure(
        "shared_sqld_port_conflict",
        "配置的共享 sqld 端口已被占用，且无法确认是本服务实例；不会连接或终止占用进程。",
      );
    }
    let child: ChildProcess;
    try {
      child = spawn(
        config.binary,
        [
          "--db-path",
          state.dbPath,
          "--http-listen-addr",
          `127.0.0.1:${config.port}`,
          "--auth-jwt-key-file",
          join(config.sharedDir, "auth.pub"),
          "--no-welcome",
        ],
        {
          cwd: config.sharedDir,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: config.sharedDir,
            TMPDIR: config.sharedDir,
          },
          stdio: "ignore",
          detached: false,
        },
      );
    } catch {
      throw failure(
        "shared_sqld_start_failed",
        "无法启动共享 sqld；未返回存储配置。",
      );
    }
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    try {
      await this.waitHealthy(
        child,
        config.port,
        config.startTimeoutMs,
        () => spawnError,
      );
      if (!state.manifest) await this.writeManifest(state);
      const running = { child, port: config.port };
      this.running = running;
      return running;
    } catch (error) {
      const stopped = await stopChild(child);
      if (!stopped) {
        this.running = { child, port: config.port };
        throw failure(
          "shared_sqld_stop_failed",
          "共享 sqld 启动失败且进程未确认退出；保留句柄供 close 重试。",
        );
      }
      throw error instanceof WasmStoreError
        ? error
        : failure(
            "shared_sqld_start_failed",
            "共享 sqld 启动失败；未返回存储配置。",
          );
    }
  }

  private async waitHealthy(
    child: ChildProcess,
    port: number,
    timeoutMs: number,
    spawnError: () => Error | undefined,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError() || exited(child))
        throw failure(
          "shared_sqld_start_failed",
          "共享 sqld 进程未能保持运行；未返回存储配置。",
        );
      if (await healthy(port)) return;
      await delay(100);
    }
    throw failure(
      "shared_sqld_health_timeout",
      "共享 sqld 在超时前未通过 /health；不会返回存储配置。",
    );
  }

  private async writeManifest(state: SharedState): Promise<void> {
    const path = join(state.config.sharedDir, "manifest.json");
    const temporary = path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          backend: SHARED_BACKEND,
          version: MANIFEST_VERSION,
          port: state.config.port,
        }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, path);
    } catch {
      await unlink(temporary).catch(() => {});
      throw failure(
        "shared_sqld_state_invalid",
        "无法持久化共享 sqld manifest；未返回存储配置。",
      );
    }
    state.manifest = {
      backend: SHARED_BACKEND,
      version: MANIFEST_VERSION,
      port: state.config.port,
    };
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.closing) return this.closing;
    const work = (async () => {
      const initializing = this.initializing;
      if (initializing) {
        try {
          await initializing;
        } catch {
          // 启动已自行清理或保留 running，供下面确认退出。
        }
      }
      if (!this.running) return;
      if (this.running.adopted) {
        // 热重载复用的是上一模块实例 spawn 的进程；不越权终止它。
        this.running = undefined;
        return;
      }
      if (!this.running.child) {
        this.running = undefined;
        return;
      }
      const stopped = await stopChild(this.running.child);
      if (!stopped)
        throw failure(
          "shared_sqld_close_failed",
          "共享 sqld 未确认退出；保留句柄，可重试关闭。",
        );
      this.running = undefined;
    })();
    this.closing = work;
    void work.catch(() => {
      if (this.closing === work) this.closing = undefined;
    });
    return work;
  }
}

/** 显式 stores 条目优先；仅当当前 scope 缺配时才回退到共享供给器。 */
export class ExplicitFirstStoreProvider implements StoreProvider {
  constructor(
    private readonly explicit: StoreProvider,
    private readonly shared: StoreProvider,
  ) {}
  async resolve(scope: Readonly<StoreScope>): Promise<WasmStoreConfiguration> {
    try {
      return await this.explicit.resolve(scope);
    } catch (error) {
      if (
        error instanceof WasmStoreError &&
        error.code === "wasm_store_not_configured"
      )
        return this.shared.resolve(scope);
      throw error;
    }
  }
}

export function sharedSqldProviderFromEnv(
  env: Environment = process.env,
): SharedSqldProvider | undefined {
  if (!(env.COMPANY_SQLD_BINARY ?? "").trim()) return undefined;
  return new SharedSqldProvider(env);
}
