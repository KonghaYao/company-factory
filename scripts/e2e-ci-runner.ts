/**
 * Isolated, secret-free CI/Review runner for the live E2E.
 *
 * The orchestrator never executes Agent-writable project scripts on the host. It
 * exports the accepted commit from git objects, stages a host-controlled fixture,
 * and runs that fixture inside a separate container/sandbox with:
 * - no network;
 * - read-only subject/fixture/manifest mounts;
 * - writable tmpfs only;
 * - an explicit non-secret environment whitelist;
 * - no E2E root, user home, effective-config, server environment or Docker socket.
 *
 * Supported backends:
 * - `docker` (default): requires a local image (never pulls during the run) and a
 *   reachable daemon. Missing Docker or image is a hard failure.
 * - `bwrap`: explicit opt-in for the documented Stage 2 E2E container, which has
 *   bubblewrap but intentionally no Docker socket. It provides the same no-secret,
 *   no-network, read-only-mount guarantees.
 *
 * There is no host-execution fallback.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type CiMode = "ci" | "review";
export type CiRunnerBackend = "docker" | "bwrap";

export type CiTreeEntry = {
  path: string;
  mode: "100644" | "100755";
  blob: string;
  sha256: string;
  size: number;
};

export type CiManifest = {
  version: 1;
  commit: string;
  parent: string | null;
  entries: CiTreeEntry[];
  parentEntries: CiTreeEntry[];
  treeSha256: string;
};

export type CiReport = {
  version: 1;
  mode: CiMode;
  /** Random per-run challenge supplied by the orchestrator. Binds the digest to
   * this run so an old digest cannot be replayed, and appears in the Reviewer's
   * real Bash tool record. */
  challenge: string;
  commit: string;
  treeSha256: string;
  files: number;
  bytes: number;
  checks: Record<string, true>;
  review?: {
    changedFiles: Array<{
      path: string;
      status: "added" | "modified" | "removed";
      size: number;
    }>;
    added: number;
    modified: number;
    removed: number;
  };
};

export type CiMount = {
  source: string;
  target: string;
  readonly: boolean;
};

export type CiIsolation = {
  networkNone: boolean;
  readOnlySubject: boolean;
  writableTmpfsOnly: boolean;
  explicitEnvWhitelist: boolean;
  noHomeMount: boolean;
  noE2eRootMount: boolean;
  noSecretEnv: boolean;
};

export type CiRunnerSpec = {
  backend: CiRunnerBackend;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
  mounts: CiMount[];
  isolation: CiIsolation;
  containerName?: string;
};

export class CiRunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const CI_FIXTURE_PATH = resolve(import.meta.dir, "e2e-fixtures/ci/check.ts");
export const CI_ENV_KEYS = ["PATH", "HOME", "BUN_INSTALL", "LANG", "NO_COLOR"] as const;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;

const GIT_HARDENING_ARGS = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
  "-c",
  "core.pager=cat",
  "-c",
  "color.ui=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.noprefix=false",
  "-c",
  "credential.helper=",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "advice.detachedHead=false",
]);

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function gitBlobId(value: Buffer): string {
  return createHash("sha1")
    .update(`blob ${value.length}\0`)
    .update(value)
    .digest("hex");
}

export function treeDigest(entries: CiTreeEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return sha256Hex(
    sorted
      .map(
        (entry) =>
          `${entry.path}\0${entry.mode}\0${entry.blob}\0${entry.sha256}\0${entry.size}\0`,
      )
      .join(""),
  );
}

export function assertSafeCodeRef(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
    throw new CiRunnerError(
      "code_ref_invalid",
      "Accepted code_ref must be a lowercase 40-hex commit id",
    );
  return value;
}

/** Per-run random challenge embedded in the fixture report. Lowercase hex only
 * so it survives shell quoting and JSON canonicalization without escaping. */
export function assertCiChallenge(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32,64}$/.test(value))
    throw new CiRunnerError(
      "ci_challenge_invalid",
      "CI challenge must be 32-64 lowercase hex characters",
    );
  return value;
}

export function assertSafeRepoPath(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new CiRunnerError("repo_path_invalid", "Repository path is empty");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.includes("\uFFFD")
  )
    throw new CiRunnerError("repo_path_invalid", "Repository path is not a safe relative path");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."))
    throw new CiRunnerError("repo_path_invalid", "Repository path escapes its root");
  if (segments.includes(".git"))
    throw new CiRunnerError("repo_path_forbidden", "Repository path contains .git");
  return value;
}

