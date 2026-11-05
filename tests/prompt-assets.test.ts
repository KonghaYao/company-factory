import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const promptsDirectory = join(import.meta.dir, "..", "templates", "prompts");

const EXPECTED_ASSETS = [
  "common.md",
  "communication.md",
  "roles/colleague.md",
  "roles/coordinator.md",
  "roles/executor.md",
  "roles/hr.md",
  "roles/preview.md",
  "roles/reviewer.md",
  "roles/secretary.md",
  "stable.md",
  "task-contract.md",
].sort();

async function readManifest(): Promise<Record<string, string>> {
  return JSON.parse(
    await readFile(join(promptsDirectory, "manifest.json"), "utf8"),
  );
}

describe("authoritative prompt assets", () => {
  test("the manifest lists exactly the 11 package prompts", async () => {
    const manifest = await readManifest();
    expect(Object.keys(manifest).sort()).toEqual(EXPECTED_ASSETS);
    const files = (await readdir(promptsDirectory, { recursive: true }))
      .map((entry) => entry.replaceAll("\\", "/"))
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    expect(files).toEqual(EXPECTED_ASSETS);
  });

  test("every asset matches the manifest sha256 byte-for-byte", async () => {
    const manifest = await readManifest();
    for (const [relativePath, expected] of Object.entries(manifest)) {
      const bytes = await readFile(join(promptsDirectory, relativePath));
      const actual = createHash("sha256").update(bytes).digest("hex");
      expect(actual, relativePath).toBe(expected);
    }
  });

  test("every asset is UTF-8 without BOM, CRLF or a missing final newline", async () => {
    for (const relativePath of EXPECTED_ASSETS) {
      const bytes = await readFile(join(promptsDirectory, relativePath));
      expect([...bytes.subarray(0, 3)], relativePath).not.toEqual([
        0xef, 0xbb, 0xbf,
      ]);
      expect(bytes.includes(0x0d), relativePath).toBe(false);
      expect(bytes.at(-1), relativePath).toBe(0x0a);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      expect(text.includes("\uFFFD"), relativePath).toBe(false);
    }
  });

  test("does not vendor the package evidence directory", async () => {
    const entries = await readdir(promptsDirectory, { recursive: true });
    expect(entries.some((entry) => entry.includes("evidence"))).toBe(false);
  });

  test("message.schema.json carries the v2 six-kind protocol", async () => {
    const schema = JSON.parse(
      await readFile(join(promptsDirectory, "message.schema.json"), "utf8"),
    );
    expect(schema.title).toContain("Company IM message");
    expect(schema.required).toEqual(["v", "kind", "task", "summary"]);
    expect(schema.properties.v.const).toBe(2);
    expect(schema.properties.kind.enum).toEqual([
      "request",
      "accept",
      "blocked",
      "result",
      "decision",
      "info",
    ]);
    expect(schema.properties.task.anyOf.map((item: any) => item.type)).toEqual([
      "null",
      "object",
    ]);
    expect(schema.properties.task.anyOf[1].required).toEqual([
      "id",
      "owner",
      "version",
    ]);
    expect(schema.properties.request_ref.type).toEqual(["string", "null"]);
    expect(schema.description).toContain("does not grant authority");
  });
});
