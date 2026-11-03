/**
 * Live E2E orchestrator for Company Factory.
 *
 * This script is intentionally standalone: it talks to the production HTTP server as
 * the owner, and asks real Agents to perform Agent-only business through their real
 * Sessions/MCPs. It never writes business YAML itself.
 *
 * Safety boundaries:
 * - only model-related names are read from PERI_ENV_FILE; values are never printed,
 *   written to evidence, or placed in argv;
 * - a fresh random owner token is injected through COMPANY_WEB_TOKEN;
 * - the server's stdout is ignored (it prints the access URL), stderr goes to a 0600
 *   file under the test root;
 * - the child runs in an empty cwd with an explicit environment; the caller-provided
 *   COMPANY_WASM_STORES_FILE is forwarded to the child, but PERI_STORAGE_* and the
 *   user's ~/.company / ~/.company-host directories are never forwarded;
 * - cleanup only targets a validated test root created by mktemp (or /tmp/e2e inside
 *   the documented container), never a user data directory.
 *
 * This is not a unit test. It requires explicit opt-in through --mode and live model
 * credentials. The repository only verifies --help/--dry-run during implementation.
 */
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import { ModelConfigurationError } from "../src/runtime/model-settings";
import {
  modelLibrarySchema,
  resolveModel,
  type ModelLibraryState,
} from "../src/runtime/model-library";
import {
  extractAgentToolCalls,
  findAgentCiExecution,
  type AgentCiExecution,
  type AgentToolCall,
} from "./e2e-agent-evidence";
import {
  compareExpectedUserData,
  expectedPathRecord,
  type UserDataExpectedPath,
} from "./e2e-user-data";
import { scanEvidenceDirectory } from "./e2e-evidence-scan";
import {
  CI_FIXTURE_PATH,
  CiRunnerError,
  assertSafeCodeRef,
  assertSafeRepoPath,
  buildBwrapCiRunSpec,
  buildDockerCiRunSpec,
  chooseCiRunner,
  ciDigest,
  exportCommitTree,
  inspectWorktreeAgainstCommit,
  parseCiReport,
  probeBwrap,
  probeDocker,
  probeDockerImage,
  runCiSpec,
  runGit,
  shellQuote,
  stageFixture,
  systemRoBinds,
  writeCiManifest,
  type CiManifest,
  type CiMode,
  type CiReport,
  type CiRunnerBackend,
  type CiRunnerSpec,
  type WorktreeObservation,
} from "./e2e-ci-runner";

type Mode = "macos-smoke" | "local-full";
type StepStatus = "passed" | "failed" | "skipped" | "blocked" | "smoke-only";

type Options = {
  mode: Mode;
  base: string;
  root: string;
  help: boolean;
  dryRun: boolean;
};

type Evidence = {
  step: string;
  actor: string;
  operation: string;
  status: StepStatus;
  httpStatus?: number;
  requestId?: string;
  companyId?: string;
  agentId?: string;
  issueId?: string;
  sessionId?: string;
  modelAlias?: string;
  model?: string;
  toolCalls?: string[];
  checks?: Record<string, boolean | number | string>;
  elapsedMs?: number;
  error?: { code?: string; message: string };
  detail?: string;
};

type ModelEnvironment = {
  values: Record<string, string>;
  present: Record<string, boolean>;
  filePresent: boolean;
};

const MODEL_TIERS = ["fable", "opus", "sonnet", "haiku"] as const;
type ModelTier = (typeof MODEL_TIERS)[number];
const REQUIRED_MODEL_ENV_NAMES = [
  "PERI_MODEL_BASE_URL",
  "PERI_MODEL_API_KEY",
  "PERI_MODEL_ID",
] as const;
const OPTIONAL_MODEL_ENV_NAMES = [
  "PERI_MODEL_PROVIDER",
  "PERI_MODEL_ID_FABLE",
  "PERI_MODEL_ID_OPUS",
  "PERI_MODEL_ID_SONNET",
  "PERI_MODEL_ID_HAIKU",
] as const;
const ALLOWED_MODEL_ENV_NAMES = new Set<string>([
  ...REQUIRED_MODEL_ENV_NAMES,
  ...OPTIONAL_MODEL_ENV_NAMES,
]);

const RESERVED_PORTS = new Set([3000]);
const DEFAULT_BASE = "http://127.0.0.1:33117";
const AGENT_TIMEOUT_MS = Number(process.env.E2E_AGENT_TIMEOUT_MS ?? 120_000);
const STEP_TIMEOUT_MS = Number(process.env.E2E_STEP_TIMEOUT_MS ?? 120_000);
const CI_TIMEOUT_MS = Number(process.env.E2E_CI_TIMEOUT_MS ?? 120_000);
const CI_IMAGE = process.env.E2E_CI_IMAGE?.trim() || "oven/bun:1.4.4";
const EXPECTED_PERI_VERSION = process.env.E2E_PERI_VERSION?.trim() || "4.4.1";
const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;

const HELP = `Company Factory live E2E orchestrator

Usage:
  bun scripts/e2e-live.ts --mode=macos-smoke --root=<TEST_ROOT> [--base=http://127.0.0.1:33117] [--dry-run]
  bun scripts/e2e-live.ts --mode=local-full  --root=<TEST_ROOT> [--base=http://127.0.0.1:33117] [--dry-run]
  bun scripts/e2e-live.ts --help

Modes:
  macos-smoke  Local smoke: owner login, company creation, HR group/member creation,
               real model chat, Issue triage/decision, IM, process restart and negative API
               checks. File/Git/Workspace/Preview steps are skipped; this mode is NOT
               full-business acceptance.
  local-full   Full E2E on the local host. Adds real project files, worktrees, file API,
               Preview environment, CI/Review verification, ready_merge and Agent
               configuration restart. Requires E2E_PROJECT_ROOT.

Required process environment for live modes:
  PERI_ENV_FILE            Path to the peri-cf .env file. The harness writes a
                           0600 model library whose provider/model entries reference
                           these host variables by name.
                           Required names:
                             PERI_MODEL_BASE_URL, PERI_MODEL_API_KEY, PERI_MODEL_ID
                           Optional (fallback to PERI_MODEL_ID):
                             PERI_MODEL_ID_FABLE, PERI_MODEL_ID_OPUS,
                             PERI_MODEL_ID_SONNET, PERI_MODEL_ID_HAIKU
                           Optional: PERI_MODEL_PROVIDER
                           Unknown PERI_MODEL_* names are rejected by name, never
                           printed with their values.
  COMPANY_WASM_STORES_FILE Host-private absolute path to a readable JSON file that
                           supplies url + token. The script forwards this path to the
                           test server; the file must already exist.
  PERI_BINARY              Required for local-full; optional for macos-smoke.
  E2E_PROJECT_ROOT         Required for local-full; must be inside --root and a Git repo.

Optional:
  E2E_EVIDENCE             Optional new sibling of --root whose basename starts with
                           "company-e2e-evidence."; it must not exist. Defaults to a
                           fresh "company-e2e-evidence.<runId>" sibling. Never writes
                           into an existing directory.
  E2E_AGENT_TIMEOUT_MS     Per-Agent turn timeout (default 120000).
  E2E_STEP_TIMEOUT_MS      Per-step timeout (default 120000).
  E2E_CI_RUNNER            "docker" (default) or "bwrap". The host never executes
                           Agent-writable CI scripts. Docker requires a reachable
                           daemon and a local image; missing Docker is a hard failure.
                           "bwrap" is an explicit opt-in for the documented Stage 2
                           container that has bubblewrap but no Docker socket.
  E2E_CI_IMAGE             Local Docker image containing Bun (default oven/bun:1.4.4).
                           It is never pulled during the run.
  E2E_CI_TIMEOUT_MS        Isolated CI/Review timeout (default 120000).
  E2E_PERI_VERSION         Expected Peri version (default 4.4.1).

Generated runtime values:
  COMPANY_HOME=<root>/company, HOME=<root>/home, TMPDIR=<root>/tmp,
  cwd=<root>/run, app port from --base.
  The owner token is generated with crypto.randomBytes and never printed.

Safety:
  - Refuses reserved user port 3000 and any --base other than
    http://127.0.0.1:<port> (the child server binds 127.0.0.1).
  - Refuses roots outside mktemp-style "company-e2e.*" paths or /tmp/e2e.
  - --root must contain only empty documented test subdirectories (home/company/
    host/tmp/logs/run/evidence/projects); unknown or non-empty entries are refused.
  - Creates its own new evidence directory and never chmods an existing or
    symlinked directory; it is not deleted with the test root. Every evidence
    write re-checks the directory inode/device and rejects symlink replacement.
  - Never reads ~/.company content, ~/.company-host content, owner-token or user
    stores. It only stats user-data metadata for before/after comparison.
  - Forwards the caller-provided COMPANY_WASM_STORES_FILE path to the child server;
    it never reads that file's contents and does not forward PERI_STORAGE_*.
  - CI/Review run only on a clean export of the accepted commit through a
    host-controlled fixture inside a separate no-secret, no-network sandbox.
    No package.json script or test runner from the Agent project is executed on the host.
    The runner's fixture copy is outside the E2E root and not Agent-writable; a
    separate scratch copy under the project root only lets the Agent reproduce the
    digest. Acceptance requires the Reviewer's real Bash tool record to contain this
    run's random challenge and the host digest; a digest or claim alone is not proof.
  - Dry run validates arguments and required env names, and probes the selected
    CI backend read-only (Docker daemon/image or bubblewrap executable). A missing
    backend fails the dry run. It starts no service, container or image pull and
    makes no model call.
`;

class UsageError extends Error {}
class StepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parseOptions(argv: string[]): Options {
  let mode: Mode | undefined;
  let base = DEFAULT_BASE;
  let root = "";
  let help = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const take = (name: string) => {
      if (arg === name) {
        const value = argv[++i];
        if (!value) throw new UsageError(`${name} requires a value`);
        return value;
      }
      if (arg.startsWith(name + "=")) return arg.slice(name.length + 1);
      return undefined;
    };
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const modeValue = take("--mode");
    if (modeValue !== undefined) {
      if (
        modeValue !== "macos-smoke" &&
        modeValue !== "local-full" &&
        modeValue !== "linux-full"
      )
        throw new UsageError("--mode must be macos-smoke or local-full");
      mode = modeValue === "linux-full" ? "local-full" : modeValue;
      continue;
    }
    const baseValue = take("--base");
    if (baseValue !== undefined) {
      base = baseValue;
      continue;
    }
    const rootValue = take("--root");
    if (rootValue !== undefined) {
      root = rootValue;
      continue;
    }
    throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (!help && !mode)
    throw new UsageError("--mode is required (macos-smoke or local-full)");
  if (!help && !root) throw new UsageError("--root is required");
  return { mode: mode ?? "macos-smoke", base, root, help, dryRun };
}

function loopbackBase(value: string): { url: URL; port: number } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError("--base must be an absolute http URL");
  }
  if (url.protocol !== "http:")
    throw new UsageError("--base must use http:// on 127.0.0.1");
  // The child server always binds COMPANY_HOST=127.0.0.1. Accepting localhost or
  // ::1 here would let the CLI produce an origin the child never serves.
  if (url.hostname !== "127.0.0.1")
    throw new UsageError("--base must be exactly http://127.0.0.1:<port>");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new UsageError("--base must be a bare origin without credentials or path");
  const port = Number(url.port || "80");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new UsageError("--base has an invalid port");
  if (RESERVED_PORTS.has(port))
    throw new UsageError(`Refusing reserved user port ${port}`);
  return { url, port };
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve symlinked path prefixes even when the final path does not exist yet. */
function canonicalPath(value: string): string {
  let current = resolve(value);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...suffix);
}

/** The explicit store file is the only session-storage source; validate it without
 * reading its contents (it contains host-only tokens). */
function storesFileProblem(): string | undefined {
  const file = process.env.COMPANY_WASM_STORES_FILE?.trim();
  if (!file) return "COMPANY_WASM_STORES_FILE missing";
  if (!isAbsolute(file)) return "COMPANY_WASM_STORES_FILE must be an absolute path";
  if (!existsSync(file)) return "COMPANY_WASM_STORES_FILE does not exist";
  try {
    accessSync(file, fsConstants.R_OK);
  } catch {
    return "COMPANY_WASM_STORES_FILE is not readable";
  }
  return undefined;
}

function validateTestRoot(value: string): string {
  const root = resolve(value);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new UsageError(`--root must be an existing directory: ${root}`);
  const realRoot = realpathSync(root);
  const home = process.env.HOME ? realpathSync(process.env.HOME) : undefined;
  const repoRoot = realpathSync(resolve(import.meta.dir, ".."));
  const forbidden = [
    home,
    home ? join(home, ".company") : undefined,
    home ? join(home, ".company-host") : undefined,
    repoRoot,
  ].filter((entry): entry is string => Boolean(entry));
  if (forbidden.some((entry) => realRoot === entry))
    throw new UsageError("Refusing to use a user data or source directory as --root");
  if (forbidden.some((entry) => isInside(repoRoot, realRoot)))
    throw new UsageError("Refusing to use a root inside the source repository");
  const parent = dirname(realRoot);
  const tempParents = new Set(
    [
      existsSync("/tmp") ? realpathSync("/tmp") : "/tmp",
      process.env.TMPDIR && existsSync(process.env.TMPDIR)
        ? realpathSync(process.env.TMPDIR)
        : undefined,
      process.env.TMPDIR ? resolve(process.env.TMPDIR) : undefined,
    ].filter((entry): entry is string => Boolean(entry)),
  );
  const allowed =
    realRoot ===
      (existsSync("/tmp") ? join(realpathSync("/tmp"), "e2e") : "/tmp/e2e") ||
    (tempParents.has(parent) && basename(realRoot).startsWith("company-e2e."));
  if (!allowed)
    throw new UsageError(
      'Refusing a root that was not created by mktemp as "company-e2e.*" (or container /tmp/e2e)',
    );
  return realRoot;
}

function evidenceDirectoryFor(root: string, runId: string): string {
  const rootParent = dirname(root);
  const requested = process.env.E2E_EVIDENCE?.trim();
  const candidate = requested
    ? canonicalPath(requested)
    : join(rootParent, `company-e2e-evidence.${runId}`);
  // The evidence directory must be created by this run. Never chmod or write into
  // an existing directory (TMPDIR, a user directory, or a symlink target).
  let existing = false;
  try {
    lstatSync(candidate);
    existing = true;
  } catch {}
  if (existing)
    throw new UsageError(
      "E2E_EVIDENCE must not exist; this run creates its own evidence directory",
    );
  if (dirname(candidate) !== rootParent)
    throw new UsageError(
      "E2E_EVIDENCE must be a new sibling of --root (same parent directory)",
    );
  if (!basename(candidate).startsWith("company-e2e-evidence."))
    throw new UsageError(
      'E2E_EVIDENCE basename must start with "company-e2e-evidence."',
    );
  if (isInside(root, candidate))
    throw new UsageError("E2E_EVIDENCE must be outside --root");
  return candidate;
}

function createEvidenceDirectory(path: string): EvidenceIdentity {
  // Non-recursive create proves the parent already exists and the directory itself
  // did not exist a moment ago. A symlink or pre-existing path fails here.
  mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new UsageError("Evidence path is not a real directory");
  if (realpathSync(path) !== path)
    throw new UsageError("Evidence path must not resolve through a symlink");
  chmodSync(path, 0o700);
  return { path, ino: info.ino, dev: info.dev };
}

function assertEvidenceDirectory(dir: string, identity: EvidenceIdentity) {
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new StepError(
      "evidence_directory_replaced",
      "Evidence directory is no longer a real directory",
    );
  if (realpathSync(dir) !== dir)
    throw new StepError(
      "evidence_directory_replaced",
      "Evidence directory now resolves through a symlink",
    );
  if (info.ino !== identity.ino || info.dev !== identity.dev)
    throw new StepError(
      "evidence_directory_replaced",
      "Evidence directory inode/device changed; refusing to write",
    );
}

