import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { arch, platform, tmpdir } from "node:os";
import pino from "pino";
import buildPinoRoll, { type PinoRollStream } from "pino-roll";
import { redactRuntimeMessage } from "./redaction";
import {
  sanitizeReadEntry,
  type DiagnosticEvent,
  type DiagnosticEventName,
} from "./diagnostic-events";

const DEFAULT_MAX_BYTES_PER_FILE = 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_LIMIT = 256;
const READ_LIMIT_DEFAULT = 50;
const READ_LIMIT_MAX = 200;
const DIAGNOSTICS_VERSION = 1;

export interface DiagnosticsOptions {
  enabled?: boolean;
  /** Absolute path or cwd-relative directory. Defaults to COMPANY_DIAGNOSTICS_DIR or <tmp>/company-factory. */
  dir?: string;
  sizeBytes?: number;
  maxFiles?: number;
  maxBufferBytes?: number;
  /** Mirror error-level records to stderr as already-redacted JSON lines. */
  stderr?: boolean;
  /** Allowlist native WASM stderr lines. Defaults to COMPANY_PERI_WASM_STDERR=1. */
  wasmStderr?: boolean;
  appName?: string;
}

export interface DiagnosticsStatus {
  enabled: boolean;
  dir?: string;
  file?: string;
  maxBytesPerFile: number;
  maxFiles: number;
  wasmEnabled: boolean;
  degraded: boolean;
  writeErrors: number;
  reason?: string;
}

export interface DiagnosticsReadResult {
  enabled: boolean;
  file: string | null;
  files: number;
  maxBytesPerFile: number;
  entries: Record<string, unknown>[];
  invalidLines: number;
  truncated: boolean;
}

export interface DiagnosticsSink {
  readonly enabled: boolean;
  readonly wasmEnabled: boolean;
  record(event: DiagnosticEvent): void;
  read(limit?: number): Promise<DiagnosticsReadResult>;
  status(): DiagnosticsStatus;
  flushSync(): void;
  close(): Promise<void>;
}

const emptyRead = (enabled: boolean, maxBytesPerFile = DEFAULT_MAX_BYTES_PER_FILE): DiagnosticsReadResult => ({
  enabled,
  file: null,
  files: 0,
  maxBytesPerFile,
  entries: [],
  invalidLines: 0,
  truncated: false,
});

/** Shared no-op sink used when diagnostics are disabled or initialization fails. */
export const disabledDiagnostics: DiagnosticsSink = {
  enabled: false,
  wasmEnabled: false,
  record() {},
  async read() {
    return emptyRead(false);
  },
  status() {
    return {
      enabled: false,
      maxBytesPerFile: DEFAULT_MAX_BYTES_PER_FILE,
      maxFiles: DEFAULT_MAX_FILES,
      wasmEnabled: false,
      degraded: false,
      writeErrors: 0,
    };
  },
  flushSync() {},
  async close() {},
};

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/** Pino options shared with the redaction regression test. */
export function diagnosticPinoOptions(
  bootId: string,
  appName = "company-factory",
): pino.LoggerOptions {
  return {
    level: "info",
    base: { app: appName, pid: process.pid, bootId },
    timestamp: pino.stdTimeFunctions.isoTime,
    depthLimit: 4,
    edgeLimit: 50,
    formatters: {
      level: (label, number) => ({ level: number, levelLabel: label }),
    },
    redact: {
      paths: [
        "message", "text", "*.message", "*.text",
        "authorization", "Authorization", "token", "accessToken",
        "access_token", "apiKey", "api_key", "apikey", "secret", "password",
        "passwd", "credential", "credentials", "ownerToken", "webToken",
        "authToken",
        "*.authorization", "*.Authorization", "*.token", "*.accessToken",
        "*.access_token", "*.apiKey", "*.api_key", "*.apikey", "*.secret",
        "*.password", "*.passwd", "*.credential", "*.credentials",
        "*.ownerToken", "*.webToken", "*.authToken",
        "*.headers.authorization", "*.headers.Authorization",
        "url", "baseUrl", "endpoint", "*.url", "*.baseUrl", "*.endpoint",
      ],
      censor: (value, path) => {
        const key = String(path[path.length - 1] ?? "");
        if (key === "message" || key === "text")
          return typeof value === "string"
            ? redactRuntimeMessage(value, 500)
            : "[redacted]";
        return "[redacted]";
      },
    },
    serializers: {
      err: (value: unknown) => {
        const error = value as { name?: unknown; code?: unknown; message?: unknown };
        return {
          type: typeof error?.name === "string" ? error.name : "Error",
          ...(typeof error?.code === "string" || typeof error?.code === "number"
            ? { code: error.code }
            : {}),
          message:
            typeof error?.message === "string"
              ? redactRuntimeMessage(error.message, 500)
              : "[redacted]",
        };
      },
    },
    hooks: {
      logMethod(this: pino.Logger, args, method) {
        // Last line of defense: every string argument is re-redacted.
        const mapped = args.map((arg) =>
          typeof arg === "string" ? redactRuntimeMessage(arg, 500) : arg,
        );
        return method.apply(this, mapped as Parameters<typeof method>);
      },
    },
  };
}

