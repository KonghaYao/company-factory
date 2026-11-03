import { describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_MEMORY_MAX_BYTES, applyAgentMemory, prepareAgentMemory, readAgentMemory } from "./agent-memory";
import { COLLEAGUE_TRUST_GUIDANCE, COMPANY_ASSETS_GUIDANCE, DECISION_GUIDANCE, MULTI_PERSON_GUIDANCE, TASK_PROGRESS_GUIDANCE } from "./templates";

describe("Agent memory host reads", () => {
  for (const name of ["CLAUDE.md", "claude.md"]) {
    test(`rejects a linked ${name} before reading its target`, async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-memory-test-"));
      try {
        const directory = join(root, "agent");
        await mkdir(directory);
        const otherNote = join(root, "other-note.md");
        await writeFile(otherNote, "ordinary external test note");
        await symlink(otherNote, join(directory, name));
        let writes = 0;
        await expect(applyAgentMemory({ atomic: async () => { writes++; } }, {
          directory, knowledgeDirectory: root, name: "Agent", role: "developer", responsibilities: "Work",
        })).rejects.toMatchObject({ code: "unsafe_agent_memory", status: 409 });
        expect(writes).toBe(0);
        expect(await readFile(otherNote, "utf8")).toBe("ordinary external test note");
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }

  test("rejects hard links and directories without consuming them as memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-memory-test-"));
    try {
      const memory = join(root, "CLAUDE.md");
      await writeFile(join(root, "notes.md"), "ordinary test note");
      await link(join(root, "notes.md"), memory);
      await expect(readAgentMemory(root)).rejects.toMatchObject({ code: "unsafe_agent_memory" });
      await rm(memory);
      await mkdir(memory);
      await expect(readAgentMemory(root)).rejects.toMatchObject({ code: "unsafe_agent_memory" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("bounds reads and rejects invalid text rather than rewriting it with replacement characters", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-memory-test-"));
    try {
      const memory = join(root, "CLAUDE.md");
      await writeFile(memory, "");
      await truncate(memory, AGENT_MEMORY_MAX_BYTES + 1);
      await expect(readAgentMemory(root)).rejects.toMatchObject({ code: "agent_memory_too_large" });
      await writeFile(memory, Buffer.from([0xff, 0xfe]));
      await expect(readAgentMemory(root)).rejects.toMatchObject({ code: "invalid_document" });
      await writeFile(memory, "中文自由记忆\n");
      expect((await readAgentMemory(root))?.content).toBe("中文自由记忆\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("replaces only the managed block with the current guidance and stays idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-memory-test-"));
    try {
      const memory = join(root, "CLAUDE.md");
      await writeFile(memory, [
        "FREE_BEFORE",
        "<!-- company:profile:start -->",
        "# Company profile (host-managed)",
        "",
        "## Role",
        "developer",
        "<!-- company:profile:end -->",
        "FREE_AFTER",
      ].join("\n"));
      const profile = {
        directory: root,
        knowledgeDirectory: join(root, "companys", "acme", "knowledgebase"),
        name: "Developer",
        role: "developer",
        responsibilities: "Work",
      };
      const prepared = await prepareAgentMemory(profile);
      expect(prepared.content).toContain("FREE_BEFORE");
      expect(prepared.content).toContain("FREE_AFTER");
      expect(prepared.content).toContain("## Colleague trust");
      expect(prepared.content).toContain(COLLEAGUE_TRUST_GUIDANCE);
      expect(prepared.content).toContain("无条件信任");
      expect(prepared.content).toContain("不要重复核对");
      expect(prepared.content).toContain("只检查存疑");
      expect(prepared.content).toContain("## Multi-person tasks");
      expect(prepared.content).toContain(MULTI_PERSON_GUIDANCE);
      expect(prepared.content).toContain("以 Company Issue 为中心");
      expect(prepared.content).toContain("写明 Issue ID");
      expect(prepared.content).toContain("登记过程");
      expect(prepared.content).toContain("## Task progress");
      expect(prepared.content).toContain(TASK_PROGRESS_GUIDANCE);
      expect(prepared.content).toContain("## Decisions");
      expect(prepared.content).toContain(DECISION_GUIDANCE);
      expect(prepared.content).toContain("askDecision");
      expect(prepared.content).toContain("2–6");
      expect(prepared.content).toContain("## Company assets");
      expect(prepared.content).toContain(COMPANY_ASSETS_GUIDANCE);
      expect(prepared.content.indexOf("## Multitasking")).toBeLessThan(
        prepared.content.indexOf("## Colleague trust"),
      );
      expect(prepared.content.indexOf("## Colleague trust")).toBeLessThan(
        prepared.content.indexOf("## Multi-person tasks"),
      );
      expect(prepared.content.indexOf("## Multi-person tasks")).toBeLessThan(
        prepared.content.indexOf("## Task progress"),
      );
      expect(prepared.content.indexOf("## Task progress")).toBeLessThan(
        prepared.content.indexOf("## Decisions"),
      );
      expect(prepared.content.indexOf("## Decisions")).toBeLessThan(
        prepared.content.indexOf("## Company assets"),
      );

      await applyAgentMemory(
        { atomic: async (path, content) => writeFile(path, content, "utf8") },
        profile,
      );
      const first = await readFile(memory, "utf8");
      expect(first).toBe(prepared.content);
      expect(await prepareAgentMemory(profile)).toEqual({
        content: first,
        legacy: false,
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