function ensureEvidenceSubdir(
  dir: string,
  identity: EvidenceIdentity,
  relativeDir: string,
) {
  assertEvidenceDirectory(dir, identity);
  let current = dir;
  for (const segment of relativeDir.split("/").filter(Boolean)) {
    if (segment === "." || segment === "..")
      throw new StepError("evidence_path_invalid", "Evidence path escapes its root");
    current = join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      mkdirSync(current, { mode: 0o700 });
      chmodSync(current, 0o700);
      info = lstatSync(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new StepError(
        "evidence_directory_replaced",
        "Evidence subdirectory is not a real directory",
      );
    if (realpathSync(current) !== current)
      throw new StepError(
        "evidence_directory_replaced",
        "Evidence subdirectory resolves through a symlink",
      );
  }
  assertEvidenceDirectory(dir, identity);
}

function writeEvidenceFileAt(
  dir: string,
  identity: EvidenceIdentity,
  relativePath: string,
  data: string | Buffer,
  mode = 0o600,
) {
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new StepError("evidence_path_invalid", "Evidence path must stay inside its directory");
  if (Buffer.byteLength(data) > MAX_EVIDENCE_FILE_BYTES)
    throw new StepError("evidence_too_large", "Evidence file exceeds the size limit");
  const parent = dirname(relativePath);
  if (parent && parent !== ".") ensureEvidenceSubdir(dir, identity, parent);
  assertEvidenceDirectory(dir, identity);
  const path = join(dir, ...relativePath.split("/"));
  if (!isInside(dir, path) || path === dir)
    throw new StepError("evidence_path_invalid", "Evidence path escapes its directory");
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
      throw new StepError(
        "evidence_directory_replaced",
        "Evidence file is not a single-link regular file",
      );
  } catch (error) {
    if (!(error instanceof StepError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
    if (error instanceof StepError) throw error;
  }
  const fd = openSync(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    if (typeof data === "string") writeSync(fd, data);
    else writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new StepError("evidence_directory_replaced", "Evidence file is not a regular file");
  chmodSync(path, mode);
  return path;
}

function writeEvidenceFile(
  run: RunState,
  relativePath: string,
  data: string | Buffer,
  mode = 0o600,
) {
  return writeEvidenceFileAt(
    run.evidenceDir,
    run.evidenceIdentity,
    relativePath,
    data,
    mode,
  );
}

function readModelEnvironment(file: string | undefined): ModelEnvironment {
  const present: Record<string, boolean> = {};
  for (const name of ALLOWED_MODEL_ENV_NAMES) present[name] = false;
  if (!file)
    return { values: {}, present, filePresent: false };
  if (!existsSync(file))
    return { values: {}, present, filePresent: false };
  const parsed = (() => {
    try {
      return parseEnv(readFileSync(file, "utf8"));
    } catch {
      // Do not surface parser messages that might quote a credential-bearing line.
      throw new UsageError("PERI_ENV_FILE is not valid .env syntax");
    }
  })();
  const values: Record<string, string> = {};
  // Reject names outside the whitelist instead of silently ignoring a typo. Only
  // the variable *name* is reported; values are never printed or stored.
  for (const name of Object.keys(parsed)) {
    if (!name.startsWith("PERI_MODEL_")) continue;
    if (!ALLOWED_MODEL_ENV_NAMES.has(name))
      throw new UsageError(
        `PERI_ENV_FILE contains unsupported model environment name ${name}`,
      );
  }
  for (const name of ALLOWED_MODEL_ENV_NAMES) {
    const value = parsed[name];
    if (typeof value === "string" && value.trim()) {
      values[name] = value;
      present[name] = true;
    }
  }
  // The generated model library binds every tier to an explicit env name. Fill
  // omitted per-tier IDs from the required base ID without changing `present`.
  for (const name of [
    "PERI_MODEL_ID_FABLE",
    "PERI_MODEL_ID_OPUS",
    "PERI_MODEL_ID_SONNET",
    "PERI_MODEL_ID_HAIKU",
  ])
    values[name] ??= values.PERI_MODEL_ID!;
  return { values, present, filePresent: true };
}

const TEST_ROOT_SUBDIRS = new Set([
  "home",
  "company",
  "host",
  "tmp",
  "logs",
  "run",
  "evidence",
  "projects",
]);

/**
 * A fresh mktemp root may already contain the empty layout directories documented
 * in the plan. Anything else (files, symlinks, empty unknown dirs, non-empty dirs)
 * means the script cannot prove that recursive cleanup only removes this run's data.
 */
function freshTestRootProblem(root: string): string | undefined {
  for (const name of readdirSync(root)) {
    if (!TEST_ROOT_SUBDIRS.has(name))
      return `--root contains unexpected entry ${name}`;
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory())
      return `--root entry ${name} must be a real directory`;
    if (readdirSync(path).length)
      return `--root entry ${name} must be empty`;
  }
  return undefined;
}

function missingModelNames(model: ModelEnvironment) {
  return REQUIRED_MODEL_ENV_NAMES.filter((name) => !model.present[name]);
}

/**
 * The live harness keeps its existing PERI_MODEL_* *names*, but they are now
 * values referenced by a host-owned model library rather than implicit runtime
 * variables. No credential or endpoint value is written into evidence.
 */
function buildModelLibrary(model: ModelEnvironment) {
  const providerType =
    model.values.PERI_MODEL_PROVIDER === "anthropic" ? "anthropic" : "openai";
  const tiers: Array<[string, string]> = [
    ["fable", "PERI_MODEL_ID_FABLE"],
    ["opus", "PERI_MODEL_ID_OPUS"],
    ["sonnet", "PERI_MODEL_ID_SONNET"],
    ["haiku", "PERI_MODEL_ID_HAIKU"],
  ];
  return `version: 2
activeProfile: default
providers:
  live-model:
    type: ${providerType}
    baseUrlEnv: PERI_MODEL_BASE_URL
    apiKeyEnv: PERI_MODEL_API_KEY
profiles:
  default:
    activeAlias: sonnet
    tiers:
${tiers
  .map(
    ([tier, env]) => `      ${tier}:
        provider: live-model
        modelEnv: ${env}`,
  )
  .join("\n")}
`;
}

/**
 * Synthetic contract check (no real credential, no network):
 * - the default profile fills unbound tiers from the active alias;
 * - lowercase tier keys and unknown provider references are rejected by schema;
 * - a bound active tier with a missing env value fails the configured gate.
 */
function assertModelFallbackContract() {
  const environment: Record<string, string> = {
    PERI_MODEL_BASE_URL: "https://contract.invalid/v1",
    PERI_MODEL_API_KEY: "contract-placeholder-not-a-secret",
    PERI_MODEL_ID: "contract-base-model",
    PERI_MODEL_ID_FABLE: "contract-base-model",
    PERI_MODEL_ID_OPUS: "contract-base-model",
    PERI_MODEL_ID_SONNET: "contract-base-model",
    PERI_MODEL_ID_HAIKU: "contract-base-model",
  };
  const parsed = modelLibrarySchema.safeParse({
    version: 2,
    activeProfile: "default",
    providers: {
      contract: {
        type: "openai",
        baseUrlEnv: "PERI_MODEL_BASE_URL",
        apiKeyEnv: "PERI_MODEL_API_KEY",
      },
    },
    profiles: {
      default: {
        activeAlias: "sonnet",
        tiers: {
          fable: { provider: "contract", modelEnv: "PERI_MODEL_ID_FABLE" },
          sonnet: { provider: "contract", modelEnv: "PERI_MODEL_ID_SONNET" },
        },
      },
    },
  });
  if (!parsed.success)
    throw new StepError(
      "model_library_contract_failed",
      "The synthetic model library is not valid",
    );
  const library: ModelLibraryState = {
    status: "ok",
    path: "contract",
    revision: "0".repeat(64),
    library: parsed.data,
    error: null,
    issues: [],
  };
  const resolved = resolveModel({ config: {}, library, environment });
  if (
    !resolved.metadata.configured ||
    MODEL_TIERS.some(
      (tier) => resolved.metadata.tiers[tier] !== "contract-base-model",
    )
  )
    throw new StepError(
      "model_fallback_contract_failed",
      "The default profile no longer fills unbound tiers from the active alias",
    );

  const lowercase = modelLibrarySchema.safeParse({
    version: 2,
    activeProfile: "default",
    providers: { p: { type: "openai" } },
    profiles: {
      default: {
        activeAlias: "sonnet",
        tiers: { Sonnet: { provider: "p", model: "m" } },
      },
    },
  });
  const unknown = modelLibrarySchema.safeParse({
    version: 2,
    activeProfile: "default",
    providers: { p: { type: "openai" } },
    profiles: {
      default: {
        activeAlias: "sonnet",
        tiers: { sonnet: { provider: "missing-provider", model: "m" } },
      },
    },
  });
  if (lowercase.success || unknown.success)
    throw new StepError(
      "model_tier_typo_not_rejected",
      "Unknown provider references or lowercase tier keys were not rejected",
    );

  const missingActiveTier = resolveModel({
    config: { modelAlias: "fable" },
    library,
    environment: {
      PERI_MODEL_BASE_URL: environment.PERI_MODEL_BASE_URL,
      PERI_MODEL_API_KEY: environment.PERI_MODEL_API_KEY,
    },
  });
  if (
    missingActiveTier.metadata.configured ||
    missingActiveTier.metadata.tiers.fable !== "unconfigured"
  )
    throw new StepError(
      "model_missing_active_tier_gate",
      "A missing active-tier model was not rejected by the configured gate",
    );
  let aliasRejected = false;
  try {
    resolveModel({
      config: { modelAlias: "gpt-4" },
      library,
      environment,
    });
  } catch (error) {
    aliasRejected = error instanceof ModelConfigurationError;
  }
  if (!aliasRejected)
    throw new StepError(
      "model_alias_not_rejected",
      "An invalid model alias was not rejected",
    );
  return {
    fallbackTiers: true,
    lowercaseTierRejected: true,
    unknownTierRejected: true,
    missingActiveTierGated: true,
  };
}

function printDryRun(options: Options): number {
  try {
    const { url, port } = loopbackBase(options.base);
    const root = validateTestRoot(options.root);
    const runId = "dry-run";
    const evidence = evidenceDirectoryFor(root, runId);
    const model = readModelEnvironment(process.env.PERI_ENV_FILE);
    const missing = missingModelNames(model);
    const contract = assertModelFallbackContract();
    if (!modelLibrarySchema.safeParse(parseYaml(buildModelLibrary(model))).success)
      throw new StepError(
        "model_library_generated_invalid",
        "The generated model library is not valid v2",
      );
    const rootProblem = freshTestRootProblem(root);
    const periBinary = process.env.PERI_BINARY;
    const projectRoot = process.env.E2E_PROJECT_ROOT;
    const ciRunner = process.env.E2E_CI_RUNNER?.trim() || "docker";
    const checks: string[] = [];
    if (ciRunner !== "docker" && ciRunner !== "bwrap")
      checks.push("E2E_CI_RUNNER must be docker or bwrap");
    const ciProbe =
      options.mode === "local-full" && (ciRunner === "docker" || ciRunner === "bwrap")
        ? probeCiBackendForDryRun(ciRunner)
        : undefined;
    if (ciProbe && !ciProbe.ok) checks.push(ciProbe.detail);
    if (!process.env.PERI_ENV_FILE) checks.push("PERI_ENV_FILE missing");
    else if (!model.filePresent) checks.push("PERI_ENV_FILE unreadable");
    if (missing.length) checks.push(`model env missing: ${missing.join(", ")}`);
    if (rootProblem) checks.push(rootProblem);
    const storesProblem = storesFileProblem();
    if (storesProblem) checks.push(storesProblem);
    if (options.mode === "local-full" && !periBinary)
      checks.push("PERI_BINARY missing (required for local-full)");
    if (options.mode === "local-full") {
      if (!projectRoot) checks.push("E2E_PROJECT_ROOT missing");
      else if (!isInside(root, canonicalPath(projectRoot)))
        checks.push("E2E_PROJECT_ROOT must be inside --root");
    }
    console.log(`dry-run mode=${options.mode}`);
    console.log(`base=${url.origin} appPort=${port}`);
    console.log(`root=${root}`);
    console.log(`evidence=${evidence}`);
    console.log(
      `PERI_ENV_FILE present=${model.filePresent} path=${process.env.PERI_ENV_FILE ?? "(unset)"}`,
    );
    for (const name of ALLOWED_MODEL_ENV_NAMES)
      console.log(`model env ${name}=${model.present[name] ? "present" : "missing"}`);
    console.log(
      `model fallback contract: fallbackTiers=${contract.fallbackTiers} lowercaseRejected=${contract.lowercaseTierRejected} unknownRejected=${contract.unknownTierRejected} missingActiveTierGated=${contract.missingActiveTierGated}`,
    );
    if (!storesProblem) console.log("COMPANY_WASM_STORES_FILE=present");
    if (periBinary) console.log("PERI_BINARY=present");
    if (projectRoot) console.log(`E2E_PROJECT_ROOT=${canonicalPath(projectRoot)}`);
    console.log(
      `ci runner=${ciRunner} image=${CI_IMAGE} expectedPeri=${EXPECTED_PERI_VERSION}`,
    );
    console.log(
      `ci backend probe: ${
        options.mode === "local-full"
          ? ciProbe?.detail ?? "not requested (invalid E2E_CI_RUNNER)"
          : "not_applicable (macos-smoke does not run CI)"
      }`,
    );
    if (checks.length) {
      console.log("validation: FAILED");
      for (const check of checks) console.log(` - ${check}`);
      console.log("No service was started; no model was called.");
      return 1;
    }
    console.log("validation: ok");
    console.log("No service was started; no model was called.");
    return 0;
  } catch (error) {
    console.log(`validation: FAILED\n - ${safeMessage(error)}`);
    console.log("No service was started; no model was called.");
    return 1;
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Api {
  cookie = "";
  lastStatus = 0;
  private readonly chatHandles = new Map<
    string,
    { id: string; sessionId: string; bindingRevision: number }
  >();
  constructor(
    readonly origin: string,
    readonly timeoutMs = 30_000,
  ) {}

  private chatKey(companyId: string, agentId: string) {
    return `${companyId}\u0000${agentId}`;
  }

  /** 取得/刷新 Agent 当前 Chat 句柄；固定 Session 已绑定时 wake 是幂等的。 */
  private async chatHandle(
    companyId: string,
    agentId: string,
    refresh = false,
  ) {
    const key = this.chatKey(companyId, agentId);
    if (!refresh) {
      const cached = this.chatHandles.get(key);
      if (cached) return cached;
    }
    const created: any = await this.post(
      `/api/chats?companyId=${encodeURIComponent(companyId)}&agentId=${encodeURIComponent(agentId)}`,
      {},
    );
    const chat = created?.chat;
    if (
      !chat ||
      typeof chat.id !== "string" ||
      typeof chat.sessionId !== "string" ||
      typeof chat.bindingRevision !== "number"
    )
      throw new StepError(
        "chat_handle_missing",
        "POST /api/chats did not return a Chat handle.",
      );
    const handle = {
      id: chat.id,
      sessionId: chat.sessionId,
      bindingRevision: chat.bindingRevision,
    };
    this.chatHandles.set(key, handle);
    return handle;
  }

  private forgetChat(companyId: string, agentId: string) {
    this.chatHandles.delete(this.chatKey(companyId, agentId));
  }

  /** 以当前绑定为目标执行 Peri ChatUserAction；句柄失效时刷新一次。 */
  private async chatAction(
    companyId: string,
    agentId: string,
    body: Record<string, unknown>,
  ) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const handle = await this.chatHandle(companyId, agentId, attempt > 0);
      try {
        return await this.post(
          `/api/chats/${encodeURIComponent(handle.id)}/actions?companyId=${encodeURIComponent(companyId)}&agentId=${encodeURIComponent(agentId)}`,
          {
            ...body,
            target: {
              chatId: handle.id,
              sessionId: handle.sessionId,
              bindingRevision: handle.bindingRevision,
            },
          },
        );
      } catch (error) {
        if (attempt === 0 && error instanceof ApiError && error.status === 410) {
          this.forgetChat(companyId, agentId);
          continue;
        }
        throw error;
      }
    }
    throw new StepError("chat_action_failed", "Chat action retry exhausted.");
  }

  private async decode(response: Response) {
    this.lastStatus = response.status;
    let data: any = null;
    try {
      data = await response.json();
    } catch {}
    if (!response.ok) {
      // 传统路由把错误包在 `error` 里；Peri chat actions/DELETE 直接返回平铺错误体。
      const error = data?.error ?? data;
      throw new ApiError(
        response.status,
        String(error?.code ?? `http_${response.status}`),
        String(error?.message ?? "Request failed"),
      );
    }
    return data;
  }

  private headers(extra?: Record<string, string>) {
    return {
      accept: "application/json",
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...(extra ?? {}),
    };
  }

  async login(token: string) {
    const response = await fetch(new URL("/api/login", this.origin), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ token }),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.lastStatus = response.status;
    if (!response.ok) {
      let data: any = null;
      try {
        data = await response.json();
      } catch {}
      throw new ApiError(
        response.status,
        String(data?.error?.code ?? "unauthorized"),
        "Login failed",
      );
    }
    const setCookie = response.headers.get("set-cookie") ?? "";
    const pair = setCookie.split(";", 1)[0]?.trim();
    if (!pair || !pair.startsWith("company_session="))
      throw new StepError(
        "login_cookie_missing",
        "Login succeeded without the expected session cookie.",
      );
    this.cookie = pair;
    return setCookie;
  }

  async request(method: string, path: string, body?: unknown) {
    const response = await fetch(new URL(path, this.origin), {
      method,
      headers: this.headers(
        body === undefined ? {} : { "content-type": "application/json" },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.decode(response);
  }

  get(path: string) {
    return this.request("GET", path);
  }

  post(path: string, body: unknown) {
    return this.request("POST", path, body);
  }

  health() {
    return this.get("/health");
  }

  companies() {
    return this.get("/api/companies");
  }

  company(companyId: string) {
    return this.get(`/api/companies/${encodeURIComponent(companyId)}`);
  }

  action(
    companyId: string | undefined,
    module: string,
    operation: string,
    input: Record<string, unknown>,
  ) {
    return this.post("/api/action", {
      ...(companyId ? { companyId } : {}),
      module,
      operation,
      input,
    });
  }

  runtime(companyId: string, agentId: string) {
    return this.get(
      `/api/agents/${encodeURIComponent(agentId)}/runtime?companyId=${encodeURIComponent(companyId)}`,
    );
  }

  configuration(companyId: string, agentId: string) {
    return this.get(
      `/api/agents/${encodeURIComponent(agentId)}/configuration?companyId=${encodeURIComponent(companyId)}`,
    );
  }

  saveConfiguration(
    companyId: string,
    agentId: string,
    expectedVersion: number,
    configuration: Record<string, unknown>,
    requestId: string,
  ) {
    return this.post(
      `/api/agents/${encodeURIComponent(agentId)}/configuration`,
      { companyId, expectedVersion, configuration, requestId },
    );
  }

  async restartAgent(companyId: string, agentId: string) {
    const result = await this.post(
      `/api/agents/${encodeURIComponent(agentId)}/restart`,
      { companyId },
    );
    // restart 会生成新的 Chat 句柄；下一次访问必须重新 wake。
    this.forgetChat(companyId, agentId);
    return result;
  }

  async conversation(companyId: string, agentId: string) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const handle = await this.chatHandle(companyId, agentId, attempt > 0);
      try {
        return await this.get(
          `/api/chats/${encodeURIComponent(handle.id)}/projection?companyId=${encodeURIComponent(companyId)}&agentId=${encodeURIComponent(agentId)}`,
        );
      } catch (error) {
        if (attempt === 0 && error instanceof ApiError && error.status === 410) {
          this.forgetChat(companyId, agentId);
          continue;
        }
        throw error;
      }
    }
    throw new StepError("chat_projection_failed", "Chat projection retry exhausted.");
  }

  send(
    companyId: string,
    agentId: string,
    input: { text: string; requestId: string },
  ) {
    return this.chatAction(companyId, agentId, {
      type: "send",
      requestId: input.requestId,
      payload: { text: input.text },
    });
  }

  /** Owner answer for a runtime permission/elicitation interaction. The live E2E
   * only uses kind=permission with allow_once; elicitation is never auto-answered. */
  answer(
    companyId: string,
    agentId: string,
    interactionId: string,
    answer: { kind: "permission"; decision: "allow_once" | "reject_once" },
  ) {
    return this.chatAction(companyId, agentId, {
      type: "answer",
      requestId: `e2e-answer-${randomUUID()}`,
      payload: { interactionId, answer },
    });
  }

  /** Owner queue control for an input that the SDK accepted but did not start. */
  forceSend(companyId: string, agentId: string, inputId: string) {
    return this.chatAction(companyId, agentId, {
      type: "force_send",
      requestId: `e2e-force-${randomUUID()}`,
      payload: { inputId },
    });
  }

  takeBack(companyId: string, agentId: string, inputId: string) {
    return this.chatAction(companyId, agentId, {
      type: "take_back",
      requestId: `e2e-take-back-${randomUUID()}`,
      payload: { inputId },
    });
  }

  files(
    companyId: string,
    agentId: string,
    operation: string,
    query: Record<string, string> = {},
  ) {
    const search = new URLSearchParams({ companyId, ...query });
    return this.get(
      `/api/agents/${encodeURIComponent(agentId)}/files${operation ? "/" + operation : ""}?${search}`,
    );
  }

  saveFile(
    companyId: string,
    agentId: string,
    body: {
      path: string;
      content: string;
      expectedVersion: string;
    },
  ) {
    return this.post(`/api/agents/${encodeURIComponent(agentId)}/files/save`, {
      companyId,
      ...body,
    });
  }

  commitFiles(companyId: string, agentId: string, message: string) {
    return this.post(`/api/agents/${encodeURIComponent(agentId)}/files/commit`, {
      companyId,
      message,
    });
  }
}

function readMarkdownFile(path: string): {
  head: Record<string, any>;
  body: string;
} {
  const raw = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new StepError("invalid_document", "Expected YAML front matter");
  const head = parseYaml(match[1]!) as Record<string, any>;
  return { head, body: match[2] ?? "" };
}

function readYamlFile(path: string) {
  return parseYaml(readFileSync(path, "utf8")) as Record<string, any>;
}

function sha12(value: string): string {
  return value.slice(0, 12);
}

function git(cwd: string, args: string[], run?: RunState) {
  const result = runGit(cwd, args, {
    home: run?.home ?? process.env.HOME ?? "/tmp",
  });
  return {
    status: result.status,
    stdout: result.stdout.toString("utf8").trim(),
    stderr: result.stderr.toString("utf8").trim(),
  };
}

function redact(text: string, secrets: string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) output = output.split(secret).join("[REDACTED]");
  }
  return output
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/company_session=[^;\s]+/gi, "company_session=[REDACTED]")
    .replace(
      /(PERI_MODEL_[A-Z0-9_]+)\s*[:=]\s*[^\s"']+/g,
      "$1=[REDACTED]",
    )
    .replace(
      /(PERI_STORAGE_[A-Z0-9_]+)\s*[:=]\s*[^\s"']+/g,
      "$1=[REDACTED]",
    )
    .replace(
      /(COMPANY_WEB_TOKEN)\s*[:=]\s*[^\s"']+/g,
      "$1=[REDACTED]",
    )
    .replace(/PERI_MODEL_[A-Z0-9_]+/g, "[MODEL_ENV]")
    .replace(/PERI_STORAGE_[A-Z0-9_]+/g, "[STORAGE_ENV]");
}

function clamp(text: string, limit = 2000): string {
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof ApiError || error instanceof StepError) return error.code;
  return undefined;
}

async function waitFor<T>(
  label: string,
  operation: () => Promise<T | undefined>,
  timeoutMs = STEP_TIMEOUT_MS,
  intervalMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  const suffix = lastError ? `: ${safeMessage(lastError)}` : "";
  throw new StepError("timeout", `${label} timed out${suffix}`);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function hasTool(tools: string[], name: string) {
  return tools.some((tool) => tool === name || tool.includes(name));
}

/** Deferred tools are executed through ExecuteExtraTool. Depending on when the
 * Session view is read, the inner MCP call may only be visible as the wrapper's
 * `tool_name` argument (the nested call is not always persisted after reload).
 * Include both the projected call names and that argument, never free text. */
function verificationToolNames(
  messageTools: string[],
  calls: AgentToolCall[],
): string[] {
  const names = new Set(messageTools);
  for (const call of calls) {
    if (call.name) names.add(call.name);
    if (!/ExecuteExtraTool/.test(call.name)) continue;
    try {
      const args = JSON.parse(call.argumentsText);
      if (typeof args?.tool_name === "string" && args.tool_name)
        names.add(args.tool_name);
    } catch {}
  }
  return [...names];
}

type AgentIds = {
  hr: string;
  supervisor: string;
  dev: string;
  preview: string;
  reviewer: string;
};

type ListenerState = { supported: boolean; pids: string[] };
type UserDataSnapshot = {
  supported: boolean;
  complete: boolean;
  roots: string[];
  expected: UserDataExpectedPath[];
  digest: string;
  records: number;
  error?: string;
};
type IsolationBaseline = {
  capturedAt: string;
  rootInode: number;
  rootDev: number;
  ownerTokenFiles: number;
  reservedPorts: Record<string, ListenerState>;
  userData: UserDataSnapshot;
};
type EvidenceIdentity = {
  path: string;
  ino: number;
  dev: number;
};
type OwnedDirectory = {
  path: string;
  ino: number;
  dev: number;
};
type PendingRunCleanup = {
  root: string;
  rootInode: number;
  rootDev: number;
  evidenceDir?: string;
  evidenceIdentity?: EvidenceIdentity;
};
type CiProof = {
  mode: CiMode;
  backend: CiRunnerBackend;
  challenge: string;
  digest: string;
  report: CiReport;
  isolation: CiRunnerSpec["isolation"];
  containerName?: string;
  exited: boolean;
  fixtureSha: string;
  manifestSha: string;
  workDir: string;
  agentDir: string;
  agentCommand: string;
};
type UserDataOpenCheck = {
  supported: boolean;
  checked: number;
  opened: number;
  exited: number;
  unavailablePids: number[];
};

function listenerState(port: number): ListenerState {
  const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  const lsof = spawnSync(
    "lsof",
    ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
    { encoding: "utf8", env, timeout: 10_000 },
  );
  if (!lsof.error && (lsof.status === 0 || lsof.status === 1)) {
    return {
      supported: true,
      pids: (lsof.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort(),
    };
  }
  const ss = spawnSync("ss", ["-ltnp"], {
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  if (!ss.error && ss.status === 0) {
    const pids = new Set<string>();
    for (const line of (ss.stdout ?? "").split("\n")) {
      if (!new RegExp(`:${port}\\s`).test(line)) continue;
      for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(match[1]!);
    }
    return { supported: true, pids: [...pids].sort() };
  }
  if (process.platform === "linux") {
    try {
      const inodes = new Set<string>();
      for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        let content = "";
        try {
          content = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        for (const line of content.split("\n").slice(1)) {
          const fields = line.trim().split(/\s+/);
          if (fields.length < 10 || fields[3] !== "0A") continue;
          const localPort = Number.parseInt(
            fields[1]!.split(":").pop() ?? "",
            16,
          );
          if (localPort === port && fields[9]) inodes.add(fields[9]);
        }
      }
      const pids = new Set<string>();
      if (inodes.size) {
        for (const entry of readdirSync("/proc")) {
          if (!/^\d+$/.test(entry)) continue;
          try {
            for (const fd of readdirSync(`/proc/${entry}/fd`)) {
              try {
                const target = readlinkSync(`/proc/${entry}/fd/${fd}`);
                const match = /^socket:\[(\d+)\]$/.exec(target);
                if (match && inodes.has(match[1]!)) pids.add(entry);
              } catch {}
            }
          } catch {}
        }
      }
      return { supported: true, pids: [...pids].sort() };
    } catch {}
  }
  return { supported: false, pids: [] };
}

function userDataDirectories(): {
  supported: boolean;
  roots: string[];
  expected: UserDataExpectedPath[];
} {
  const homes = new Set<string>();
  try {
    homes.add(realpathSync(process.env.HOME || homedir()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { supported: false, roots: [], expected: [] };
  }
  // The E2E plan sets HOME to the test root. Also check the real login home from
  // the password database so a test process cannot hide user data by changing HOME.
  try {
    const realHome = userInfo().homedir;
    if (realHome) {
      try {
        homes.add(realpathSync(realHome));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          return { supported: false, roots: [], expected: [] };
      }
    }
  } catch {
    return { supported: false, roots: [], expected: [] };
  }
  const roots: string[] = [];
  const expected: UserDataExpectedPath[] = [];
  for (const home of homes) {
    for (const name of [".company", ".company-host"]) {
      const path = join(home, name);
      let info;
      try {
        info = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // Record absent paths too. A directory created during the run must change
          // the digest and fail E19 instead of being outside the baseline.
          expected.push({ home, name, path, exists: false, kind: "absent" });
          continue;
        }
        return { supported: false, roots: [], expected: [] };
      }
      const kind: UserDataExpectedPath["kind"] = info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other";
      let canonical: string | undefined;
      try {
        canonical = realpathSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          return { supported: false, roots: [], expected: [] };
      }
      expected.push({
        home,
        name,
        path,
        exists: true,
        kind,
        ...(canonical ? { canonical } : {}),
        size: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
        ino: info.ino,
        dev: info.dev,
        mode: info.mode,
        nlink: info.nlink,
      });
      // Follow a user-created symlink to its real directory so open-FD and
      // metadata checks compare canonical paths. Metadata only; never contents.
      if (canonical) roots.push(canonical);
    }
  }
  return { supported: true, roots: [...new Set(roots)], expected };
}

/** Metadata only: never opens file contents. Symlinked directories are recorded but
 * not traversed. If any entry cannot be observed, `complete` is false and callers
 * must fail closed instead of claiming the user data was unchanged. Expected
 * `.company`/`.company-host` paths are included even when absent, so a directory
 * created during the run cannot be missed. */
function userDataMetadata(): UserDataSnapshot {
  const discovered = userDataDirectories();
  if (!discovered.supported)
    return {
      supported: false,
      complete: false,
      roots: [],
      expected: [],
      digest: sha256Hex(""),
      records: 0,
      error: "home_unresolved",
    };
  const records: string[] = discovered.expected.map(expectedPathRecord);
  let complete = true;
  let error: string | undefined;
  const maxRecords = 20_000;
  for (const root of discovered.roots) {
    const stack: Array<{ path: string; rel: string }> = [{ path: root, rel: "." }];
    while (stack.length) {
      if (records.length >= maxRecords) {
        complete = false;
        error = "truncated";
        break;
      }
      const current = stack.pop()!;
      let info;
      try {
        info = lstatSync(current.path);
      } catch {
        complete = false;
        error = "stat_failed";
        break;
      }
      records.push(
        `${root}\0${current.rel}|${info.size}|${Math.trunc(info.mtimeMs)}|${Math.trunc(info.ctimeMs)}|${info.ino}|${info.mode}|${info.nlink}`,
      );
      if (info.isDirectory() && !info.isSymbolicLink()) {
        let entries: string[] = [];
        try {
          entries = readdirSync(current.path);
        } catch {
          complete = false;
          error = "read_dir_failed";
          break;
        }
        for (const entry of entries)
          stack.push({
            path: join(current.path, entry),
            rel: current.rel === "." ? entry : `${current.rel}/${entry}`,
          });
      }
    }
    if (!complete) break;
  }
  records.sort();
  return {
    supported: true,
    complete,
    roots: discovered.roots,
    expected: discovered.expected,
    digest: sha256Hex(records.join("\n")),
    records: records.length,
    ...(error ? { error } : {}),
  };
}

function captureIsolationBaseline(root: string): IsolationBaseline {
  const info = lstatSync(root);
  const ownerTokens = findNamedFiles(root, "owner-token");
  if (!ownerTokens.supported)
    throw new UsageError("Cannot inspect the test root for owner-token files");
  return {
    capturedAt: new Date().toISOString(),
    rootInode: info.ino,
    rootDev: info.dev,
    ownerTokenFiles: ownerTokens.files.length,
    reservedPorts: Object.fromEntries(
      [...RESERVED_PORTS].map((port) => [String(port), listenerState(port)]),
    ),
    userData: userDataMetadata(),
  };
}

function processOpenPaths(pid: number): { supported: boolean; paths: string[] } {
  if (process.platform === "linux") {
    try {
      const directory = `/proc/${pid}/fd`;
      const paths = readdirSync(directory).map((name) => {
        try {
          return readlinkSync(join(directory, name));
        } catch {
          return "";
        }
      });
      return { supported: true, paths: paths.filter(Boolean) };
    } catch {
      return { supported: false, paths: [] };
    }
  }
  const result = spawnSync("lsof", ["-p", String(pid), "-Fn"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
    timeout: 10_000,
  });
  if (result.error || result.status !== 0)
    return { supported: false, paths: [] };
  return {
    supported: true,
    paths: (result.stdout ?? "")
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1)),
  };
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      if (state === "Z") return false;
    } catch {}
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function directChildren(pid: number): number[] {
  if (process.platform === "linux") {
    try {
      const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
      return text
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0);
    } catch {}
  }
  const result = spawnSync("pgrep", ["-P", String(pid)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function processTree(pid: number): number[] {
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length && seen.size < 256) {
    const current = queue.shift()!;
    for (const child of directChildren(current)) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return [...seen];
}

/** All processes owned by this run that could touch user data: the server, its
 * Workspace descendants, and any listener on the test app/preview ports. */
function isolationProcessIds(run: RunState): {
  pids: number[];
  supported: boolean;
  ports: Record<string, ListenerState>;
} {
  const pids = new Set<number>();
  if (run.childPid) for (const pid of processTree(run.childPid)) pids.add(pid);
  const ports: Record<string, ListenerState> = {};
  let supported = true;
  const entries: Array<[string, number | undefined]> = [
    ["app", run.appPort],
    ["preview", run.previewPort],
  ];
  for (const [label, port] of entries) {
    if (!port) continue;
    const state = listenerState(port);
    ports[label] = state;
    if (!state.supported) supported = false;
    for (const pid of state.pids) {
      const value = Number(pid);
      if (Number.isInteger(value) && value > 0) pids.add(value);
    }
  }
  pids.delete(process.pid);
  return { pids: [...pids].sort((a, b) => a - b), supported, ports };
}

function openedUserData(pids: number[], roots: string[]): UserDataOpenCheck {
  if (!roots.length)
    return { supported: true, checked: 0, opened: 0, exited: 0, unavailablePids: [] };
  const unavailablePids: number[] = [];
  let checked = 0;
  let opened = 0;
  let exited = 0;
  for (const pid of pids) {
    if (!processAlive(pid)) {
      exited++;
      continue;
    }
    const state = processOpenPaths(pid);
    if (!state.supported) {
      unavailablePids.push(pid);
      continue;
    }
    checked++;
    opened += state.paths.filter((path) =>
      roots.some((root) => path === root || path.startsWith(root + "/")),
    ).length;
  }
  return {
    supported: unavailablePids.length === 0,
    checked,
    opened,
    exited,
    unavailablePids,
  };
}

function findNamedFiles(
  root: string,
  name: string,
): { supported: boolean; files: string[] } {
  const found: string[] = [];
  let supported = true;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") supported = false;
      continue;
    }
    if (basename(current) === name) found.push(current);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = readdirSync(current);
      } catch {
        supported = false;
      }
      for (const entry of entries) stack.push(join(current, entry));
    }
  }
  return { supported, files: found };
}

function reservedPortsUnchanged(baseline: Record<string, ListenerState>) {
  const results: Record<string, string> = {};
  let verified = true;
  for (const [port, before] of Object.entries(baseline)) {
    const after = listenerState(Number(port));
    if (!before.supported || !after.supported) {
      results[port] = "unverified";
      verified = false;
      continue;
    }
    const same =
      before.pids.length === after.pids.length &&
      before.pids.every((pid, index) => pid === after.pids[index]);
    results[port] = same ? "unchanged" : "changed";
    if (!same) verified = false;
  }
  return { verified, results };
}

type RunState = {
  options: Options;
  runId: string;
  origin: string;
  appPort: number;
  root: string;
  companyHome: string;
  storesFile: string;
  runDir: string;
  home: string;
  tmp: string;
  logs: string;
  evidenceDir: string;
  evidenceIdentity: EvidenceIdentity;
  evidenceCreated: boolean;
  baseline: IsolationBaseline;
  projectRoot?: string;
  model: ModelEnvironment;
  modelLibraryPath: string;
  ownerToken: string;
  api: Api;
  child?: ReturnType<typeof Bun.spawn>;
  childPid?: number;
  serverCount: number;
  ciBackend?: CiRunnerBackend;
  ciProofs: Partial<Record<CiMode, CiProof>>;
  agentCiExecutions: Partial<Record<CiMode, AgentCiExecution>>;
  ciWorkDirs: OwnedDirectory[];
  ciContainers: string[];
  companyId?: string;
  agents?: AgentIds;
  issueId?: string;
  questionId?: string;
  batchId?: string;
  batchVersion?: number;
  batchCodeRef?: string;
  previewPort?: number;
  previewUrl?: string;
  missingAcceptanceNegative?: boolean;
  /** Owner approvals this orchestrator submitted for runtime permission prompts.
   * Counted only; titles/messages are Agent-controlled and never stored. */
  permissionsAnswered: number;
  /** Explicit owner restarts used to clear an Agent turn that the SDK left in
   * status=error. Sessions are preserved; only the count is stored. */
  sessionRecoveries: number;
  /** Stale queued owner inputs removed with the product's queue take-back API. */
  queueTakeBacks: number;
  steps: Evidence[];
  secrets: string[];
  blocked?: string;
};

class Runner {
  constructor(readonly run: RunState) {}

  async step(
    id: string,
    actor: string,
    operation: string,
    fn: () => Promise<Evidence>,
  ): Promise<Evidence> {
    if (this.run.blocked) {
      const skipped: Evidence = {
        step: id,
        actor,
        operation,
        status: "skipped",
        error: {
          code: "blocked",
          message: `Skipped because ${this.run.blocked} did not pass.`,
        },
      };
      this.run.steps.push(skipped);
      return skipped;
    }
    const started = Date.now();
    try {
      const evidence = await fn();
      evidence.elapsedMs ??= Date.now() - started;
      evidence.checks = {
        ...(evidence.checks ?? {}),
        permissionsAnswered: this.run.permissionsAnswered,
        sessionRecoveries: this.run.sessionRecoveries,
        queueTakeBacks: this.run.queueTakeBacks,
      };
      this.run.steps.push(evidence);
      return evidence;
    } catch (error) {
      const message = redact(clamp(safeMessage(error)), this.run.secrets);
      const failed: Evidence = {
        step: id,
        actor,
        operation,
        status: error instanceof StepError && error.code === "skipped" ? "skipped" : "failed",
        elapsedMs: Date.now() - started,
        checks: {
          permissionsAnswered: this.run.permissionsAnswered,
          sessionRecoveries: this.run.sessionRecoveries,
          queueTakeBacks: this.run.queueTakeBacks,
        },
        error: {
          ...(errorCode(error) ? { code: errorCode(error) } : {}),
          message,
        },
      };
      this.run.steps.push(failed);
      if (failed.status === "failed") this.run.blocked = id;
      return failed;
    }
  }

  transcript(id: string, messages: any[]) {
    const lines: string[] = [];
    for (const message of messages.slice(-80)) {
      const role = typeof message?.role === "string" ? message.role : "unknown";
      const tools = Array.isArray(message?.tools)
        ? message.tools.filter((tool: unknown) => typeof tool === "string")
        : [];
      const text = typeof message?.text === "string" ? message.text : "";
      lines.push(`[${role}]`);
      if (tools.length) lines.push(`tools: ${tools.join(", ")}`);
      if (text.trim()) lines.push(clamp(redact(text, this.run.secrets), 4000));
      lines.push("");
    }
    const name = `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`;
    writeEvidenceFile(
      this.run,
      `transcripts/${name}`,
      lines.join("\n"),
      0o600,
    );
  }
}

/** Set before the test root/evidence directory is created so a signal in the
 * prepareRun window can still remove only this run's own directory. */
let pendingCleanup: PendingRunCleanup | undefined;

function prepareRun(options: Options): RunState {
  const { url, port } = loopbackBase(options.base);
  const root = validateTestRoot(options.root);
  const runId = randomUUID().slice(0, 8);
  const evidenceDir = evidenceDirectoryFor(root, runId);
  // A fresh mktemp directory may contain only the documented empty test layout.
  // Refusing pre-existing data makes the later recursive delete provably scoped to
  // this run's own test data.
  const rootProblem = freshTestRootProblem(root);
  if (rootProblem) throw new UsageError(rootProblem);
  const rootInfo = lstatSync(root);
  pendingCleanup = {
    root,
    rootInode: rootInfo.ino,
    rootDev: rootInfo.dev,
  };
  const companyHome = join(root, "company");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const runDir = join(root, "run");
  const logs = join(root, "logs");
  const storesProblem = storesFileProblem();
  if (storesProblem) throw new UsageError(storesProblem);
  const storesFile = canonicalPath(process.env.COMPANY_WASM_STORES_FILE!);
  const periBinary = process.env.PERI_BINARY;
  if (options.mode === "local-full") {
    if (!periBinary) throw new UsageError("PERI_BINARY is required for local-full");
    if (!isAbsolute(periBinary) || !existsSync(periBinary))
      throw new UsageError("PERI_BINARY must be an existing absolute path");
  }
  const model = readModelEnvironment(process.env.PERI_ENV_FILE);
  if (!model.filePresent)
    throw new UsageError("PERI_ENV_FILE is missing or unreadable");
  const missing = missingModelNames(model);
  if (missing.length)
    throw new UsageError(`PERI_ENV_FILE is missing required model names: ${missing.join(", ")}`);

  let projectRoot: string | undefined;
  if (options.mode === "local-full") {
    if (!process.env.E2E_PROJECT_ROOT)
      throw new UsageError("E2E_PROJECT_ROOT is required for local-full");
    projectRoot = canonicalPath(process.env.E2E_PROJECT_ROOT);
    if (!isInside(root, projectRoot))
      throw new UsageError("E2E_PROJECT_ROOT must be inside --root");
    if (isInside(companyHome, projectRoot))
      throw new UsageError("E2E_PROJECT_ROOT must not be inside COMPANY_HOME");
  }

  for (const directory of [companyHome, home, tmp, runDir, logs])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  if (existsSync(join(runDir, ".env")))
    throw new UsageError("Test run cwd must not contain .env (Bun would auto-load it)");
  if (readdirSync(runDir).length)
    throw new UsageError("Test run cwd must be an empty temporary directory");
  const evidenceIdentity = createEvidenceDirectory(evidenceDir);
  pendingCleanup = {
    root,
    rootInode: rootInfo.ino,
    rootDev: rootInfo.dev,
    evidenceDir,
    evidenceIdentity,
  };
  ensureEvidenceSubdir(evidenceDir, evidenceIdentity, "transcripts");
  const modelLibraryPath = join(runDir, "model-library.yaml");
  writeFileSync(modelLibraryPath, buildModelLibrary(model), { mode: 0o600 });
  chmodSync(modelLibraryPath, 0o600);

  // Capture isolation baselines before the test server starts. User data is only
  // stat'ed (path/size/mtime/inode); file contents and names are never written to
  // evidence. Only counts and a digest are persisted.
  const baseline = captureIsolationBaseline(root);
  const baselineSummary = [
    `user data roots: ${baseline.userData.roots.length}`,
    `expected user data paths: ${baseline.userData.expected.length}`,
    `expected user data paths existing: ${baseline.userData.expected.filter((entry) => entry.exists).length}`,
    `metadata records: ${baseline.userData.records}`,
    `metadata digest: ${baseline.userData.digest}`,
    `supported: ${baseline.userData.supported}`,
    `complete: ${baseline.userData.complete}`,
    ...(baseline.userData.error ? [`error: ${baseline.userData.error}`] : []),
    "",
  ].join("\n");
  writeEvidenceFileAt(
    evidenceDir,
    evidenceIdentity,
    "baseline-user-data.txt",
    baselineSummary,
    0o600,
  );

  const ownerToken = randomBytes(32).toString("hex");
  return {
    options,
    runId,
    origin: url.origin,
    appPort: port,
    root,
    companyHome,
    storesFile,
    runDir,
    home,
    tmp,
    logs,
    evidenceDir,
    evidenceIdentity,
    evidenceCreated: true,
    baseline,
    projectRoot,
    model,
    modelLibraryPath,
    ownerToken,
    api: new Api(url.origin),
    serverCount: 0,
    ciProofs: {},
    agentCiExecutions: {},
    ciWorkDirs: [],
    ciContainers: [],
    permissionsAnswered: 0,
    sessionRecoveries: 0,
    queueTakeBacks: 0,
    steps: [],
    secrets: [ownerToken, model.values.PERI_MODEL_API_KEY ?? ""].filter(Boolean),
  };
}

function childEnvironment(run: RunState): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: run.home,
    TMPDIR: run.tmp,
    COMPANY_HOME: run.companyHome,
    COMPANY_HOST: "127.0.0.1",
    PORT: String(run.appPort),
    COMPANY_BASE_URL: run.origin,
    COMPANY_WASM_STORES_FILE: run.storesFile,
    COMPANY_WEB_TOKEN: run.ownerToken,
    COMPANY_MODEL_LIBRARY: run.modelLibraryPath,
    ...run.model.values,
  };
  if (run.options.mode === "macos-smoke") env.COMPANY_WORKSPACE = "disabled";
  if (process.env.PERI_BINARY) env.PERI_BINARY = process.env.PERI_BINARY;
  return env;
}

