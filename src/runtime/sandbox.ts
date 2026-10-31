import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve, relative } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export type SandboxScope = {
  directory: string;
  companyHome?: string;
  knowledgeDirectory?: string;
  runtimeDirectory?: string;
  projectRoots?: string[];
  privatePaths?: string[];
};
/** OS capability boundary around the UNMODIFIED official Peri binary.
 * The process can use its normal Workspace implementation; Company business roots,
 * other Agent tokens, and other Sessions are not mounted in its namespace.
 */
export function sandboxCommand(
  command: string,
  args: string[],
  scope: SandboxScope,
): { command: string; args: string[] } {
  // 所有者显式设置的逃生阀。关闭后 Workspace/文件/Git/Agent 工具以服务进程
  // 身份直接运行，没有 OS 级隔离，可访问该用户能访问的全部文件。
  if (process.env.COMPANY_SANDBOX === "disabled") return { command, args };
  if (process.platform !== "linux")
    throw Object.assign(
      new Error(
        "Secure native Workspace currently requires Linux bubblewrap. macOS/Windows sandbox adapters are not validated; refusing unrestricted runtime.",
      ),
      { code: "sandbox_unavailable", status: 503 },
    );
  const bwrap = process.env.COMPANY_BWRAP ?? "/usr/bin/bwrap";
  if (!existsSync(bwrap))
    throw Object.assign(
      new Error(
        "Install bubblewrap (bwrap). Refusing to start an unrestricted Agent or Workspace.",
      ),
      { code: "sandbox_unavailable", status: 503 },
    );
  const options = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
  ];
  for (const path of ["/usr", "/bin", "/lib", "/lib64"])
    if (existsSync(path)) options.push("--ro-bind", path, path);
  for (const path of [
    "/etc/ssl",
    "/etc/alternatives",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
  ])
    if (existsSync(path)) options.push("--ro-bind", path, path);
  options.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  const companyHome = realpathSync(
    scope.companyHome ?? resolve(scope.directory, "../.."),
  );
  options.push("--tmpfs", companyHome);
  for (const path of new Set([
    resolve(command),
    realpathSync(process.execPath),
  ]))
    if (!path.startsWith("/usr/") && !path.startsWith("/bin/"))
      options.push("--ro-bind", path, path);
  // Official release's sibling resource sidecar is needed by native workflows.
  const resources = resolve(command, "..", "peri-resources");
  if (existsSync(resources)) options.push("--ro-bind", resources, resources);
  for (const path of scope.projectRoots ?? []) {
    const project = realpathSync(path);
    const inside = relative(companyHome, project),
      ancestor = relative(project, companyHome);
    const forbidden = [
      "/proc",
      "/dev",
      "/sys",
      "/etc",
      "/usr",
      "/bin",
      "/lib",
      "/lib64",
      "/run",
      "/var",
    ];
    const home = resolve(homedir());
    const isHomeAncestor =
      project === home || !relative(project, home).startsWith("..");
    if (
      project === "/" ||
      isHomeAncestor ||
      forbidden.some(
        (root) => project === root || project.startsWith(root + "/"),
      ) ||
      !inside.startsWith("..") ||
      !ancestor.startsWith("..")
    )
      throw Object.assign(
        new Error(
          "Project roots cannot expose system/home ancestors or Company data.",
        ),
        { code: "forbidden", status: 403 },
      );
    if (!existsSync(resolve(project, ".git")))
      throw Object.assign(
        new Error(
          "An additional root must be an existing project Git repository/worktree with .git metadata.",
        ),
        { code: "forbidden", status: 403 },
      );
  }
  const visiblePaths = [
    "/usr", "/bin", "/lib", "/lib64", "/etc/ssl", "/etc/alternatives",
    resolve(command), realpathSync(process.execPath), resources,
    "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group",
    scope.directory, scope.knowledgeDirectory, scope.runtimeDirectory, ...(scope.projectRoots ?? []),
  ];
  for (const secret of scope.privatePaths ?? []) {
    const protectedPath = existsSync(secret) ? realpathSync(secret) : resolve(secret);
    for (const path of visiblePaths) {
      if (!path || !existsSync(path)) continue;
      const canonical = realpathSync(path);
      const inside = relative(canonical, protectedPath);
      if (canonical === protectedPath || (!inside.startsWith("..") && !inside.startsWith("/")))
        throw Object.assign(new Error("宿主存储配置不能暴露给 Workspace；请移至 Agent 与项目挂载范围之外。"), { code: "wasm_store_config_exposed", status: 503 });
    }
  }
  for (const path of [
    scope.directory,
    scope.knowledgeDirectory,
    scope.runtimeDirectory,
    ...(scope.projectRoots ?? []),
  ])
    if (path && existsSync(path)) {
      const canonical = realpathSync(path);
      options.push("--bind", canonical, canonical);
    }
  // Read-only file mounts cannot be unlinked/replaced from the writable parent.
  // `.env` is tracked in the Agent's personal repository, but it must not be mutable
  // inside the sandbox: model credentials/endpoints are read from the trusted host
  // environment only. Read-only binding is defense in depth against persisting a
  // redirect for a future explicit restart. Provisioning writes the file before any
  // sandbox is created, so the bind always sees the intended content.
  for (const name of ["agent.yaml", ".mcp.json", ".env"]) {
    const path = resolve(scope.directory, name);
    if (!existsSync(path)) continue;
    const info = lstatSync(path);
    // A symlink here could bind an arbitrary host file into the Agent namespace.
    // Refuse rather than silently exposing the target read-only.
    if (!info.isFile() || info.isSymbolicLink())
      throw Object.assign(
        new Error(
          "Agent identity/environment files must be regular files (no symlinks) before sandboxing.",
        ),
        { code: "sandbox_unavailable", status: 503 },
      );
    options.push("--ro-bind", path, path);
  }
  options.push(
    "--remount-ro",
    companyHome,
    "--chdir",
    scope.directory,
    "--",
    command,
    ...args,
  );
  return { command: bwrap, args: options };
}
export function sandboxProbe() {
  const args: string[] = [];
  for (const p of ["/usr", "/bin", "/lib", "/lib64"])
    if (existsSync(p)) args.push("--ro-bind", p, p);
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--unshare-user",
    "--unshare-pid",
    "--die-with-parent",
    "/usr/bin/true",
  );
  const result = spawnSync(
    process.env.COMPANY_BWRAP ?? "/usr/bin/bwrap",
    args,
    { encoding: "utf8" },
  );
  return {
    available: result.status === 0,
    error: result.error?.message ?? result.stderr,
  };
}
