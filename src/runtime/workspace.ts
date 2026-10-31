import { resolve, relative, join, dirname, basename } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { StdioTransport } from "./stdio-transport";
import type { RuntimeAgent } from "./index";
import { sandboxCommand } from "./sandbox";
export {
  createWorkspaceMcpServerFactory,
  type WorkspaceMcpServerOptions,
} from "./workspace-mcp";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export class WorkspaceError extends Error {
  readonly status: number;
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status =
      code === "forbidden" ? 403 : code === "version_conflict" ? 409 : 400;
  }
}
/** A view adapter over the official Workspace MCP, not a filesystem server.
 * Exact-byte editor payloads use its existing Bash tool because Read is line-numbered,
 * truncated model presentation. All actual user file I/O executes inside Workspace.
 */
export class WorkspaceViewAdapter {
  private clients = new Map<string, Promise<StdioTransport>>();
  private fingerprints = new Map<string, string>();
  private clientLocks = new Map<string, Promise<unknown>>();
  private writes = new Map<string, Promise<unknown>>();
  constructor(private options: { periBinary: string; home?: string; companyHome?: string; privatePaths?: string[] }) {}
  private async client(input: RuntimeAgent): Promise<StdioTransport> {
    const key = `${input.companyId}/${input.agentId}`;
    const previous = this.clientLocks.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const versions = await Promise.all(
          ["agent.yaml", ".mcp.json"].map(async (name) => {
            const value = await stat(join(input.directory, name)).catch(
              () => null,
            );
            return value ? `${value.ino}:${value.mtimeMs}` : "missing";
          }),
        );
        const fingerprint = JSON.stringify([
          input.directory,
          input.knowledgeDirectory,
          (input.configuration ?? input.config ?? {}).workspaceRoots ?? [],
          versions,
        ]);
        const existing = this.clients.get(key);
        if (existing && this.fingerprints.get(key) === fingerprint)
          return existing;
        if (existing) {
          await (await existing).close();
          this.clients.delete(key);
        }
        const pending = (async () => {
          const command = sandboxCommand(
            this.options.periBinary,
            [
              "mcp-start",
              "workspace",
              "--stdio",
              "--workspace",
              input.directory,
            ],
            {
              directory: input.directory,
              companyHome: this.options.companyHome,
              privatePaths: this.options.privatePaths,
              knowledgeDirectory: input.knowledgeDirectory,
              projectRoots: (input.configuration ?? input.config ?? {})
                .workspaceRoots,
            },
          );
          const transport = new StdioTransport(command.command, command.args, {
            cwd: input.directory,
            env: {
              PATH: process.env.PATH,
              LANG: process.env.LANG ?? "C.UTF-8",
              HOME: "/tmp",
            },
          });
          try {
            await transport.request("initialize", {
              protocolVersion: "2025-06-18",
              capabilities: { roots: { listChanged: false } },
              clientInfo: { name: "company-workspace-view", version: "1.0.0" },
            });
            await transport.notify("notifications/initialized", {});
            return transport;
          } catch (e) {
            await transport.close();
            throw e;
          }
        })();
        this.clients.set(key, pending);
        this.fingerprints.set(key, fingerprint);
        try {
          return await pending;
        } catch (e) {
          if (this.clients.get(key) === pending) {
            this.clients.delete(key);
            this.fingerprints.delete(key);
          }
          throw e;
        }
      });
    this.clientLocks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.clientLocks.get(key) === next) this.clientLocks.delete(key);
    }
  }
  async capabilities(input: RuntimeAgent) {
    return (await this.client(input)).request("tools/list", {});
  }
  async tool(input: RuntimeAgent, name: string, args: Record<string, unknown>) {
    const result: any = await (
      await this.client(input)
    ).request("tools/call", { name, arguments: args });
    const text = (result.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    if (result.isError)
      throw new WorkspaceError(
        "workspace_tool_failed",
        text || `${name} failed`,
      );
    return { ...result, text };
  }
  roots(input: RuntimeAgent) {
    return [
      { name: input.agentId, path: input.directory, kind: "agent" },
      ...(input.knowledgeDirectory
        ? [
            {
              name: "公司知识",
              path: input.knowledgeDirectory,
              kind: "knowledge",
            },
          ]
        : []),
      ...((input.configuration ?? input.config ?? {}).workspaceRoots ?? []).map(
        (path: string) => ({
          name: "项目 " + basename(path),
          path,
          kind: "project",
        }),
      ),
    ];
  }
  private async path(input: RuntimeAgent, path?: string, writable = false) {
    const absolute = resolve(input.directory, path || ".");
    // Canonical checks reject symlink escape; new files use their canonical parent.
    let canonical: string;
    try {
      canonical = await realpath(absolute);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      let parent = absolute;
      const suffix: string[] = [];
      while (true) {
        try {
          canonical = join(await realpath(parent), ...suffix);
          break;
        } catch (next: any) {
          if (next.code !== "ENOENT") throw next;
          const up = dirname(parent);
          if (up === parent) throw next;
          suffix.unshift(basename(parent));
          parent = up;
        }
      }
    }
    const roots = await Promise.all(
      this.roots(input).map(async (root) => realpath(root.path)),
    );
    if (
      !roots.some(
        (root) =>
          canonical === root ||
          (!relative(root, canonical).startsWith("..") &&
            !relative(root, canonical).startsWith("/")),
      )
    )
      throw new WorkspaceError(
        "forbidden",
        "File is outside this Agent and company knowledge roots.",
      );
    if (
      writable &&
      canonical ===
        (await realpath(join(input.directory, "agent.yaml")).catch(() =>
          join(input.directory, "agent.yaml"),
        ))
    )
      throw new WorkspaceError(
        "forbidden",
        "Agent identity/configuration is managed through the Company configuration interface.",
      );
    if (
      writable &&
      canonical ===
        (await realpath(join(input.directory, ".mcp.json")).catch(() =>
          join(input.directory, ".mcp.json"),
        ))
    )
      throw new WorkspaceError(
        "forbidden",
        "Trusted MCP identity configuration is managed through the Company configuration interface.",
      );
    if (
      writable &&
      canonical ===
        (await realpath(join(input.directory, ".env")).catch(() =>
          join(input.directory, ".env"),
        ))
    )
      throw new WorkspaceError(
        "forbidden",
        "The Agent environment file is read-only; model credentials and endpoints are host-trusted configuration.",
      );
    if (
      writable &&
      relative(input.directory, canonical).split(/[\\/]/).includes(".git")
    )
      throw new WorkspaceError(
        "forbidden",
        "Git internals are read-only in the file editor.",
      );
    if (writable) {
      const info = await stat(canonical).catch(() => null);
      if (info && info.nlink > 1)
        throw new WorkspaceError(
          "forbidden",
          "Hard-linked files cannot be edited through the workspace view.",
        );
    }
    return canonical;
  }
  private async script(
    input: RuntimeAgent,
    body: string,
    args: unknown[] = [],
  ) {
    // This executable is the already-running Bun host, passed as an absolute path.
    // Generated JSON strings are shell-quoted; user text never becomes shell syntax.
    const source = `const args=${JSON.stringify(args)};const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const cp=require('node:child_process');const hash=x=>crypto.createHash('sha256').update(x).digest('hex');try { ${body} } catch(e){ console.log('COMPANY_JSON:'+JSON.stringify({__error:String(e.message),code:e.code||'workspace_error'})); }`;
    const result = await this.tool(input, "Bash", {
      command: `${quote(process.execPath)} -e ${quote(source)}`,
      timeout: 15000,
    });
    const line = result.text
      .split("\n")
      .find((line: string) => line.startsWith("COMPANY_JSON:"));
    if (!line)
      throw new WorkspaceError(
        "workspace_output_unavailable",
        "Default Workspace output was truncated or not a JSON view result.",
        result.text,
      );
    const value = JSON.parse(line.slice("COMPANY_JSON:".length));
    if (value.__error)
      throw new WorkspaceError(value.code, value.__error, value);
    return value;
  }
  async list(input: RuntimeAgent, path?: string) {
    const target = await this.path(input, path);
    const entries: any[] = [];
    let offset = 0;
    let total = 0;
    do {
      const data = await this.script(
        input,
        `const entries=fs.readdirSync(args[0],{withFileTypes:true}).map(e=>({name:e.name,path:path.join(args[0],e.name),type:e.isDirectory()?'directory':e.isSymbolicLink()?'symlink':'file'})).sort((a,b)=>(a.type==='directory'?0:1)-(b.type==='directory'?0:1)||a.name.localeCompare(b.name));const page=[];let end=args[1];while(end<entries.length){const next=[...page,entries[end]];if(page.length&&Buffer.byteLength(JSON.stringify(next))>6000)break;page.push(entries[end++]);}console.log('COMPANY_JSON:'+JSON.stringify({entries:page,total:entries.length,next:end}));`,
        [target, offset],
      );
      entries.push(...data.entries);
      total = data.total;
      offset = data.next;
    } while (offset < total);
    return { entries, path: target, roots: this.roots(input) };
  }
  async read(input: RuntimeAgent, path: string) {
    const target = await this.path(input, path);
    const metadata = await this.script(
      input,
      `const b=fs.readFileSync(args[0]);if(b.length>1024*1024)throw Error('Editor limit is 1 MiB; use Workspace Read for paged access.');if(b.includes(0))throw Error('Binary file: text editing is unavailable.');console.log('COMPANY_JSON:'+JSON.stringify({size:b.length,version:hash(b)}));`,
      [target],
    );
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < metadata.size; offset += 4000) {
      const chunk = await this.script(
        input,
        `const b=fs.readFileSync(args[0]);if(hash(b)!==args[2]){const e=Error('File changed during paged read; retry.');e.code='version_conflict';throw e;}console.log('COMPANY_JSON:'+JSON.stringify({data:b.subarray(args[1],args[1]+4000).toString('base64')}));`,
        [target, offset, metadata.version],
      );
      chunks.push(Buffer.from(chunk.data, "base64"));
    }
    return {
      path: target,
      content: Buffer.concat(chunks).toString("utf8"),
      version: metadata.version,
    };
  }
  async save(
    input: RuntimeAgent,
    path: string,
    content: string,
    expectedVersion: string,
  ) {
    const target = await this.path(input, path, true);
    const key = `${input.companyId}/${input.agentId}/${target}`;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        let current: { version: string; content: string } | null = null;
        try {
          current = await this.read(input, target);
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
        if (current && current.version !== expectedVersion)
          throw new WorkspaceError(
            "version_conflict",
            "Disk changed; compare your unsaved draft with disk before saving.",
            current,
          );
        if (!current && expectedVersion)
          throw new WorkspaceError(
            "version_conflict",
            "The file was deleted after you opened it.",
          );
        if (current?.content === content) return current;
        if (Buffer.byteLength(content) > 1024 * 1024)
          throw new WorkspaceError("too_large", "Editor save limit is 1 MiB.");
        // Stage bytes with upstream Write (not shell interpolation or a large argv).
        // The final precondition+rename is one existing Workspace Bash invocation.
        const staged = join(
          dirname(target),
          ".company-save-" + crypto.randomUUID(),
        );
        await this.tool(input, "Write", { file_path: staged, content });
        await this.script(
          input,
          `try{if(args[2]===''){if(fs.existsSync(args[0])){const e=Error('A file appeared before create.');e.code='version_conflict';throw e;}fs.linkSync(args[1],args[0]);}else{const old=fs.readFileSync(args[0]);if(hash(old)!==args[2]){const e=Error('Disk changed during save.');e.code='version_conflict';throw e;}const info=fs.statSync(args[0]);if(info.nlink>1)throw Error('Hard-linked file is not editable.');fs.chmodSync(args[1],info.mode);const current=fs.statSync(args[0]);if(current.ino!==info.ino||hash(fs.readFileSync(args[0]))!==args[2]){const e=Error('Disk changed during save.');e.code='version_conflict';throw e;}fs.renameSync(args[1],args[0]);}console.log('COMPANY_JSON:'+JSON.stringify({saved:true}));}finally{if(fs.existsSync(args[1]))fs.unlinkSync(args[1]);}`,
          [target, staged, expectedVersion],
        );
        return this.read(input, target);
      });
    this.writes.set(key, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(key) === next) this.writes.delete(key);
    }
  }
  async search(input: RuntimeAgent, query: string, path?: string) {
    const target = await this.path(input, path);
    const result = await this.tool(input, "Grep", {
      pattern: query,
      path: target,
      fixed_strings: true,
      head_limit: 100,
    });
    const matches = result.text
      .split("\n")
      .filter(Boolean)
      .map((text: string) => {
        const match = text.match(/^(.+?):(\d+):\s?(.*)$/);
        return match
          ? {
              path: resolve(input.directory, match[1]!),
              line: Number(match[2]),
              text: match[3],
            }
          : { text };
      });
    return {
      query,
      path: target,
      text: result.text,
      results: matches,
      matches,
    };
  }
  async diff(input: RuntimeAgent, path: string) {
    const target = await this.path(input, path);
    const current = await this.read(input, target);
    const metadata = await this.script(
      input,
      `let root;try{root=cp.execFileSync('git',['-C',path.dirname(args[0]),'rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();}catch{throw Error('This file is not in a Git repository.');}const rel=path.relative(root,args[0]);const head=cp.spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'});const base=head.status===0?head.stdout.trim():null;const show=cp.spawnSync('git',['-C',root,'show',(base||'HEAD')+':'+rel]);const b=show.status===0?show.stdout:Buffer.alloc(0);if(b.length>1024*1024)throw Error('Diff text limit is 1 MiB.');console.log('COMPANY_JSON:'+JSON.stringify({root,rel,base,size:b.length,tracked:show.status===0}));`,
      [target],
    );
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < metadata.size; offset += 4000) {
      const part = await this.script(
        input,
        `const b=cp.execFileSync('git',['-C',args[0],'show',args[1]+':'+args[2]]);console.log('COMPANY_JSON:'+JSON.stringify({data:b.subarray(args[3],args[3]+4000).toString('base64')}));`,
        [metadata.root, metadata.base, metadata.rel, offset],
      );
      chunks.push(Buffer.from(part.data, "base64"));
    }
    return {
      original: Buffer.concat(chunks).toString("utf8"),
      modified: current.content,
      path: target,
      version: current.version,
      base: metadata.base ?? "unborn HEAD",
      tracked: metadata.tracked,
    };
  }
  async changes(input: RuntimeAgent) {
    const changes: any[] = [];
    let offset = 0,
      total = 0;
    do {
      const data = await this.script(
        input,
        `const r=cp.spawnSync('git',['-C',args[0],'status','--porcelain=v1','-z'],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);const records=r.stdout.split('\\0').filter(Boolean),all=[];for(let i=0;i<records.length;i++){const v=records[i],status=v.slice(0,2);all.push({status,path:path.join(args[0],v.slice(3)),...(/[RC]/.test(status)?{oldPath:path.join(args[0],records[++i])}:{})});}const page=[];let end=args[1];while(end<all.length){const next=[...page,all[end]];if(page.length&&Buffer.byteLength(JSON.stringify(next))>6000)break;page.push(all[end++]);}console.log('COMPANY_JSON:'+JSON.stringify({changes:page,total:all.length,next:end}));`,
        [input.directory, offset],
      );
      changes.push(...data.changes);
      total = data.total;
      offset = data.next;
    } while (offset < total);
    return { changes };
  }
  async commit(input: RuntimeAgent, message: string) {
    if (!message.trim())
      throw new WorkspaceError("invalid_input", "Commit message is required.");
    return this.script(
      input,
      `for(const a of [['add','-A'],['-c','user.name=Company Factory','-c','user.email=company@localhost','commit','-m',args[1]]]){const r=cp.spawnSync('git',['-C',args[0],...a],{encoding:'utf8'});if(r.status!==0)throw Error(r.stdout+r.stderr);}console.log('COMPANY_JSON:'+JSON.stringify({commit:cp.execFileSync('git',['-C',args[0],'rev-parse','HEAD'],{encoding:'utf8'}).trim()}));`,
      [input.directory, message],
    );
  }
  async shutdown() {
    for (const promise of this.clients.values()) await (await promise).close();
    this.clients.clear();
  }
}
