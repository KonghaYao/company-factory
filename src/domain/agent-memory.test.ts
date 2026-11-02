import { describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_MEMORY_MAX_BYTES, applyAgentMemory, readAgentMemory } from "./agent-memory";

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
});
