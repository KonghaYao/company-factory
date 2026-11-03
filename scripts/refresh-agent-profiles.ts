#!/usr/bin/env bun
/**
 * Refresh the host-managed profile block in every member's CLAUDE.md.
 *
 * - Dry run by default; pass --apply to write.
 * - Only the block between the Company profile markers is replaced. Free
 *   memory outside the block is preserved byte-for-byte.
 * - One Agent Git commit per changed member; no agent.yaml, version,
 *   configVersion, Session or Company business data is changed.
 * - Never prints memory or YAML content, only member ids, changed headings and
 *   the resulting commit id.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import {
  applyAgentMemory,
  prepareAgentMemory,
  readAgentMemory,
  type AgentMemoryProfile,
} from "../src/domain/agent-memory";
import {
  COMPANY_PROFILE_END,
  COMPANY_PROFILE_START,
  LEGACY_MEMORY_FILE,
  MEMORY_FILE,
  memoryManagedBlock,
} from "../src/domain/templates";
import { DomainError } from "../src/domain/types";
import { CompanyStore } from "../src/storage/company-store";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const COMMIT_MESSAGE = "Refresh Company-managed profile guidance";

export type RefreshStatus =
  | "unchanged"
  | "would-update"
  | "updated"
  | "conflict"
  | "error";

export interface RefreshResult {
  agentId: string;
  companyId: string;
  status: RefreshStatus;
  /** Changed managed-block headings, never their content. */
  blocks?: string[];
  /** HEAD after the per-member Agent Git commit, when one was created. */
  commit?: string | null;
  detail?: string;
}

export interface RefreshOptions {
  /** Defaults to true; the CLI requires --apply to write. */
  dryRun?: boolean;
  agentId?: string;
  companyId?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorDetail(error: unknown): string {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  if (error instanceof Error) return error.name;
  return "unknown error";
}

function extractManagedBlock(content: string): string | null {
  const start = content.indexOf(COMPANY_PROFILE_START);
  const end = content.indexOf(COMPANY_PROFILE_END);
  if (start < 0 || end < start) return null;
  return content.slice(start + COMPANY_PROFILE_START.length, end);
}

function sections(block: string): Map<string, string> {
  const result = new Map<string, string>();
  let heading: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (heading !== null) result.set(heading, lines.join("\n").trim());
    lines = [];
  };
  for (const line of block.split("\n")) {
    const match = /^## (.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1]!;
    } else if (heading !== null) {
      lines.push(line);
    }
  }
  flush();
  return result;
}

/** Compare managed-block headings only; free memory is never diffed. */
export function changedManagedSections(
  existingContent: string,
  nextBlock: string,
): string[] {
  const currentBlock = extractManagedBlock(existingContent);
  const next = sections(nextBlock);
  if (currentBlock === null) return [...next.keys()];
  const current = sections(currentBlock);
  return [...next.entries()]
    .filter(([heading, value]) => current.get(heading) !== value)
    .map(([heading]) => heading);
}

async function loadAgent(
  agentsRoot: string,
  agentId: string,
  root: string,
): Promise<{ companyId: string; profile: AgentMemoryProfile }> {
  const directory = join(agentsRoot, agentId);
  const raw = await readFile(join(directory, "agent.yaml"), "utf8");
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    throw new DomainError("invalid_document", "agent.yaml is not valid YAML", 500);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new DomainError("invalid_document", "agent.yaml must be an object", 500);
  const agent = parsed as Record<string, unknown>;
  if (typeof agent.agentId === "string" && agent.agentId !== agentId)
    throw new DomainError(
      "invalid_document",
      "agent.yaml agentId does not match its directory",
      409,
    );
  const companyId = agent.companyId;
  if (typeof companyId !== "string" || !SAFE_ID.test(companyId))
    throw new DomainError(
      "invalid_document",
      "agent.yaml has an invalid companyId",
      500,
    );
  const config = object(agent.config);
  const effectiveConfig = object(agent.effectiveConfig);
  const instructions =
    typeof effectiveConfig.instructions === "string"
      ? effectiveConfig.instructions
      : typeof config.instructions === "string"
        ? config.instructions
        : "";
  return {
    companyId,
    profile: {
      directory,
      knowledgeDirectory: join(root, "companys", companyId, "knowledgebase"),
      name: typeof agent.name === "string" ? agent.name : agentId,
      role: typeof agent.role === "string" ? agent.role : "",
      responsibilities:
        typeof agent.responsibilities === "string" ? agent.responsibilities : "",
      systemPrompt:
        typeof agent.systemPrompt === "string" ? agent.systemPrompt : "",
      instructions,
    },
  };
}