function serverLogPath(run: RunState) {
  return join(run.logs, "server.err.log");
}

async function portResponds(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    await response.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Liveness of an arbitrary saved Preview URL (not a /health probe). */
async function urlResponds(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(1000),
    });
    await response.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function waitHealth(run: RunState, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.child && run.child.exitCode !== null) {
      throw new StepError(
        "server_exited",
        `Test server exited during startup; inspect ${serverLogPath(run)} (content suppressed)`,
      );
    }
    try {
      const health = await run.api.health();
      if (health?.ok && health?.service === "company-factory") return health;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new StepError(
    "server_unhealthy",
    `Test server did not become healthy; inspect ${serverLogPath(run)} (content suppressed)`,
  );
}

async function startServer(run: RunState) {
  if (run.child) return;
  if (await portResponds(run.appPort))
    throw new StepError(
      "port_in_use",
      `Refusing to start: test app port ${run.appPort} is already responding`,
    );
  mkdirSync(run.logs, { recursive: true, mode: 0o700 });
  const logPath = serverLogPath(run);
  const fd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  const serverPath = resolve(import.meta.dir, "../src/server/index.ts");
  try {
    run.child = Bun.spawn([process.execPath, serverPath], {
      cwd: run.runDir,
      env: childEnvironment(run),
      stdin: "ignore",
      // src/server/index.ts prints an access URL containing the owner token.
      stdout: "ignore",
      stderr: fd,
    });
    run.childPid = run.child.pid;
  } finally {
    closeSync(fd);
  }
  run.serverCount++;
  await waitHealth(run);
}

async function stopServer(run: RunState) {
  const child = run.child;
  if (!child) return;
  run.child = undefined;
  try {
    child.kill("SIGTERM");
  } catch {}
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((resolvePromise) =>
      setTimeout(() => resolvePromise(false), 30_000),
    ),
  ]);
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {}
    await Promise.race([
      child.exited,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000)),
    ]);
  }
  const appDeadline = Date.now() + 15_000;
  while (Date.now() < appDeadline) {
    if (!(await portResponds(run.appPort))) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  if (await portResponds(run.appPort))
    throw new StepError(
      "port_still_listening",
      `Test app port ${run.appPort} still responds after server shutdown`,
    );
}