export type GitResult = {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
};

export function gitEnvironment(home: string, path?: string): Record<string, string> {
  return {
    PATH: path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_SSH_COMMAND: "/bin/false",
  };
}

/** Hardened host git call. The environment is rebuilt from scratch (no GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_COUNT, hooks or credential helpers
 * are inherited from the host process). It never executes project scripts. */
export function runGit(
  cwd: string,
  args: string[],
  options: { home: string; timeoutMs?: number; maxBuffer?: number } = { home: "/tmp" },
): GitResult {
  const result = spawnSync(
    "git",
    ["-C", cwd, ...GIT_HARDENING_ARGS, ...args],
    {
      encoding: null,
      env: gitEnvironment(options.home),
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return {
    status: result.status ?? -1,
    stdout: Buffer.from(result.stdout ?? []),
    stderr: Buffer.from(
      result.stderr ?? (result.error ? Buffer.from(result.error.message) : []),
    ),
  };
}

export function runGitText(
  cwd: string,
  args: string[],
  options: { home: string; timeoutMs?: number } = { home: "/tmp" },
): { status: number; stdout: string; stderr: string } {
  const result = runGit(cwd, args, options);
  return {
    status: result.status,
    stdout: result.stdout.toString("utf8").trim(),
    stderr: result.stderr.toString("utf8").trim(),
  };
}

type RawTreeEntry = { path: string; mode: string; type: string; object: string };

export function parseGitLsTree(output: Buffer): RawTreeEntry[] {
  const text = output.toString("utf8");
  const records = text.split("\0").filter(Boolean);
  if (records.length > MAX_FILES)
    throw new CiRunnerError("ci_export_too_many_files", "Commit contains too many files");
  const entries: RawTreeEntry[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab < 0)
      throw new CiRunnerError("ci_export_invalid", "Unparseable git ls-tree record");
    const header = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (header.length !== 3)
      throw new CiRunnerError("ci_export_invalid", "Unparseable git ls-tree header");
    const [mode, type, object] = header as [string, string, string];
    assertSafeRepoPath(path);
    if (seen.has(path))
      throw new CiRunnerError("ci_export_invalid", "Commit contains a duplicate path");
    seen.add(path);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755"))
      throw new CiRunnerError(
        "ci_export_unsupported_entry",
        `Commit contains an unsupported entry (${mode} ${type}) at ${path}`,
      );
    if (!/^[0-9a-f]{40}$/.test(object))
      throw new CiRunnerError("ci_export_invalid", "Commit contains an invalid blob id");
    entries.push({ path, mode, type, object });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function lsTree(
  projectRoot: string,
  ref: string,
  home: string,
): RawTreeEntry[] {
  const result = runGit(projectRoot, ["ls-tree", "-r", "-z", "--full-tree", ref], {
    home,
  });
  if (result.status !== 0)
    throw new CiRunnerError("ci_export_failed", `git ls-tree failed for ${ref}`);
  return parseGitLsTree(result.stdout);
}

function readBlob(
  projectRoot: string,
  object: string,
  home: string,
): Buffer {
  const result = runGit(projectRoot, ["cat-file", "blob", object], {
    home,
    maxBuffer: MAX_FILE_BYTES + 4096,
  });
  if (result.status !== 0)
    throw new CiRunnerError("ci_export_failed", "git cat-file blob failed");
  if (result.stdout.length > MAX_FILE_BYTES)
    throw new CiRunnerError("ci_export_too_large", "Commit contains an oversized file");
  if (gitBlobId(result.stdout) !== object)
    throw new CiRunnerError("ci_export_corrupt", "Exported blob does not match its git id");
  return result.stdout;
}

function parentOf(projectRoot: string, codeRef: string, home: string): string | null {
  const result = runGitText(projectRoot, ["rev-parse", "--verify", `${codeRef}^`], {
    home,
  });
  if (result.status !== 0) return null;
  if (!/^[0-9a-f]{40}$/.test(result.stdout)) return null;
  return result.stdout;
}

function entriesFor(
  projectRoot: string,
  ref: string,
  home: string,
): CiTreeEntry[] {
  const entries: CiTreeEntry[] = [];
  let total = 0;
  for (const raw of lsTree(projectRoot, ref, home)) {
    const content = readBlob(projectRoot, raw.object, home);
    total += content.length;
    if (total > MAX_TOTAL_BYTES)
      throw new CiRunnerError("ci_export_too_large", "Commit export exceeds the size limit");
    entries.push({
      path: raw.path,
      mode: raw.mode as "100644" | "100755",
      blob: raw.object,
      sha256: sha256Hex(content),
      size: content.length,
    });
  }
  return entries;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function normalizeCommand(value: string, label: string): string {
  const command = value.trim();
  if (!command || command.includes("\0") || command.includes("\n"))
    throw new CiRunnerError("ci_runner_invalid", `${label} is invalid`);
  return command;
}

function assertMountPathSafe(path: string, label: string): string {
  const resolved = resolve(path);
  if (!isAbsolute(resolved))
    throw new CiRunnerError("ci_mount_invalid", `${label} must be absolute`);
  if (resolved.includes(",") || resolved.includes("\n") || resolved.includes("\0"))
    throw new CiRunnerError("ci_mount_invalid", `${label} contains an unsafe character`);
  return resolved;
}

export function assertOutsideForbidden(
  sources: Array<{ path: string; label: string }>,
  forbiddenPaths: string[],
): void {
  const forbidden = forbiddenPaths
    .filter(Boolean)
    .map((path) => realOrResolved(path));
  for (const source of sources) {
    const path = realOrResolved(assertMountPathSafe(source.path, source.label));
    if (path === "/" || path === "/proc" || path === "/sys" || path === "/dev")
      throw new CiRunnerError(
        "ci_mount_forbidden",
        `${source.label} must not mount a host system root`,
      );
    for (const blocked of forbidden) {
      if (path === blocked || isInside(blocked, path) || isInside(path, blocked))
        throw new CiRunnerError(
          "ci_mount_forbidden",
          `${source.label} overlaps a protected path and must not be mounted`,
        );
    }
  }
}

function isForbiddenOverlap(path: string, forbiddenPaths: string[]): boolean {
  const candidate = realOrResolved(path);
  return forbiddenPaths
    .filter(Boolean)
    .map((item) => realOrResolved(item))
    .some(
      (blocked) =>
        candidate === blocked ||
        isInside(blocked, candidate) ||
        isInside(candidate, blocked),
    );
}

const ALLOWED_SYSTEM_BINDS = [
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/etc/ld.so.cache",
  "/etc/ssl",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
];

export function assertSystemBindAllowed(path: string, forbiddenPaths: string[]): void {
  const resolved = resolve(path);
  if (!isAbsolute(resolved))
    throw new CiRunnerError("ci_mount_invalid", "System bind must be absolute");
  const allowed = ALLOWED_SYSTEM_BINDS.some(
    (root) => resolved === root || isInside(root, resolved),
  );
  if (!allowed)
    throw new CiRunnerError(
      "ci_mount_forbidden",
      "Only fixed system paths may be read-only mounted by the bwrap runner",
    );
  if (isForbiddenOverlap(resolved, forbiddenPaths))
    throw new CiRunnerError(
      "ci_mount_forbidden",
      "System bind overlaps a protected path",
    );
}

/** The Docker backend runs as an unprivileged user. The staged tree contains only
 * committed code, the host fixture and a non-secret manifest, so make it readable. */
function relaxExportPermissions(root: string): void {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let info;
    try {
      info = lstatSync(current);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (!isInside(root, current) || realpathSync(current) !== current)
      throw new CiRunnerError(
        "ci_export_invalid",
        "Exported tree contains a symlinked or escaping path",
      );
    if (info.isDirectory()) {
      chmodSync(current, 0o755);
      for (const entry of readdirSync(current)) stack.push(join(current, entry));
    } else if (info.isFile()) {
      chmodSync(current, (info.mode & 0o111) !== 0 ? 0o755 : 0o644);
    }
  }
}

function ensureExportDirectory(root: string, relativeDir: string): void {
  let current = root;
  for (const segment of relativeDir.split("/").filter(Boolean)) {
    current = join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      mkdirSync(current, { mode: 0o755 });
      chmodSync(current, 0o755);
      info = lstatSync(current);
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !isInside(root, current) ||
      realpathSync(current) !== current
    )
      throw new CiRunnerError(
        "ci_export_invalid",
        "Export directory is a symlink or outside its root",
      );
  }
}

export function exportCommitTree(input: {
  projectRoot: string;
  codeRef: string;
  destination: string;
  home: string;
  /** Trusted values (API key, owner token, session cookie) that must never be
   * exported into a CI sandbox, even if an Agent accidentally committed them. */
  forbiddenValues?: string[];
}): CiManifest {
  const codeRef = assertSafeCodeRef(input.codeRef);
  const destination = realOrResolved(input.destination);
  const info = lstatSync(destination);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new CiRunnerError("ci_export_destination", "Export destination is not a real directory");
  if (readdirSync(destination).length)
    throw new CiRunnerError("ci_export_destination", "Export destination must be empty");

  const entries = entriesFor(input.projectRoot, codeRef, input.home);
  if (!entries.length)
    throw new CiRunnerError("ci_export_empty", "Accepted commit contains no files");
  if (entries.length > MAX_FILES)
    throw new CiRunnerError("ci_export_too_many_files", "Commit contains too many files");
  let total = 0;
  for (const entry of entries) {
    if (entry.size > MAX_FILE_BYTES)
      throw new CiRunnerError("ci_export_too_large", `File is too large: ${entry.path}`);
    total += entry.size;
    if (total > MAX_TOTAL_BYTES)
      throw new CiRunnerError("ci_export_too_large", "Commit export exceeds the size limit");
    const content = readBlob(input.projectRoot, entry.blob, input.home);
    for (const secret of input.forbiddenValues ?? []) {
      if (secret.length >= 8 && content.includes(Buffer.from(secret)))
        throw new CiRunnerError(
          "ci_export_secret",
          "Accepted commit contains a trusted credential; refusing to export it into the CI sandbox",
        );
    }
    const target = join(destination, ...entry.path.split("/"));
    if (!isInside(destination, target))
      throw new CiRunnerError("ci_export_invalid", "Export path escapes its root");
    ensureExportDirectory(
      destination,
      entry.path.split("/").slice(0, -1).join("/"),
    );
    writeFileSync(target, content, {
      flag: "wx",
      mode: entry.mode === "100755" ? 0o755 : 0o644,
    });
    chmodSync(target, entry.mode === "100755" ? 0o755 : 0o644);
    const written = lstatSync(target);
    if (!written.isFile() || written.isSymbolicLink() || !isInside(destination, realpathSync(target)))
      throw new CiRunnerError("ci_export_invalid", "Exported file is not a regular file");
  }
  relaxExportPermissions(destination);
  const parent = parentOf(input.projectRoot, codeRef, input.home);
  const parentEntries = parent ? entriesFor(input.projectRoot, parent, input.home) : [];
  return {
    version: 1,
    commit: codeRef,
    parent,
    entries,
    parentEntries,
    treeSha256: treeDigest(entries),
  };
}

export type WorktreeObservation = {
  supported: boolean;
  state: "clean" | "dirty_expected" | "dirty_unexpected" | "unavailable";
  headMatchesCommit: boolean;
  dirtyEntries: number;
  unexpectedEntries: number;
  expectedArtifacts: string[];
};

/**
 * Compare an Agent worktree with a committed tree without invoking Git's
 * filter/hook machinery on Agent-controlled files. `git status` can run clean
 * filters from `.gitattributes`/`.git/config`; this helper only uses `rev-parse`
 * and `ls-tree` (read-only object queries) and compares file bytes itself.
 *
 * `expectedArtifacts` are test files intentionally left uncommitted (E10 marker/log
 * or the Agent's scratch `.e2e-ci` copy). They are never part of the CI input, which
 * is always the clean export of the accepted commit.
 */
export function inspectWorktreeAgainstCommit(input: {
  worktree: string;
  commit: string;
  home: string;
  expectedArtifacts?: RegExp[];
}): WorktreeObservation {
  const accepted = assertSafeCodeRef(input.commit);
  const expectedArtifacts = input.expectedArtifacts ?? [];
  const isExpected = (path: string) =>
    expectedArtifacts.some((pattern) => pattern.test(path));
  const head = runGit(input.worktree, ["rev-parse", "HEAD"], { home: input.home });
  const tree = runGit(
    input.worktree,
    ["ls-tree", "-r", "-z", "--full-tree", accepted],
    { home: input.home },
  );
  const unavailable = (headMatchesCommit: boolean): WorktreeObservation => ({
    supported: false,
    state: "unavailable",
    headMatchesCommit,
    dirtyEntries: 0,
    unexpectedEntries: 0,
    expectedArtifacts: [],
  });
  if (head.status !== 0 || tree.status !== 0) return unavailable(false);
  let entries: RawTreeEntry[];
  try {
    entries = parseGitLsTree(tree.stdout);
  } catch {
    return unavailable(head.stdout.toString("utf8").trim() === accepted);
  }
  const committed = new Map(entries.map((entry) => [entry.path, entry]));
  const expectedFound: string[] = [];
  const unexpected: string[] = [];
  const seen = new Set<string>();
  let incomplete = false;
  const stack: Array<{ path: string; rel: string }> = [
    { path: input.worktree, rel: "" },
  ];
  while (stack.length) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(current.path);
    } catch {
      incomplete = true;
      break;
    }
    for (const name of names) {
      if (!current.rel && name === ".git") continue;
      const full = join(current.path, name);
      const rel = current.rel ? `${current.rel}/${name}` : name;
      let info;
      try {
        info = lstatSync(full);
      } catch {
        incomplete = true;
        break;
      }
      if (info.isDirectory() && !info.isSymbolicLink()) {
        stack.push({ path: full, rel });
        continue;
      }
      if (isExpected(rel) && !committed.has(rel)) {
        expectedFound.push(rel);
        continue;
      }
      const entry = committed.get(rel);
      if (!entry) {
        unexpected.push(rel);
        continue;
      }
      seen.add(rel);
      if (info.isSymbolicLink() || !info.isFile()) {
        unexpected.push(rel);
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        unexpected.push(rel);
        continue;
      }
      let content: Buffer;
      try {
        content = readFileSync(full);
      } catch {
        incomplete = true;
        break;
      }
      const executable = (info.mode & 0o111) !== 0;
      if (
        gitBlobId(content) !== entry.object ||
        executable !== (entry.mode === "100755")
      )
        unexpected.push(rel);
    }
    if (incomplete) break;
  }
  if (incomplete)
    return {
      ...unavailable(head.stdout.toString("utf8").trim() === accepted),
      expectedArtifacts: [...new Set(expectedFound)].sort(),
    };
  for (const path of committed.keys())
    if (!seen.has(path)) unexpected.push(path);
  const unexpectedUnique = [...new Set(unexpected)].sort();
  const dirtyEntries = unexpectedUnique.length + expectedFound.length;
  return {
    supported: true,
    state: unexpectedUnique.length
      ? "dirty_unexpected"
      : dirtyEntries
        ? "dirty_expected"
        : "clean",
    headMatchesCommit: head.stdout.toString("utf8").trim() === accepted,
    dirtyEntries,
    unexpectedEntries: unexpectedUnique.length,
    expectedArtifacts: [...new Set(expectedFound)].sort(),
  };
}

export function writeCiManifest(path: string, manifest: CiManifest): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
    mode: 0o644,
  });
  chmodSync(path, 0o644);
}