function stringField(value: unknown, limit = 200): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, limit)
    : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface NormalizedFailure {
  event: DiagnosticEventName;
  level: "info" | "error";
  fields: Record<string, unknown>;
}

function normalizeFailure(event: DiagnosticEvent): NormalizedFailure | null {
  switch (event.event) {
    case "agent_execution_failed": {
      if (typeof event.message !== "string" || !event.message.trim())
        return null;
      const fields: Record<string, unknown> = {
        message: redactRuntimeMessage(event.message, 500),
      };
      const companyId = stringField(event.companyId);
      const agentId = stringField(event.agentId);
      const sessionId = stringField(event.sessionId);
      const chatId = stringField(event.chatId);
      const bindingRevision = numberField(event.bindingRevision);
      const eventId = stringField(event.eventId);
      const turnId = stringField(event.turnId);
      const stopReason = stringField(event.stopReason);
      if (companyId) fields.companyId = companyId;
      if (agentId) fields.agentId = agentId;
      if (sessionId) fields.sessionId = sessionId;
      if (chatId) fields.chatId = chatId;
      if (bindingRevision !== undefined) fields.bindingRevision = bindingRevision;
      if (eventId) fields.eventId = eventId;
      if (turnId) fields.turnId = turnId;
      if (stopReason) fields.stopReason = stopReason;
      return { event: event.event, level: "error", fields };
    }
    case "wasm_stderr": {
      const pattern = stringField(event.pattern);
      const text =
        typeof event.text === "string"
          ? redactRuntimeMessage(event.text, 500)
          : undefined;
      if (!pattern || !text) return null;
      const fields: Record<string, unknown> = { pattern, text };
      const companyId = stringField(event.companyId);
      const agentId = stringField(event.agentId);
      if (companyId) fields.companyId = companyId;
      if (agentId) fields.agentId = agentId;
      if (event.truncated === true) fields.truncated = true;
      return { event: event.event, level: "error", fields };
    }
    case "chat_action_failed": {
      const fields: Record<string, unknown> = {};
      const strings: Array<[string, unknown]> = [
        ["companyId", event.companyId],
        ["agentId", event.agentId],
        ["chatId", event.chatId],
        ["op", event.op],
        ["requestId", event.requestId],
        ["errorName", event.errorName],
        ["generation", event.generation],
        ["snapshotSessionId", event.snapshotSessionId],
        ["activeRequestId", event.activeRequestId],
      ];
      for (const [key, value] of strings) {
        const scalar = stringField(value);
        if (scalar) fields[key] = scalar;
      }
      if (typeof event.code === "string") fields.code = event.code.slice(0, 200);
      else if (numberField(event.code) !== undefined) fields.code = event.code;
      if (typeof event.message === "string" && event.message.trim())
        fields.message = redactRuntimeMessage(event.message, 500);
      if (typeof event.rejected === "boolean") fields.rejected = event.rejected;
      const revision = numberField(event.revision);
      if (revision !== undefined) fields.revision = revision;
      const itemCount = numberField(event.itemCount);
      if (itemCount !== undefined) fields.itemCount = itemCount;
      if (!fields.message && fields.code === undefined) return null;
      return { event: event.event, level: "error", fields };
    }
    default:
      return null;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function dedupeKeyFor(
  event: DiagnosticEventName,
  fields: Record<string, unknown>,
): string | null {
  if (event === "agent_execution_failed") {
    const eventId = stringField(fields.eventId);
    if (eventId) return `notice:${eventId}`;
    return `notice:${hash(String(fields.message ?? ""))}`;
  }
  if (event === "wasm_stderr")
    return `wasm:${String(fields.pattern ?? "")}:${String(fields.text ?? "")}`;
  if (event === "chat_action_failed") {
    const chatId = stringField(fields.chatId);
    const requestId = stringField(fields.requestId);
    if (chatId && requestId) return `chat-action:${chatId}:${requestId}`;
    return `chat-action:${hash(
      `${String(fields.op ?? "")}|${String(fields.code ?? "")}|${String(fields.message ?? "")}`,
    )}`;
  }
  return null;
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stats = await lstat(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error("diagnostics path is not a directory");
  if (
    typeof process.getuid === "function" &&
    stats.uid !== process.getuid()
  )
    throw new Error("diagnostics directory is not owned by the current user");
  await chmod(dir, 0o700);
}

async function waitForReady(stream: PinoRollStream): Promise<void> {
  if (typeof stream.fd === "number" && stream.fd >= 0) return;
  await new Promise<void>((resolveReady) => {
    const timer = setTimeout(finish, 2000);
    function finish() {
      clearTimeout(timer);
      stream.off("ready", finish);
      resolveReady();
    }
    stream.once("ready", finish);
  });
}

async function runtimeFiles(dir: string): Promise<Array<{ path: string; number: number }>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: Array<{ path: string; number: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^runtime\.(\d+)\.jsonl$/.exec(entry.name);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number)) continue;
    files.push({ path: join(dir, entry.name), number });
  }
  return files.sort((a, b) => b.number - a.number);
}