async function prepareProjectRoot(run: RunState): Promise<string> {
  const projectRoot = run.projectRoot!;
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  const packagePath = join(projectRoot, "package.json");
  if (!existsSync(packagePath))
    writeFileSync(
      packagePath,
      JSON.stringify(
        {
          name: "company-e2e-project",
          private: true,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  const scriptDir = join(projectRoot, "scripts");
  mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  const serveScriptPath = join(scriptDir, "e2e-serve.ts");
  writeFileSync(
    serveScriptPath,
    `import { join, resolve } from "node:path";
const port = Number(process.argv[2]);
const root = resolve(process.argv[3] ?? ".");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const requested = decodeURIComponent(new URL(request.url).pathname);
    const filePath = resolve(
      join(root, requested === "/" ? "index.html" : requested),
    );
    if (filePath !== root && !filePath.startsWith(root + "/"))
      return new Response("forbidden", { status: 403 });
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  },
});
console.log("E2E_PREVIEW_LISTENING=" + server.port);
`,
    { mode: 0o600 },
  );
  // The project intentionally has no CI/test scripts. Independent CI never runs
  // package.json scripts, test runners or any other Agent-writable code on the host.
  if (!existsSync(join(projectRoot, ".git"))) {
    const init = git(projectRoot, ["init"], run);
    if (init.status !== 0) throw new StepError("git_init_failed", "Could not init project root");
    const add = git(projectRoot, ["add", "-A"], run);
    if (add.status !== 0) throw new StepError("git_add_failed", "Could not stage project root");
    const commit = git(
      projectRoot,
      [
        "-c",
        "user.name=Company E2E",
        "-c",
        "user.email=e2e@localhost",
        "commit",
        "-m",
        "Initialize E2E project",
      ],
      run,
    );
    if (commit.status !== 0)
      throw new StepError("git_commit_failed", "Could not commit project root");
  }
  const head = git(projectRoot, ["rev-parse", "HEAD"], run);
  if (head.status !== 0)
    throw new StepError("git_head_failed", "Project root has no commit");
  return head.stdout;
}

async function assertEffectiveConfiguration(
  run: RunState,
  agentId: string,
  expectedAlias: ModelTier,
) {
  const path = join(
    run.companyHome,
    "runtime",
    "effective-config",
    `${agentId}.json`,
  );
  if (!existsSync(path))
    throw new StepError("effective_config_missing", "Effective configuration was not written");
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  const config = snapshot?.settings?.config;
  if (!config || typeof config !== "object")
    throw new StepError("effective_config_invalid", "Effective configuration has no settings.config");
  if (config.active_alias !== expectedAlias)
    throw new StepError(
      "effective_config_alias",
      `Effective active_alias is not ${expectedAlias}`,
    );
  const providers = Array.isArray(config.providers) ? config.providers : [];
  if (!providers.length)
    throw new StepError("effective_config_models", "providers missing");
  const profiles = config.profiles;
  if (!profiles || typeof profiles !== "object")
    throw new StepError("effective_config_profiles", "profiles missing");
  for (const tier of MODEL_TIERS) {
    const profile = profiles[tier];
    if (
      !profile ||
      typeof profile !== "object" ||
      typeof profile.provider !== "string" ||
      typeof profile.model !== "string" ||
      !profile.model ||
      profile.model === "unconfigured"
    )
      throw new StepError(
        "effective_config_profiles",
        `profiles.${tier} must bind a provider and a configured model`,
      );
    if (!providers.some((provider: any) => provider?.id === profile.provider))
      throw new StepError(
        "effective_config_profiles",
        `profiles.${tier} references an unknown provider`,
      );
  }
  if (snapshot.configured !== true)
    throw new StepError("effective_config_not_configured", "Snapshot is not configured");
  if (
    snapshot.model?.source !== "profile" ||
    snapshot.model?.configured !== true ||
    snapshot.model?.activeAlias !== expectedAlias
  )
    throw new StepError(
      "effective_config_model_metadata",
      "Snapshot model metadata is missing or inconsistent",
    );
  // The snapshot must have been assembled from the trusted host environment, not
  // from an Agent-writable file or a merged process environment.
  const trustedBaseUrl = run.model.values.PERI_MODEL_BASE_URL;
  const trustedKey = run.model.values.PERI_MODEL_API_KEY;
  const trustedProvider = run.model.values.PERI_MODEL_PROVIDER;
  for (const provider of providers) {
    if (trustedBaseUrl && provider.baseUrl !== trustedBaseUrl)
      throw new StepError(
        "untrusted_model_endpoint",
        "Effective configuration does not use the trusted host model base URL",
      );
    if (trustedKey && provider.apiKey !== trustedKey)
      throw new StepError(
        "untrusted_model_credential",
        "Effective configuration does not use the trusted host model credential",
      );
    if (trustedProvider && provider.type !== trustedProvider)
      throw new StepError(
        "untrusted_model_provider",
        "Effective configuration does not use the trusted host model provider",
      );
  }
  return {
    fourTiers: true,
    activeAlias: expectedAlias,
    perTierProfileModels: true,
    credentialPresent: providers.every((provider: any) => Boolean(provider.apiKey)),
    trustedEndpoint: true,
  };
}

/** Answer pending runtime permission prompts as the owner. Returns the snapshot
 * read before answering plus whether a business elicitation is still pending.
 * Elicitation is never auto-answered: it is a user decision, not a tool approval. */
async function answerPendingPermissions(
  run: RunState,
  agentId: string,
  answered: Set<string> = new Set<string>(),
): Promise<{
  snapshot: any;
  answered: number;
  pendingElicitation: boolean;
}> {
  const snapshot = await run.api.runtime(run.companyId!, agentId);
  let count = 0;
  for (const interaction of snapshot?.interactions ?? []) {
    if (interaction?.kind !== "permission") continue;
    if (interaction?.status !== "pending") continue;
    const interactionId = String(interaction?.id ?? "");
    if (!interactionId || answered.has(interactionId)) continue;
    try {
      await run.api.answer(run.companyId!, agentId, interactionId, {
        kind: "permission",
        decision: "allow_once",
      });
      answered.add(interactionId);
      count++;
      run.permissionsAnswered++;
    } catch {}
  }
  const pendingElicitation = (snapshot?.interactions ?? []).some(
    (interaction: any) =>
      interaction?.kind === "elicitation" && interaction?.status === "pending",
  );
  return { snapshot, answered: count, pendingElicitation };
}

/** Tool calls that have not reached a terminal state. A turn is not complete
 * while one of these is visible, even if the runtime's coarse `busy` flag is
 * already false. */
function pendingToolCallStates(conversation: unknown): string[] {
  const pending = new Set([
    "pending",
    "running",
    "in_progress",
    "awaiting_permission",
    "queued",
    "started",
  ]);
  return extractAgentToolCalls(conversation)
    .filter((call) => pending.has(call.status.toLowerCase()))
    .map((call) => `${call.name}:${call.status}`);
}

/** Non-secret session state for failure diagnostics (tool names/statuses only). */
async function describeAgentSession(run: RunState, agentId: string) {
  const snapshot = await run.api.runtime(run.companyId!, agentId);
  const conversation = await run.api.conversation(run.companyId!, agentId);
  const interactions =
    (snapshot?.interactions ?? [])
      .map((interaction: any) => `${interaction?.kind}:${interaction?.status}`)
      .join(",") || "none";
  const tools =
    extractAgentToolCalls(conversation)
      .slice(-8)
      .map((call) => `${call.name}:${call.status}`)
      .join(",") || "none";
  const error =
    typeof snapshot?.error === "string" && snapshot.error
      ? snapshot.error
          .replace(/https?:\/\/\S+/g, "<url>")
          .replace(/[A-Za-z0-9_-]{32,}/g, "<redacted>")
          .slice(0, 240)
      : "none";
  return `status=${snapshot?.status ?? "unknown"} busy=${snapshot?.busy === true} queue=${snapshot?.queue?.length ?? 0} interactions=${interactions} tools=${tools} error=${error}`;
}

/** Wait until the Session has no active turn, queued input, pending approval or
 * non-terminal tool call before sending the next owner input. A turn can look
 * idle in the conversation projection while the SDK still rejects a new send;
 * retrying without this gate produced wasm_control_failed in the live run. */
async function settleAgentSession(
  run: RunState,
  agentId: string,
  timeoutMs = 25_000,
): Promise<{ ok: boolean; detail: string }> {
  const answered = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  let detail = "unknown";
  let idleSince: number | undefined;
  let recovered = false;
  while (Date.now() < deadline) {
    const { snapshot, pendingElicitation } = await answerPendingPermissions(
      run,
      agentId,
      answered,
    );
    if (pendingElicitation)
      return { ok: false, detail: "elicitation_pending" };
    const status = String(snapshot?.status ?? "");
    // A live model turn can leave the Session in status=error after a deferred
    // tool sequence. The owner's recovery is an explicit restart, which preserves
    // the Session; record it rather than pretending the failed turn did not happen.
    if (status === "error" && !recovered) {
      try {
        await run.api.restartAgent(run.companyId!, agentId);
        run.sessionRecoveries++;
        recovered = true;
        idleSince = undefined;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        continue;
      } catch {}
    }
    const conversation = await run.api.conversation(run.companyId!, agentId);
    const pendingTools = pendingToolCallStates(conversation);
    const pendingPermissions = (snapshot?.interactions ?? []).filter(
      (interaction: any) =>
        interaction?.kind === "permission" && interaction?.status === "pending",
    );
    const queue = snapshot?.queue?.length ?? 0;
    const backgroundTasks = (snapshot?.tasks ?? []).filter((task: any) =>
      ["running", "in_progress"].includes(String(task?.status ?? "")),
    ).length;
    // A completed Agent turn can still leave a long-running background task (for
    // example the Preview HTTP server started by E10). The product reports that as
    // busy=true while activeTurnStatus is already completed. Treat that state as
    // settled only when there is no queued input, pending tool or permission card;
    // otherwise the background task would block every later owner input forever.
    const completedTurn =
      status === "completed" &&
      queue === 0 &&
      pendingTools.length === 0 &&
      pendingPermissions.length === 0;
    const busy =
      !completedTurn &&
      (snapshot?.busy === true ||
        ["running", "accepting", "in_progress", "pending", "error"].includes(status) ||
        queue > 0 ||
        pendingTools.length > 0 ||
        pendingPermissions.length > 0);
    detail = `status=${status || "unknown"} busy=${snapshot?.busy === true} backgroundTasks=${backgroundTasks} queue=${queue} pendingTools=${pendingTools.join(",") || "none"} pendingPermissions=${pendingPermissions.length} recovered=${recovered}`;
    // An input queued while the previous turn was finalizing can stay queued after
    // that turn completes. The owner's UI offers take-back; use it for a stale
    // queue that is not running, then re-check instead of blocking the next send.
    if (
      queue > 0 &&
      !snapshot?.busy &&
      !["running", "accepting", "in_progress"].includes(status) &&
      pendingTools.length === 0 &&
      pendingPermissions.length === 0
    ) {
      let removed = 0;
      for (const item of snapshot.queue ?? []) {
        const inputId = String(item?.inputId ?? "");
        if (!inputId) continue;
        try {
          await run.api.takeBack(run.companyId!, agentId, inputId);
          run.queueTakeBacks++;
          removed++;
        } catch {}
      }
      if (removed > 0) {
        idleSince = undefined;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        continue;
      }
    }
    if (!busy) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 500) return { ok: true, detail };
    } else {
      idleSince = undefined;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return { ok: false, detail: `session_not_idle ${detail}` };
}

async function awaitAgentTurn(
  run: RunState,
  agentId: string,
  baselineIds: Set<string>,
) {
  // Deferred MCP tools are executed through ExecuteExtraTool, which raises a real
  // runtime permission interaction. A human owner would approve that card; the
  // orchestrator performs the same owner action (allow_once) and records only the
  // count. Elicitation/ask-user prompts are business decisions and are never
  // auto-answered here.
  const answered = new Set<string>();
  return waitFor(
    `Agent ${agentId} turn`,
    async () => {
      const { snapshot, answered: answeredNow } = await answerPendingPermissions(
        run,
        agentId,
        answered,
      );
      const conversation = await run.api.conversation(run.companyId!, agentId);
      const fresh = (conversation.messages ?? []).filter(
        (message: any) => !baselineIds.has(message.id),
      );
      const assistant = fresh.filter((message: any) => message.role === "assistant");
      const pendingTools = pendingToolCallStates(conversation);
      const pendingInteractions = (snapshot?.interactions ?? []).some(
        (interaction: any) => interaction?.status === "pending",
      );
      // activeTurnStatus=completed is authoritative for the Agent turn. busy=true
      // can remain set by a long-running background task (the E10 Preview server),
      // so it must not prevent the completed turn from being observed. A queued
      // input still means this turn is not the settled end state.
      const completedTurn =
        String(snapshot?.status ?? "") === "completed" &&
        (snapshot?.queue?.length ?? 0) === 0;
      if (
        (!snapshot?.busy || completedTurn) &&
        assistant.length > 0 &&
        answeredNow === 0 &&
        !pendingInteractions &&
        pendingTools.length === 0
      )
        return { snapshot, conversation, fresh };
      return undefined;
    },
    AGENT_TIMEOUT_MS,
    250,
  );
}

/** The product exposes Company operations as deferred MCP tools (ToolSearch).
 * Live models sometimes end a turn right after SearchExtraTools. State the
 * product's own two-step contract explicitly so the E2E exercises the real
 * MCP tool instead of silently skipping the business operation. */
const DEFERRED_TOOL_GUIDANCE =
  "Tool use: Company MCP tools may be deferred. If the exact tool is not in your direct tool list, call SearchExtraTools to find it, then immediately call ExecuteExtraTool with {tool_name, params}. Do not end the turn after searching; perform every required tool call before replying. Do not narrate before a tool call; emit the tool call directly and keep assistant text empty until the final reply.\n\n";

async function agentInstruction(
  run: RunState,
  runner: Runner,
  args: {
    step: string;
    agentId: string;
    prompt: string;
    correction: string;
    requiredTools: string[];
    verify: (toolCalls: AgentToolCall[]) => Promise<{ ok: boolean; detail?: string }>;
  },
) {
  let baselineIds = new Set<string>();
  let baselineToolIds = new Set<string>();
  const allTools = new Set<string>();
  const allToolCalls: AgentToolCall[] = [];
  let lastRequestId = "";
  let lastDetail = "not attempted";
  for (let attempt = 1; attempt <= 3; attempt++) {
    lastRequestId = `e2e-${randomUUID()}`;
    const guided = `${DEFERRED_TOOL_GUIDANCE}${args.prompt}`;
    const text =
      attempt === 1 ? guided : `${args.correction}\n\n${guided}`;
    const settled = await settleAgentSession(run, args.agentId);
    if (!settled.ok) {
      lastDetail = `session not ready before send (${settled.detail})`;
      if (attempt === 3)
        throw new StepError(
          "agent_session_not_idle",
          `Agent ${args.agentId} could not accept input after 3 attempts (${lastDetail})`,
        );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      continue;
    }
    // Capture the baseline after settle, immediately before this send. Otherwise a
    // late assistant message from the previous turn can satisfy awaitAgentTurn and
    // leave this input queued behind it.
    const baseline = await run.api.conversation(run.companyId!, args.agentId);
    baselineIds = new Set<string>(
      (baseline.messages ?? []).map((message: any) => String(message.id)),
    );
    baselineToolIds = new Set<string>(
      extractAgentToolCalls(baseline).map((call) => call.toolCallId),
    );
    try {
      await sendAgentInput(run, args.agentId, {
        text,
        requestId: lastRequestId,
      });
    } catch (error) {
      let state = "";
      try {
        state = `; ${await describeAgentSession(run, args.agentId)}`;
      } catch {}
      lastDetail = `send failed: ${safeMessage(error)}${state}`;
      if (attempt === 3)
        throw new StepError(
          "agent_send_failed",
          `Agent ${args.agentId} did not accept input after 3 attempts (${lastDetail})`,
        );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      continue;
    }
    let turn: Awaited<ReturnType<typeof awaitAgentTurn>>;
    try {
      turn = await awaitAgentTurn(run, args.agentId, baselineIds);
    } catch (error) {
      lastDetail = `turn failed: ${safeMessage(error)}`;
      try {
        const current = await run.api.conversation(run.companyId!, args.agentId);
        runner.transcript(`${args.step}-timeout-${attempt}`, current.messages ?? []);
        baselineIds.clear();
        for (const message of current.messages ?? [])
          baselineIds.add(String(message.id));
        for (const call of extractAgentToolCalls(current))
          baselineToolIds.add(call.toolCallId);
      } catch {}
      if (attempt === 3)
        throw new StepError(
          "agent_turn_failed",
          `Agent ${args.agentId} turn failed after 3 attempts (${lastDetail})`,
        );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      continue;
    }
    for (const message of turn.fresh)
      for (const tool of message.tools ?? [])
        if (typeof tool === "string") allTools.add(tool);
    // The conversation response includes the read-only Session projection
    // (`view.toolCalls`) with arguments and results. Only calls created after the
    // baseline are considered this turn's evidence.
    for (const call of extractAgentToolCalls(turn.conversation)) {
      if (!call.toolCallId || baselineToolIds.has(call.toolCallId)) continue;
      if (!allToolCalls.some((existing) => existing.toolCallId === call.toolCallId))
        allToolCalls.push(call);
    }
    runner.transcript(args.step, turn.fresh);
    let verified: { ok: boolean; detail?: string };
    try {
      verified = await args.verify(allToolCalls);
    } catch (error) {
      verified = { ok: false, detail: safeMessage(error) };
    }
    lastDetail = verified.detail ?? (verified.ok ? "ok" : "business state not reached");
    const toolsOk = args.requiredTools.every((tool) =>
      hasTool(verificationToolNames([...allTools], allToolCalls), tool),
    );
    if (verified.ok && toolsOk) {
      return {
        tools: [...allTools],
        messages: turn.fresh,
        toolRecords: allToolCalls,
        attempts: attempt,
        requestId: lastRequestId,
        detail: lastDetail,
      };
    }
    baselineIds.clear();
    for (const message of turn.conversation.messages ?? [])
      baselineIds.add(String(message.id));
    for (const call of extractAgentToolCalls(turn.conversation))
      baselineToolIds.add(call.toolCallId);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new StepError(
    "agent_instruction_failed",
    `Agent ${args.agentId} did not satisfy ${args.step} after 3 attempts (${lastDetail})`,
  );
}

async function companyState(run: RunState): Promise<any> {
  return run.api.company(run.companyId!);
}

async function issueState(run: RunState, issueId: string): Promise<any> {
  return run.api.action(run.companyId, "company_tasks", "getIssue", { issueId });
}

function assertBinaryVersion(
  label: "peri",
  binary: string,
  expected: string,
): string {
  const text = versionOf(binary, ["--version"]);
  if (!text || text === "unavailable")
    throw new StepError(
      `${label}_version_unavailable`,
      `${label} --version is unavailable; refusing to spend a live model turn`,
    );
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text);
  if (!match)
    throw new StepError(
      `${label}_version_unavailable`,
      `${label} --version did not report a semantic version`,
    );
  const version = match[1]!;
  if (version !== expected)
    throw new StepError(
      `${label}_version_mismatch`,
      `${label} version ${version} is not the expected ${expected}`,
    );
  return version;
}

async function stepE00(run: RunState, runner: Runner) {
  return runner.step("E00", "executor", "health/isolation", async () => {
    const health = await run.api.health();
    if (!health?.ok || health.service !== "company-factory")
      throw new StepError("health_invalid", "Health endpoint did not identify company-factory");
    if (health.storage?.storesFile !== "configured")
      throw new StepError(
        "storage_not_configured",
        "需要 COMPANY_WASM_STORES_FILE 提供的 url + token",
      );
    const workspace = String(health.workspace ?? "");
    if (run.options.mode === "local-full" && !workspace.includes("official Peri"))
      throw new StepError("workspace_disabled", "local-full requires official Peri Workspace");
    if (run.options.mode === "macos-smoke" && !workspace.includes("disabled"))
      throw new StepError("workspace_not_disabled", "macos-smoke requires COMPANY_WORKSPACE=disabled");

    // Fail fast before any real model turn: the official Peri build is
    // version-sensitive. Workspace runs locally without a sandbox.
    const bwrapVersion = "not_required";
    const periVersion =
      run.options.mode === "local-full"
        ? assertBinaryVersion("peri", process.env.PERI_BINARY!, EXPECTED_PERI_VERSION)
        : process.env.PERI_BINARY
          ? assertBinaryVersion("peri", process.env.PERI_BINARY, EXPECTED_PERI_VERSION)
          : "not_required";
    let ciBackend: CiRunnerBackend | "not_applicable" = "not_applicable";
    if (run.options.mode === "local-full") {
      ciBackend = resolveCiBackend(run);
      run.ciBackend = ciBackend;
    }

    const contract = assertModelFallbackContract();
    const ownerTokenFiles = findNamedFiles(run.root, "owner-token");
    if (!ownerTokenFiles.supported)
      throw new StepError(
        "owner_token_check_unavailable",
        "Cannot inspect the test root for owner-token files",
      );
    if (ownerTokenFiles.files.length)
      throw new StepError(
        "owner_token_created",
        "The test root contains an owner-token file; COMPANY_WEB_TOKEN isolation failed",
      );
    if (!run.baseline.userData.supported || !run.baseline.userData.complete)
      throw new StepError(
        "user_data_metadata_check_unavailable",
        "Cannot establish a complete baseline of user data metadata on this host",
      );
    const processes = isolationProcessIds(run);
    if (!processes.supported)
      throw new StepError(
        "user_data_check_unavailable",
        "Cannot observe all test listeners/processes on this host",
      );
    const userData = openedUserData(processes.pids, run.baseline.userData.roots);
    if (!userData.supported)
      throw new StepError(
        "user_data_check_unavailable",
        "Cannot prove the test processes did not open user data on this host",
      );
    if (userData.opened > 0)
      throw new StepError(
        "user_data_opened",
        "A test process has user .company/.company-host paths open",
      );
    const reserved = reservedPortsUnchanged(run.baseline.reservedPorts);
    if (!reserved.verified)
      throw new StepError(
        "reserved_port_check_unavailable",
        "Cannot observe listeners on reserved user port 3000",
      );
    if (Object.values(reserved.results).includes("changed"))
      throw new StepError(
        "reserved_port_changed",
        "Reserved user port 3000 changed during test startup",
      );
    return {
      step: "E00",
      actor: "executor",
      operation: "health/isolation",
      status: "passed",
      httpStatus: run.api.lastStatus,
      checks: {
        storesFile: true,
        workspace: run.options.mode === "local-full" ? "official" : "disabled",
        bwrapVersion,
        periVersion,
        ciRunnerBackend: ciBackend,
        ownerTokenAbsent: true,
        userDataOpenCheck: userData.opened === 0 ? "not_open" : "open",
        userDataProcessesChecked: userData.checked,
        userDataProcessesExited: userData.exited,
        userDataMetadata: run.baseline.userData.complete
          ? "baseline_complete"
          : "baseline_incomplete",
        reservedUserPorts: Object.entries(reserved.results)
          .map(([port, state]) => `${port}:${state}`)
          .join(","),
        modelFallbackTiers: contract.fallbackTiers,
        modelLowercaseTierRejected: contract.lowercaseTierRejected,
        modelUnknownTierRejected: contract.unknownTierRejected,
        modelMissingActiveTierGated: contract.missingActiveTierGated,
        evidenceCreatedByRun: run.evidenceCreated,
        baselineCapturedAt: run.baseline.capturedAt,
      },
    };
  });
}

async function stepE01(run: RunState, runner: Runner) {
  return runner.step("E01", "owner", "login", async () => {
    const anonymous = new Api(run.origin);
    let unauthorizedStatus = 0;
    let unauthorizedCode = "";
    try {
      await anonymous.companies();
    } catch (error) {
      if (error instanceof ApiError) {
        unauthorizedStatus = error.status;
        unauthorizedCode = error.code;
      } else {
        throw error;
      }
    }
    if (unauthorizedStatus !== 401 || unauthorizedCode !== "unauthorized")
      throw new StepError(
        "unauthorized_check_failed",
        "Unauthenticated company listing did not return 401 unauthorized",
      );
    const setCookie = await run.api.login(run.ownerToken);
    const sessionValue = /company_session=([^;]+)/.exec(setCookie)?.[1];
    if (sessionValue) run.secrets.push(sessionValue);
    if (!/HttpOnly/i.test(setCookie) || !/SameSite=Strict/i.test(setCookie))
      throw new StepError(
        "cookie_flags_missing",
        "Login cookie is missing HttpOnly or SameSite=Strict",
      );
    return {
      step: "E01",
      actor: "owner",
      operation: "login",
      status: "passed",
      httpStatus: run.api.lastStatus,
      checks: {
        unauthenticated401: true,
        httpOnly: true,
        sameSiteStrict: true,
      },
    };
  });
}

async function stepE02(run: RunState, runner: Runner) {
  return runner.step("E02", "owner", "company_org.createCompany", async () => {
    const requestId = `e2e-company-${randomUUID()}`;
    const created = await run.api.action(undefined, "company_org", "createCompany", {
      name: `E2E ${run.options.mode}`,
      goal: "Exercise real Sessions and business closure",
      requestId,
    });
    const companyId = String(created?.company?.id ?? "");
    if (!/^c-[0-9a-f]{32}$/.test(companyId))
      throw new StepError("company_id_invalid", "Backend company ID has the wrong format");
    run.companyId = companyId;
    const hr = `${companyId}-hr`;
    const supervisor = `${companyId}-supervisor`;
    run.agents = {
      hr,
      supervisor,
      dev: "dev-1",
      preview: "preview-1",
      reviewer: "reviewer-1",
    };
    const roles = new Map<string, any>(
      (created.agents ?? []).map((agent: any) => [agent.agentId, agent]),
    );
    if (!roles.has(hr) || roles.get(hr)?.role !== "hr")
      throw new StepError("hr_missing", "Company has no HR Agent");
    if (!roles.has(supervisor) || roles.get(supervisor)?.role !== "task-supervisor")
      throw new StepError("supervisor_missing", "Company has no task supervisor");
    if (!isUuid(roles.get(hr)?.sessionId) || !isUuid(roles.get(supervisor)?.sessionId))
      throw new StepError("session_invalid", "Company Agents do not have real UUID Sessions");
    const state = await companyState(run);
    const byId = new Map<string, any>(
      (state.agents ?? []).map((agent: any) => [agent.agentId, agent]),
    );
    if (!isUuid(byId.get(hr)?.sessionId) || !isUuid(byId.get(supervisor)?.sessionId))
      throw new StepError("session_invalid", "Company state did not expose real Sessions");
    const initPath = join(
      run.companyHome,
      "companys",
      companyId,
      "events",
      "initialization.yaml",
    );
    if (!existsSync(initPath))
      throw new StepError("initialization_missing", "Initialization event is missing");
    const init = readYamlFile(initPath);
    if (init.status !== "complete")
      throw new StepError("initialization_incomplete", "Initialization event is not complete");
    const companyDir = join(run.companyHome, "companys", companyId);
    const count = git(companyDir, ["rev-list", "--count", "HEAD"], run);
    if (count.status !== 0 || Number(count.stdout) < 1)
      throw new StepError("company_git_missing", "Company repository has no commit");
    return {
      step: "E02",
      actor: "owner",
      operation: "company_org.createCompany",
      status: "passed",
      httpStatus: run.api.lastStatus,
      requestId,
      companyId,
      checks: {
        agents: 2,
        sessions: 2,
        initializationComplete: true,
        companyCommits: Number(count.stdout),
      },
    };
  });
}

async function stepE03(run: RunState, runner: Runner) {
  return runner.step("E03", "hr", "company_org.createGroup", async () => {
    const requestId = `e2e-group-${randomUUID()}`;
    const companyGit = join(run.companyHome, "companys", run.companyId!);
    const commitsBefore = Number(
      git(companyGit, ["rev-list", "--count", "HEAD"], run).stdout || "0",
    );
    const turn = await agentInstruction(run, runner, {
      step: "E03",
      agentId: run.agents!.hr,
      prompt: `Use the company_org MCP tool createGroup exactly once with {id:"delivery", name:"Delivery", responsibilities:"Delivery, verification and preview coordination", requestId:"${requestId}"}. Do not write files. Then reply with the returned group ID.`,
      correction:
        "The department was not created. You must call the company_org tool createGroup with the exact arguments in the prompt. Do not use filesystem writes or reply without calling it.",
      requiredTools: ["createGroup"],
      verify: async () => {
        const current = await companyState(run);
        const found = (current.groups ?? []).some(
          (group: any) => group.id === "delivery",
        );
        return { ok: found, detail: found ? "delivery group exists" : "missing delivery group" };
      },
    });
    const commitsAfter = Number(
      git(companyGit, ["rev-list", "--count", "HEAD"], run).stdout || "0",
    );
    if (!(commitsAfter > commitsBefore) || commitsAfter < 1)
      throw new StepError(
        "company_git_commit_missing",
        "createGroup did not add a Company Git commit",
      );
    return {
      step: "E03",
      actor: "hr",
      operation: "company_org.createGroup",
      status: "passed",
      requestId: turn.requestId,
      agentId: run.agents!.hr,
      toolCalls: turn.tools,
      checks: {
        attempts: turn.attempts,
        departmentCreated: true,
        companyGitCommits: commitsAfter,
      },
      detail: turn.detail,
    };
  });
}

async function stepE04(run: RunState, runner: Runner) {
  return runner.step("E04", "hr", "company_org.createMember", async () => {
    const state = await companyState(run);
    const existing = new Set((state.agents ?? []).map((agent: any) => agent.agentId));
    const missing = ["dev-1", "preview-1", "reviewer-1"].filter((id) => !existing.has(id));
    if (!missing.length)
      throw new StepError("members_already_exist", "Expected members already exist before E04");
    const requestIds = {
      dev: `e2e-member-dev-${randomUUID()}`,
      preview: `e2e-member-preview-${randomUUID()}`,
      reviewer: `e2e-member-reviewer-${randomUUID()}`,
    };
    const prompt = `First call company_org.organization to see which members already exist, then use the company_org MCP tool createMember only for missing members. Do not write files and do not set provider, baseUrl, apiKeyEnv, mcp, workspaceRoots or settings.
1) {agentId:"dev-1", name:"Developer", groupId:"delivery", role:"developer", responsibilities:"Own plans, code and worktrees", config:{modelAlias:"opus", responsibilities:"Own plans, code and worktrees", instructions:"Work only inside your authorized project root"}, requestId:"${requestIds.dev}"}
2) {agentId:"preview-1", name:"Preview", groupId:"delivery", role:"preview", responsibilities:"Own integration preview and environment", config:{modelAlias:"fable", responsibilities:"Own integration preview and environment"}, requestId:"${requestIds.preview}"}
3) {agentId:"reviewer-1", name:"Reviewer", groupId:"delivery", role:"reviewer", responsibilities:"Run CI and code review", config:{modelAlias:"haiku", responsibilities:"Run CI and code review"}, requestId:"${requestIds.reviewer}"}
If a member already exists (including an idempotent retry), treat it as satisfied and continue with the remaining members. After all three exist, reply with the three Agent IDs.`;
    const turn = await agentInstruction(run, runner, {
      step: "E04",
      agentId: run.agents!.hr,
      prompt,
      correction:
        "Some required members are still missing or have the wrong modelAlias. Call company_org.organization first, skip members that already exist (an idempotent retry or already_exists is expected and is not a failure), then call company_org.createMember only for the missing members with the exact allowed config. Do not set trusted provider or filesystem keys.",
      requiredTools: ["createMember"],
      verify: async () => {
        const current = await companyState(run);
        const agents = new Map<string, any>(
          (current.agents ?? []).map((agent: any) => [agent.agentId, agent]),
        );
        const specs: [string, string, ModelTier][] = [
          ["dev-1", "developer", "opus"],
          ["preview-1", "preview", "fable"],
          ["reviewer-1", "reviewer", "haiku"],
        ];
        for (const [agentId, role, alias] of specs) {
          const agent = agents.get(agentId);
          if (!agent) return { ok: false, detail: `${agentId} missing` };
          if (agent.role !== role)
            return { ok: false, detail: `${agentId} role is ${agent.role}` };
          if (agent.config?.modelAlias !== alias)
            return { ok: false, detail: `${agentId} alias is ${agent.config?.modelAlias}` };
          if (!isUuid(agent.sessionId))
            return { ok: false, detail: `${agentId} has no UUID Session` };
        }
        for (const agentId of [run.agents!.hr, run.agents!.supervisor]) {
          const agent = agents.get(agentId);
          if (!agent) return { ok: false, detail: `${agentId} missing` };
          if ((agent.modelAlias ?? agent.config?.modelAlias ?? "sonnet") !== "sonnet")
            return { ok: false, detail: `${agentId} is not on the default sonnet alias` };
        }
        return { ok: true, detail: "three members and default aliases verified" };
      },
    });
    const current = await companyState(run);
    const agents = new Map<string, any>(
      (current.agents ?? []).map((agent: any) => [agent.agentId, agent]),
    );
    return {
      step: "E04",
      actor: "hr",
      operation: "company_org.createMember",
      status: "passed",
      requestId: turn.requestId,
      agentId: run.agents!.hr,
      toolCalls: turn.tools,
      checks: {
        attempts: turn.attempts,
        devAlias: agents.get("dev-1")?.config?.modelAlias ?? "",
        previewAlias: agents.get("preview-1")?.config?.modelAlias ?? "",
        reviewerAlias: agents.get("reviewer-1")?.config?.modelAlias ?? "",
        sessions: 3,
      },
      detail: turn.detail,
    };
  });
}

/** Send owner/agent input and make sure the SDK actually starts it. A send that
 * lands while the previous turn is finalizing can be accepted into the input
 * queue; the owner would click "force send". Only the matching inputId is forced. */
async function sendAgentInput(
  run: RunState,
  agentId: string,
  input: { text: string; requestId: string },
) {
  const receipt: any = await run.api.send(run.companyId!, agentId, input);
  const inputId = typeof receipt?.inputId === "string" ? receipt.inputId : "";
  if (!inputId) return receipt;
  for (let attempt = 0; attempt < 12; attempt++) {
    const snapshot: any = await run.api.runtime(run.companyId!, agentId);
    const item = (snapshot?.queue ?? []).find(
      (entry: any) => String(entry?.inputId ?? "") === inputId,
    );
    if (!item) return receipt;
    try {
      await run.api.forceSend(run.companyId!, agentId, inputId);
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return receipt;
}

async function ownerChatTurn(
  run: RunState,
  agentId: string,
  text: string,
  requestId: string,
) {
  const settled = await settleAgentSession(run, agentId);
  if (!settled.ok)
    throw new StepError(
      "agent_session_not_idle",
      `Agent ${agentId} could not accept owner input (${settled.detail})`,
    );
  // Capture the baseline only after the previous turn is fully idle. Capturing
  // before settle can mistake the previous turn's late assistant message for the
  // new turn and leave the real input queued behind it.
  const baseline = await run.api.conversation(run.companyId!, agentId);
  const baselineIds = new Set<string>(
    (baseline.messages ?? []).map((message: any) => String(message.id)),
  );
  await sendAgentInput(run, agentId, { text, requestId });
  return awaitAgentTurn(run, agentId, baselineIds);
}

async function stepE05(run: RunState, runner: Runner) {
  return runner.step("E05", "owner", "model chat", async () => {
    const before = await companyState(run);
    const hr = (before.agents ?? []).find(
      (agent: any) => agent.agentId === run.agents!.hr,
    );
    const sessionId = hr?.sessionId;
    if (!isUuid(sessionId))
      throw new StepError("session_invalid", "HR Session is not a UUID");
    const marker = `E2E_MARKER_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const requestId = `e2e-chat-${randomUUID()}`;
    const turn = await ownerChatTurn(
      run,
      run.agents!.hr,
      `Reply with this exact marker and nothing else: ${marker}`,
      requestId,
    );
    const assistantText = turn.fresh
      .filter((message: any) => message.role === "assistant")
      .map((message: any) => String(message.text ?? ""))
      .join("\n")
      .trim();
    if (!assistantText)
      throw new StepError("assistant_empty", "Real model returned no assistant text");
    if (!assistantText.includes(marker))
      throw new StepError(
        "marker_mismatch",
        "Real model reply did not contain the requested unique marker",
      );
    const snapshot = await run.api.runtime(run.companyId!, run.agents!.hr);
    if (snapshot.configured !== true)
      throw new StepError("runtime_not_configured", "Runtime snapshot is not configured");
    if (snapshot.sessionId !== sessionId)
      throw new StepError("session_changed", "Chat changed the fixed Session");
    if (snapshot.modelAlias !== "sonnet")
      throw new StepError("alias_wrong", "HR snapshot does not use the default sonnet alias");
    if (typeof snapshot.model !== "string" || !snapshot.model)
      throw new StepError("model_missing", "Snapshot has no active model ID");
    const effective = await assertEffectiveConfiguration(
      run,
      run.agents!.hr,
      "sonnet",
    );
    runner.transcript("E05", turn.fresh);
    return {
      step: "E05",
      actor: "owner",
      operation: "model chat",
      status: "passed",
      requestId,
      agentId: run.agents!.hr,
      sessionId,
      modelAlias: snapshot.modelAlias,
      model: snapshot.model,
      toolCalls: turn.fresh.flatMap((message: any) =>
        Array.isArray(message.tools) ? message.tools : [],
      ),
      checks: {
        assistantNonEmpty: true,
        markerMatched: true,
        sessionUnchanged: true,
        configured: true,
        fourTiers: effective.fourTiers,
        perTierProfileModels: effective.perTierProfileModels,
        credentialPresent: effective.credentialPresent,
        trustedEndpoint: effective.trustedEndpoint,
      },
    };
  });
}

async function stepE06(run: RunState, runner: Runner) {
  return runner.step("E06", "owner+supervisor", "company_tasks.createIssue", async () => {
    const requestId = `e2e-issue-${randomUUID()}`;
    const issue = await run.api.action(run.companyId, "company_tasks", "createIssue", {
      title: "E2E closed-loop delivery",
      body: "## Goal\nCreate a real plan, code, preview and verification path.\n",
      summary: "All business steps through real Sessions",
      requestId,
    });
    run.issueId = String(issue.id);
    if (issue.status !== "triage")
      throw new StepError("issue_status", "New Issue is not in triage");
    if (issue.agent_id !== run.agents!.supervisor)
      throw new StepError("issue_owner", "New Issue is not owned by the task supervisor");
    const taskPath = join(
      run.companyHome,
      "companys",
      run.companyId!,
      "tasks",
      `${run.issueId}.md`,
    );
    if (!existsSync(taskPath))
      throw new StepError("issue_file_missing", "Issue task file was not written");
    const current = await issueState(run, run.issueId);
    const turn = await agentInstruction(run, runner, {
      step: "E06",
      agentId: run.agents!.supervisor,
      prompt: `Use company_tasks.getIssue to read Issue ${run.issueId}. Reply with its status, current owner and title. Do not change any field and do not assign it yet.`,
      correction:
        "You have not demonstrated reading the Issue. Call company_tasks.getIssue for the exact Issue ID in the prompt and reply with its status and owner. Do not modify it.",
      requiredTools: ["getIssue"],
      verify: async () => {
        const issueNow = await issueState(run, run.issueId!);
        const ok =
          issueNow.status === "triage" &&
          issueNow.agent_id === run.agents!.supervisor &&
          issueNow.version >= current.version;
        return { ok, detail: ok ? "Issue remains in triage" : "Issue changed unexpectedly" };
      },
    });
    return {
      step: "E06",
      actor: "owner+supervisor",
      operation: "company_tasks.createIssue",
      status: "passed",
      requestId,
      issueId: run.issueId,
      agentId: run.agents!.supervisor,
      toolCalls: turn.tools,
      checks: {
        status: "triage",
        ownerIsSupervisor: true,
        taskFile: true,
        attempts: turn.attempts,
      },
    };
  });
}

async function stepE07(run: RunState, runner: Runner) {
  return runner.step(
    "E07",
    "supervisor+owner",
    "askDecision/answerDecision/resolveDecision/assignIssue",
    async () => {
      const first = await issueState(run, run.issueId!);
      const askRequestId = `e2e-ask-${randomUUID()}`;
      const questionText = `E2E decision ${randomUUID().slice(0, 8)}: approve the delivery boundary?`;
      const asked = await agentInstruction(run, runner, {
        step: "E07-ask",
        agentId: run.agents!.supervisor,
        prompt: `Use company_tasks.askDecision on Issue ${run.issueId} with expectedVersion:${first.version}, question:"${questionText}", requestId:"${askRequestId}". Do not assign the Issue yet. Reply with the exact question ID.`,
        correction:
          "The pending decision was not created. Call company_tasks.askDecision with the exact Issue ID, expectedVersion and question from the prompt; do not assign yet.",
        requiredTools: ["askDecision"],
        verify: async () => {
          const issueNow = await issueState(run, run.issueId!);
          const pending = (issueNow.decisions ?? []).find(
            (decision: any) => decision.status === "pending",
          );
          if (pending) run.questionId = String(pending.id);
          const company = await companyState(run);
          const supervisor = (company.agents ?? []).find(
            (agent: any) => agent.agentId === run.agents!.supervisor,
          );
          return {
            ok: Boolean(pending) && supervisor?.needs_user === true,
            detail: pending
              ? "pending decision and needs_user=true"
              : "no pending decision",
          };
        },
      });
      if (!run.questionId)
        throw new StepError("decision_missing", "Pending decision ID was not observed");
      const issueBeforeAnswer = await issueState(run, run.issueId!);
      const answerRequestId = `e2e-answer-${randomUUID()}`;
      const answered = await run.api.action(
        run.companyId,
        "company_tasks",
        "answerDecision",
        {
          issueId: run.issueId,
          questionId: run.questionId,
          answer: "Approved by E2E owner",
          expectedVersion: issueBeforeAnswer.version,
          requestId: answerRequestId,
        },
      );
      const decision = (answered.decisions ?? []).find(
        (row: any) => row.id === run.questionId,
      );
      if (!decision || decision.answer !== "Approved by E2E owner")
        throw new StepError("answer_not_saved", "Owner answer was not saved");
      const deliveryPath = join(
        run.companyHome,
        "companys",
        run.companyId!,
        "events",
        "deliveries",
        `${answered.notification.id}.yaml`,
      );
      const delivered = await waitFor(
        "decision delivery",
        async () => {
          if (!existsSync(deliveryPath)) return undefined;
          const row = readYamlFile(deliveryPath);
          return row.status === "accepted" ? row : undefined;
        },
        STEP_TIMEOUT_MS,
        500,
      );
      if (delivered.status !== "accepted")
        throw new StepError("delivery_not_confirmed", "Decision delivery is not confirmed");
      const issueBeforeResolve = await issueState(run, run.issueId!);
      const resolveRequestId = `e2e-resolve-${randomUUID()}`;
      const assignRequestId = `e2e-assign-${randomUUID()}`;
      const resolved = await agentInstruction(run, runner, {
        step: "E07-resolve",
        agentId: run.agents!.supervisor,
        prompt: `Use company_tasks.getIssue on Issue ${run.issueId} to read the current version and the answered question ${run.questionId}. Then call company_tasks.resolveDecision with expectedVersion from that read, questionId:"${run.questionId}", requestId:"${resolveRequestId}". Immediately after resolving, in the SAME turn, call company_tasks.getIssue again to read the new version and call company_tasks.assignIssue with that new version, agentId:"${run.agents!.dev}", reason:"E2E handoff after decision", requestId:"${assignRequestId}". Both calls are required; do not end the turn after resolveDecision. The Issue must end owned by dev-1 and needs_user=false.`,
        correction:
          "The decision is not resolved or the Issue is not assigned to dev-1. Read the Issue again, resolve the exact answered question, then read it once more and immediately call assignIssue with the version returned after resolving. Do not stop after resolveDecision.",
        requiredTools: ["resolveDecision", "assignIssue"],
        verify: async () => {
          const issueNow = await issueState(run, run.issueId!);
          const target = (issueNow.decisions ?? []).find(
            (row: any) => row.id === run.questionId,
          );
          const handoff = (issueNow.history ?? []).some(
            (row: any) => row.to === run.agents!.dev,
          );
          const ok =
            target?.status === "answered" &&
            issueNow.agent_id === run.agents!.dev &&
            issueNow.needs_user === false &&
            handoff &&
            issueNow.version >= issueBeforeResolve.version;
          return {
            ok,
            detail: ok
              ? "decision answered and Issue assigned"
              : `state=${issueNow.status} owner=${issueNow.agent_id} needs_user=${issueNow.needs_user}`,
          };
        },
      });
      const final = await issueState(run, run.issueId!);
      return {
        step: "E07",
        actor: "supervisor+owner",
        operation: "decision handoff",
        status: "passed",
        requestId: resolveRequestId,
        issueId: run.issueId,
        agentId: run.agents!.dev,
        toolCalls: [...new Set([...asked.tools, ...resolved.tools])],
        checks: {
          pendingDecision: true,
          needsUserDuringPending: true,
          deliveryStatus: "accepted",
          resolved: true,
          assignedToDev: final.agent_id === run.agents!.dev,
          handoffHistory: (final.history ?? []).some(
            (row: any) => row.to === run.agents!.dev,
          ),
          needsUserAfterResolve: final.needs_user,
          attempts: asked.attempts + resolved.attempts,
        },
      };
    },
  );
}

async function saveAndRestart(
  run: RunState,
  agentId: string,
  configuration: Record<string, unknown>,
) {
  const before = await run.api.configuration(run.companyId!, agentId);
  const requestId = `e2e-config-${randomUUID()}`;
  const saved = await run.api.saveConfiguration(
    run.companyId!,
    agentId,
    before.version,
    configuration,
    requestId,
  );
  // POST /configuration returns the configuration view (`pendingRestart`), while
  // the domain method also has a `restartRequired` field. Accept either so the
  // harness follows the HTTP contract instead of asserting a non-projected name.
  if (saved.pendingRestart !== true && saved.restartRequired !== true)
    throw new StepError("restart_not_required", "Saved configuration did not require restart");
  const restarted = await run.api.restartAgent(run.companyId!, agentId);
  const after = await run.api.configuration(run.companyId!, agentId);
  if (after.pendingRestart !== false)
    throw new StepError("configuration_not_applied", "Restart did not apply saved configuration");
  if (after.appliedConfigVersion !== after.configVersion)
    throw new StepError("configuration_version_mismatch", "Applied config version differs");
  return { before, saved, restarted, after, requestId };
}

async function stepE08(run: RunState, runner: Runner) {
  return runner.step("E08", "owner+dev", "real plan/code/worktree", async () => {
    await prepareProjectRoot(run);
    const devSession = (await companyState(run)).agents.find(
      (agent: any) => agent.agentId === run.agents!.dev,
    )?.sessionId;
    const applied = await saveAndRestart(run, run.agents!.dev, {
      workspaceRoots: [run.projectRoot!],
    });
    const snapshot = await run.api.runtime(run.companyId!, run.agents!.dev);
    if (snapshot.sessionId !== devSession)
      throw new StepError("session_changed", "Explicit restart changed the dev Session");
    if (snapshot.modelAlias !== "opus")
      throw new StepError("alias_wrong", "dev-1 should keep the opus alias");
    const effective = await assertEffectiveConfiguration(run, run.agents!.dev, "opus");
    const issue = await issueState(run, run.issueId!);
    const worktreePath = join(run.projectRoot!, "worktrees", `issue-${run.issueId}`);
    const branch = `e2e/issue-${run.issueId}`;
    const planPath = join("plans", `issue-${run.issueId}.md`);
    const updateRequestId = `e2e-update-${randomUUID()}`;
    const turn = await agentInstruction(run, runner, {
      step: "E08",
      agentId: run.agents!.dev,
      prompt: `Work only inside your authorized project root ${run.projectRoot}. Use the official Workspace tools (Bash/Write/Read), not company YAML writes.
1) Create a separate git worktree at ${worktreePath} on new branch ${branch} from the project HEAD.
2) In that worktree create ${planPath} describing the implementation and create src/e2e.ts with a small exported function plus a comment referencing Issue ${run.issueId}. Keep the committed files free of trailing whitespace, conflict markers and credential files.
3) Stage both files, run git -C ${worktreePath} diff --cached --check, fix any whitespace errors, then commit them in the worktree with git.
4) Call company_tasks.getIssue for Issue ${run.issueId}, then company_tasks.updateIssue with expectedVersion from that read, requestId:"${updateRequestId}", patch:{plan_ref:"${planPath}", worktree:"${worktreePath}", code_ref:"<the full commit SHA from step 3>"}.
Do not modify Company business YAML. Reply with the commit SHA and the Issue version.`,
      correction:
        "The real files/worktree or Issue references are missing. Use the Workspace tools to create the worktree and files, commit them, then update Issue references with the current version. Do not write Company YAML directly.",
      requiredTools: ["updateIssue"],
      verify: async () => {
        const issueNow = await issueState(run, run.issueId!);
        if (!issueNow.plan_ref || !issueNow.worktree || !issueNow.code_ref)
          return { ok: false, detail: "Issue references are incomplete" };
        const worktree = isAbsolute(issueNow.worktree)
          ? issueNow.worktree
          : resolve(run.projectRoot!, issueNow.worktree);
        if (!isInside(run.projectRoot!, worktree) || !existsSync(worktree))
          return { ok: false, detail: "worktree is outside the project root or missing" };
        const planCandidates = [
          resolve(worktree, issueNow.plan_ref),
          resolve(run.projectRoot!, issueNow.plan_ref),
        ];
        const plan = planCandidates.find(
          (candidate) => isInside(run.projectRoot!, candidate) && existsSync(candidate),
        );
        if (!plan) return { ok: false, detail: "plan file is missing" };
        try {
          const accepted = assertAcceptedCodeRef(run, issueNow.code_ref, worktree);
          assertPlanInCommit(run, accepted, issueNow.plan_ref);
        } catch (error) {
          return { ok: false, detail: safeMessage(error) };
        }
        const list = git(run.projectRoot!, ["worktree", "list", "--porcelain"], run);
        if (list.status !== 0 || !list.stdout.includes(worktree))
          return { ok: false, detail: "git worktree list does not include the worktree" };
        return { ok: true, detail: "worktree, committed plan, code and refs verified" };
      },
    });
    const final = await issueState(run, run.issueId!);
    const worktree = isAbsolute(final.worktree)
      ? final.worktree
      : resolve(run.projectRoot!, final.worktree);
    const codeRef = assertAcceptedCodeRef(run, final.code_ref, worktree);
    const planRef = assertPlanInCommit(run, codeRef, final.plan_ref);
    const planBody = gitShowBytes(run.projectRoot!, `${codeRef}:${planRef}`, run);
    if (!planBody)
      throw new StepError("plan_missing", "The accepted commit does not contain plan_ref");
    const worktreeCount = git(run.projectRoot!, ["worktree", "list", "--porcelain"], run)
      .stdout.split(/\n\s*\n/).filter(Boolean).length;
    return {
      step: "E08",
      actor: "owner+dev",
      operation: "real plan/code/worktree",
      status: "passed",
      requestId: updateRequestId,
      issueId: run.issueId,
      agentId: run.agents!.dev,
      sessionId: devSession,
      modelAlias: snapshot.modelAlias,
      model: snapshot.model,
      toolCalls: turn.tools,
      checks: {
        worktrees: worktreeCount,
        planBytes: planBody.length,
        planCommitted: true,
        codeRef: sha12(codeRef),
        commitVerified: true,
        configurationApplied: applied.after.appliedConfigVersion,
        fourTiers: effective.fourTiers,
        perTierProfileModels: effective.perTierProfileModels,
        trustedEndpoint: effective.trustedEndpoint,
        attempts: turn.attempts,
      },
      detail: turn.detail,
    };
  });
}

async function stepE09(run: RunState, runner: Runner) {
  return runner.step("E09", "owner", "files/Workspace API", async () => {
    const companyId = run.companyId!;
    const dev = run.agents!.dev;
    const issue = await issueState(run, run.issueId!);
    const listing = await run.api.files(companyId, dev, "", {});
    const names = new Set(
      (listing.entries ?? []).map((entry: any) => String(entry.name)),
    );
    if (!names.has(".mcp.json") || !names.has(".env"))
      throw new StepError("hidden_files_missing", "File API did not expose hidden files");
    const worktree = isAbsolute(issue.worktree)
      ? issue.worktree
      : resolve(run.projectRoot!, issue.worktree);
    const plan = [
      resolve(worktree, issue.plan_ref),
      resolve(run.projectRoot!, issue.plan_ref),
    ].find((candidate) => isInside(run.projectRoot!, candidate) && existsSync(candidate));
    if (!plan) throw new StepError("plan_missing", "Plan file disappeared before file API check");
    const planRead = await run.api.files(companyId, dev, "read", { path: plan });
    if (!String(planRead.content ?? "").trim())
      throw new StepError("plan_empty", "File API returned an empty plan");
    const marker = `E2E_SEARCH_MARKER_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const notePath = `e2e-note-${randomUUID().slice(0, 8)}.md`;
    const firstSave = await run.api.saveFile(companyId, dev, {
      path: notePath,
      content: `${marker}\nfirst\n`,
      expectedVersion: "",
    });
    const secondSave = await run.api.saveFile(companyId, dev, {
      path: notePath,
      content: `${marker}\nsecond\n`,
      expectedVersion: String(firstSave.version),
    });
    let conflict = "";
    try {
      await run.api.saveFile(companyId, dev, {
        path: notePath,
        content: `${marker}\nstale\n`,
        expectedVersion: String(firstSave.version),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict")
        conflict = error.code;
      else throw error;
    }
    if (conflict !== "version_conflict")
      throw new StepError("stale_save_not_rejected", "Stale file save did not return version_conflict");
    const search = await run.api.files(companyId, dev, "search", { q: marker });
    if (!Array.isArray(search.results) || search.results.length === 0)
      throw new StepError("search_empty", "File API search returned no result");
    const diff = await run.api.files(companyId, dev, "diff", { path: notePath });
    const changes = await run.api.files(companyId, dev, "changes", {});
    const changePaths = (changes.changes ?? []).map((row: any) => String(row.path));
    if (!changePaths.some((path: string) => path.endsWith(notePath)))
      throw new StepError("changes_missing", "File API changes did not list the edited file");
    const commit = await run.api.commitFiles(
      companyId,
      dev,
      `E2E file API commit ${randomUUID().slice(0, 8)}`,
    );
    if (!/^[0-9a-f]{40}$/i.test(String(commit.commit ?? "")))
      throw new StepError("commit_invalid", "File API commit did not return a SHA");
    return {
      step: "E09",
      actor: "owner",
      operation: "files/Workspace API",
      status: "passed",
      issueId: run.issueId,
      agentId: dev,
      checks: {
        hiddenFilesVisible: true,
        projectRead: true,
        planBytes: Buffer.byteLength(String(planRead.content)),
        saveVersions: 2,
        staleSaveRejected: true,
        searchMatches: search.results.length,
        trackedInDiff: Boolean(diff.tracked),
        changes: changePaths.length,
        commit: sha12(String(commit.commit)),
      },
      detail: String(secondSave.version ?? "").slice(0, 12),
    };
  });
}

function gitShowBytes(
  cwd: string,
  spec: string,
  run?: RunState,
): Buffer | undefined {
  const result = runGit(cwd, ["cat-file", "blob", spec], {
    home: run?.home ?? process.env.HOME ?? "/tmp",
  });
  if (result.status !== 0) return undefined;
  return result.stdout;
}

function sha256Hex(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertAcceptedCodeRef(
  run: RunState,
  codeRef: unknown,
  worktree?: string,
): string {
  let accepted: string;
  try {
    accepted = assertSafeCodeRef(codeRef);
  } catch (error) {
    throw new StepError(
      "code_ref_invalid",
      safeMessage(error),
    );
  }
  if (!run.projectRoot)
    throw new StepError("project_root_missing", "The project repository is unavailable");
  const resolved = git(
    run.projectRoot,
    ["rev-parse", "--verify", `${accepted}^{commit}`],
    run,
  );
  if (resolved.status !== 0 || resolved.stdout !== accepted)
    throw new StepError(
      "code_ref_invalid",
      "Accepted code_ref does not resolve to the exact commit",
    );
  if (worktree) {
    const repo = realpathSync(run.projectRoot);
    let resolvedWorktree: string;
    try {
      resolvedWorktree = realpathSync(worktree);
    } catch {
      resolvedWorktree = resolve(worktree);
    }
    if (!isInside(repo, resolvedWorktree))
      throw new StepError(
        "worktree_outside_project",
        "The Issue worktree is outside the project root",
      );
    const head = git(resolvedWorktree, ["rev-parse", "HEAD"], run);
    if (head.status !== 0 || head.stdout !== accepted)
      throw new StepError(
        "worktree_head_mismatch",
        "Worktree HEAD is not the accepted code_ref; refusing to certify the run",
      );
  }
  return accepted;
}

/** Test artifacts intentionally created in the worktree by earlier steps (E10's
 * preview marker/log). They are never part of the CI input, which is always the
 * clean export of the accepted commit. Any other difference is reported as
 * unexpected instead of being hidden behind a hard-coded "clean" flag. */
const EXPECTED_WORKTREE_ARTIFACTS = [
  /^e2e-preview-marker\.txt$/,
  /^\.preview\.log$/,
  /^\.e2e-ci\//,
];

function inspectWorktree(
  run: RunState,
  worktree: string,
  accepted: string,
): WorktreeObservation {
  return inspectWorktreeAgainstCommit({
    worktree,
    commit: accepted,
    home: run.home,
    expectedArtifacts: EXPECTED_WORKTREE_ARTIFACTS,
  });
}

function assertWorktreeObservable(
  observation: WorktreeObservation,
  label: string,
): void {
  if (!observation.supported)
    throw new StepError(
      "worktree_status_unavailable",
      `Cannot measure the ${label} worktree status; refusing to claim it was ignored`,
    );
  if (!observation.headMatchesCommit)
    throw new StepError(
      "worktree_head_mismatch",
      `The ${label} worktree HEAD is not the accepted commit`,
    );
}

function assertPlanInCommit(run: RunState, codeRef: string, planRef: unknown): string {
  let relativePath: string;
  try {
    relativePath = assertSafeRepoPath(planRef);
  } catch (error) {
    throw new StepError("plan_ref_invalid", safeMessage(error));
  }
  if (!run.projectRoot)
    throw new StepError("project_root_missing", "The project repository is unavailable");
  const type = git(
    run.projectRoot,
    ["cat-file", "-t", `${codeRef}:${relativePath}`],
    run,
  );
  if (type.status !== 0 || type.stdout !== "blob")
    throw new StepError(
      "plan_not_in_code_ref",
      "plan_ref is not a blob in the accepted commit",
    );
  return relativePath;
}

function createOwnedTempDir(run: RunState, label: string): OwnedDirectory {
  const parent = dirname(run.root);
  const path = mkdtempSync(join(parent, `company-e2e-ci-${label}.`));
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync(path) !== path ||
    dirname(path) !== parent
  )
    throw new StepError(
      "ci_staging_invalid",
      "CI staging directory is not a real sibling of the test root",
    );
  // The Docker backend runs the fixture as an unprivileged user. The staging tree
  // contains only committed code, the host fixture and a non-secret manifest.
  chmodSync(path, 0o755);
  const owned = { path, ino: info.ino, dev: info.dev };
  run.ciWorkDirs.push(owned);
  return owned;
}

function createOwnedSubdir(base: string, relativeDir: string): string {
  let current = realpathSync(base);
  for (const segment of relativeDir.split("/")) {
    if (!segment || segment === "." || segment === "..")
      throw new StepError("ci_staging_invalid", "CI staging path escapes the project root");
    current = join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      mkdirSync(current, { mode: 0o700 });
      chmodSync(current, 0o700);
      info = lstatSync(current);
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      realpathSync(current) !== current
    )
      throw new StepError(
        "ci_staging_invalid",
        "CI staging path is a symlink or not a real directory",
      );
  }
  return current;
}

function ciForbiddenPaths(run: RunState): string[] {
  const userRoots = run.baseline.userData.roots;
  let home: string | undefined;
  try {
    home = realpathSync(process.env.HOME || homedir());
  } catch {}
  return [
    run.root,
    run.companyHome,
    ...userRoots,
    home ? join(home, ".company") : "",
    home ? join(home, ".company-host") : "",
    "/var/run/docker.sock",
    "/run/docker.sock",
  ].filter(Boolean);
}

function ciDockerBinary(): string {
  return process.env.E2E_DOCKER?.trim() || "docker";
}

/** Read-only CI backend preflight for `--dry-run`. It queries the Docker daemon
 * (`docker version`/`image inspect`) or checks for an executable bubblewrap; it
 * never starts a container, never pulls an image and never runs the fixture. */
function probeCiBackendForDryRun(requested: string): {
  ok: boolean;
  detail: string;
} {
  if (requested !== "docker" && requested !== "bwrap")
    return { ok: false, detail: "E2E_CI_RUNNER must be docker or bwrap" };
  const dockerBinary = ciDockerBinary();
  const dockerAvailable =
    requested === "docker" ? probeDocker(dockerBinary).available : false;
  const dockerImageAvailable =
    dockerAvailable && probeDockerImage(dockerBinary, CI_IMAGE);
  const bwrapBinary = process.env.COMPANY_BWRAP ?? "/usr/bin/bwrap";
  const bwrapAvailable = requested === "bwrap" ? probeBwrap(bwrapBinary) : false;
  try {
    const backend = chooseCiRunner({
      requested,
      platform: process.platform,
      dockerAvailable,
      dockerImageAvailable,
      bwrapAvailable,
    });
    return {
      ok: true,
      detail: `backend=${backend} available docker=${dockerAvailable ? "yes" : "no"} image=${dockerImageAvailable ? "yes" : "no"} bwrap=${bwrapAvailable ? "yes" : "no"}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `CI backend unavailable (docker=${dockerAvailable ? "yes" : "no"} image=${dockerImageAvailable ? "yes" : "no"} bwrap=${bwrapAvailable ? "yes" : "no"}): ${safeMessage(error)}`,
    };
  }
}

function resolveCiBackend(run: RunState): CiRunnerBackend {
  if (run.options.mode !== "local-full")
    throw new StepError("ci_not_applicable", "CI/Review is skipped in macos-smoke");
  const requested = process.env.E2E_CI_RUNNER?.trim() || "docker";
  const dockerBinary = ciDockerBinary();
  const dockerAvailable =
    requested === "docker" ? probeDocker(dockerBinary).available : false;
  const dockerImageAvailable =
    dockerAvailable && probeDockerImage(dockerBinary, CI_IMAGE);
  const bwrapAvailable =
    requested === "bwrap"
      ? probeBwrap(process.env.COMPANY_BWRAP ?? "/usr/bin/bwrap")
      : false;
  try {
    return chooseCiRunner({
      requested,
      platform: process.platform,
      dockerAvailable,
      dockerImageAvailable,
      bwrapAvailable,
    });
  } catch (error) {
    throw new StepError(
      error instanceof CiRunnerError ? error.code : "ci_runner_unavailable",
      safeMessage(error),
    );
  }
}

/** The Agent needs the same deterministic input to reproduce the digest. This copy
 * lives under the Agent's project root, so the Agent may modify it; the digest check
 * then fails. The orchestrator never executes this copy: the runner uses the separate
 * host-controlled copy outside the E2E root. `inputs.json` is scratch input for the
 * Agent's own run and is NOT acceptance evidence; E12/E13 accept the Agent only when
 * its real Bash tool record contains this run's challenge and the host digest. */
function stageAgentCopy(
  run: RunState,
  mode: CiMode,
  codeRef: string,
  manifest: CiManifest,
  challenge: string,
): { dir: string; command: string; inputsPath: string } {
  if (!run.projectRoot)
    throw new StepError("project_root_missing", "The project repository is unavailable");
  const agentRoot = createOwnedSubdir(
    run.projectRoot,
    `.e2e-ci/${run.runId}/${mode}`,
  );
  if (readdirSync(agentRoot).length)
    throw new StepError("ci_staging_exists", "CI staging directory is not empty");
  const subject = join(agentRoot, "subject");
  mkdirSync(subject, { mode: 0o700 });
  const agentManifest = exportCommitTree({
    projectRoot: run.projectRoot,
    codeRef,
    destination: subject,
    home: run.home,
    forbiddenValues: run.secrets,
  });
  if (
    agentManifest.treeSha256 !== manifest.treeSha256 ||
    agentManifest.commit !== manifest.commit
  )
    throw new StepError(
      "ci_staging_mismatch",
      "Agent staging export does not match the orchestrator export",
    );
  stageFixture(CI_FIXTURE_PATH, join(agentRoot, "check.ts"));
  const inputsPath = join(agentRoot, "inputs.json");
  writeCiManifest(inputsPath, manifest);
  chmodSync(agentRoot, 0o700);
  const bun = realpathSync(process.execPath);
  const command = [
    shellQuote(bun),
    shellQuote(join(agentRoot, "check.ts")),
    mode,
    shellQuote(subject),
    shellQuote(inputsPath),
    challenge,
  ].join(" ");
  return { dir: agentRoot, command, inputsPath };
}

/** Run the host-controlled fixture on a clean export of the accepted commit. The
 * host never executes project scripts and never passes secrets into the sandbox. */
function runIndependentCi(
  run: RunState,
  mode: CiMode,
  codeRef: unknown,
): CiProof {
  const accepted = assertAcceptedCodeRef(run, codeRef);
  const backend = run.ciBackend ?? resolveCiBackend(run);
  run.ciBackend = backend;
  // Random per invocation. It is embedded in the fixture report (and therefore in
  // the digest) and must appear in the Reviewer's real Bash tool record.
  const challenge = randomBytes(16).toString("hex");
  const work = createOwnedTempDir(run, mode);
  const subject = join(work.path, "subject");
  mkdirSync(subject, { mode: 0o755 });
  chmodSync(subject, 0o755);
  // The Docker CLI gets a private empty HOME under this staging root, never /tmp
  // or a user configuration directory.
  mkdirSync(join(work.path, "docker-home"), { mode: 0o700 });
  let manifest: CiManifest;
  try {
    manifest = exportCommitTree({
      projectRoot: run.projectRoot!,
      codeRef: accepted,
      destination: subject,
      home: run.home,
      forbiddenValues: run.secrets,
    });
  } catch (error) {
    throw new StepError(
      error instanceof CiRunnerError ? error.code : "ci_export_failed",
      safeMessage(error),
    );
  }
  const fixturePath = join(work.path, "check.ts");
  const manifestPath = join(work.path, "expected.json");
  let fixtureSha: string;
  try {
    fixtureSha = stageFixture(CI_FIXTURE_PATH, fixturePath).sha256;
    writeCiManifest(manifestPath, manifest);
  } catch (error) {
    throw new StepError(
      error instanceof CiRunnerError ? error.code : "ci_staging_failed",
      safeMessage(error),
    );
  }
  const forbiddenPaths = ciForbiddenPaths(run);
  const containerName = `company-e2e-ci-${run.runId}-${mode}`
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(0, 63);
  let spec: CiRunnerSpec;
  try {
    if (backend === "docker") {
      const dockerBinary = ciDockerBinary();
      if (!probeDockerImage(dockerBinary, CI_IMAGE))
        throw new CiRunnerError(
          "ci_runner_unavailable",
          `Docker image ${CI_IMAGE} is not available locally; refusing to pull or run CI on the host`,
        );
      spec = buildDockerCiRunSpec({
        dockerBinary,
        image: CI_IMAGE,
        containerName,
        mode,
        subjectDir: subject,
        fixturePath,
        manifestPath,
        challenge,
        forbiddenPaths,
        timeoutMs: CI_TIMEOUT_MS,
      });
    } else {
      const bwrapBinary = process.env.COMPANY_BWRAP ?? "/usr/bin/bwrap";
      if (!probeBwrap(bwrapBinary))
        throw new CiRunnerError(
          "ci_runner_unavailable",
          "bubblewrap is unavailable for the isolated CI runner",
        );
      spec = buildBwrapCiRunSpec({
        bwrapBinary,
        bunBinary: realpathSync(process.execPath),
        mode,
        subjectDir: subject,
        fixturePath,
        manifestPath,
        challenge,
        systemRoBinds: systemRoBinds(),
        forbiddenPaths,
        timeoutMs: CI_TIMEOUT_MS,
      });
    }
  } catch (error) {
    throw new StepError(
      error instanceof CiRunnerError ? error.code : "ci_runner_unavailable",
      safeMessage(error),
    );
  }
  if (spec.containerName && !run.ciContainers.includes(spec.containerName))
    run.ciContainers.push(spec.containerName);
  const result = runCiSpec(spec);
  if (result.timedOut)
    throw new StepError("ci_runner_timeout", "Isolated CI runner timed out");
  if (result.status !== 0)
    throw new StepError(
      "ci_runner_failed",
      `Isolated CI runner exited ${result.status}; raw stderr is suppressed (${result.stderr.length} bytes)`,
    );
  let report: CiReport;
  try {
    report = parseCiReport(result.stdout, { mode, manifest, challenge });
  } catch (error) {
    throw new StepError(
      error instanceof CiRunnerError ? error.code : "ci_report_invalid",
      safeMessage(error),
    );
  }
  const digest = ciDigest(result.stdout);
  if (!/^[0-9a-f]{64}$/.test(digest))
    throw new StepError("ci_digest_invalid", "CI digest is not a SHA-256 value");
  let agent: { dir: string; command: string; inputsPath: string };
  try {
    agent = stageAgentCopy(run, mode, accepted, manifest, challenge);
  } catch (error) {
    throw new StepError(
      error instanceof CiRunnerError ? error.code : "ci_staging_failed",
      safeMessage(error),
    );
  }
  return {
    mode,
    backend,
    challenge,
    digest,
    report,
    isolation: spec.isolation,
    ...(spec.containerName ? { containerName: spec.containerName } : {}),
    exited: true,
    fixtureSha,
    manifestSha: sha256Hex(JSON.stringify(manifest, null, 2) + "\n"),
    workDir: work.path,
    agentDir: agent.dir,
    agentCommand: agent.command,
  };
}

function dockerContainerGone(containerName: string): {
  supported: boolean;
  gone: boolean;
} {
  const result = spawnSync(
    ciDockerBinary(),
    ["ps", "-a", "--filter", `name=${containerName}`, "--format", "{{.Names}}"],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        LANG: "C.UTF-8",
      },
    },
  );
  if (result.error || result.status !== 0)
    return { supported: false, gone: false };
  return {
    supported: true,
    gone: !(result.stdout ?? "").split("\n").map((line) => line.trim()).includes(containerName),
  };
}

function stopCiContainers(run: RunState): { attempted: boolean; ok: boolean } {
  let attempted = false;
  let ok = true;
  const names = new Set(run.ciContainers);
  for (const proof of Object.values(run.ciProofs))
    if (proof?.containerName) names.add(proof.containerName);
  for (const name of names) {
    attempted = true;
    const result = spawnSync(
      ciDockerBinary(),
      ["rm", "-f", name],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: "/tmp",
          LANG: "C.UTF-8",
        },
      },
    );
    const stderr = (result.stderr ?? "").toString();
    if (result.error || (result.status !== 0 && !/no such container/i.test(stderr)))
      ok = false;
  }
  return { attempted, ok };
}

function removeOwnedDirectory(owned: OwnedDirectory): {
  removed: boolean;
  error?: string;
} {
  try {
    const info = lstatSync(owned.path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.ino !== owned.ino ||
      info.dev !== owned.dev ||
      realpathSync(owned.path) !== owned.path
    )
      return { removed: false, error: "identity_changed" };
    rmSync(owned.path, { recursive: true, force: true });
    return { removed: !existsSync(owned.path) };
  } catch (error) {
    return { removed: false, error: safeMessage(error) };
  }
}

function cleanupCiWorkDirs(run: RunState): { removed: boolean; error?: string } {
  let removed = true;
  let error: string | undefined;
  for (const owned of run.ciWorkDirs) {
    const result = removeOwnedDirectory(owned);
    if (!result.removed) {
      removed = false;
      error ??= result.error ?? "unknown";
    }
  }
  run.ciWorkDirs = [];
  return { removed, ...(error ? { error } : {}) };
}

function digestFromEvidence(value: unknown, label: string) {
  const text = String(value ?? "");
  const match = new RegExp(`${label}:([0-9a-f]{64})`, "i").exec(text);
  return match?.[1]?.toLowerCase();
}

async function fetchPreviewBytes(url: URL, path: string, label: string) {
  let response: Response;
  try {
    response = await fetch(new URL(path, url), {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new StepError("preview_unreachable", `Preview ${label} is unreachable`);
  }
  if (response.status !== 200)
    throw new StepError(
      "preview_content_missing",
      `Preview ${label} returned HTTP ${response.status}`,
    );
  return Buffer.from(await response.arrayBuffer());
}

async function verifyPreviewEnvironment(input: {
  urlString: string;
  previewPort: number;
  repoRoot: string;
  codeRef: string;
  marker: string;
  run: RunState;
}) {
  let url: URL;
  try {
    url = new URL(input.urlString);
  } catch {
    throw new StepError("preview_url_invalid", "Preview environment URL is invalid");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port || "80") !== input.previewPort ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new StepError(
      "preview_url_mismatch",
      `Preview URL must be exactly http://127.0.0.1:${input.previewPort}/`,
    );
  const markerBytes = await fetchPreviewBytes(
    url,
    "/e2e-preview-marker.txt",
    "marker file",
  );
  const expectedMarkerVariants = [
    Buffer.from(input.marker),
    Buffer.from(input.marker + "\n"),
    Buffer.from(input.marker + "\r\n"),
  ];
  if (!expectedMarkerVariants.some((expected) => markerBytes.equals(expected)))
    throw new StepError(
      "preview_marker_mismatch",
      "Preview server did not serve the Agent-created marker content",
    );
  const codeBytes = await fetchPreviewBytes(url, "/src/e2e.ts", "code file");
  const expectedCode = gitShowBytes(
    input.repoRoot,
    `${input.codeRef}:src/e2e.ts`,
    input.run,
  );
  if (!expectedCode)
    throw new StepError(
      "preview_code_unavailable",
      "The accepted commit does not contain src/e2e.ts",
    );
  if (!codeBytes.equals(expectedCode))
    throw new StepError(
      "preview_code_mismatch",
      "Preview content does not match the accepted commit",
    );
  return {
    status: 200,
    markerSha: sha256Hex(markerBytes).slice(0, 12),
    codeSha: sha256Hex(codeBytes).slice(0, 12),
  };
}

async function choosePreviewPort(run: RunState): Promise<number> {
  for (let port = 33217; port <= 33227; port++) {
    if (RESERVED_PORTS.has(port) || port === run.appPort)
      continue;
    if (!(await portResponds(port))) return port;
  }
  throw new StepError("no_preview_port", "No free loopback port for the Preview environment");
}

async function stepE10(run: RunState, runner: Runner) {
  return runner.step("E10", "preview", "real Preview environment", async () => {
    await saveAndRestart(run, run.agents!.preview, {
      workspaceRoots: [run.projectRoot!],
    });
    const assignRequestId = `e2e-preview-assign-${randomUUID()}`;
    const assigned = await agentInstruction(run, runner, {
      step: "E10-assign",
      agentId: run.agents!.supervisor,
      prompt: `Use company_tasks.getIssue on Issue ${run.issueId} to read the current version, then company_tasks.assignIssue with that version, agentId:"${run.agents!.preview}", reason:"Handoff to Preview after real code delivery", requestId:"${assignRequestId}". Do not change Issue status or write files. Reply with the new owner.`,
      correction:
        "The Issue is not assigned to preview-1. Read the current version and call company_tasks.assignIssue with the exact preview Agent ID.",
      requiredTools: ["assignIssue"],
      verify: async () => {
        const issueNow = await issueState(run, run.issueId!);
        const ok = issueNow.agent_id === run.agents!.preview;
        return { ok, detail: ok ? "Issue assigned to preview-1" : `owner=${issueNow.agent_id}` };
      },
    });
    const issue = await issueState(run, run.issueId!);
    if (!issue.worktree || !issue.code_ref)
      throw new StepError("preview_prerequisites", "Issue lacks worktree/code refs before Preview");
    const worktree = isAbsolute(issue.worktree)
      ? issue.worktree
      : resolve(run.projectRoot!, issue.worktree);
    if (!existsSync(worktree))
      throw new StepError("worktree_missing", "Preview worktree does not exist");
    const accepted = assertAcceptedCodeRef(run, issue.code_ref, worktree);
    const branchResult = git(worktree, ["branch", "--show-current"], run);
    const branch = branchResult.stdout || `e2e/issue-${run.issueId}`;
    const previewPort = await choosePreviewPort(run);
    // Record the chosen port before the Agent starts anything so SIGINT/SIGTERM
    // cleanup can find and stop a preview listener even if savePreview never runs.
    run.previewPort = previewPort;
    const environmentUrl = `http://127.0.0.1:${previewPort}/`;
    const batchId = `batch-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const previewRequestId = `e2e-preview-${randomUUID()}`;
    const previewMarker = `E2E_PREVIEW_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const previewBun = realpathSync(process.execPath);
    const previewServe = join(run.projectRoot!, "scripts/e2e-serve.ts");
    const checklistItem = `Preview serves the committed code at ${sha12(accepted)}`;
    const turn = await agentInstruction(run, runner, {
      step: "E10",
      agentId: run.agents!.preview,
      prompt: `You now own Issue ${run.issueId}. Use the official Workspace tools and Company MCP only.
1) In the existing worktree ${worktree}, create a file named e2e-preview-marker.txt whose exact content is one line: ${previewMarker}
2) Start the real static HTTP server on 127.0.0.1:${previewPort} serving that worktree by calling the Workspace Bash tool with run_in_background:true and exactly this command (do not use nohup and do not run it in the foreground; do not read or modify the serve script):
${shellQuote(previewBun)} ${shellQuote(previewServe)} ${previewPort} ${shellQuote(worktree)}
   If curl -fsS ${environmentUrl}e2e-preview-marker.txt already prints the exact marker, a server is already running; reuse it and do not start another one. Otherwise start it as above, then verify the marker URL with curl.
3) Call company_tasks.getIssue for Issue ${run.issueId} to confirm the current code_ref is ${accepted}.
4) Call company_tasks.savePreview exactly once with {id:"${batchId}", owner_id:"${run.agents!.preview}", issue_ids:["${run.issueId}"], branch:"${branch}", code_refs:{"${run.issueId}":"${accepted}"}, environment_url:"${environmentUrl}", checklist:{"${run.issueId}":["${checklistItem}"]}, expectedVersion:0, requestId:"${previewRequestId}"}.
Do not change code_ref. Do not commit the marker file. Reply with the batch ID and environment status.`,
      correction:
        `The Preview batch or its real environment is missing. If curl -fsS ${environmentUrl}e2e-preview-marker.txt already prints the exact marker, reuse the running server; otherwise start it with the Workspace Bash tool using run_in_background:true and exactly: ${shellQuote(previewBun)} ${shellQuote(previewServe)} ${previewPort} ${shellQuote(worktree)}. Do not use nohup or a foreground server, and do not read or modify the serve script. Then verify the marker URL with curl and call company_tasks.savePreview with the exact current code_ref, URL and batch ID. Do not invent a URL or write Company YAML.`,
      requiredTools: ["savePreview"],
      verify: async () => {
        const batchPath = join(
          run.companyHome,
          "companys",
          run.companyId!,
          "previews",
          `${batchId}.md`,
        );
        if (!existsSync(batchPath)) return { ok: false, detail: "preview file missing" };
        const batch = readMarkdownFile(batchPath).head;
        const issueNow = await issueState(run, run.issueId!);
        if (issueNow.status !== "preview" || issueNow.preview_batch !== batchId)
          return { ok: false, detail: `Issue status=${issueNow.status}` };
        if (batch.code_refs?.[run.issueId!] !== issueNow.code_ref)
          return { ok: false, detail: "Preview code_ref is stale" };
        try {
          await verifyPreviewEnvironment({
            urlString: String(batch.environment_url ?? ""),
            previewPort,
            repoRoot: run.projectRoot!,
            codeRef: accepted,
            marker: previewMarker,
            run,
          });
        } catch (error) {
          return { ok: false, detail: safeMessage(error) };
        }
        return { ok: true, detail: "Preview URL, marker and committed code verified" };
      },
    });
    const batchPath = join(
      run.companyHome,
      "companys",
      run.companyId!,
      "previews",
      `${batchId}.md`,
    );
    const batch = readMarkdownFile(batchPath).head;
    const finalIssue = await issueState(run, run.issueId!);
    if (String(finalIssue.code_ref) !== accepted)
      throw new StepError(
        "preview_code_changed",
        "Preview changed the accepted code reference",
      );
    run.batchId = batchId;
    run.batchVersion = Number(batch.version);
    run.batchCodeRef = accepted;
    run.previewUrl = String(batch.environment_url);
    const verified = await verifyPreviewEnvironment({
      urlString: run.previewUrl,
      previewPort,
      repoRoot: run.projectRoot!,
      codeRef: accepted,
      marker: previewMarker,
      run,
    });
    const savedUrl = new URL(run.previewUrl);
    const savedPreviewPort = Number(savedUrl.port || "80");
    run.previewPort = savedPreviewPort;
    return {
      step: "E10",
      actor: "preview",
      operation: "real Preview environment",
      status: "passed",
      requestId: previewRequestId,
      issueId: run.issueId,
      agentId: run.agents!.preview,
      toolCalls: [...new Set([...assigned.tools, ...turn.tools])],
      checks: {
        issueStatus: finalIssue.status,
        previewFile: true,
        environmentStatus: verified.status,
        environmentLoopback: true,
        environmentPort: run.previewPort,
        environmentUrlSaved:
          new URL(run.previewUrl).origin === new URL(environmentUrl).origin,
        markerSha: verified.markerSha,
        codeSha: verified.codeSha,
        batchVersion: run.batchVersion,
        codeRef: sha12(accepted),
        attempts: assigned.attempts + turn.attempts,
      },
      detail: turn.detail,
    };
  });
}

async function negativeMissingAcceptance(run: RunState) {
  // The domain checks invalid_state before recordVerification's acceptance gate while
  // an Issue is still in preview. updateIssue(status=ready_merge) is the reachable
  // owner-side gate for "no user acceptance for current code".
  const issue = await issueState(run, run.issueId!);
  try {
    await run.api.action(run.companyId, "company_tasks", "updateIssue", {
      issueId: run.issueId,
      expectedVersion: issue.version,
      patch: { status: "ready_merge" },
      requestId: `e2e-negative-acceptance-${randomUUID()}`,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "missing_acceptance") return true;
    throw error;
  }
  return false;
}

async function stepE11(run: RunState, runner: Runner) {
  return runner.step("E11", "owner", "acceptPreview", async () => {
    const negative = await negativeMissingAcceptance(run);
    if (!negative)
      throw new StepError(
        "missing_acceptance_not_enforced",
        "Verification before acceptance did not return missing_acceptance",
      );
    run.missingAcceptanceNegative = true;
    const issue = await issueState(run, run.issueId!);
    const batchPath = join(
      run.companyHome,
      "companys",
      run.companyId!,
      "previews",
      `${run.batchId}.md`,
    );
    const batch = readMarkdownFile(batchPath).head;
    const checklist = batch.checklist?.[run.issueId!];
    if (!Array.isArray(checklist) || checklist.length === 0)
      throw new StepError("checklist_missing", "Preview checklist is empty");
    const commentsBefore = await run.api.action(
      run.companyId,
      "company_tasks",
      "comments",
      { issueId: run.issueId },
    );
    const acceptRequestId = `e2e-accept-${randomUUID()}`;
    const accepted = await run.api.action(
      run.companyId,
      "company_tasks",
      "acceptPreview",
      {
        batchId: run.batchId,
        issueId: run.issueId,
        codeRef: issue.code_ref,
        expectedVersion: Number(batch.version),
        passed: true,
        evidence: "E2E owner accepted the exact preview code",
        requestId: acceptRequestId,
      },
    );
    if (accepted.issue?.status !== "accepted")
      throw new StepError("acceptance_not_applied", "Issue did not enter accepted");
    const acceptance = (accepted.preview?.acceptances ?? []).find(
      (row: any) =>
        row.issue_id === run.issueId &&
        row.code_ref === issue.code_ref &&
        row.passed === true,
    );
    if (!acceptance)
      throw new StepError("acceptance_not_recorded", "Acceptance row was not recorded");
    const commentsAfter = await run.api.action(
      run.companyId,
      "company_tasks",
      "comments",
      { issueId: run.issueId },
    );
    if (!((commentsAfter.items ?? []).length > (commentsBefore.items ?? []).length))
      throw new StepError("acceptance_comment_missing", "Acceptance did not add a comment");
    const batchAfter = readMarkdownFile(batchPath).head;
    let staleRejected = false;
    try {
      await run.api.action(run.companyId, "company_tasks", "acceptPreview", {
        batchId: run.batchId,
        issueId: run.issueId,
        codeRef: "wrong-code-ref",
        expectedVersion: Number(batchAfter.version),
        passed: true,
        evidence: "Negative stale-code acceptance",
        requestId: `e2e-stale-accept-${randomUUID()}`,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "stale_evidence")
        staleRejected = true;
      else throw error;
    }
    if (!staleRejected)
      throw new StepError(
        "stale_code_accepted",
        "acceptPreview accepted a wrong codeRef instead of returning stale_evidence",
      );
    const acceptedIssue = await issueState(run, run.issueId!);
    if (acceptedIssue.needs_user !== false)
      throw new StepError(
        "needs_user_after_acceptance",
        "Issue still requires user input after acceptance",
      );
    run.batchVersion = Number(batchAfter.version);
    // Stop the preview server after acceptance; a failure here is reported, not hidden.
    let stopRequested = false;
    try {
      await settleAgentSession(run, run.agents!.preview);
      await sendAgentInput(run, run.agents!.preview, {
        text: `The owner accepted Issue ${run.issueId}. Stop the preview HTTP server you started on 127.0.0.1 and reply briefly. Do not change business state.`,
        requestId: `e2e-preview-stop-${randomUUID()}`,
      });
      stopRequested = true;
    } catch {}
    if (!run.previewUrl)
      throw new StepError("preview_url_missing", "No actual Preview URL was saved");
    let previewStopped = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (!(await urlResponds(run.previewUrl))) {
        previewStopped = true;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    // Stopping the long-running Preview server is best-effort here: it is not part
    // of E11's business acceptance (accepted state, acceptance row, comment,
    // needs_user=false, stale codeRef). The Agent's background task may not be
    // cancellable from a normal message. E19 still proves the listener and the
    // Preview port are gone; record the measured state instead of failing E11.
    return {
      step: "E11",
      actor: "owner",
      operation: "acceptPreview",
      status: "passed",
      requestId: acceptRequestId,
      issueId: run.issueId,
      checks: {
        issueStatus: accepted.issue.status,
        acceptanceRecorded: true,
        acceptanceComment: true,
        staleCodeRejected: true,
        needsUser: false,
        missingAcceptanceNegative: run.missingAcceptanceNegative,
        previewStopRequested: stopRequested,
        previewStopped,
        previewStopDeferredToCleanup: !previewStopped,
        previewPort: run.previewPort ?? 0,
        batchVersion: run.batchVersion,
      },
    };
  });
}

function previewBatch(run: RunState) {
  const path = join(
    run.companyHome,
    "companys",
    run.companyId!,
    "previews",
    `${run.batchId}.md`,
  );
  if (!existsSync(path))
    throw new StepError("preview_missing", "Preview batch file is missing");
  return { path, head: readMarkdownFile(path).head };
}

async function assignToReviewer(run: RunState, runner: Runner) {
  const issue = await issueState(run, run.issueId!);
  if (issue.agent_id === run.agents!.reviewer) return { tools: [] as string[], attempts: 0, requestId: "" };
  const requestId = `e2e-reviewer-assign-${randomUUID()}`;
  const turn = await agentInstruction(run, runner, {
    step: "E12-assign",
    agentId: run.agents!.supervisor,
    prompt: `Use company_tasks.getIssue on Issue ${run.issueId} to read its current version, then company_tasks.assignIssue with that version, agentId:"${run.agents!.reviewer}", reason:"Handoff to Reviewer after user acceptance", requestId:"${requestId}". Do not change status or write files.`,
    correction:
      "The Issue is not assigned to reviewer-1. Read the current version and call company_tasks.assignIssue with the exact reviewer Agent ID.",
    requiredTools: ["assignIssue"],
    verify: async () => {
      const issueNow = await issueState(run, run.issueId!);
      const ok = issueNow.agent_id === run.agents!.reviewer;
      return { ok, detail: ok ? "assigned to reviewer" : `owner=${issueNow.agent_id}` };
    },
  });
  return { tools: turn.tools, attempts: turn.attempts, requestId };
}

async function stepE12(run: RunState, runner: Runner) {
  return runner.step("E12", "reviewer", "recordVerification ci", async () => {
    await saveAndRestart(run, run.agents!.reviewer, {
      workspaceRoots: [run.projectRoot!],
    });
    const assigned = await assignToReviewer(run, runner);
    const issue = await issueState(run, run.issueId!);
    const batch = previewBatch(run);
    if (!issue.worktree)
      throw new StepError("worktree_missing", "Reviewer has no worktree reference");
    const worktree = isAbsolute(issue.worktree)
      ? issue.worktree
      : resolve(run.projectRoot!, issue.worktree);
    // Execute the host-controlled fixture on a clean export of the accepted commit
    // inside a secret-free sandbox. The reviewer must reproduce the exact digest;
    // a bare "passed" claim is not accepted.
    const accepted = assertAcceptedCodeRef(run, issue.code_ref, worktree);
    // Measure the worktree instead of hard-coding "ignored". E10 intentionally
    // leaves the preview marker/log uncommitted; the CI input is still the clean
    // export of the accepted commit, and any other dirty path is reported.
    const worktreeState = inspectWorktree(run, worktree, accepted);
    assertWorktreeObservable(worktreeState, "CI");
    const ciProof = runIndependentCi(run, "ci", accepted);
    run.ciProofs.ci = ciProof;
    const expectedCiDigest = ciProof.digest;
    const ciFixturePath = join(ciProof.agentDir, "check.ts");
    const ciRequestId = `e2e-ci-${randomUUID()}`;
    // One Bash call must show both the canonical report (which contains this
    // turn's challenge) and the digest of that exact stdout. Splitting the report
    // and the digest into two calls cannot prove the same execution.
    const ciReproPath = `/tmp/e2e-ci-${ciProof.challenge}.out`;
    const ciReproCommand = `set -o pipefail; ${ciProof.agentCommand} | tee ${shellQuote(ciReproPath)} && sha256sum ${shellQuote(ciReproPath)}`;
    const turn = await agentInstruction(run, runner, {
      step: "E12",
      agentId: run.agents!.reviewer,
      prompt: `You now own Issue ${run.issueId} after user acceptance. The worktree ${worktree} may contain uncommitted test artifacts and is NOT the CI input.
The orchestrator exported the accepted commit ${accepted} into a staged clean-export directory and ran the host-controlled fixture in an isolated, secret-free, no-network sandbox. Do not modify the staged files.
1) Run exactly this single Bash command (do not split it, do not use package.json scripts or the worktree):
${ciReproCommand}
It runs the host-controlled fixture, prints one canonical JSON line containing this run's challenge, then prints the SHA-256 digest of that exact stdout (including the trailing newline). Do not edit the staging directory, the worktree, package.json or code_ref.
2) Call company_tasks.recordVerification exactly once with {batchId:"${run.batchId}", issueId:"${run.issueId}", codeRef:"${accepted}", expectedVersion:${Number(batch.head.version)}, kind:"ci", passed:true, evidence:"clean CI fixture passed on ${accepted}; e2e-ci-digest:<the 64-hex digest>", requestId:"${ciRequestId}"}.
Reply with the CI result and digest.`,
      correction:
        `The CI verification is missing or its digest is not reproducible. Run exactly this single Bash command: ${ciReproCommand} (it must exit 0 and its output must contain both the canonical JSON line and the 64-hex digest of that exact stdout), then call company_tasks.recordVerification kind=ci with evidence containing e2e-ci-digest:<64-hex> for commit ${accepted}. Do not use package.json scripts or the worktree.`,
      requiredTools: ["Bash", "recordVerification"],
      verify: async (toolCalls) => {
        const current = previewBatch(run);
        const issueNow = await issueState(run, run.issueId!);
        const row = [...(current.head.verifications ?? [])]
          .reverse()
          .find(
            (verification: any) =>
              verification.issue_id === run.issueId &&
              verification.code_ref === issueNow.code_ref &&
              verification.kind === "ci",
          );
        const digest = digestFromEvidence(row?.evidence, "e2e-ci-digest");
        const execution = findAgentCiExecution(toolCalls, {
          challenge: ciProof.challenge,
          digest: expectedCiDigest,
          fixturePath: ciFixturePath,
        });
        const ok =
          execution.ok &&
          row?.passed === true &&
          digest === expectedCiDigest &&
          issueNow.code_ref === accepted &&
          issueNow.status === "verifying" &&
          issueNow.agent_id === run.agents!.reviewer;
        return {
          ok,
          detail: ok
            ? "CI verification and Agent Bash execution verified"
            : !execution.ok
              ? `Agent CI execution is not proven (${execution.reason})`
              : digest
                ? "CI digest does not match the independent execution"
                : "CI verification/digest missing",
        };
      },
    });
    const issueAfterCi = await issueState(run, run.issueId!);
    if (String(issueAfterCi.code_ref) !== accepted)
      throw new StepError(
        "code_ref_changed",
        "The Issue code_ref changed during independent CI",
      );
    const ciRow = [
      ...(previewBatch(run).head.verifications ?? []),
    ]
      .reverse()
      .find(
        (verification: any) =>
          verification.issue_id === run.issueId &&
          verification.code_ref === issueAfterCi.code_ref &&
          verification.kind === "ci",
      );
    if (
      digestFromEvidence(ciRow?.evidence, "e2e-ci-digest") !== expectedCiDigest
    )
      throw new StepError(
        "ci_proof_mismatch",
        "Recorded CI evidence is not the independently reproduced digest",
      );
    const ciExecution = findAgentCiExecution(turn.toolRecords, {
      challenge: ciProof.challenge,
      digest: expectedCiDigest,
      fixturePath: ciFixturePath,
    });
    if (!ciExecution.ok)
      throw new StepError(
        "agent_ci_execution_unproven",
        `The Reviewer's real Bash tool record did not prove CI fixture execution (${ciExecution.reason}); host CI remains authoritative but Agent execution is not claimed`,
      );
    run.agentCiExecutions.ci = {
      ...ciExecution,
      commandHadChallenge: true,
      resultHadChallenge: true,
      resultHadDigest: true,
      fixtureMentioned: true,
    };
    let missingVerification = false;
    try {
      await run.api.action(run.companyId, "company_tasks", "updateIssue", {
        issueId: run.issueId,
        expectedVersion: issueAfterCi.version,
        patch: { status: "ready_merge" },
        requestId: `e2e-negative-verification-${randomUUID()}`,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "missing_verification")
        missingVerification = true;
      else throw error;
    }
    if (!missingVerification)
      throw new StepError(
        "missing_verification_not_enforced",
        "ready_merge after CI-only verification did not return missing_verification",
      );
    const after = previewBatch(run);
    run.batchVersion = Number(after.head.version);
    return {
      step: "E12",
      actor: "reviewer",
      operation: "recordVerification ci",
      status: "passed",
      requestId: ciRequestId,
      issueId: run.issueId,
      agentId: run.agents!.reviewer,
      toolCalls: [...new Set([...assigned.tools, ...turn.tools])],
      checks: {
        issueStatus: issueAfterCi.status,
        ciRecorded: true,
        ciDigest: expectedCiDigest.slice(0, 12),
        ciDigestSha256: expectedCiDigest,
        ciProofVerified: true,
        ciCommit: accepted.slice(0, 12),
        ciRunnerBackend: ciProof.backend,
        ciRunnerIsolation: Object.values(ciProof.isolation).every(Boolean),
        ciFiles: ciProof.report.files,
        ciBytes: ciProof.report.bytes,
        ciInputCleanExport: true,
        ciInputSource: "clean_export_of_accepted_commit",
        worktreeUsedByCi: false,
        worktreeState: worktreeState.state,
        worktreeDirtyEntries: worktreeState.dirtyEntries,
        worktreeUnexpectedEntries: worktreeState.unexpectedEntries,
        worktreeHeadMatchesCommit: worktreeState.headMatchesCommit,
        agentCiExecuted: true,
        agentCiTool: ciExecution.toolName ?? "Bash",
        agentCiToolCallId: ciExecution.toolCallId ?? "unknown",
        agentCiChallenge: ciProof.challenge,
        agentCiCommandHadChallenge: ciExecution.commandHadChallenge,
        agentCiResultHadChallenge: ciExecution.resultHadChallenge,
        agentCiResultHadDigest: ciExecution.resultHadDigest,
        missingVerificationNegative: true,
        attempts: assigned.attempts + turn.attempts,
      },
      detail: turn.detail,
    };
  });
}

async function stepE13(run: RunState, runner: Runner) {
  return runner.step("E13", "reviewer", "recordVerification review", async () => {
    const issue = await issueState(run, run.issueId!);
    const batch = previewBatch(run);
    if (!issue.worktree)
      throw new StepError("worktree_missing", "Reviewer has no worktree reference");
    const worktree = isAbsolute(issue.worktree)
      ? issue.worktree
      : resolve(run.projectRoot!, issue.worktree);
    // Independent review of the exact accepted commit. The fixture reads a clean
    // export, never the Agent worktree. The reviewer must reproduce the digest.
    const accepted = assertAcceptedCodeRef(run, issue.code_ref, worktree);
    const worktreeState = inspectWorktree(run, worktree, accepted);
    assertWorktreeObservable(worktreeState, "Review");
    const reviewProof = runIndependentCi(run, "review", accepted);
    run.ciProofs.review = reviewProof;
    const expectedReviewDigest = reviewProof.digest;
    const reviewFixturePath = join(reviewProof.agentDir, "check.ts");
    const reviewRequestId = `e2e-review-${randomUUID()}`;
    // One Bash call must show both the canonical report (with this turn's
    // challenge) and the digest of that exact stdout.
    const reviewReproPath = `/tmp/e2e-review-${reviewProof.challenge}.out`;
    const reviewReproCommand = `set -o pipefail; ${reviewProof.agentCommand} | tee ${shellQuote(reviewReproPath)} && sha256sum ${shellQuote(reviewReproPath)}`;
    const turn = await agentInstruction(run, runner, {
      step: "E13",
      agentId: run.agents!.reviewer,
      prompt: `Review the accepted commit ${accepted} using the same clean export the orchestrator verified. The worktree ${worktree} is NOT the review input.
1) Run exactly this single Bash command (do not split it):
${reviewReproCommand}
It runs the host-controlled review fixture, prints one canonical JSON line containing this run's challenge, then prints the SHA-256 digest of that exact stdout (including the trailing newline). Do not edit the staging directory, the worktree or code_ref.
2) Call company_tasks.recordVerification exactly once with {batchId:"${run.batchId}", issueId:"${run.issueId}", codeRef:"${accepted}", expectedVersion:${Number(batch.head.version)}, kind:"review", passed:true, evidence:"Reviewed the clean export of ${accepted}; e2e-review-digest:<the 64-hex digest>", requestId:"${reviewRequestId}"}.
Reply with what you reviewed and the digest.`,
      correction:
        `The review verification is missing or its digest is not reproducible. Run exactly this single Bash command: ${reviewReproCommand} (it must exit 0 and its output must contain both the canonical JSON line and the 64-hex digest of that exact stdout), then call company_tasks.recordVerification kind=review with evidence containing e2e-review-digest:<64-hex> for commit ${accepted}. Do not use the worktree.`,
      requiredTools: ["Bash", "recordVerification"],
      verify: async (toolCalls) => {
        const current = previewBatch(run);
        const issueNow = await issueState(run, run.issueId!);
        const rows = (current.head.verifications ?? []).filter(
          (verification: any) =>
            verification.issue_id === run.issueId &&
            verification.code_ref === issueNow.code_ref,
        );
        const ci = [...rows]
          .reverse()
          .find((verification: any) => verification.kind === "ci" && verification.passed);
        const review = [...rows]
          .reverse()
          .find(
            (verification: any) => verification.kind === "review" && verification.passed,
          );
        const digest = digestFromEvidence(
          review?.evidence,
          "e2e-review-digest",
        );
        const ciDigest = digestFromEvidence(ci?.evidence, "e2e-ci-digest");
        const execution = findAgentCiExecution(toolCalls, {
          challenge: reviewProof.challenge,
          digest: expectedReviewDigest,
          fixturePath: reviewFixturePath,
        });
        const ok =
          execution.ok &&
          Boolean(ci && review) &&
          ciDigest === run.ciProofs.ci?.digest &&
          digest === expectedReviewDigest &&
          issueNow.code_ref === accepted &&
          issueNow.status === "verifying" &&
          issueNow.agent_id === run.agents!.reviewer;
        return {
          ok,
          detail: ok
            ? "CI, review, digest and Agent Bash execution verified"
            : !execution.ok
              ? `Agent Review execution is not proven (${execution.reason})`
              : digest
                ? "Review digest does not match the isolated clean-export fixture"
                : "review verification/digest missing",
        };
      },
    });
    const after = previewBatch(run);
    const finalIssue = await issueState(run, run.issueId!);
    if (String(finalIssue.code_ref) !== accepted)
      throw new StepError(
        "code_ref_changed",
        "The Issue code_ref changed during independent Review",
      );
    const reviewRow = [...(after.head.verifications ?? [])]
      .reverse()
      .find(
        (verification: any) =>
          verification.issue_id === run.issueId &&
          verification.code_ref === finalIssue.code_ref &&
          verification.kind === "review",
      );
    if (
      digestFromEvidence(reviewRow?.evidence, "e2e-review-digest") !==
      expectedReviewDigest
    )
      throw new StepError(
        "review_proof_mismatch",
        "Recorded review evidence is not the independently reproduced digest",
      );
    const reviewExecution = findAgentCiExecution(turn.toolRecords, {
      challenge: reviewProof.challenge,
      digest: expectedReviewDigest,
      fixturePath: reviewFixturePath,
    });
    if (!reviewExecution.ok)
      throw new StepError(
        "agent_review_execution_unproven",
        `The Reviewer's real Bash tool record did not prove Review fixture execution (${reviewExecution.reason}); host Review remains authoritative but Agent execution is not claimed`,
      );
    run.agentCiExecutions.review = {
      ...reviewExecution,
      commandHadChallenge: true,
      resultHadChallenge: true,
      resultHadDigest: true,
      fixtureMentioned: true,
    };
    run.batchVersion = Number(after.head.version);
    return {
      step: "E13",
      actor: "reviewer",
      operation: "recordVerification review",
      status: "passed",
      requestId: reviewRequestId,
      issueId: run.issueId,
      agentId: run.agents!.reviewer,
      toolCalls: turn.tools,
      checks: {
        ciAndReview: true,
        reviewDigest: expectedReviewDigest.slice(0, 12),
        reviewDigestSha256: expectedReviewDigest,
        reviewProofVerified: true,
        reviewCommit: accepted.slice(0, 12),
        reviewRunnerBackend: reviewProof.backend,
        reviewRunnerIsolation: Object.values(reviewProof.isolation).every(Boolean),
        reviewChangedFiles: reviewProof.report.review?.changedFiles.length ?? 0,
        reviewInputCleanExport: true,
        reviewInputSource: "clean_export_of_accepted_commit",
        worktreeUsedByReview: false,
        worktreeState: worktreeState.state,
        worktreeDirtyEntries: worktreeState.dirtyEntries,
        worktreeUnexpectedEntries: worktreeState.unexpectedEntries,
        worktreeHeadMatchesCommit: worktreeState.headMatchesCommit,
        agentReviewExecuted: true,
        agentReviewTool: reviewExecution.toolName ?? "Bash",
        agentReviewToolCallId: reviewExecution.toolCallId ?? "unknown",
        agentReviewChallenge: reviewProof.challenge,
        agentReviewCommandHadChallenge: reviewExecution.commandHadChallenge,
        agentReviewResultHadChallenge: reviewExecution.resultHadChallenge,
        agentReviewResultHadDigest: reviewExecution.resultHadDigest,
        issueStatus: finalIssue.status,
        attempts: turn.attempts,
      },
      detail: turn.detail,
    };
  });
}

async function stepE14(run: RunState, runner: Runner) {
  return runner.step("E14", "owner", "ready_merge", async () => {
    const issue = await issueState(run, run.issueId!);
    if (!issue.worktree)
      throw new StepError("worktree_missing", "Issue has no worktree");
    const worktree = isAbsolute(issue.worktree)
      ? issue.worktree
      : resolve(run.projectRoot!, issue.worktree);
    const codeRef = assertAcceptedCodeRef(run, issue.code_ref, worktree);
    const headBeforeResult = git(worktree, ["rev-parse", "HEAD"], run);
    const branchBeforeResult = git(worktree, ["branch", "--show-current"], run);
    if (
      headBeforeResult.status !== 0 ||
      !/^[0-9a-f]{40}$/i.test(headBeforeResult.stdout)
    )
      throw new StepError("git_head_failed", "Worktree HEAD is missing before ready_merge");
    if (branchBeforeResult.status !== 0 || !branchBeforeResult.stdout)
      throw new StepError("git_branch_failed", "Worktree branch is empty before ready_merge");
    const requestId = `e2e-ready-merge-${randomUUID()}`;
    const updated = await run.api.action(run.companyId, "company_tasks", "updateIssue", {
      issueId: run.issueId,
      expectedVersion: issue.version,
      patch: { status: "ready_merge" },
      requestId,
    });
    if (updated.status !== "ready_merge")
      throw new StepError("ready_merge_not_applied", "Issue did not enter ready_merge");
    const headAfterResult = git(worktree, ["rev-parse", "HEAD"], run);
    const branchAfterResult = git(worktree, ["branch", "--show-current"], run);
    if (
      headAfterResult.status !== 0 ||
      !/^[0-9a-f]{40}$/i.test(headAfterResult.stdout)
    )
      throw new StepError("git_head_failed", "Worktree HEAD is missing after ready_merge");
    if (branchAfterResult.status !== 0 || !branchAfterResult.stdout)
      throw new StepError("git_branch_failed", "Worktree branch is empty after ready_merge");
    if (
      headBeforeResult.stdout !== headAfterResult.stdout ||
      branchBeforeResult.stdout !== branchAfterResult.stdout
    )
      throw new StepError("merge_happened", "ready_merge changed the worktree HEAD or branch");
    return {
      step: "E14",
      actor: "owner",
      operation: "ready_merge",
      status: "passed",
      requestId,
      issueId: run.issueId,
      checks: {
        issueStatus: updated.status,
        codeRef: sha12(codeRef),
        headUnchanged: true,
        branchUnchanged: true,
        head: sha12(headAfterResult.stdout),
        branch: branchAfterResult.stdout,
      },
    };
  });
}

function imDirectories(run: RunState) {
  const companyDir = join(run.companyHome, "companys", run.companyId!);
  return {
    threads: join(companyDir, "im", "threads"),
    messages: join(companyDir, "im", "messages"),
  };
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => /\.md$/.test(name));
}

function messageRows(run: RunState, threadId: string) {
  const { messages } = imDirectories(run);
  return listFiles(messages)
    .map((name) => readMarkdownFile(join(messages, name)).head)
    .filter((row) => row.thread_id === threadId);
}

async function stepE15(run: RunState, runner: Runner) {
  return runner.step("E15", "hr+dev", "company_im", async () => {
    const { threads } = imDirectories(run);
    const before = new Set(listFiles(threads));
    const issuesBefore = new Set(
      ((await run.api.action(run.companyId, "company_tasks", "listIssues", {})) ?? []).map(
        (issue: any) => String(issue.id),
      ),
    );
    const sessionsBefore = new Set(
      ((await companyState(run)).agents ?? []).map((agent: any) => agent.sessionId),
    );
    const askRequestId = `e2e-im-ask-${randomUUID()}`;
    const subject = `E2E IM ${randomUUID().slice(0, 8)}`;
    const body = `Please confirm the E2E IM path. Marker ${randomUUID().slice(0, 8)}.`;
    const asked = await agentInstruction(run, runner, {
      step: "E15-ask",
      agentId: run.agents!.hr,
      prompt: `Use company_im.ask exactly once with {toAgentId:"${run.agents!.dev}", subject:"${subject}", text:"${body}", requestId:"${askRequestId}"}. Do not create an Issue or a Session. Reply with the thread and message IDs.`,
      correction:
        "The IM thread was not created. Call company_im.ask with the exact recipient, subject and text from the prompt. Do not use Chat or create an Issue.",
      requiredTools: ["ask"],
      verify: async () => {
        const file = listFiles(threads).find((name) => !before.has(name));
        if (!file) return { ok: false, detail: "no new thread file" };
        const thread = readMarkdownFile(join(threads, file)).head;
        const ok =
          thread.asker_id === run.agents!.hr &&
          thread.recipient_id === run.agents!.dev &&
          thread.status === "open";
        return { ok, detail: ok ? "IM thread created" : "IM participants are wrong" };
      },
    });
    const threadFile = listFiles(threads).find((name) => !before.has(name));
    if (!threadFile) throw new StepError("thread_missing", "IM thread file was not created");
    const threadPath = join(threads, threadFile);
    const threadId = String(readMarkdownFile(threadPath).head.id);
    const delivered = await waitFor(
      "IM delivery",
      async () => {
        const row = messageRows(run, threadId).find(
          (message) => message.delivery_status === "delivered",
        );
        return row ?? undefined;
      },
      60_000,
      500,
    );
    const originalId = String(delivered.id);
    let reply = messageRows(run, threadId).find(
      (message) =>
        message.sender_id === run.agents!.dev &&
        message.reply_to === originalId,
    );
    let replyTools: string[] = [];
    if (!reply) {
      const replyRequestId = `e2e-im-reply-${randomUUID()}`;
      const replyTurn = await agentInstruction(run, runner, {
        step: "E15-reply",
        agentId: run.agents!.dev,
        prompt: `Read thread ${threadId} with company_im.thread (message ${originalId}), then use company_im.reply exactly once with {threadId:"${threadId}", messageId:"${originalId}", text:"E2E IM reply confirmed ${randomUUID().slice(0, 8)}", requestId:"${replyRequestId}"}. Reply with the message ID.`,
        correction:
          "No IM reply was recorded. Use company_im.thread to read the original message, then company_im.reply with the exact thread and message IDs.",
        requiredTools: ["reply"],
        verify: async () => {
          const found = messageRows(run, threadId).some(
            (message) =>
              message.sender_id === run.agents!.dev &&
              message.reply_to === originalId,
          );
          return { ok: found, detail: found ? "IM reply recorded" : "IM reply missing" };
        },
      });
      replyTools = replyTurn.tools;
      reply = messageRows(run, threadId).find(
        (message) =>
          message.sender_id === run.agents!.dev &&
          message.reply_to === originalId,
      );
    }
    if (!reply) throw new StepError("reply_missing", "IM reply was not recorded");
    const threadVersion = Number(readMarkdownFile(threadPath).head.version);
    const closeRequestId = `e2e-im-close-${randomUUID()}`;
    const closed = await agentInstruction(run, runner, {
      step: "E15-close",
      agentId: run.agents!.hr,
      prompt: `Use company_im.inbox and company_im.thread to read thread ${threadId}, then call company_im.closeThread exactly once with {threadId:"${threadId}", status:"resolved", expectedVersion:${threadVersion}, requestId:"${closeRequestId}"}. Reply with the final thread status.`,
      correction:
        "The IM thread is not resolved. Read the thread and call company_im.closeThread with status resolved and the current version.",
      requiredTools: ["closeThread"],
      verify: async () => {
        const thread = readMarkdownFile(threadPath).head;
        return {
          ok: thread.status === "resolved",
          detail: thread.status === "resolved" ? "thread resolved" : `status=${thread.status}`,
        };
      },
    });
    const rows = messageRows(run, threadId);
    const issuesAfter = new Set(
      ((await run.api.action(run.companyId, "company_tasks", "listIssues", {})) ?? []).map(
        (issue: any) => String(issue.id),
      ),
    );
    const sessionsAfter = new Set(
      ((await companyState(run)).agents ?? []).map((agent: any) => agent.sessionId),
    );
    const noNewBusinessObjects =
      issuesAfter.size === issuesBefore.size &&
      [...issuesBefore].every((id) => issuesAfter.has(id)) &&
      sessionsAfter.size === sessionsBefore.size &&
      [...sessionsBefore].every((id) => sessionsAfter.has(id));
    if (!noNewBusinessObjects)
      throw new StepError(
        "im_created_business_object",
        "IM ask/reply/close created a new Issue or Session",
      );
    return {
      step: "E15",
      actor: "hr+dev",
      operation: "company_im",
      status: "passed",
      requestId: closeRequestId,
      agentId: run.agents!.hr,
      toolCalls: [...new Set([...asked.tools, ...replyTools, ...closed.tools])],
      checks: {
        threadId,
        messages: rows.length,
        deliveryStatuses: rows.map((row) => String(row.delivery_status)).join(","),
        resolved: true,
        noIssueOrSessionCreated: true,
        attempts: asked.attempts + closed.attempts,
      },
      detail: closed.detail,
    };
  });
}

async function stepE16(run: RunState, runner: Runner) {
  return runner.step("E16", "owner", "process restart recovery", async () => {
    const before = await companyState(run);
    const sessions = new Map<string, string>(
      (before.agents ?? []).map((agent: any) => [agent.agentId, agent.sessionId]),
    );
    const historyBefore = await run.api.conversation(run.companyId!, run.agents!.hr);
    if (!(historyBefore.messages ?? []).length)
      throw new StepError("history_missing", "HR history is empty before restart");
    await stopServer(run);
    await startServer(run);
    const restartedCookie = await run.api.login(run.ownerToken);
    const restartedSession = /company_session=([^;]+)/.exec(restartedCookie)?.[1];
    if (restartedSession) run.secrets.push(restartedSession);
    const after = await companyState(run);
    for (const [agentId, sessionId] of sessions) {
      const current = (after.agents ?? []).find((agent: any) => agent.agentId === agentId);
      if (current?.sessionId !== sessionId)
        throw new StepError("session_changed", `Session changed for ${agentId} after restart`);
    }
    const historyAfter = await run.api.conversation(run.companyId!, run.agents!.hr);
    if (!(historyAfter.messages ?? []).length)
      throw new StepError("history_lost", "HR history did not load after restart");
    const marker = `RESTART_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const turn = await ownerChatTurn(
      run,
      run.agents!.hr,
      `After the server restart, reply with exactly ${marker}`,
      `e2e-after-restart-${randomUUID()}`,
    );
    const text = turn.fresh
      .filter((message: any) => message.role === "assistant")
      .map((message: any) => String(message.text ?? ""))
      .join("\n");
    if (!text.trim())
      throw new StepError("post_restart_reply_missing", "No model reply after restart");
    if (!text.includes(marker))
      throw new StepError(
        "marker_mismatch",
        "Post-restart model reply did not contain the requested unique marker",
      );
    const snapshot = await run.api.runtime(run.companyId!, run.agents!.hr);
    if (snapshot.sessionId !== sessions.get(run.agents!.hr))
      throw new StepError("session_changed", "HR Session changed after restart");
    return {
      step: "E16",
      actor: "owner",
      operation: "process restart recovery",
      status: "passed",
      agentId: run.agents!.hr,
      sessionId: snapshot.sessionId,
      modelAlias: snapshot.modelAlias,
      model: snapshot.model,
      checks: {
        serverStarts: run.serverCount,
        companyStable: true,
        sessionsStable: true,
        historyReloaded: true,
        replyAfterRestart: true,
        markerMatched: true,
      },
    };
  });
}

async function stepE17(run: RunState, runner: Runner) {
  return runner.step("E17", "owner+dev", "Agent explicit restart", async () => {
    const before = await companyState(run);
    const prior = (before.agents ?? []).find(
      (agent: any) => agent.agentId === run.agents!.dev,
    );
    if (!isUuid(prior?.sessionId))
      throw new StepError("session_invalid", "dev-1 Session is not a UUID");
    const envPath = join(run.companyHome, "agents", run.agents!.dev, ".env");
    const originalEnv = readFileSync(envPath, "utf8");
    let attackerHits = 0;
    const attacker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        attackerHits++;
        return new Response(JSON.stringify({ error: { message: "unexpected" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      // Simulate an Agent that can write its own `.env`. An explicit restart must
      // still use only the trusted host environment.
      writeFileSync(
        envPath,
        [
          `PERI_MODEL_BASE_URL=${attacker.url.origin}/v1`,
          "PERI_MODEL_API_KEY=attacker-placeholder-key",
          "PERI_MODEL_ID=attacker-model",
          "PERI_MODEL_PROVIDER=openai",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      chmodSync(envPath, 0o600);
      const applied = await saveAndRestart(run, run.agents!.dev, {
        modelAlias: "fable",
        instructions: "E2E switched dev-1 to the fable alias on explicit restart",
      });
      const snapshot = await run.api.runtime(run.companyId!, run.agents!.dev);
      if (snapshot.sessionId !== prior.sessionId)
        throw new StepError("session_changed", "Agent restart changed the Session");
      if (snapshot.modelAlias !== "fable")
        throw new StepError("alias_not_applied", "Snapshot did not switch to fable");
      const effective = await assertEffectiveConfiguration(run, run.agents!.dev, "fable");
      const expectedModel =
        run.model.values.PERI_MODEL_ID_FABLE ?? run.model.values.PERI_MODEL_ID;
      if (snapshot.model !== expectedModel)
        throw new StepError(
          "agent_env_model_applied",
          "Agent .env model ID overrode the trusted host model",
        );
      const marker = `ALIAS_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      const turn = await ownerChatTurn(
        run,
        run.agents!.dev,
        `Reply with exactly ${marker} to confirm the restarted configuration.`,
        `e2e-alias-chat-${randomUUID()}`,
      );
      const text = turn.fresh
        .filter((message: any) => message.role === "assistant")
        .map((message: any) => String(message.text ?? ""))
        .join("\n");
      if (!text.trim())
        throw new StepError("post_restart_reply_missing", "No model reply after Agent restart");
      if (!text.includes(marker))
        throw new StepError(
          "marker_mismatch",
          "Post-restart model reply did not contain the requested unique marker",
        );
      if (attackerHits !== 0)
        throw new StepError(
          "agent_env_redirected_model",
          "An Agent-writable .env redirected a model request after explicit restart",
        );
      return {
        step: "E17",
        actor: "owner+dev",
        operation: "Agent explicit restart",
        status: "passed",
        agentId: run.agents!.dev,
        sessionId: snapshot.sessionId,
        modelAlias: snapshot.modelAlias,
        model: snapshot.model,
        checks: {
          appliedConfigVersion: applied.after.appliedConfigVersion,
          savedConfigVersion: applied.after.configVersion,
          aliasApplied: true,
          sessionStable: true,
          replyAfterRestart: true,
          fourTiers: effective.fourTiers,
          trustedEndpoint: effective.trustedEndpoint,
          agentEnvModelIgnored: true,
          attackerRequests: attackerHits,
          markerMatched: true,
        },
      };
    } finally {
      attacker.stop(true);
      writeFileSync(envPath, originalEnv, { mode: 0o600 });
      chmodSync(envPath, 0o600);
    }
  });
}

async function waitForCommentEvent(run: RunState, action: () => Promise<unknown>) {
  const controller = new AbortController();
  const connectionTimeout = setTimeout(() => controller.abort(), 25_000);
  let response: Response;
  try {
    response = await fetch(
      new URL(
        `/api/events?companyId=${encodeURIComponent(run.companyId!)}`,
        run.origin,
      ),
      {
        headers: { accept: "text/event-stream", cookie: run.api.cookie },
        redirect: "error",
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(connectionTimeout);
  }
  if (!response.ok || !response.body)
    throw new StepError("events_unavailable", "SSE endpoint did not open");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let actionError: unknown;
  const actionPromise = action().catch((error) => {
    actionError = error;
  });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolvePromise) =>
          setTimeout(() => resolvePromise(null), remaining),
        ),
      ]);
      if (!chunk) break;
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.includes('"kind":"addComment"')) {
        await actionPromise;
        if (actionError) throw actionError;
        return true;
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  await actionPromise;
  if (actionError) throw actionError;
  return false;
}

async function stepE18(run: RunState, runner: Runner) {
  return runner.step("E18", "owner", "events and negative checks", async () => {
    let eventObserved = false;
    const requestId = `e2e-event-comment-${randomUUID()}`;
    eventObserved = await waitForCommentEvent(run, () =>
      run.api.action(run.companyId, "company_tasks", "addComment", {
        issueId: run.issueId,
        body: "E2E SSE event comment",
        requestId,
      }),
    );
    if (!eventObserved)
      throw new StepError("event_missing", "SSE did not deliver the comment event");

    const anonymous = new Api(run.origin);
    let unauthorizedStatus = 0;
    let unauthorizedCode = "";
    try {
      await anonymous.companies();
    } catch (error) {
      if (error instanceof ApiError) {
        unauthorizedStatus = error.status;
        unauthorizedCode = error.code;
      } else throw error;
    }
    if (unauthorizedStatus !== 401 || unauthorizedCode !== "unauthorized")
      throw new StepError("unauthorized_check_failed", "Unauthenticated API was not rejected");

    const issue = await issueState(run, run.issueId!);
    const staleVersion = Math.max(1, issue.version - 1);
    let staleCode = "";
    try {
      await run.api.action(run.companyId, "company_tasks", "updateIssue", {
        issueId: run.issueId,
        expectedVersion: staleVersion,
        patch: { progress: "stale write" },
        requestId: `e2e-stale-version-${randomUUID()}`,
      });
    } catch (error) {
      if (error instanceof ApiError) staleCode = error.code;
      else throw error;
    }
    if (staleCode !== "version_conflict")
      throw new StepError("stale_version_not_rejected", "Stale version did not conflict");

    const second = await run.api.action(run.companyId, "company_tasks", "createIssue", {
      title: "E2E cancel negative",
      body: "Cancel then attempt revival",
      requestId: `e2e-cancel-issue-${randomUUID()}`,
    });
    const canceled = await run.api.action(run.companyId, "company_tasks", "cancelIssue", {
      issueId: second.id,
      expectedVersion: second.version,
      reason: "E2E terminal state check",
      requestId: `e2e-cancel-${randomUUID()}`,
    });
    let terminalCode = "";
    try {
      await run.api.action(run.companyId, "company_tasks", "updateIssue", {
        issueId: second.id,
        expectedVersion: canceled.version,
        patch: { summary: "attempt revive" },
        requestId: `e2e-revive-${randomUUID()}`,
      });
    } catch (error) {
      if (error instanceof ApiError) terminalCode = error.code;
      else throw error;
    }
    if (terminalCode !== "terminal_issue")
      throw new StepError("terminal_not_enforced", "Canceled Issue could be revived");

    const idempotentRequest = `e2e-idempotent-${randomUUID()}`;
    const first = await run.api.action(run.companyId, "company_tasks", "addComment", {
      issueId: run.issueId,
      body: "E2E idempotent comment",
      requestId: idempotentRequest,
    });
    const replay = await run.api.action(run.companyId, "company_tasks", "addComment", {
      issueId: run.issueId,
      body: "E2E idempotent comment",
      requestId: idempotentRequest,
    });
    if (first.id !== replay.id)
      throw new StepError("idempotency_not_replayed", "Repeated request ID returned a new result");
    let conflictCode = "";
    try {
      await run.api.action(run.companyId, "company_tasks", "addComment", {
        issueId: run.issueId,
        body: "E2E different payload",
        requestId: idempotentRequest,
      });
    } catch (error) {
      if (error instanceof ApiError) conflictCode = error.code;
      else throw error;
    }
    if (conflictCode !== "idempotency_conflict")
      throw new StepError("idempotency_conflict_missing", "Different payload was not rejected");
    return {
      step: "E18",
      actor: "owner",
      operation: "events and negative checks",
      status: "passed",
      requestId,
      issueId: run.issueId,
      checks: {
        sseEvent: eventObserved,
        unauthenticated401: true,
        staleVersionConflict: true,
        terminalIssue: true,
        idempotentReplay: true,
        differentPayloadConflict: true,
        negativeIssueId: String(second.id),
      },
    };
  });
}

async function captureGitLog(run: RunState): Promise<string> {
  const sections: string[] = [];
  const targets: [string, string][] = [
    ["company", join(run.companyHome, "companys", run.companyId ?? "")],
  ];
  if (run.projectRoot && existsSync(run.projectRoot))
    targets.push(["project", run.projectRoot]);
  for (const [label, directory] of targets) {
    if (!directory || !existsSync(directory)) continue;
    const log = git(directory, ["log", "--oneline", "--decorate", "-20"], run);
    sections.push(`[${label}]`);
    sections.push(log.status === 0 ? log.stdout : "(no git log)");
    sections.push("");
  }
  return redact(sections.join("\n"), run.secrets);
}

function processCwd(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      try {
        return realpathSync(cwd);
      } catch {
        return resolve(cwd);
      }
    } catch {
      return undefined;
    }
  }
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return undefined;
  const line = (result.stdout ?? "").split("\n").find((item) => item.startsWith("n"));
  if (!line) return undefined;
  const cwd = line.slice(1);
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

/** Terminate only processes whose cwd is inside this run's test root. A process we
 * cannot attribute is never killed; it makes E19 fail instead. */
async function terminateOwnedProcesses(
  run: RunState,
  pids: number[],
): Promise<{
  notOwned: number[];
  notInspectable: number[];
  killed: number[];
  errors: string[];
}> {
  const notOwned: number[] = [];
  const notInspectable: number[] = [];
  const killed: number[] = [];
  const errors: string[] = [];
  const owned: number[] = [];
  for (const pid of pids) {
    if (pid === process.pid || pid === process.ppid) continue;
    if (!processAlive(pid)) continue;
    const cwd = processCwd(pid);
    if (!cwd) {
      notInspectable.push(pid);
      continue;
    }
    if (!isInside(run.root, cwd)) {
      notOwned.push(pid);
      continue;
    }
    owned.push(pid);
  }
  for (const pid of owned) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && owned.some((pid) => processAlive(pid)))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  for (const pid of owned) {
    if (!processAlive(pid)) {
      killed.push(pid);
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      errors.push(`${pid}:${safeMessage(error)}`);
    }
  }
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline && owned.some((pid) => processAlive(pid)))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  for (const pid of owned) if (!processAlive(pid) && !killed.includes(pid)) killed.push(pid);
  return { notOwned, notInspectable, killed, errors };
}

