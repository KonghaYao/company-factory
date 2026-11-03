import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSkillMeta, scanSkillsDir } from "@peri-code/mcpp/skills";

const skillsDirectory = join(import.meta.dir, "..", "templates", "skills");
const skillFile = join(skillsDirectory, "company-assets", "SKILL.md");

describe("company-assets skill template", () => {
  test("is a valid MCP skill entry with non-empty metadata", async () => {
    const metas = await scanSkillsDir(skillsDirectory);
    expect(metas.map((meta) => meta.name)).toEqual(["company-assets"]);
    const meta = await readSkillMeta(skillsDirectory, "company-assets");
    expect(meta).toBeDefined();
    expect(meta!.name).toBe("company-assets");
    expect(meta!.description?.trim()).toBeTruthy();
    expect(meta!.uri).toContain("skill://company-assets/SKILL.md");
  });

  test("documents classification, authoritative interfaces and non-permissions", async () => {
    const text = await readFile(skillFile, "utf8");
    for (const expected of [
      "skill://company-assets/SKILL.md",
      "mcp_read_resource",
      "company_org",
      "company_tasks",
      "company_im",
      "knowledgebase/",
      "# Company assets",
      "## 2. The boundary",
      "## 3. Decision order",
      "## 5. Company shared knowledge",
      "## 8. Host secrets",
      "## 9. Conflict, idempotency, evidence",
      "## 11. Anti-patterns and examples",
      "## 12. Non-permissions",
      "不是 OS ACL",
    ])
      expect(text).toContain(expected);
    expect(text).not.toContain(".claude/skills");
    expect(text).not.toContain("install-agent-skills");
  });

  test("is UTF-8 without BOM, below the 64 KiB resource budget and contains no secret-shaped values", async () => {
    const bytes = await readFile(skillFile);
    expect(bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(text.includes("\uFFFD")).toBe(false);
    expect(text).not.toMatch(/\bsk-[A-Za-z0-9]{20,}\b/);
    expect(text).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{20,}\b/);
    expect(text).not.toMatch(/\b[0-9a-fA-F]{40,}\b/);
  });
});