export async function refreshAgentProfiles(
  root: string,
  options: RefreshOptions = {},
): Promise<RefreshResult[]> {
  if (options.agentId !== undefined && !SAFE_ID.test(options.agentId))
    throw new Error("invalid --agent id");
  if (options.companyId !== undefined && !SAFE_ID.test(options.companyId))
    throw new Error("invalid --company id");
  const rootDir = resolve(root);
  const agentsRoot = join(rootDir, "agents");
  let ids: string[];
  if (options.agentId) {
    ids = [options.agentId];
  } else {
    try {
      ids = (await readdir(agentsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }
  const dryRun = options.dryRun ?? true;
  const store = new CompanyStore(rootDir);
  const results: RefreshResult[] = [];
  for (const agentId of ids) {
    if (!SAFE_ID.test(agentId)) {
      results.push({
        agentId,
        companyId: "",
        status: "error",
        detail: "invalid agent directory",
      });
      continue;
    }
    let loaded: Awaited<ReturnType<typeof loadAgent>>;
    try {
      loaded = await loadAgent(agentsRoot, agentId, rootDir);
    } catch (error) {
      results.push({
        agentId,
        companyId: "",
        status: "error",
        detail: errorDetail(error),
      });
      continue;
    }
    const { companyId, profile } = loaded;
    if (options.companyId && companyId !== options.companyId) continue;
    const directory = join(agentsRoot, agentId);
    const result = { agentId, companyId };
    try {
      const entries = await readdir(directory);
      if (
        entries.includes(MEMORY_FILE) &&
        entries.includes(LEGACY_MEMORY_FILE)
      ) {
        results.push({
          ...result,
          status: "conflict",
          detail: "both CLAUDE.md and claude.md exist; left untouched",
        });
        continue;
      }
      const existing = await readAgentMemory(directory);
      const prepared = await prepareAgentMemory(profile);
      const changed =
        !existing || existing.content !== prepared.content || prepared.legacy;
      if (!changed) {
        results.push({ ...result, status: "unchanged" });
        continue;
      }
      const blocks = changedManagedSections(
        existing?.content ?? "",
        memoryManagedBlock(profile),
      );
      if (dryRun) {
        results.push({ ...result, status: "would-update", blocks });
        continue;
      }
      await applyAgentMemory(store, profile);
      try {
        await store.commit(directory, COMMIT_MESSAGE);
      } catch {
        results.push({
          ...result,
          status: "error",
          blocks,
          detail: "memory updated, but the per-member Git commit failed",
        });
        continue;
      }
      const snapshot = await store.agentGitSnapshot(directory);
      results.push({
        ...result,
        status: "updated",
        blocks,
        commit: snapshot?.head ?? null,
      });
    } catch (error) {
      results.push({
        ...result,
        status: "error",
        detail: errorDetail(error),
      });
    }
  }
  return results;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: bun scripts/refresh-agent-profiles.ts [--dry-run] [--apply] [--agent <id>] [--company <id>] [--root <dir>]\n" +
        "Default: dry run. --apply writes the managed block and creates one Agent Git commit per changed member.",
    );
    process.exit(0);
  }
  const dryRun = args.includes("--dry-run") || !args.includes("--apply");
  try {
    const root =
      option(args, "--root") ??
      process.env.COMPANY_HOME ??
      join(homedir(), ".company");
    const results = await refreshAgentProfiles(root, {
      dryRun,
      agentId: option(args, "--agent"),
      companyId: option(args, "--company"),
    });
    console.log(JSON.stringify({ root, dryRun, results }, null, 2));
    if (results.some((result) => ["conflict", "error"].includes(result.status)))
      process.exitCode = 1;
  } catch (error) {
    // Never echo memory or YAML content from a failed run.
    console.error(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
  }
}