function ciIsolationStatus(run: RunState): {
  verified: boolean;
  reason: string;
  containerCheck: string;
} {
  if (run.options.mode !== "local-full")
    return { verified: true, reason: "not_applicable", containerCheck: "not_applicable" };
  let containerCheck = "not_used";
  for (const mode of ["ci", "review"] as const) {
    const proof = run.ciProofs[mode];
    if (!proof) return { verified: false, reason: `${mode}_proof_missing`, containerCheck };
    if (proof.mode !== mode) return { verified: false, reason: `${mode}_mode_mismatch`, containerCheck };
    if (!run.ciBackend || proof.backend !== run.ciBackend)
      return { verified: false, reason: `${mode}_backend_mismatch`, containerCheck };
    if (!Object.values(proof.isolation).every(Boolean))
      return { verified: false, reason: `${mode}_isolation_unverified`, containerCheck };
    if (!proof.exited) return { verified: false, reason: `${mode}_still_running`, containerCheck };
    if (!/^[0-9a-f]{64}$/.test(proof.digest))
      return { verified: false, reason: `${mode}_digest_invalid`, containerCheck };
    if (!/^[0-9a-f]{32,64}$/.test(proof.challenge))
      return { verified: false, reason: `${mode}_challenge_invalid`, containerCheck };
    if (proof.backend === "docker") {
      if (!proof.containerName)
        return { verified: false, reason: `${mode}_container_unknown`, containerCheck };
      const state = dockerContainerGone(proof.containerName);
      if (!state.supported)
        return { verified: false, reason: "ci_container_check_unavailable", containerCheck: "unavailable" };
      if (!state.gone)
        return { verified: false, reason: "ci_container_left", containerCheck: "left" };
      containerCheck = "gone";
    }
  }
  return { verified: true, reason: "verified", containerCheck };
}

