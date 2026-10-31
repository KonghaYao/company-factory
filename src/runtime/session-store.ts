import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ChatDatabase,
  ChatSessionDirectoryEntry,
  KvStorage,
} from "@peri-code/sdk";

/** 仅供 legacy 识别的只读 native 适配器；WASM 主路径不读写此 schema。 */
export class NativeSessionStore implements ChatDatabase {
  constructor(readonly path: string) {}
  private query(
    where: string,
    parameters: string[],
  ): ChatSessionDirectoryEntry[] {
    if (!existsSync(this.path)) return [];
    const database = new Database(this.path, { readonly: true });
    try {
      return database
        .query(
          `SELECT id AS sessionId,title,cwd,message_count AS messageCount,created_at AS createdAt,updated_at AS updatedAt FROM threads ${where} ORDER BY updated_at DESC`,
        )
        .all(...parameters) as ChatSessionDirectoryEntry[];
    } finally {
      database.close();
    }
  }
  async listSessions(path?: string) {
    return this.query(
      path ? "WHERE cwd = ? AND hidden = 0" : "WHERE hidden = 0",
      path ? [path] : [],
    );
  }
  async getSession(id: string) {
    return this.query("WHERE id = ?", [id])[0] ?? null;
  }
}
/** Single-process ownership markers. No stale cross-process lease/recovery system is introduced. */
export class ProcessOwnershipStore implements KvStorage {
  private values = new Map<string, unknown>();
  async getItem(key: string) {
    return this.values.get(key);
  }
  async setItem(key: string, value: unknown) {
    this.values.set(key, value);
  }
  async removeItem(key: string) {
    this.values.delete(key);
  }
}

/** 保留旧 native 数据目录；不再用作 WASM Manager 的 database 或迁移目标。 */
export class NativeSessionDirectory implements ChatDatabase {
  constructor(readonly path: string) {}
  private stores() {
    return existsSync(this.path)
      ? readdirSync(this.path, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map(
            (e) =>
              new NativeSessionStore(join(this.path, e.name, "sessions.db")),
          )
      : [];
  }
  async listSessions(path?: string) {
    const groups = await Promise.all(
      this.stores().map((s) => s.listSessions(path)),
    );
    return groups.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getSession(id: string) {
    for (const store of this.stores()) {
      const session = await store.getSession(id);
      if (session) return session;
    }
    return null;
  }
}