export function stageFixture(source: string, destination: string): {
  sha256: string;
  size: number;
} {
  const info = lstatSync(source);
  if (!info.isFile() || info.isSymbolicLink())
    throw new CiRunnerError("ci_fixture_invalid", "CI fixture must be a regular file");
  const content = readFileSync(source);
  if (content.length > 2 * 1024 * 1024)
    throw new CiRunnerError("ci_fixture_invalid", "CI fixture is unexpectedly large");
  writeFileSync(destination, content, { flag: "wx", mode: 0o644 });
  chmodSync(destination, 0o644);
  return { sha256: sha256Hex(content), size: content.length };
}

function ciEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    BUN_INSTALL: "/tmp/bun",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
}

export function assertEnvWhitelist(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (!(CI_ENV_KEYS as readonly string[]).includes(key))
      throw new CiRunnerError("ci_env_invalid", `Unexpected CI environment key ${key}`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OWNER/i.test(key))
      throw new CiRunnerError("ci_env_invalid", "CI environment contains a secret-shaped key");
    if (value.includes("\n") || value.includes("\0"))
      throw new CiRunnerError("ci_env_invalid", "CI environment contains an unsafe value");
  }
}

function isolationFor(
  forbiddenPaths: string[],
  mounts: CiMount[],
): CiIsolation {
  assertOutsideForbidden(
    mounts.map((mount) => ({ path: mount.source, label: mount.target })),
    forbiddenPaths,
  );
  return {
    networkNone: true,
    readOnlySubject: mounts.every((mount) => mount.readonly),
    writableTmpfsOnly: true,
    explicitEnvWhitelist: true,
    noHomeMount: true,
    noE2eRootMount: true,
    noSecretEnv: true,
  };
}