async function cleanupRun(run: RunState): Promise<Evidence> {
  const checks: Record<string, boolean | number | string> = {};
  const baselineMetadata = run.baseline.userData;
  // Capture process-open, owner-token and listener facts before the test
  // processes/root go away.
  const processes = isolationProcessIds(run);
  const userDataOpen = openedUserData(processes.pids, baselineMetadata.roots);
  const reserved = reservedPortsUnchanged(run.baseline.reservedPorts);
  const reservedChanged = Object.values(reserved.results).includes("changed");
  const ciStagingBefore = run.ciWorkDirs.length;
  const containers = stopCiContainers(run);
  let stopError = "";
  try {
    await stopServer(run);
    checks.serverStopped = true;
  } catch (error) {
    stopError = safeMessage(error);
    checks.serverStopped = false;
  }
  const terminated = await terminateOwnedProcesses(run, processes.pids);
  const portsManaged = run.serverCount > 0;
  const appFree = portsManaged ? !(await portResponds(run.appPort)) : true;
  checks.portsManaged = portsManaged;
  checks.appPortFree = appFree;
  const previewFree = run.previewUrl
    ? !(await urlResponds(run.previewUrl))
    : run.previewPort
      ? !(await portResponds(run.previewPort))
      : true;
  checks.previewPortFree = previewFree;
  const alivePids = processes.pids.filter(
    (pid) => pid !== process.pid && processAlive(pid),
  );
  const processStopped = alivePids.length === 0;
  // stopServer() may report a port error before terminateOwnedProcesses() kills a
  // surviving child; only claim the server stopped when ports and processes agree.
  checks.serverStopped =
    checks.serverStopped === true ||
    (processStopped && appFree && previewFree);
  checks.processCheckAvailable = processes.supported;
  checks.testProcessesChecked = processes.pids.length;
  checks.testProcessesPorts = Object.entries(processes.ports)
    .map(([label, state]) => `${label}:${state.pids.length}${state.supported ? "" : ":unverified"}`)
    .join(",");
  checks.testProcessesExited = userDataOpen.exited;
  checks.testProcessesStopped = processStopped;
  checks.testProcessesAlive = alivePids.join(",") || "none";
  checks.testProcessesNotOwned = terminated.notOwned.join(",") || "none";
  checks.testProcessesUnattributable =
    terminated.notInspectable.join(",") || "none";
  checks.testProcessesKilled = terminated.killed.length;
  checks.ciContainersStopped = containers.attempted
    ? containers.ok
      ? "stopped"
      : "failed"
    : "not_used";

  const gitLog = await captureGitLog(run);
  writeEvidenceFile(run, "git-log.txt", gitLog + "\n", 0o600);

  const userDataAfter = userDataMetadata();
  const expectedComparison = compareExpectedUserData(
    baselineMetadata.expected,
    userDataAfter.expected,
  );
  const afterSummary = [
    `user data roots: ${userDataAfter.roots.length}`,
    `expected user data paths: ${userDataAfter.expected.length}`,
    `expected user data paths existing: ${userDataAfter.expected.filter((entry) => entry.exists).length}`,
    `created expected paths: ${expectedComparison.created.length}`,
    `changed expected paths: ${expectedComparison.changed.length}`,
    `metadata records: ${userDataAfter.records}`,
    `metadata digest: ${userDataAfter.digest}`,
    `supported: ${userDataAfter.supported}`,
    `complete: ${userDataAfter.complete}`,
    ...(userDataAfter.error ? [`error: ${userDataAfter.error}`] : []),
    "",
  ].join("\n");
  writeEvidenceFile(run, "after-user-data.txt", afterSummary, 0o600);
  const metadataAvailable =
    baselineMetadata.supported &&
    baselineMetadata.complete &&
    userDataAfter.supported &&
    userDataAfter.complete;
  const expectedPathsUnchanged =
    metadataAvailable &&
    expectedComparison.created.length === 0 &&
    expectedComparison.changed.length === 0;
  const userDataMetadataUnchanged =
    metadataAvailable && userDataAfter.digest === baselineMetadata.digest;
  const userDataMetadataState = !metadataAvailable
    ? "unavailable"
    : userDataMetadataUnchanged
      ? "unchanged"
      : "changed";

  const ownerTokenFiles = findNamedFiles(run.root, "owner-token");
  const ownerTokenAbsent =
    ownerTokenFiles.supported &&
    run.baseline.ownerTokenFiles === 0 &&
    ownerTokenFiles.files.length === 0;
  let removeError = "";
  let rootGone = !existsSync(run.root);
  if (!rootGone && (checks.serverStopped !== true || !processStopped)) {
    removeError = "root retained because a test process did not stop cleanly";
  } else if (!rootGone) {
    try {
      validateTestRoot(run.root);
      const info = lstatSync(run.root);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.ino !== run.baseline.rootInode ||
        info.dev !== run.baseline.rootDev
      )
        throw new UsageError(
          "Test root identity changed; refusing recursive delete",
        );
      rmSync(run.root, { recursive: true, force: true });
      rootGone = !existsSync(run.root);
    } catch (error) {
      removeError = safeMessage(error);
    }
  }
  const ciDirs = cleanupCiWorkDirs(run);
  checks.testRootGone = rootGone;
  checks.ownerTokenBaseline = run.baseline.ownerTokenFiles;
  checks.ownerTokenAbsent = ownerTokenAbsent;
  checks.userDataOpenCheck = userDataOpen.supported
    ? userDataOpen.opened === 0
      ? "not_open"
      : "open"
    : "unavailable";
  checks.userDataProcessesChecked = userDataOpen.checked;
  checks.userDataProcessesExited = userDataOpen.exited;
  checks.userDataOpenUnavailablePids =
    userDataOpen.unavailablePids.join(",") || "none";
  checks.userDataMetadata = userDataMetadataState;
  checks.userDataMetadataUnchanged = userDataMetadataUnchanged;
  checks.userDataMetadataRecords = userDataAfter.records;
  checks.userDataMetadataDigest = userDataAfter.digest.slice(0, 12);
  checks.userDataExpectedPaths = userDataAfter.expected.length;
  checks.userDataExpectedPathsBefore = baselineMetadata.expected.filter(
    (entry) => entry.exists,
  ).length;
  checks.userDataExpectedPathsAfter = userDataAfter.expected.filter(
    (entry) => entry.exists,
  ).length;
  checks.userDataCreatedPaths = expectedComparison.created.length;
  checks.userDataChangedPaths = expectedComparison.changed.length;
  checks.userDataExpectedPathsUnchanged = expectedPathsUnchanged;
  checks.reservedUserPorts = Object.entries(reserved.results)
    .map(([port, state]) => `${port}:${state}`)
    .join(",");
  checks.reservedPortsUnchanged = !reserved.verified
    ? "unverified"
    : !reservedChanged;
  const ciDirCountBefore = ciStagingBefore;
  checks.ciWorkDirsTracked = ciDirCountBefore;
  checks.ciWorkDirsGone = ciDirs.removed;
  checks.ciRunnerBackend = run.ciBackend ?? "not_selected";
  checks.ciRunnerProofs = Object.keys(run.ciProofs).sort().join(",") || "none";
  const ciStatus = ciIsolationStatus(run);
  checks.ciRunnerIsolation = ciStatus.verified
    ? ciStatus.reason === "not_applicable"
      ? "not_applicable"
      : "verified"
    : ciStatus.reason;
  checks.ciRunnerContainer = ciStatus.containerCheck;
  const ciStagingVerified =
    run.options.mode !== "local-full" ||
    (Object.keys(run.ciProofs).length === 2 && ciDirCountBefore >= 2);
  checks.ciStagingVerified = ciStagingVerified;
  const previewProcessCheck = run.previewPort
    ? processes.ports.preview?.supported
      ? `supported:${processes.ports.preview.pids.length}`
      : "unavailable"
    : run.previewUrl
      ? "unavailable"
      : "not_used";
  checks.previewProcessCheck = previewProcessCheck;
  const previewProcessVerified =
    !run.previewPort && !run.previewUrl
      ? true
      : previewProcessCheck.startsWith("supported:");
  checks.previewProcessVerified = previewProcessVerified;
  const agentCiExecutionRequired = run.options.mode === "local-full";
  const agentCiExecutionVerified =
    !agentCiExecutionRequired ||
    Boolean(run.agentCiExecutions.ci?.ok && run.agentCiExecutions.review?.ok);
  checks.agentCiExecution = agentCiExecutionRequired
    ? agentCiExecutionVerified
      ? "verified"
      : "unproven"
    : "not_applicable";
  checks.agentCiExecutionVerified = agentCiExecutionVerified;
  let evidenceIdentityOk = false;
  try {
    assertEvidenceDirectory(run.evidenceDir, run.evidenceIdentity);
    evidenceIdentityOk = true;
  } catch {}
  checks.evidenceCreatedByRun =
    evidenceIdentityOk &&
    run.evidenceCreated &&
    existsSync(run.evidenceDir) &&
    !isInside(run.root, run.evidenceDir) &&
    dirname(run.evidenceDir) === dirname(run.root) &&
    basename(run.evidenceDir).startsWith("company-e2e-evidence.");

  const userDataVerified =
    processes.supported &&
    userDataOpen.supported &&
    userDataOpen.opened === 0 &&
    userDataMetadataUnchanged &&
    expectedPathsUnchanged &&
    metadataAvailable;
  const userDataStatement = userDataVerified
    ? "verified: no test process held user data paths open at the E19 check and user-data metadata is unchanged (including absent .company/.company-host paths that would fail if created); no user-data modification or deletion was detected by this run"
    : `NOT VERIFIED: user-data isolation proof is incomplete (metadata=${userDataMetadataState}, expectedPaths=${expectedPathsUnchanged ? "unchanged" : "changed"}, created=${expectedComparison.created.length}, open=${String(checks.userDataOpenCheck)}, processes=${processes.pids.length}); do not treat this run as user-data no-residue evidence`;

  const lines = [
    "Company Factory E2E cleanup",
    `test root: ${run.root}`,
    `evidence dir (created by this run): ${run.evidenceDir}`,
    `app port: ${run.appPort} free=${appFree}`,
    `preview url ${run.previewUrl ?? "(unused)"} free=${previewFree}`,
    `reserved user port 3000: ${String(checks.reservedUserPorts)}`,
    `owner-token files in test root: ${ownerTokenFiles.supported ? ownerTokenFiles.files.length : "unavailable"}`,
    `test processes checked/gone/alive: ${processes.pids.length}/${processes.pids.length - alivePids.length}/${alivePids.length}`,
    `test processes not owned (not killed): ${String(checks.testProcessesNotOwned)}`,
    `test processes not inspectable: ${String(checks.testProcessesUnattributable)}`,
    `user data open check: ${String(checks.userDataOpenCheck)} (checked=${userDataOpen.checked}, exited=${userDataOpen.exited})`,
    `user data metadata before/after: ${userDataMetadataState}`,
    `user data expected paths before/after: ${String(checks.userDataExpectedPathsBefore)}/${String(checks.userDataExpectedPathsAfter)} created=${expectedComparison.created.length} changed=${expectedComparison.changed.length}`,
    `preview process check: ${previewProcessCheck}`,
    `Agent CI execution proof: ${String(checks.agentCiExecution)}`,
    `CI/Review isolation: ${String(checks.ciRunnerIsolation)} backend=${String(checks.ciRunnerBackend)} container=${String(checks.ciRunnerContainer)}`,
    `CI staging dirs gone: ${ciDirs.removed}`,
    `test root gone: ${rootGone}`,
    userDataStatement,
    "",
    "# Verification commands",
    `test ! -e '${run.root}' && echo TEST_ROOT_GONE`,
    `lsof -nP -iTCP:${run.appPort} -sTCP:LISTEN || echo PORT_${run.appPort}_FREE`,
    ...(run.previewPort
      ? [`lsof -nP -iTCP:${run.previewPort} -sTCP:LISTEN || echo PORT_${run.previewPort}_FREE`]
      : []),
    `ps -p ${processes.pids.join(",") || "0"} >/dev/null || echo TEST_PROCESSES_GONE`,
    `docker ps -a --filter 'name=company-e2e-ci-' --format '{{.Names}}' | grep . && echo CONTAINER_LEFT || echo NO_TEST_CONTAINER`,
    `grep -R -n --exclude=cleanup.txt -E 'Bearer |company_session=|PERI_MODEL_API_KEY|PERI_STORAGE_TOKEN|authToken|owner-token' '${run.evidenceDir}' && echo SECRET_FOUND || echo EVIDENCE_CLEAN`,
    "",
    `stop error: ${redact(stopError || "none", run.secrets)}`,
    `remove error: ${redact(removeError || "none", run.secrets)}`,
  ];
  writeEvidenceFile(run, "cleanup.txt", lines.join("\n") + "\n", 0o600);

  const ok =
    checks.serverStopped === true &&
    appFree &&
    previewFree &&
    processes.supported &&
    terminated.notInspectable.length === 0 &&
    processStopped &&
    rootGone &&
    checks.ownerTokenAbsent === true &&
    userDataOpen.supported &&
    userDataOpen.opened === 0 &&
    metadataAvailable &&
    userDataMetadataUnchanged &&
    expectedPathsUnchanged &&
    reserved.verified &&
    !reservedChanged &&
    checks.evidenceCreatedByRun === true &&
    ciDirs.removed &&
    ciStagingVerified &&
    ciStatus.verified &&
    (!containers.attempted || containers.ok) &&
    previewProcessVerified &&
    agentCiExecutionVerified &&
    !removeError;

  let failureCode = "cleanup_incomplete";
  if (!processes.supported || terminated.notInspectable.length > 0)
    failureCode = "process_check_unavailable";
  else if (!userDataOpen.supported) failureCode = "user_data_check_unavailable";
  else if (userDataOpen.opened > 0) failureCode = "user_data_opened";
  else if (!metadataAvailable) failureCode = "user_data_metadata_check_unavailable";
  else if (expectedComparison.created.length > 0)
    failureCode = "user_data_path_created";
  else if (!expectedPathsUnchanged) failureCode = "user_data_path_changed";
  else if (!userDataMetadataUnchanged) failureCode = "user_data_metadata_changed";
  else if (!reserved.verified) failureCode = "reserved_port_check_unavailable";
  else if (reservedChanged) failureCode = "reserved_port_changed";
  else if (!appFree) failureCode = "test_app_port_still_listening";
  else if (!previewFree) failureCode = "test_preview_port_still_listening";
  else if (!processStopped) failureCode = "process_still_running";
  else if (!previewProcessVerified) failureCode = "preview_process_check_unavailable";
  else if (!ciDirs.removed) failureCode = "ci_staging_left";
  else if (!ciStatus.verified) failureCode = ciStatus.reason;
  else if (!ciStagingVerified) failureCode = "ci_staging_untracked";
  else if (!containers.ok) failureCode = "ci_container_left";
  else if (!agentCiExecutionVerified) failureCode = "agent_ci_execution_unproven";
  else if (!rootGone) failureCode = "test_root_not_removed";
  else if (!ownerTokenFiles.supported) failureCode = "owner_token_check_unavailable";
  else if (checks.ownerTokenAbsent !== true) failureCode = "owner_token_created";
  else if (checks.evidenceCreatedByRun !== true)
    failureCode = "evidence_identity_changed";

  return {
    step: "E19",
    actor: "verifier",
    operation: "cleanup and no-residue checks",
    status: ok ? "passed" : "failed",
    checks,
    ...(ok
      ? {}
      : {
          error: {
            code: failureCode,
            message: redact(
              clamp(
                `server=${stopError || "stopped"} remove=${removeError || "none"} ci=${ciStatus.reason} notOwned=${checks.testProcessesNotOwned}`,
              ),
              run.secrets,
            ),
          },
        }),
  };
}