interface FailureState {
  degraded: boolean;
  writeErrors: number;
}

class PinoDiagnosticsSink implements DiagnosticsSink {
  readonly enabled = true;
  readonly wasmEnabled: boolean;
  private closed = false;
  private dedupe = new Map<string, number>();
  private readonly onExit = () => this.flushSync();

  constructor(
    private readonly logger: pino.Logger,
    private readonly destination: PinoRollStream,
    private readonly dir: string,
    readonly maxBytesPerFile: number,
    readonly maxFiles: number,
    wasmEnabled: boolean,
    private readonly failureState: FailureState,
  ) {
    this.wasmEnabled = wasmEnabled;
    process.once("exit", this.onExit);
  }

  record(event: DiagnosticEvent): void {
    if (this.closed) return;
    try {
      const normalized = normalizeFailure(event);
      if (!normalized) return;
      const key = dedupeKeyFor(normalized.event, normalized.fields);
      if (key && !this.shouldEmit(key)) return;
      this.logger.error(normalized.fields, normalized.event);
    } catch {
      this.failureState.writeErrors += 1;
      this.failureState.degraded = true;
    }
  }

  private shouldEmit(key: string): boolean {
    const now = Date.now();
    const prior = this.dedupe.get(key);
    if (prior !== undefined && now - prior < DEDUPE_WINDOW_MS) return false;
    if (prior !== undefined) this.dedupe.delete(key);
    this.dedupe.set(key, now);
    while (this.dedupe.size > DEDUPE_LIMIT) {
      const oldest = this.dedupe.keys().next().value;
      if (oldest === undefined) break;
      this.dedupe.delete(oldest);
    }
    return true;
  }

  async read(limit = READ_LIMIT_DEFAULT): Promise<DiagnosticsReadResult> {
    const capped = Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit, 1), READ_LIMIT_MAX)
      : READ_LIMIT_DEFAULT;
    if (this.closed) return emptyRead(false, this.maxBytesPerFile);
    this.flushSync();
    let files: Array<{ path: string; number: number }> = [];
    try {
      files = await runtimeFiles(this.dir);
    } catch {
      files = [];
    }
    let entries: Record<string, unknown>[] = [];
    let invalidLines = 0;
    let truncated = false;
    for (let index = 0; index < files.length; index += 1) {
      if (entries.length >= capped) {
        truncated = true;
        break;
      }
      let text: string;
      try {
        text = await readFile(files[index].path, "utf8");
      } catch {
        continue;
      }
      const fileEntries: Record<string, unknown>[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          invalidLines += 1;
          continue;
        }
        const sanitized = sanitizeReadEntry(parsed);
        if (!sanitized) {
          invalidLines += 1;
          continue;
        }
        fileEntries.push(sanitized);
      }
      entries = fileEntries.concat(entries);
      if (entries.length > capped) {
        entries = entries.slice(entries.length - capped);
        truncated = true;
      }
    }
    entries.sort((a, b) =>
      String(a.time ?? "").localeCompare(String(b.time ?? "")),
    );
    return {
      enabled: true,
      file: files[0]?.path ?? null,
      files: files.length,
      maxBytesPerFile: this.maxBytesPerFile,
      entries,
      invalidLines,
      truncated,
    };
  }

  status(): DiagnosticsStatus {
    return {
      enabled: !this.closed,
      dir: this.dir,
      file: this.destination.file,
      maxBytesPerFile: this.maxBytesPerFile,
      maxFiles: this.maxFiles,
      wasmEnabled: this.wasmEnabled,
      degraded: this.failureState.degraded,
      writeErrors: this.failureState.writeErrors,
    };
  }

  flushSync(): void {
    if (this.closed) return;
    try {
      this.destination.flushSync();
    } catch {
      // fd may still be opening, or the destination may be closing.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    process.removeListener("exit", this.onExit);
    try {
      this.logger.flush();
    } catch {
      // best effort
    }
    try {
      this.destination.flushSync();
    } catch {
      // best effort
    }
    await new Promise<void>((resolveClose) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveClose();
      };
      const timer = setTimeout(finish, 1000);
      this.destination.once("close", finish);
      try {
        this.destination.end();
      } catch {
        finish();
      }
    });
  }
}