export type DockerCiSpecInput = {
  dockerBinary: string;
  image: string;
  containerName: string;
  mode: CiMode;
  subjectDir: string;
  fixturePath: string;
  manifestPath: string;
  challenge: string;
  forbiddenPaths: string[];
  timeoutMs?: number;
};

export function buildDockerCiRunSpec(input: DockerCiSpecInput): CiRunnerSpec {
  const dockerBinary = normalizeCommand(input.dockerBinary, "docker binary");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(input.image))
    throw new CiRunnerError("ci_runner_invalid", "E2E_CI_IMAGE is not a valid image reference");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(input.containerName))
    throw new CiRunnerError("ci_runner_invalid", "CI container name is invalid");
  const challenge = assertCiChallenge(input.challenge);
  const subjectDir = assertMountPathSafe(input.subjectDir, "subject");
  const fixturePath = assertMountPathSafe(input.fixturePath, "fixture");
  const manifestPath = assertMountPathSafe(input.manifestPath, "manifest");
  const mounts: CiMount[] = [
    { source: subjectDir, target: "/subject", readonly: true },
    { source: fixturePath, target: "/ci/check.ts", readonly: true },
    { source: manifestPath, target: "/ci/expected.json", readonly: true },
  ];
  const isolation = isolationFor(input.forbiddenPaths, mounts);
  assertEnvWhitelist({
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp",
    BUN_INSTALL: "/tmp/bun",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  });
  const args = [
    "run",
    "--rm",
    "--name",
    input.containerName,
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--workdir=/",
    "--pids-limit=64",
    "--memory=256m",
    "--cpus=1",
    "--user=65534:65534",
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
    "--tmpfs=/out:rw,nosuid,nodev,noexec,size=16m,mode=1777",
    "--mount",
    `type=bind,source=${subjectDir},target=/subject,readonly`,
    "--mount",
    `type=bind,source=${fixturePath},target=/ci/check.ts,readonly`,
    "--mount",
    `type=bind,source=${manifestPath},target=/ci/expected.json,readonly`,
    "--env",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--env",
    "HOME=/tmp",
    "--env",
    "BUN_INSTALL=/tmp/bun",
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "NO_COLOR=1",
    "--entrypoint",
    "bun",
    input.image,
    "/ci/check.ts",
    input.mode,
    "/subject",
    "/ci/expected.json",
    challenge,
  ];
  // Keep the Docker CLI away from /tmp and any user/Docker config: its HOME is a
  // private directory inside the host-controlled CI staging root.
  const cliEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: resolve(subjectDir, "../docker-home"),
    LANG: "C.UTF-8",
  };
  assertEnvWhitelist(cliEnv);
  return {
    backend: "docker",
    command: dockerBinary,
    args,
    env: cliEnv,
    cwd: "/",
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_BUFFER,
    mounts,
    isolation,
    containerName: input.containerName,
  };
}