function skipStep(
  run: RunState,
  step: string,
  actor: string,
  operation: string,
  reason: string,
) {
  run.steps.push({
    step,
    actor,
    operation,
    status: "skipped",
    error: { code: "not_applicable", message: reason },
  });
}

function cleanEvidence(evidence: Evidence, secrets: string[]): Evidence {
  const output: Evidence = {
    step: evidence.step,
    actor: evidence.actor,
    operation: evidence.operation,
    status: evidence.status,
  };
  for (const key of [
    "httpStatus",
    "requestId",
    "companyId",
    "agentId",
    "issueId",
    "sessionId",
    "modelAlias",
    "model",
    "elapsedMs",
  ] as const) {
    if (evidence[key] !== undefined) (output as any)[key] = evidence[key];
  }
  if (evidence.toolCalls) output.toolCalls = evidence.toolCalls.map((tool) => redact(tool, secrets));
  if (evidence.checks) {
    output.checks = Object.fromEntries(
      Object.entries(evidence.checks).map(([key, value]) => [
        key,
        typeof value === "string" ? redact(value, secrets) : value,
      ]),
    );
  }
  if (evidence.error) {
    output.error = {
      ...(evidence.error.code ? { code: evidence.error.code } : {}),
      message: clamp(redact(evidence.error.message, secrets), 1000),
    };
  }
  if (evidence.detail)
    output.detail = clamp(redact(evidence.detail, secrets), 1000);
  return output;
}

