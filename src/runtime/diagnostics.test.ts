import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import {
  diagnosticPinoOptions,
  openRuntimeDiagnostics,
  type DiagnosticsOptions,
  type DiagnosticsSink,
} from "./diagnostics";

const dirs: string[] = [];
const sinks: DiagnosticsSink[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "company-diagnostics-"));
  dirs.push(dir);
  return dir;
}

async function open(
  dir: string,
  extra: Partial<DiagnosticsOptions> = {},
) {
  const sink = await openRuntimeDiagnostics({
    dir,
    enabled: true,
    sizeBytes: 1024 * 1024,
    maxFiles: 3,
    maxBufferBytes: 4 * 1024 * 1024,
    ...extra,
  });
  sinks.push(sink);
  return sink;
}

afterEach(async () => {
  for (const sink of sinks.splice(0)) await sink.close().catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("runtime diagnostics sink", () => {
  test("creates a 0700 directory, 0600 JSONL file and stable symlink", async () => {
    const dir = await tempDir();
    const sink = await open(dir);
    expect(sink.enabled).toBe(true);
    const status = sink.status();
    expect(status.file).toBeTruthy();
    expect(status.file!.endsWith(".jsonl")).toBe(true);
    expect(/runtime\.\d+\.jsonl$/.test(status.file!)).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await lstat(status.file!)).mode & 0o777).toBe(0o600);
    const link = await lstat(join(dir, "current.log"));
    expect(link.isSymbolicLink()).toBe(true);
    sink.record({
      event: "agent_execution_failed",
      companyId: "company-1",
      agentId: "agent-1",
      sessionId: "session-1",
      chatId: "chat-1",
      bindingRevision: 2,
      eventId: "notice-1",
      message: "failed at https://host.example/x?token=secret with 0123456789abcdef0123456789abcdef",
    });
    const read = await sink.read(50);
    const failure = read.entries.find((entry) => entry.event === "agent_execution_failed")!;
    expect(failure.message).toContain("[url]");
    expect(failure.message).toContain("[redacted]");
    expect(JSON.stringify(failure)).not.toContain("host.example");
    expect(failure.sessionId).toBe("session-1");
    expect(failure.bindingRevision).toBe(2);
    const raw = await readFile(status.file!, "utf8");
    expect(raw).not.toContain("host.example");
    expect(raw.split("\n").filter((line) => line.includes("agent_execution_failed")).length).toBe(1);
  });

  test("deduplicates the same notice and wasm line within the window", async () => {
    const dir = await tempDir();
    const sink = await open(dir);
    for (let index = 0; index < 3; index += 1) {
      sink.record({
        event: "agent_execution_failed",
        eventId: "notice-repeat",
        message: "Conversation persistence failed",
      });
      sink.record({
        event: "wasm_stderr",
        companyId: "company-1",
        agentId: "agent-1",
        pattern: "append_history_failed",
        text: "append_history failed: database is locked",
      });
    }
    const read = await sink.read(50);
    const notices = read.entries.filter((entry) => entry.event === "agent_execution_failed");
    const wasm = read.entries.filter((entry) => entry.event === "wasm_stderr");
    expect(notices).toHaveLength(1);
    expect(wasm).toHaveLength(1);
    expect(read.entries.filter((entry) => entry.event === "process_start")).toHaveLength(1);
  });

  test("records, redacts and deduplicates IM delivery failures per attempt", async () => {
    const dir = await tempDir();
    const sink = await open(dir);
    for (let index = 0; index < 2; index += 1)
      sink.record({
        event: "im_delivery_failed",
        companyId: "company-1",
        agentId: "agent-1",
        messageId: "M1",
        threadId: "T1",
        attempt: 1,
        code: "prompt_failed",
        disposition: "unknown",
        uncertain: true,
        message:
          "delivery failed at https://host.example/x?token=secret with 0123456789abcdef0123456789abcdef",
      });
    sink.record({
      event: "im_delivery_failed",
      companyId: "company-1",
      agentId: "agent-1",
      messageId: "M1",
      threadId: "T1",
      attempt: 2,
      code: "session_initialization_failed",
      disposition: "not_sent",
      uncertain: false,
      message: "second attempt",
    });
    const read = await sink.read(50);
    const failures = read.entries.filter(
      (entry) => entry.event === "im_delivery_failed",
    );
    expect(failures).toHaveLength(2);
    const first = failures.find((entry) => entry.attempt === 1)!;
    expect(first).toMatchObject({
      companyId: "company-1",
      agentId: "agent-1",
      messageId: "M1",
      threadId: "T1",
      code: "prompt_failed",
      disposition: "unknown",
      uncertain: true,
    });
    expect(first.message).toContain("[url]");
    expect(first.message).toContain("[redacted]");
    expect(JSON.stringify(failures)).not.toContain("host.example");
    expect(JSON.stringify(failures)).not.toContain("0123456789abcdef");
    const raw = await readFile(sink.status().file!, "utf8");
    expect(raw).not.toContain("host.example");
    expect(
      raw.split("\n").filter((line) => line.includes("im_delivery_failed")),
    ).toHaveLength(2);
  });

  test("rotates by size, keeps at most maxFiles+1 transient files and bounded bytes", async () => {
    const dir = await tempDir();
    const sink = await open(dir, {
      sizeBytes: 4096,
      maxFiles: 3,
      maxBufferBytes: 4 * 1024 * 1024,
    });
    for (let batch = 0; batch < 10; batch += 1) {
      for (let index = 0; index < 30; index += 1) {
        sink.record({
          event: "agent_execution_failed",
          eventId: `rotate-${batch}-${index}`,
          message: `rotation payload ${batch}-${index} ${"z".repeat(300)}`,
        });
      }
      await Bun.sleep(40);
    }
    sink.flushSync();
    await Bun.sleep(250);
    const files = (await readdir(dir)).filter((name) => /^runtime\.\d+\.jsonl$/.test(name));
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.length).toBeLessThanOrEqual(4);
    let total = 0;
    for (const file of files) {
      const fileStats = await stat(join(dir, file));
      expect(fileStats.mode & 0o777).toBe(0o600);
      total += fileStats.size;
    }
    expect(total).toBeLessThanOrEqual(5 * 1024 * 1024);
    const read = await sink.read(200);
    expect(read.files).toBeGreaterThanOrEqual(2);
    expect(read.entries.length).toBeGreaterThan(0);
    expect(read.entries.length).toBeLessThanOrEqual(200);
  });

  test("appends across restart and distinguishes boots by bootId", async () => {
    const dir = await tempDir();
    const first = await open(dir);
    first.record({
      event: "agent_execution_failed",
      eventId: "restart-notice",
      message: "before restart",
    });
    const firstRead = await first.read(50);
    const firstBoot = firstRead.entries.find((entry) => entry.event === "process_start")!.bootId;
    await first.close();
    sinks.splice(sinks.indexOf(first), 1);

    const second = await open(dir);
    const secondRead = await second.read(50);
    const boots = new Set(
      secondRead.entries
        .filter((entry) => entry.event === "process_start")
        .map((entry) => entry.bootId),
    );
    expect(boots.size).toBe(2);
    expect(boots.has(firstBoot as string)).toBe(true);
    expect(
      secondRead.entries.some(
        (entry) => entry.event === "agent_execution_failed" && entry.message === "before restart",
      ),
    ).toBe(true);
  });

  test("pino redaction and logMethod redact object fields and strings", async () => {
    const chunks: string[] = [];
    const logger = pino(diagnosticPinoOptions("boot-test"), {
      write(chunk: string) {
        chunks.push(chunk);
      },
    });
    logger.error(
      {
        token: "SECRET_TOKEN",
        nested: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
        message:
          "https://host.example/v1 0123456789abcdef0123456789abcdef",
      },
      "agent_execution_failed",
    );
    const line = JSON.parse(chunks.join("").trim());
    expect(line.token).toBe("[redacted]");
    expect(line.nested.authorization).toBe("[redacted]");
    expect(line.message).toContain("[url]");
    expect(line.message).toContain("[redacted]");
    expect(JSON.stringify(line)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(line)).not.toContain("host.example");
  });

  test("initialization failure degrades to a no-op sink without throwing", async () => {
    const dir = await tempDir();
    const file = join(dir, "not-a-directory");
    await writeFile(file, "x");
    const sink = await openRuntimeDiagnostics({ dir: file, enabled: true });
    sinks.push(sink);
    expect(sink.enabled).toBe(false);
    expect(sink.status().enabled).toBe(false);
    expect(() =>
      sink.record({ event: "agent_execution_failed", message: "ignored" }),
    ).not.toThrow();
    const read = await sink.read();
    expect(read.enabled).toBe(false);
    expect(read.entries).toEqual([]);
  });

  test("read sanitizes forged lines and reports invalid JSON", async () => {
    const dir = await tempDir();
    const sink = await open(dir);
    const file = sink.status().file!;
    const forged = JSON.stringify({
      level: 50,
      time: "2026-11-02T00:00:00.000Z",
      msg: "agent_execution_failed",
      bootId: "boot-forged",
      message: "forged https://forged.example/x",
      items: [{ content: "SECRET_CONTENT" }],
      token: "SECRET_TOKEN",
    });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, `${forged}\nnot-json\n`);
    const read = await sink.read(50);
    expect(read.invalidLines).toBe(1);
    const entry = read.entries.find((value) => value.message === "forged [url]")!;
    expect(entry).toBeTruthy();
    const serialized = JSON.stringify(read.entries);
    expect(serialized).not.toContain("SECRET_CONTENT");
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("items");
  });
});