export type BwrapCiSpecInput = {
  bwrapBinary: string;
  bunBinary: string;
  mode: CiMode;
  subjectDir: string;
  fixturePath: string;
  manifestPath: string;
  challenge: string;
  systemRoBinds: string[];
  forbiddenPaths: string[];
  timeoutMs?: number;
};

export function buildBwrapCiRunSpec(input: BwrapCiSpecInput): CiRunnerSpec {
  const bwrapBinary = normalizeCommand(input.bwrapBinary, "bwrap binary");
  const bunBinary = assertMountPathSafe(input.bunBinary, "bun binary");
  const challenge = assertCiChallenge(input.challenge);
  const subjectDir = assertMountPathSafe(input.subjectDir, "subject");
  const fixturePath = assertMountPathSafe(input.fixturePath, "fixture");
  const manifestPath = assertMountPathSafe(input.manifestPath, "manifest");
  const mounts: CiMount[] = [
    { source: subjectDir, target: "/subject", readonly: true },
    { source: fixturePath, target: "/ci/check.ts", readonly: true },
    { source: manifestPath, target: "/ci/expected.json", readonly: true },
  ];
  const isolation = isolationFor(input.forbiddenPaths, mounts);
  for (const path of input.systemRoBinds)
    assertSystemBindAllowed(path, input.forbiddenPaths);
  // The runtime is bound as a single file, never as a home directory. This is
  // required for Bun installed outside /usr (for example in the E2E container).
  assertOutsideForbidden(
    [{ path: bunBinary, label: "bun binary" }],
    input.forbiddenPaths,
  );
  for (const path of input.systemRoBinds) {
    if (path.includes(",") || path.includes("\n") || path.includes("\0"))
      throw new CiRunnerError("ci_mount_invalid", "System bind contains an unsafe character");
  }
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--unshare-net",
  ];
  for (const path of [...new Set(input.systemRoBinds)]) {
    if (!existsSync(path)) continue;
    args.push("--ro-bind", path, path);
  }
  const bunAlreadyVisible = ["/usr", "/bin", "/lib", "/lib64"].some(
    (root) =>
      existsSync(root) && (bunBinary === root || isInside(root, bunBinary)),
  );
  args.push("--dir", "/ci", "--dir", "/subject");
  if (!bunAlreadyVisible) args.push("--ro-bind", bunBinary, bunBinary);
  args.push(
    "--ro-bind",
    fixturePath,
    "/ci/check.ts",
    "--ro-bind",
    manifestPath,
    "/ci/expected.json",
    "--ro-bind",
    subjectDir,
    "/subject",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/out",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "BUN_INSTALL",
    "/tmp/bun",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "NO_COLOR",
    "1",
    "--chdir",
    "/",
    "--",
    bunBinary,
    "/ci/check.ts",
    input.mode,
    "/subject",
    "/ci/expected.json",
    challenge,
  );
  const env = ciEnvironment();
  assertEnvWhitelist(env);
  return {
    backend: "bwrap",
    command: bwrapBinary,
    args,
    env,
    cwd: "/",
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_BUFFER,
    mounts,
    isolation,
  };
}