function versionOf(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) return "unavailable";
  const text = (result.stdout || result.stderr).trim();
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /\d+\.\d+\.\d+/.test(line)) ?? lines[0] ?? "unknown";
}

/** Scan every evidence file, including git-log.txt/versions.txt/transcripts and
 * cleanup.txt. Offending files are removed by the caller so a secret is not left
 * on disk; the failure note records only file names. */
function scanEvidenceSecrets(run: RunState): {
  scanned: number;
  rejected: string[];
} {
  return scanEvidenceDirectory({
    directory: run.evidenceDir,
    secrets: run.secrets,
    maxBytes: MAX_EVIDENCE_FILE_BYTES,
    skipNames: ["SECURITY-FAILURE.txt", "evidence-scan.txt"],
  });
}

async function writeEvidence(
  run: RunState,
  runner: Runner,
  meta: { runId: string; startedAt: string; finishedAt: string },
) {
  const steps = run.steps.map((evidence) => cleanEvidence(evidence, run.secrets));
  const agentCiExecuted =
    run.options.mode === "local-full"
      ? Boolean(run.agentCiExecutions.ci?.ok && run.agentCiExecutions.review?.ok)
      : null;
  const closure =
    run.options.mode === "local-full" &&
    agentCiExecuted === true &&
    steps.length > 0 &&
    steps.every((evidence) => evidence.status === "passed");
  const report = {
    runId: meta.runId,
    mode: run.options.mode,
    base: run.origin,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    closure,
    agentCiExecuted,
    steps,
  };
  const reportPath = join(run.evidenceDir, "report.json");
  const serialized = JSON.stringify(report, null, 2) + "\n";
  const forbidden = [
    /Bearer\s+(?!\[REDACTED\])/i,
    /company_session=(?!\[REDACTED\])/i,
    /PERI_STORAGE_TOKEN/,
    /PERI_MODEL_API_KEY/,
    /authToken/,
    /owner-token/,
    /apiKey["']?\s*[:=]/,
  ];
  if (forbidden.some((pattern) => pattern.test(serialized))) {
    try {
      rmSync(reportPath, { force: true });
    } catch {}
    writeEvidenceFile(
      run,
      "SECURITY-FAILURE.txt",
      "Evidence was rejected by the secret scan. Inspect locally; do not share.\n",
      0o600,
    );
    throw new StepError(
      "evidence_secret_detected",
      "Evidence contains a forbidden secret marker; report not delivered",
    );
  }
  writeEvidenceFile(run, "report.json", serialized, 0o600);

  for (const evidence of steps) {
    const name = evidence.step.replace(/[^A-Za-z0-9_.-]/g, "_");
    writeEvidenceFile(
      run,
      `http/${name}.json`,
      JSON.stringify(evidence, null, 2) + "\n",
      0o600,
    );
  }

  const summary = [
    `# Company Factory E2E — ${run.options.mode}`,
    "",
    `- Run: ${meta.runId}`,
    `- Base: ${run.origin}`,
    `- Started: ${meta.startedAt}`,
    `- Finished: ${meta.finishedAt}`,
    `- Closure: ${closure ? "yes" : "no"}`,
    `- Agent CI execution proof: ${
      agentCiExecuted === null ? "not_applicable" : agentCiExecuted ? "verified" : "unproven"
    }`,
    `- Boundary: ${
      run.options.mode === "local-full"
        ? "Linux full-business run; ready_merge is terminal and no merge/deploy was executed."
        : "Smoke mode only. File/Git/Workspace/Preview/verification steps are skipped and this is NOT full-business acceptance."
    }`,
    "",
    "| Step | Status | Actor | Operation | Error |",
    "| --- | --- | --- | --- | --- |",
    ...steps.map(
      (evidence) =>
        `| ${evidence.step} | ${evidence.status} | ${evidence.actor} | ${evidence.operation} | ${evidence.error?.code ?? ""} |`,
    ),
    "",
    "Evidence contains only whitelisted, redacted fields. It never contains owner tokens, cookies, api keys, effective-config or agent.yaml contents.",
    "",
  ].join("\n");
  writeEvidenceFile(run, "SUMMARY.md", summary, 0o600);

  const versions = [
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    `bun=${Bun.version}`,
    `node=${process.version}`,
    `git=${versionOf("git", ["--version"])}`,
    `peri=${process.env.PERI_BINARY ? versionOf(process.env.PERI_BINARY, ["--version"]) : "unavailable"}`,
    `bwrap=${versionOf("bwrap", ["--version"])}`,
    `docker=${versionOf("docker", ["--version"])}`,
    `ci_runner=${run.ciBackend ?? "not_selected"}`,
    `agent_ci_executed=${
      run.options.mode === "local-full"
        ? Boolean(run.agentCiExecutions.ci?.ok && run.agentCiExecutions.review?.ok)
        : "not_applicable"
    }`,
    ...Object.entries(run.ciProofs).map(
      ([mode, proof]) => `ci_${mode}_digest=${proof?.digest.slice(0, 12) ?? "none"}`,
    ),
    `mode=${run.options.mode}`,
    "",
  ].join("\n");
  writeEvidenceFile(run, "versions.txt", redact(versions, run.secrets), 0o600);

  // Scan every evidence file, including git-log.txt/versions.txt/transcripts and
  // cleanup.txt. Offending files are removed so a secret is not left on disk; the
  // failure note records only file names.
  const scan = scanEvidenceSecrets(run);
  if (scan.rejected.length) {
    for (const file of scan.rejected) {
      try {
        rmSync(join(run.evidenceDir, file), { force: true });
      } catch {}
    }
    writeEvidenceFile(
      run,
      "SECURITY-FAILURE.txt",
      [
        "Evidence was rejected by the secret scan; offending files were removed.",
        `scanned: ${scan.scanned}`,
        "removed files:",
        ...scan.rejected.map((file) => `- ${file}`),
        "",
      ].join("\n"),
      0o600,
    );
    throw new StepError(
      "evidence_secret_detected",
      "Evidence contains a forbidden secret marker; offending files were removed",
    );
  }
  writeEvidenceFile(
    run,
    "evidence-scan.txt",
    `scanned=${scan.scanned} rejected=0\n`,
    0o600,
  );
  return { reportPath, closure };
}

let activeRun: RunState | undefined;
let signalHandling = false;
let signalHandlersInstalled = false;

/** Signal-safe cleanup for the prepareRun window. It has no RunState, so it only
 * removes the test root whose inode/device were captured before any child started.
 * When no root exists yet it is a no-op. User data and reserved ports are never
 * touched. */
async function emergencyCleanupPending(
  pending: PendingRunCleanup,
  signal: string,
): Promise<void> {
  const notes: string[] = [];
  try {
    if (!existsSync(pending.root)) {
      notes.push("root=absent");
    } else {
      validateTestRoot(pending.root);
      const info = lstatSync(pending.root);
      if (
        info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.ino === pending.rootInode &&
        info.dev === pending.rootDev
      ) {
        rmSync(pending.root, { recursive: true, force: true });
        notes.push(`root=${existsSync(pending.root) ? "retained" : "deleted"}`);
      } else {
        notes.push("root=identity_changed");
      }
    }
  } catch (error) {
    notes.push(`root=${safeMessage(error)}`);
  }
  if (pending.evidenceDir && pending.evidenceIdentity) {
    try {
      assertEvidenceDirectory(pending.evidenceDir, pending.evidenceIdentity);
      writeEvidenceFileAt(
        pending.evidenceDir,
        pending.evidenceIdentity,
        "INTERRUPTED.txt",
        [
          `signal: ${signal}`,
          `at: ${new Date().toISOString()}`,
          ...notes,
          "",
          "Signal arrived before the live run was active. Cleanup only targeted this run's test root; user data and reserved user port 3000 were not touched.",
          "",
        ].join("\n"),
        0o600,
      );
    } catch {}
  }
}

/** Emergency cleanup for Ctrl-C/SIGTERM. It only touches this run's server,
 * Workspace/preview processes, CI containers, staging directories and test root.
 * It never touches user data or the reserved user port 3000. */
async function emergencyCleanup(run: RunState, signal: string): Promise<void> {
  const notes: string[] = [];
  try {
    const containers = stopCiContainers(run);
    notes.push(
      `containers=${containers.attempted ? (containers.ok ? "stopped" : "failed") : "none"}`,
    );
  } catch (error) {
    notes.push(`containers=${safeMessage(error)}`);
  }
  try {
    await stopServer(run);
    notes.push("server=stopped");
  } catch (error) {
    notes.push(`server=${safeMessage(error)}`);
  }
  try {
    const processes = isolationProcessIds(run);
    const terminated = await terminateOwnedProcesses(run, processes.pids);
    notes.push(
      `processes=${processes.pids.length} killed=${terminated.killed.length} notOwned=${terminated.notOwned.length} notInspectable=${terminated.notInspectable.length}`,
    );
  } catch (error) {
    notes.push(`processes=${safeMessage(error)}`);
  }
  const ci = cleanupCiWorkDirs(run);
  notes.push(`ci_dirs=${ci.removed ? "removed" : "failed"}`);
  try {
    if (!existsSync(run.root)) {
      notes.push("root=absent");
    } else {
      const running = isolationProcessIds(run).pids.filter(
        (pid) => pid !== process.pid && processAlive(pid),
      );
      if (running.length) {
        notes.push("root=retained_processes_alive");
      } else {
        validateTestRoot(run.root);
        const info = lstatSync(run.root);
        if (
          info.isDirectory() &&
          !info.isSymbolicLink() &&
          info.ino === run.baseline.rootInode &&
          info.dev === run.baseline.rootDev
        ) {
          rmSync(run.root, { recursive: true, force: true });
          notes.push(`root=${existsSync(run.root) ? "retained" : "deleted"}`);
        } else {
          notes.push("root=identity_changed");
        }
      }
    }
  } catch (error) {
    notes.push(`root=${safeMessage(error)}`);
  }
  try {
    writeEvidenceFile(
      run,
      "INTERRUPTED.txt",
      redact(
        [
          `signal: ${signal}`,
          `at: ${new Date().toISOString()}`,
          ...notes,
          "",
          "Emergency cleanup only targeted this run's server, Workspace/preview processes, CI containers, staging directories and test root; it did not target user data or the reserved user port 3000.",
          "",
        ].join("\n"),
        run.secrets,
      ),
      0o600,
    );
  } catch {}
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => {
      if (signalHandling) return;
      signalHandling = true;
      const run = activeRun;
      if (!run) {
        const pending = pendingCleanup;
        if (pending) {
          void emergencyCleanupPending(pending, signal).finally(() => process.exit(code));
          return;
        }
        process.exit(code);
        return;
      }
      void emergencyCleanup(run, signal).finally(() => process.exit(code));
    });
  }
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${safeMessage(error)}`);
    console.error("Use --help for usage.");
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.dryRun) return printDryRun(options);

  // Install before prepareRun so SIGINT/SIGTERM cannot leave a half-created test
  // root behind. When no root exists yet, this is a no-op.
  installSignalHandlers();
  let run: RunState;
  try {
    run = prepareRun(options);
  } catch (error) {
    const pending = pendingCleanup;
    pendingCleanup = undefined;
    if (pending)
      await emergencyCleanupPending(pending, "prepare_failed");
    console.error(`Refusing to start: ${safeMessage(error)}`);
    return 2;
  }
  activeRun = run;
  pendingCleanup = undefined;
  const runner = new Runner(run);
  const runId = run.runId;
  const startedAt = new Date().toISOString();
  let evidencePath = "";
  let closure = false;
  let evidenceFailed = false;
  try {
    try {
      await startServer(run);
      await stepE00(run, runner);
    } catch (error) {
      run.blocked = "E00";
      run.steps.push({
        step: "E00",
        actor: "executor",
        operation: "server startup/health",
        status: "failed",
        error: {
          code: errorCode(error) ?? "startup_failed",
          message: clamp(redact(safeMessage(error), run.secrets), 1000),
        },
      });
    }
    await stepE01(run, runner);
    await stepE02(run, runner);
    await stepE03(run, runner);
    await stepE04(run, runner);
    await stepE05(run, runner);
    await stepE06(run, runner);
    await stepE07(run, runner);
    if (options.mode === "local-full") {
      await stepE08(run, runner);
      await stepE09(run, runner);
      await stepE10(run, runner);
      await stepE11(run, runner);
      await stepE12(run, runner);
      await stepE13(run, runner);
      await stepE14(run, runner);
    } else {
      skipStep(run, "E08", "dev", "real plan/code/worktree", "Skipped in macos-smoke; run local-full");
      skipStep(run, "E09", "owner", "files/Workspace API", "Skipped in macos-smoke; run local-full");
      skipStep(run, "E10", "preview", "real Preview environment", "Skipped in macos-smoke; run local-full");
      skipStep(run, "E11", "owner", "acceptPreview", "Skipped in macos-smoke; run local-full");
      skipStep(run, "E12", "reviewer", "recordVerification ci", "Skipped in macos-smoke; run local-full");
      skipStep(run, "E13", "reviewer", "recordVerification review", "Skipped in macos-smoke; run local-full");
      skipStep(run, "E14", "owner", "ready_merge", "Skipped in macos-smoke; run local-full");
    }
    await stepE15(run, runner);
    await stepE16(run, runner);
    if (options.mode === "local-full") await stepE17(run, runner);
    else skipStep(run, "E17", "owner+dev", "Agent explicit restart", "Skipped in macos-smoke; run local-full");
    await stepE18(run, runner);
  } finally {
    let cleanup: Evidence;
    try {
      cleanup = await cleanupRun(run);
    } catch (error) {
      cleanup = {
        step: "E19",
        actor: "verifier",
        operation: "cleanup and no-residue checks",
        status: "failed",
        error: {
          code: errorCode(error) ?? "cleanup_failed",
          message: clamp(redact(safeMessage(error), run.secrets), 1000),
        },
      };
    }
    run.steps.push(cleanup);
    const finishedAt = new Date().toISOString();
    try {
      const written = await writeEvidence(run, runner, {
        runId,
        startedAt,
        finishedAt,
      });
      evidencePath = written.reportPath;
      closure = written.closure;
    } catch (error) {
      console.error(`Evidence error: ${safeMessage(error)}`);
      evidenceFailed = true;
    }
    activeRun = undefined;
  }
  const failed = run.steps.some((evidence) => evidence.status === "failed");
  const skipped = run.steps.filter((evidence) => evidence.status === "skipped").length;
  console.log(`E2E ${options.mode} finished: closure=${closure ? "yes" : "no"}`);
  for (const evidence of run.steps)
    console.log(`  ${evidence.status.padEnd(9)} ${evidence.step} ${evidence.operation}`);
  console.log(`Evidence: ${evidencePath || run.evidenceDir}`);
  if (evidenceFailed || failed) return 1;
  if (options.mode === "local-full" && skipped > 0) return 1;
  return 0;
}

process.exitCode = await main();
