import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateAgentMemories } from "./migrate-agent-memory";

describe("agent memory migration", () => {
  let root: string;
  let conflictVisible = false;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-memory-migration-"));
    for (const [agentId, extra] of [
      ["legacy-dev", ""],
      ["conflict-dev", ""],
    ] as const) {
      const directory = join(root, "agents", agentId);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "agent.yaml"),
        `agentId: ${agentId}\nrole: developer\nresponsibilities: Build ${agentId}\nsystemPrompt: Verify ${agentId}\nconfig:\n  instructions: Follow ${agentId}\n`,
      );
      await writeFile(
        join(directory, "claude.md"),
        `FREE_LEGACY_${agentId}\n${extra}`,
      );
      if (agentId === "conflict-dev")
        await writeFile(join(directory, "CLAUDE.md"), "EXISTING_UPPER\n");
    }
    // APFS is case-insensitive: the two names can be the same entry. The
    // conflict branch is still meaningful on case-sensitive filesystems.
    const entries = await readdir(join(root, "agents", "conflict-dev"));
    conflictVisible =
      entries.includes("CLAUDE.md") && entries.includes("claude.md");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("dry-run reports without writing and real run preserves free memory", async () => {
    const dry = await migrateAgentMemories(root, { dryRun: true });
    expect(dry).toEqual(
      expect.arrayContaining([
        { agentId: "legacy-dev", status: "would-migrate" },
        conflictVisible
          ? {
              agentId: "conflict-dev",
              status: "conflict",
              detail: "both CLAUDE.md and claude.md exist; left untouched",
            }
          : {
              agentId: "conflict-dev",
              status: "would-migrate",
            },
      ]),
    );
    expect(
      await readFile(join(root, "agents", "legacy-dev", "claude.md"), "utf8"),
    ).toContain("FREE_LEGACY_legacy-dev");

    const real = await migrateAgentMemories(root);
    expect(real).toEqual(
      expect.arrayContaining([
        { agentId: "legacy-dev", status: "migrated" },
        expect.objectContaining({
          agentId: "conflict-dev",
          status: conflictVisible ? "conflict" : "migrated",
        }),
      ]),
    );
    const migrated = await readFile(
      join(root, "agents", "legacy-dev", "CLAUDE.md"),
      "utf8",
    );
    expect(migrated).toContain("<!-- company:profile:start -->");
    expect(migrated).toContain("Build legacy-dev");
    expect(migrated).toContain("Verify legacy-dev");
    expect(migrated).toContain("Follow legacy-dev");
    expect(migrated).toContain("FREE_LEGACY_legacy-dev");
    expect(
      await readdir(join(root, "agents", "legacy-dev")),
    ).toContain("CLAUDE.md");
    expect(
      await readdir(join(root, "agents", "legacy-dev")),
    ).not.toContain("claude.md");
    const conflictMemory = await readFile(
      join(root, "agents", "conflict-dev", "CLAUDE.md"),
      "utf8",
    );
    if (conflictVisible) {
      expect(conflictMemory).toBe("EXISTING_UPPER\n");
      expect(
        await readFile(
          join(root, "agents", "conflict-dev", "claude.md"),
          "utf8",
        ),
      ).toContain("FREE_LEGACY_conflict-dev");
    } else {
      // Case-insensitive filesystem: the second write kept the lowercase
      // directory entry, so this was a safe migration rather than a conflict.
      expect(conflictMemory).toContain("EXISTING_UPPER");
      expect(conflictMemory).toContain("<!-- company:profile:start -->");
      const entries = await readdir(join(root, "agents", "conflict-dev"));
      expect(entries).toContain("CLAUDE.md");
      expect(entries).not.toContain("claude.md");
    }
  });
});