export type CiRunnerChoiceInput = {
  requested: string | undefined;
  platform: NodeJS.Platform;
  dockerAvailable: boolean;
  dockerImageAvailable: boolean;
  bwrapAvailable: boolean;
};

/** Docker is the default and never falls back to host execution. `bwrap` is an
 * explicit opt-in for the documented Stage 2 container, which has no Docker
 * socket; it is still a no-network, read-only, env-whitelisted sandbox. */
export function chooseCiRunner(input: CiRunnerChoiceInput): CiRunnerBackend {
  const requested = (input.requested ?? "docker").trim() || "docker";
  if (requested === "docker") {
    if (!input.dockerAvailable)
      throw new CiRunnerError(
        "ci_runner_unavailable",
        "Docker is unavailable; refusing to run CI on the host",
      );
    if (!input.dockerImageAvailable)
      throw new CiRunnerError(
        "ci_runner_unavailable",
        "Docker image is not available locally; refusing to pull or run CI on the host",
      );
    return "docker";
  }
  if (requested === "bwrap") {
    if (input.platform !== "linux" || !input.bwrapAvailable)
      throw new CiRunnerError(
        "ci_runner_unavailable",
        "The bwrap CI runner requires Linux with bubblewrap; refusing to run CI on the host",
      );
    return "bwrap";
  }
  throw new CiRunnerError(
    "ci_runner_invalid",
    "E2E_CI_RUNNER must be docker or bwrap",
  );
}

function cliEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    LANG: "C.UTF-8",
  };
}

export function probeDocker(dockerBinary: string): { available: boolean; detail: string } {
  const result = spawnSync(
    dockerBinary,
    ["version", "--format", "{{.Server.Version}}"],
    {
      encoding: "utf8",
      env: cliEnvironment(),
      timeout: 10_000,
    },
  );
  if (result.error || result.status !== 0)
    return { available: false, detail: "docker daemon is unavailable" };
  return { available: true, detail: "docker daemon is available" };
}

export function probeDockerImage(dockerBinary: string, image: string): boolean {
  const result = spawnSync(
    dockerBinary,
    ["image", "inspect", image, "--format", "{{.Id}}"],
    {
      encoding: "utf8",
      env: cliEnvironment(),
      timeout: 10_000,
    },
  );
  return !result.error && result.status === 0;
}

export function probeBwrap(bwrapBinary: string): boolean {
  const candidates = bwrapBinary.includes("/")
    ? [bwrapBinary]
    : (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
        .split(":")
        .filter(Boolean)
        .map((directory) => join(directory, bwrapBinary));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

export function runCiSpec(spec: CiRunnerSpec): {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
} {
  const result = spawnSync(spec.command, spec.args, {
    encoding: null,
    env: spec.env,
    cwd: spec.cwd,
    timeout: spec.timeoutMs,
    maxBuffer: spec.maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    status: result.status ?? -1,
    stdout: Buffer.from(result.stdout ?? []),
    stderr: Buffer.from(
      result.stderr ?? (result.error ? Buffer.from(result.error.message) : []),
    ),
    timedOut,
  };
}

const EXPECTED_CHECK_KEYS = [
  "conflictMarkersAbsent",
  "deliveryExportPresent",
  "fileModesMatched",
  "forbiddenPathsAbsent",
  "manifestMatched",
  "previewArtifactsAbsent",
  "srcEntryPresent",
  "typescriptSyntaxValid",
  "whitespaceClean",
].sort();

const SECRET_MARKERS = [
  /PERI_MODEL_/,
  /PERI_STORAGE_/,
  /COMPANY_WEB_TOKEN/,
  /owner-token/i,
  /Bearer\s+/i,
  /apiKey["']?\s*[:=]/i,
  /sk-[A-Za-z0-9]{20,}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
];

function reportProblem(message: string): never {
  throw new CiRunnerError("ci_report_invalid", message);
}

export function parseCiReport(
  stdout: Buffer,
  expected: { mode: CiMode; manifest: CiManifest; challenge: string },
): CiReport {
  const challenge = assertCiChallenge(expected.challenge);
  if (!stdout.length || stdout.length > MAX_REPORT_BYTES)
    reportProblem("CI report is empty or too large");
  const text = stdout.toString("utf8");
  if (!text.endsWith("\n")) reportProblem("CI report must end with exactly one newline");
  const body = text.slice(0, -1);
  if (body.includes("\n")) reportProblem("CI report must be a single canonical line");
  if (SECRET_MARKERS.some((pattern) => pattern.test(body)))
    reportProblem("CI report contains a forbidden secret marker");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    reportProblem("CI report is not valid JSON");
  }
  if (JSON.stringify(parsed) !== body)
    reportProblem("CI report is not in canonical form");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    reportProblem("CI report is not an object");
  const report = parsed as Record<string, unknown>;
  if (report.version !== 1) reportProblem("CI report version is invalid");
  if (report.mode !== expected.mode) reportProblem("CI report mode does not match");
  if (report.challenge !== challenge)
    reportProblem("CI report challenge does not match this run");
  if (report.commit !== expected.manifest.commit)
    reportProblem("CI report commit does not match the accepted commit");
  if (report.treeSha256 !== expected.manifest.treeSha256)
    reportProblem("CI report tree digest does not match the clean export");
  if (typeof report.files !== "number" || report.files !== expected.manifest.entries.length)
    reportProblem("CI report file count does not match the clean export");
  const expectedBytes = expected.manifest.entries.reduce(
    (sum, entry) => sum + entry.size,
    0,
  );
  if (typeof report.bytes !== "number" || report.bytes !== expectedBytes)
    reportProblem("CI report byte count does not match the clean export");
  if (!report.checks || typeof report.checks !== "object" || Array.isArray(report.checks))
    reportProblem("CI report checks are missing");
  const checks = report.checks as Record<string, unknown>;
  const keys = Object.keys(checks).sort();
  if (keys.length !== EXPECTED_CHECK_KEYS.length || keys.some((key, index) => key !== EXPECTED_CHECK_KEYS[index]))
    reportProblem("CI report contains unexpected checks");
  for (const key of keys)
    if (checks[key] !== true) reportProblem(`CI check ${key} did not pass`);
  if (expected.mode === "review") {
    const review = report.review;
    if (!review || typeof review !== "object" || Array.isArray(review))
      reportProblem("Review report is missing");
    const rows = (review as Record<string, unknown>).changedFiles;
    if (!Array.isArray(rows) || rows.length > MAX_FILES)
      reportProblem("Review report changedFiles is invalid");
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row))
        reportProblem("Review report changed file is invalid");
      const file = row as Record<string, unknown>;
      if (
        typeof file.path !== "string" ||
        !Number.isInteger(file.size) ||
        (file.size as number) < 0 ||
        !["added", "modified", "removed"].includes(String(file.status))
      )
        reportProblem("Review report changed file is invalid");
      assertSafeRepoPath(file.path);
    }
    const summary = review as Record<string, unknown>;
    if (
      !Number.isInteger(summary.added) ||
      !Number.isInteger(summary.modified) ||
      !Number.isInteger(summary.removed) ||
      (summary.added as number) + (summary.modified as number) + (summary.removed as number) !==
        rows.length
    )
      reportProblem("Review report counts are invalid");
  } else if (report.review !== undefined) {
    reportProblem("CI report unexpectedly contains review data");
  }
  return parsed as CiReport;
}

export function ciDigest(stdout: Buffer): string {
  return sha256Hex(stdout);
}

export function systemRoBinds(): string[] {
  const candidates = [
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    "/etc/ld.so.cache",
    "/etc/ssl",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/localtime",
  ];
  return candidates.filter((path) => existsSync(path));
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