function writeProcessStart(
  logger: pino.Logger,
  retention: { maxBytesPerFile: number; maxFiles: number },
): void {
  // Emitted exactly once per process by openRuntimeDiagnostics.
  logger.info(
    {
      ppid: process.ppid,
      startedAt: new Date().toISOString(),
      platform: platform(),
      arch: arch(),
      bunVersion:
        (process.versions as { bun?: string }).bun ?? process.version,
      diagnosticsVersion: DIAGNOSTICS_VERSION,
      retention,
    },
    "process_start",
  );
}

/**
 * Open the process-wide diagnostics sink. This function never throws: any
 * initialization failure yields the shared disabled sink so server startup and
 * request handling are unaffected.
 */
export async function openRuntimeDiagnostics(
  options: DiagnosticsOptions = {},
): Promise<DiagnosticsSink> {
  if (options.enabled === false) return disabledDiagnostics;

  const maxBytesPerFile = positiveInteger(
    options.sizeBytes,
    DEFAULT_MAX_BYTES_PER_FILE,
  );
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
  const maxBufferBytes = positiveInteger(
    options.maxBufferBytes,
    DEFAULT_MAX_BUFFER_BYTES,
  );
  const wasmEnabled =
    options.wasmStderr ?? process.env.COMPANY_PERI_WASM_STDERR === "1";
  const stderr = options.stderr ?? process.env.COMPANY_DIAGNOSTICS_STDERR === "1";
  const appName = options.appName ?? "company-factory";
  const requestedDir =
    options.dir ??
    process.env.COMPANY_DIAGNOSTICS_DIR ??
    join(tmpdir(), "company-factory");
  const dir = resolve(requestedDir);

  let destination: PinoRollStream | undefined;
  let logger: pino.Logger | undefined;
  const failureState: FailureState = { degraded: false, writeErrors: 0 };
  try {
    await ensurePrivateDirectory(dir);
    destination = await buildPinoRoll({
      file: join(dir, "runtime.jsonl"),
      size: `${maxBytesPerFile}b`,
      limit: { count: maxFiles, removeOtherLogFiles: true },
      symlink: true,
      mode: 0o600,
      append: true,
      mkdir: false,
      minLength: 0,
      maxLength: maxBufferBytes,
      fsync: false,
    });
    // Rotation/cleanup errors are asynchronous. They must never become an
    // unhandled EventEmitter error or crash the server.
    destination.on("error", () => {
      failureState.degraded = true;
    });
    await waitForReady(destination);
    await chmod(destination.file, 0o600);

    const bootId = randomUUID();
    const pinoOptions = diagnosticPinoOptions(bootId, appName);
    const stream = stderr
      ? pino.multistream([
          { stream: destination as unknown as pino.DestinationStream },
          { level: "error", stream: process.stderr },
        ])
      : (destination as unknown as pino.DestinationStream);
    logger = pino(pinoOptions, stream);
  } catch {
    try {
      destination?.destroy();
    } catch {
      // best effort
    }
    return disabledDiagnostics;
  }

  const sink = new PinoDiagnosticsSink(
    logger,
    destination,
    dir,
    maxBytesPerFile,
    maxFiles,
    wasmEnabled,
    failureState,
  );
  try {
    writeProcessStart(logger, { maxBytesPerFile, maxFiles });
  } catch {
    // process_start is best effort; the sink is still usable.
  }
  return sink;
}