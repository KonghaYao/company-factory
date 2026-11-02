#!/usr/bin/env bun
/**
 * One-time migration: agents/<id>/claude.md -> CLAUDE.md.
 *
 * - Dry run by default? No: pass --dry-run explicitly. Real runs rewrite the
 *   file with the managed Company profile block and keep free memory intact.
 * - Never overwrites an existing CLAUDE.md; both files => conflict report.
 * - Never commits any Git repository.
 */
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import {
  LEGACY_MEMORY_FILE,
  MEMORY_FILE,
  memoryManagedBlock,
  mergeManagedBlock,
} from "../src/domain/templates";

export type MigrationStatus =
  | "migrated"
  | "would-migrate"
  | "conflict"
  | "skipped"
  | "error";

export interface MigrationResult {
  agentId: string;
  status: MigrationStatus;
  detail?: string;
}

export async function migrateAgentMemories(
  root: string,
  options: { dryRun?: boolean; agentId?: string } = {},
): Promise<MigrationResult[]> {
  const agentsRoot = join(root, "agents");
  const ids = options.agentId
    ? [options.agentId]
    : (await readdir(agentsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
  const results: MigrationResult[] = [];
  for (const agentId of ids) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(agentId)) {
      results.push({ agentId, status: "error", detail: "invalid agent directory" });
      continue;
    }
    const directory = join(agentsRoot, agentId);
    const memory = join(directory, MEMORY_FILE);
    const legacy = join(directory, LEGACY_MEMORY_FILE);
    const entries = await readdir(directory);
    const hasMemory = entries.includes(MEMORY_FILE);
    const hasLegacy = entries.includes(LEGACY_MEMORY_FILE);
    if (hasMemory) {
      results.push({
        agentId,
        status: hasLegacy ? "conflict" : "skipped",
        detail: hasLegacy
          ? "both CLAUDE.md and claude.md exist; left untouched"
          : "already uses CLAUDE.md",
      });
      continue;
    }
    if (!hasLegacy) {
      results.push({ agentId, status: "skipped", detail: "no memory file" });
      continue;
    }
    if (!entries.includes("agent.yaml")) {
      results.push({
        agentId,
        status: "skipped",
        detail: "missing agent.yaml; cannot build the managed profile block",
      });
      continue;
    }
    try {
      const profile = parse(
        await readFile(join(directory, "agent.yaml"), "utf8"),
      ) as Record<string, unknown>;
      const config =
        profile.config && typeof profile.config === "object"
          ? (profile.config as Record<string, unknown>)
          : {};
      const content = mergeManagedBlock(
        await readFile(legacy, "utf8"),
        memoryManagedBlock({
          role: String(profile.role ?? ""),
          responsibilities: String(profile.responsibilities ?? ""),
          systemPrompt: String(profile.systemPrompt ?? ""),
          instructions:
            typeof config.instructions === "string" ? config.instructions : "",
        }),
      );
      if (options.dryRun) {
        results.push({ agentId, status: "would-migrate" });
        continue;
      }
      // On case-insensitive filesystems the two names are one file, so move
      // the legacy entry aside before writing the canonical one. A failure
      // restores the backup instead of deleting memory.
      const temporary = `${memory}.tmp-${randomUUID()}`;
      const backup = `${directory}/${LEGACY_MEMORY_FILE}.migrating-${randomUUID()}`;
      await writeFile(temporary, content, "utf8");
      await rename(legacy, backup);
      try {
        await rename(temporary, memory);
        await unlink(backup);
      } catch (error) {
        await rename(backup, legacy).catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
      results.push({ agentId, status: "migrated" });
    } catch (error) {
      results.push({
        agentId,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const agentIndex = args.indexOf("--agent");
  const rootIndex = args.indexOf("--root");
  const root =
    rootIndex >= 0 && args[rootIndex + 1]
      ? args[rootIndex + 1]!
      : process.env.COMPANY_HOME ?? join(homedir(), ".company");
  const results = await migrateAgentMemories(root, {
    dryRun,
    agentId: agentIndex >= 0 ? args[agentIndex + 1] : undefined,
  });
  console.log(JSON.stringify({ root, dryRun, results }, null, 2));
  if (results.some((result) => ["conflict", "error"].includes(result.status)))
    process.exitCode = 1;
}
