import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSkillMeta } from "@peri-code/mcpp/skills";

const skillsDirectory = join(import.meta.dir, "..", "templates", "skills");
const skillFile = join(skillsDirectory, "interview", "SKILL.md");

describe("interview skill template", () => {
  test("is a valid shared skill entry", async () => {
    const meta = await readSkillMeta(skillsDirectory, "interview");
    expect(meta).toBeDefined();
    expect(meta!.name).toBe("interview");
    expect(meta!.description).toContain("Interview");
    expect(meta!.uri).toContain("skill://interview/SKILL.md");
  });

  test("turns a rough request into executable Company Issues without a separate approval step", async () => {
    const text = await readFile(skillFile, "utf8");
    for (const expected of [
      "# Interview",
      "company_org.organization",
      "company_tasks.searchIssues",
      "Company Issues",
      "assigneeAgentId",
      "（推荐）",
      "不要进入 plan mode",
      "do not wait for a separate approval step",
      "already executable",
      "one self-contained question",
      "leadPersonId",
      "reversible defaults",
    ])
      expect(text).toContain(expected);
    expect(text).not.toContain("$ARGUMENTS");
    expect(text).not.toContain("AskUserQuestionTool");
    expect(text).not.toContain(".claude/skills");
    expect(text).not.toContain("task supervisor");
    expect(text).not.toContain("逐题澄清");
    expect(text).not.toContain("Interview in detail");
    expect(text).not.toContain("Every question MUST have a recommended option");
  });

  test("is UTF-8, below the resource budget and contains no secret-shaped values", async () => {
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
