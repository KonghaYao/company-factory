import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  access,
  realpath,
} from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import { simpleGit } from "simple-git";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sandboxCommand } from "../runtime/sandbox";
const execFileAsync = promisify(execFile);
import { DomainError, requireValue } from "../domain/types";

export function safeId(value: unknown, label = "id"): string {
  requireValue(
    typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value),
    "invalid_input",
    `${label} must be 1–96 letters, digits, underscores or hyphens`,
  );
  return value;
}
export function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      typeof value === "string" ? value : JSON.stringify(canonical(value)),
    )
    .digest("hex");
}
function canonical(v: any): any {
  return Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
}
export class CompanyStore {
  readonly root: string;
  private locks = new Map<string, Promise<unknown>>();
  constructor(root: string) {
    this.root = resolve(root);
  }
  company(id: string) {
    return join(this.root, "companys", safeId(id, "companyId"));
  }
  agent(id: string) {
    return join(this.root, "agents", safeId(id, "agentId"));
  }
  async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
  async exists(path: string) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
  async ids(path: string): Promise<string[]> {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .filter((f) => f.isDirectory())
        .map((f) => f.name)
        .sort();
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async files(path: string): Promise<string[]> {
    try {
      return (await readdir(path))
        .filter((f) => f.endsWith(".md"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async raw(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch (e: any) {
      if (e.code === "ENOENT")
        throw new DomainError("not_found", "Record not found", 404);
      throw e;
    }
  }
  async yaml<T = any>(path: string): Promise<T> {
    const doc = parseDocument(await this.raw(path));
    if (doc.errors.length)
      throw new DomainError(
        "invalid_document",
        `Invalid YAML: ${doc.errors[0]?.message}`,
        500,
      );
    return doc.toJSON() as T;
  }
  async markdown<T = any>(path: string): Promise<T> {
    const raw = await this.raw(path);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
    requireValue(match, "invalid_document", "Expected YAML front matter", 500);
    const doc = parseDocument(match[1]!);
    requireValue(
      !doc.errors.length,
      "invalid_document",
      "Invalid YAML front matter",
      500,
    );
    return { ...doc.toJSON(), body: match[2] } as T;
  }
  async atomic(path: string, content: string) {
    requireValue(
      !relative(this.root, resolve(path)).startsWith(".."),
      "invalid_path",
      "Write escaped Company root",
    );
    await mkdir(resolve(path, ".."), { recursive: true });
    const temp = `${path}.tmp-${randomUUID()}`;
    await writeFile(temp, content, "utf8");
    await rename(temp, path);
  }
  async putYaml(path: string, data: any, expectedVersion?: number) {
    let doc;
    if (await this.exists(path)) {
      doc = parseDocument(await this.raw(path));
      const current = doc.toJSON();
      if (expectedVersion !== undefined && current.version !== expectedVersion)
        throw new DomainError("version_conflict", "Record has changed", 409, {
          actualVersion: current.version,
        });
      for (const [k, v] of Object.entries(data)) doc.set(k, v);
    } else {
      if (expectedVersion !== undefined && expectedVersion !== 0)
        throw new DomainError("version_conflict", "Record does not exist", 409);
      doc = parseDocument(stringify(data));
    }
    await this.atomic(path, String(doc));
  }
  async putMarkdown(path: string, data: any, expectedVersion?: number) {
    const { body, ...head } = data;
    let doc;
    if (await this.exists(path)) {
      const raw = await this.raw(path);
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
      requireValue(
        match,
        "invalid_document",
        "Expected YAML front matter",
        500,
      );
      doc = parseDocument(match[1]!);
      const current = doc.toJSON();
      if (expectedVersion !== undefined && current.version !== expectedVersion)
        throw new DomainError("version_conflict", "Record has changed", 409, {
          actualVersion: current.version,
        });
      for (const [k, v] of Object.entries(head)) doc.set(k, v);
    } else {
      if (expectedVersion !== undefined && expectedVersion !== 0)
        throw new DomainError("version_conflict", "Record does not exist", 409);
      doc = parseDocument(stringify(head));
    }
    await this.atomic(
      path,
      `---\n${String(doc).trimEnd()}\n---\n${body ?? ""}`,
    );
  }
  private isAgentDirectory(dir: string): boolean {
    const rel = relative(join(this.root, "agents"), resolve(dir));
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
  }
  /** Agent Git config, hooks, fsmonitor and filters are untrusted executable code.
   * Every Git subprocess stays inside the same OS boundary as official Workspace.
   * Disabling selected hooks is not an adequate substitute for this boundary.
   */
  private async agentGit(dir: string, args: string[]): Promise<string> {
    const canonical = await realpath(dir);
    const agentRoot = await realpath(join(this.root, "agents"));
    const rel = relative(agentRoot, canonical);
    requireValue(
      rel !== "" && !rel.startsWith("..") && !rel.startsWith("/"),
      "forbidden",
      "Agent Git directory escaped the private Agent root",
      403,
    );
    const launch = sandboxCommand("/usr/bin/git", args, {
      directory: canonical,
      companyHome: this.root,
    });
    const result = await execFileAsync(launch.command, launch.args, {
      cwd: canonical,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/tmp",
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return result.stdout;
  }
  async initGit(dir: string) {
    await mkdir(dir, { recursive: true });
    if (this.isAgentDirectory(dir)) {
      if (!(await this.exists(join(dir, ".git"))))
        await this.agentGit(dir, ["init"]);
      await this.agentGit(dir, [
        "config",
        "--local",
        "user.name",
        "Company Factory",
      ]);
      await this.agentGit(dir, [
        "config",
        "--local",
        "user.email",
        "company@localhost",
      ]);
      return;
    }
    const git = simpleGit(dir);
    if (!(await this.exists(join(dir, ".git")))) await git.init();
    await git.addConfig("user.name", "Company Factory");
    await git.addConfig("user.email", "company@localhost");
  }
  async commit(dir: string, message: string) {
    await this.initGit(dir);
    if (this.isAgentDirectory(dir)) {
      await this.agentGit(dir, ["add", "."]);
      if ((await this.agentGit(dir, ["status", "--porcelain=v1"])).trim()) {
        await this.agentGit(dir, ["commit", "-m", message]);
      }
      return;
    }
    const git = simpleGit(dir);
    await git.add(".");
    if ((await git.status()).files.length) await git.commit(message);
  }
  async history(dir: string) {
    try {
      if (this.isAgentDirectory(dir)) {
        const raw = await this.agentGit(dir, [
          "log",
          "-20",
          "--format=%H%x00%aI%x00%s%x00%D%x00%b%x00%aN%x00%aE%x1e",
        ]);
        return raw
          .split("\x1e")
          .map((row) => row.trim())
          .filter(Boolean)
          .map((row) => {
            const [
              hash = "",
              date = "",
              message = "",
              refs = "",
              body = "",
              author_name = "",
              author_email = "",
            ] = row.split("\0");
            return {
              hash,
              date,
              message,
              refs,
              body,
              author_name,
              author_email,
            };
          });
      }
      return (await simpleGit(dir).log({ maxCount: 20 })).all;
    } catch (error) {
      // Empty/unborn repositories have no history, but a missing OS boundary must
      // be visible instead of silently claiming a valid empty Git result.
      if (this.isAgentDirectory(dir)) {
        const stderr = String((error as { stderr?: string }).stderr ?? "");
        if (/does not have any commits yet|bad default revision/.test(stderr))
          return [];
        throw error;
      }
      return [];
    }
  }
}
