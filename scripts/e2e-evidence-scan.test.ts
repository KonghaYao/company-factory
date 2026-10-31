import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanEvidenceDirectory, textHasSecret } from "./e2e-evidence-scan";

const roots: string[] = [];
function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "cf-evidence-scan."));
  roots.push(path);
  return path;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("evidence secret scan", () => {
  test("detects secret-shaped values but ignores bare variable names", () => {
    expect(textHasSecret("PERI_MODEL_API_KEY=[VALUE-REDACTED]", [])).toBe(false);
    expect(textHasSecret("grep -E 'Bearer |PERI_MODEL_API_KEY|owner-token'", [])).toBe(
      false,
    );
    expect(textHasSecret("PERI_MODEL_API_KEY=abcdefgh12345678", [])).toBe(true);
    expect(textHasSecret("company_session=abcdefgh12345678", [])).toBe(true);
    expect(textHasSecret("sk-abcdefghijklmnopqrstuvwx", [])).toBe(true);
    expect(textHasSecret("token=supersecretvalue", ["supersecretvalue"])).toBe(true);
  });

  test("scans every file, including git-log.txt and versions.txt", () => {
    const root = tempRoot();
    const evidence = join(root, "evidence");
    mkdirSync(join(evidence, "http"), { recursive: true });
    writeFileSync(join(evidence, "git-log.txt"), "clean commit\n");
    writeFileSync(join(evidence, "versions.txt"), "bun=1.0.0\n");
    writeFileSync(join(evidence, "http", "E01.json"), "{}\n");
    writeFileSync(join(evidence, "cleanup.txt"), "grep -E 'Bearer |owner-token'\n");
    const clean = scanEvidenceDirectory({
      directory: evidence,
      secrets: ["synthetic-owner-token-value"],
      maxBytes: 2 * 1024 * 1024,
    });
    expect(clean.rejected).toEqual([]);
    expect(clean.scanned).toBe(4);

    writeFileSync(join(evidence, "versions.txt"), "bun=1.0.0\nsk-abcdefghijklmnopqrstuvwx\n");
    const dirty = scanEvidenceDirectory({
      directory: evidence,
      secrets: [],
      maxBytes: 2 * 1024 * 1024,
    });
    expect(dirty.rejected).toEqual(["versions.txt"]);

    writeFileSync(join(evidence, "versions.txt"), "bun=1.0.0\n");
    writeFileSync(join(evidence, "git-log.txt"), "commit synthetic-owner-token-value\n");
    const secretValue = scanEvidenceDirectory({
      directory: evidence,
      secrets: ["synthetic-owner-token-value"],
      maxBytes: 2 * 1024 * 1024,
    });
    expect(secretValue.rejected).toEqual(["git-log.txt"]);
  });
});
