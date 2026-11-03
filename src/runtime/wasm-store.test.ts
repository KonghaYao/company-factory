import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStoreProvider, WasmStoreDirectory, storeScopeId, type StoreScope } from "./wasm-store";

// 只覆盖宿主配置/backend 边界；不发 HTTP、不伪造真实 WASM Session。
const temporary: string[] = [];
const token = () => crypto.randomUUID();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "company-wasm-config-"));
  temporary.push(root);
  const scope: StoreScope = { companyId: "company", agentId: "agent", directory: join(root, "agents", "agent") };
  await mkdir(scope.directory, { recursive: true });
  const file = join(root, "private-stores.json");
  const authToken = token();
  const write = (stores: unknown[]) => writeFile(file, JSON.stringify({ stores }), { mode: 0o600 });
  const entry = { companyId: scope.companyId, agentId: scope.agentId, url: "http://127.0.0.1:18081", authToken };
  await write([entry]);
  return { root, scope, file, entry, write, provider: new FileStoreProvider({ root, file }) };
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe("WASM 显式 url/token 存储配置与可信 backend（无数据库请求）", () => {
  test("缺配给出必要字段和 scope 请求文件，不回显端点或 token", async () => {
    const { root, scope } = await fixture();
    const directory = new WasmStoreDirectory({ root, provider: new FileStoreProvider({ root }) });
    await expect(directory.acquire(scope)).rejects.toMatchObject({ code: "wasm_store_not_configured" });
    const request = JSON.parse(await readFile(join(root, "runtime", "store-requests", storeScopeId(scope) + ".json"), "utf8"));
    expect(request).toEqual({ companyId: "company", agentId: "agent", backend: "wasm-sqld-v1" });
  });
  test("精确匹配 scope；明文 token 仅交给宿主 SDK", async () => {
    const f = await fixture();
    expect(await f.provider.resolve(f.scope)).toEqual({ url: f.entry.url + "/", authToken: f.entry.authToken });
    await expect(f.provider.resolve({ ...f.scope, agentId: "other" })).rejects.toMatchObject({ code: "wasm_store_not_configured" });
  });
  test("拒绝同 scope 重复；允许不同 Agent 共用同一回环端点", async () => {
    const f = await fixture();
    await f.write([f.entry, f.entry]);
    await expect(f.provider.resolve(f.scope)).rejects.toMatchObject({ code: "wasm_store_conflict" });
    for (const second of [{ ...f.entry, agentId: "other" }, { ...f.entry, agentId: "other", url: "http://[::1]:18081" }]) {
      await f.write([f.entry, second]);
      expect(await f.provider.resolve(f.scope)).toEqual({ url: f.entry.url + "/", authToken: f.entry.authToken });
    }
  });
  test("拒绝外域、userinfo、query、fragment 和非规范回环", async () => {
    const f = await fixture();
    for (const url of ["https://example.invalid", "http://localhost:18081", "http://127.1:18081", "http://127.0.0.1:18081?secret=x", "http://127.0.0.1:18081/#x", "http://user:pass@127.0.0.1:18081"]) {
      await f.write([{ ...f.entry, url }]);
      try { await f.provider.resolve(f.scope); throw new Error("必须拒绝 URL"); } catch (error: any) {
        expect(error.code).toBe("wasm_store_invalid_url");
        expect(error.message).not.toContain(f.entry.authToken);
        expect(error.message).not.toContain(url);
      }
    }
  });
  test("允许回环端点带数据库路径", async () => {
    const f = await fixture();
    const url = "http://127.0.0.1:18081/db/local_default/demo/main";
    await f.write([{ ...f.entry, url }]);
    expect(await f.provider.resolve(f.scope)).toEqual({ url, authToken: f.entry.authToken });
  });
  test("全局 default 覆盖未列出的 scope，精确条目优先", async () => {
    const f = await fixture();
    const fallback = { url: "http://127.0.0.1:18083/db/local_default/demo/main", authToken: token() };
    await writeFile(f.file, JSON.stringify({ default: fallback, stores: [f.entry] }), { mode: 0o600 });
    expect(await f.provider.resolve(f.scope)).toEqual({ url: f.entry.url + "/", authToken: f.entry.authToken });
    const other = { ...f.scope, agentId: "other", directory: join(f.root, "agents", "other") };
    expect(await f.provider.resolve(other)).toEqual(fallback);
  });
  test("非法 default 被拒绝且不回显", async () => {
    const f = await fixture();
    const bad = { url: "http://example.invalid", authToken: token() };
    await writeFile(f.file, JSON.stringify({ default: bad, stores: [] }), { mode: 0o600 });
    try {
      await f.provider.resolve({ ...f.scope, agentId: "other" });
      throw new Error("必须拒绝 default");
    } catch (error: any) {
      expect(error.code).toBe("wasm_store_invalid_url");
      expect(error.message).not.toContain(bad.authToken);
      expect(error.message).not.toContain(bad.url);
    }
  });
  test("拒绝 group/world 权限、符号链接和 Agent 可见文件", async () => {
    const f = await fixture();
    await chmod(f.file, 0o640);
    await expect(f.provider.resolve(f.scope)).rejects.toMatchObject({ code: "wasm_store_config_permissions" });
    await chmod(f.file, 0o600);
    const link = join(f.root, "stores-link.json");
    await symlink(f.file, link);
    await expect(new FileStoreProvider({ root: f.root, file: link }).resolve(f.scope)).rejects.toMatchObject({ code: "wasm_store_config_invalid" });
    const visible = join(f.scope.directory, "stores.json");
    await writeFile(visible, JSON.stringify({ stores: [f.entry] }), { mode: 0o600 });
    await expect(new FileStoreProvider({ root: f.root, file: visible }).resolve(f.scope)).rejects.toMatchObject({ code: "wasm_store_config_exposed" });
  });
  test("legacy Session/native db 在解析 provider 前拒绝，保留数据", async () => {
    const f = await fixture();
    let calls = 0;
    const directory = new WasmStoreDirectory({ root: f.root, provider: { async resolve() { calls++; return f.entry; } } });
    await expect(directory.acquire(f.scope, "old-session")).rejects.toMatchObject({ code: "legacy_session_backend" });
    const native = join(f.root, "runtime", "agents", f.scope.agentId);
    await mkdir(native, { recursive: true });
    await writeFile(join(native, "sessions.db"), "legacy-marker");
    await expect(directory.acquire(f.scope)).rejects.toMatchObject({ code: "legacy_session_backend" });
    expect(calls).toBe(0);
    expect(await readFile(join(native, "sessions.db"), "utf8")).toBe("legacy-marker");
  });
  test("可信绑定按 backend/scope/cwd 匹配；只允许 token 轮转", async () => {
    const f = await fixture();
    const directory = join(f.root, "runtime", "wasm-stores");
    await mkdir(directory, { recursive: true });
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const path = join(directory, storeScopeId(f.scope) + ".json");
    const binding = {
      backend: "wasm-sqld-v1", companyId: f.scope.companyId, agentId: f.scope.agentId,
      cwd: f.scope.directory, storeIdentity: digest(f.entry.url + "/"),
      state: "bound", sessionId: "bound-session",
    };
    await writeFile(path, JSON.stringify(binding), { mode: 0o600 });
    const stores = new WasmStoreDirectory({ root: f.root, provider: f.provider });
    expect((await stores.acquire(f.scope, "bound-session")).sessionId).toBe("bound-session");
    await f.write([{ ...f.entry, authToken: token() }]);
    expect((await stores.acquire(f.scope, "bound-session")).sessionId).toBe("bound-session");
    await expect(stores.acquire(f.scope, "different-session")).rejects.toMatchObject({ code: "wasm_session_binding_mismatch" });
    await f.write([{ ...f.entry, url: "http://127.0.0.1:18082" }]);
    await expect(stores.acquire(f.scope, "bound-session")).rejects.toMatchObject({ code: "wasm_store_backend_changed" });
    expect(await stores.getSession("untrusted-session")).toBeNull();
    expect(await stores.listSessions("/other-cwd")).toEqual([]);
    expect(await readFile(path, "utf8")).not.toContain(f.entry.authToken);
    expect(await readFile(path, "utf8")).not.toContain(f.entry.url);
    await writeFile(path, JSON.stringify({ ...binding, state: "creating", sessionId: undefined }));
    await expect(stores.acquire(f.scope)).rejects.toMatchObject({ code: "wasm_session_creation_unconfirmed" });
  });
  test("存储端点丢失旧 Session 后，可原子替换为新的固定 Session", async () => {
    const f = await fixture();
    const directory = join(f.root, "runtime", "wasm-stores");
    await mkdir(directory, { recursive: true });
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const path = join(directory, storeScopeId(f.scope) + ".json");
    const binding = {
      backend: "wasm-sqld-v1", companyId: f.scope.companyId, agentId: f.scope.agentId,
      cwd: f.scope.directory, storeIdentity: digest(f.entry.url + "/"),
      state: "bound", sessionId: "bound-session",
    };
    await writeFile(path, JSON.stringify(binding), { mode: 0o600 });
    const stores = new WasmStoreDirectory({ root: f.root, provider: f.provider });
    const store = await stores.acquire(f.scope, "bound-session");
    expect(await stores.boundSessionId(f.scope)).toBe("bound-session");
    expect(await stores.boundSessionId({ companyId: f.scope.companyId, agentId: "other" })).toBeUndefined();
    await store.replaceBinding("bound-session", "replacement-session");
    expect(store.sessionId).toBe("replacement-session");
    expect(await stores.boundSessionId(f.scope)).toBe("replacement-session");
    const reopened = await new WasmStoreDirectory({ root: f.root, provider: f.provider }).acquire(f.scope, "replacement-session");
    expect(reopened.sessionId).toBe("replacement-session");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...binding, sessionId: "replacement-session", replacesSessionId: "bound-session" });
    await expect(store.replaceBinding("wrong-old-id", "another")).rejects.toMatchObject({ code: "wasm_session_binding_mismatch" });
    const unchanged = await readFile(path, "utf8");
    expect(JSON.parse(unchanged).sessionId).toBe("replacement-session");
    expect(unchanged).not.toContain("another");
  });
  test("同一端点与凭据共用一条 TursoStorage；closeAll 只关闭一次", async () => {
    const f = await fixture();
    const other: StoreScope = { companyId: f.scope.companyId, agentId: "other", directory: join(f.root, "agents", "other") };
    await mkdir(other.directory, { recursive: true });
    await f.write([f.entry, { ...f.entry, agentId: "other" }]);
    const stores = new WasmStoreDirectory({ root: f.root, provider: f.provider });
    const first = await stores.acquire(f.scope);
    const second = await stores.acquire(other);
    expect(first.storage).toBe(second.storage);
    let closes = 0;
    const close = first.storage.close.bind(first.storage);
    first.storage.close = async () => { closes++; await close(); };
    expect(await stores.closeAll()).toBe(false);
    expect(closes).toBe(1);
  });
  test("provider 原始异常不泄露；运行时响应递归移除 store 凭据", async () => {
    const f = await fixture();
    const broken = new WasmStoreDirectory({ root: f.root, provider: { async resolve() { throw new Error(f.entry.authToken); } } });
    try { await broken.acquire(f.scope); } catch (error: any) {
      expect(error.code).toBe("wasm_store_provider_failed");
      expect(error.message).not.toContain(f.entry.authToken);
    }
    const stores = new WasmStoreDirectory({ root: f.root, provider: f.provider });
    await stores.acquire(f.scope);
    expect(JSON.stringify(stores.redact({ error: { message: f.entry.authToken + " " + f.entry.url + "/" } }))).not.toContain(f.entry.authToken);
  });
});
