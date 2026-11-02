import { constants } from "node:fs";
import { open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  LEGACY_MEMORY_FILE,
  MEMORY_FILE,
  memoryManagedBlock,
  memoryTemplate,
  mergeManagedBlock,
} from "./templates";
import { DomainError, requireValue } from "./types";

/** Memory remains Agent-owned text; bound host reads without truncating it. */
export const AGENT_MEMORY_MAX_BYTES = 4 * 1024 * 1024;

export interface AgentMemoryProfile {
  directory: string;
  knowledgeDirectory: string;
  name: string;
  role: string;
  responsibilities: string;
  systemPrompt?: string;
  instructions?: string;
}

interface AgentMemory {
  content: string;
  legacy: boolean;
}

/**
 * Agent-writable paths are never trusted host read targets. Open the final
 * component without following links, validate that descriptor, and read from
 * that same descriptor. NONBLOCK also prevents a substituted FIFO from hanging
 * the host before fstat can reject it.
 */
export async function readAgentMemory(directory: string): Promise<AgentMemory | null> {
  const entries = await readdir(directory);
  const name = entries.includes(MEMORY_FILE)
    ? MEMORY_FILE
    : entries.includes(LEGACY_MEMORY_FILE)
      ? LEGACY_MEMORY_FILE
      : null;
  if (!name) return null;
  let file;
  try {
    file = await open(
      join(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error: any) {
    if (["ELOOP", "EMLINK", "ENOENT"].includes(error.code))
      throw new DomainError("unsafe_agent_memory", "Agent memory must be a stable regular file, not a link", 409);
    throw error;
  }
  try {
    const before = await file.stat();
    requireValue(
      before.isFile() && before.nlink === 1,
      "unsafe_agent_memory",
      "Agent memory must be a regular file with one link",
      409,
    );
    requireValue(
      before.size <= AGENT_MEMORY_MAX_BYTES,
      "agent_memory_too_large",
      "Agent memory exceeds the 4 MiB host update limit; move detailed notes to referenced files",
      409,
    );
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (size <= AGENT_MEMORY_MAX_BYTES) {
      const { bytesRead } = await file.read(
        buffer, 0, Math.min(buffer.length, AGENT_MEMORY_MAX_BYTES + 1 - size), size,
      );
      if (!bytesRead) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      size += bytesRead;
    }
    requireValue(size <= AGENT_MEMORY_MAX_BYTES, "agent_memory_too_large", "Agent memory changed beyond the 4 MiB host update limit", 409);
    const after = await file.stat();
    requireValue(
      before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
      "agent_memory_changed",
      "Agent memory changed while being read; retry with the latest memory",
      409,
    );
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)); }
    catch { throw new DomainError("invalid_document", "Agent memory must contain valid UTF-8 text", 409); }
    return { content, legacy: name === LEGACY_MEMORY_FILE };
  } finally {
    await file.close();
  }
}

/** Validate/compose before changing any member/configuration facts. */
export async function prepareAgentMemory(profile: AgentMemoryProfile) {
  const existing = await readAgentMemory(profile.directory);
  const content = existing
    ? mergeManagedBlock(existing.content, memoryManagedBlock(profile))
    : memoryTemplate(profile);
  requireValue(
    Buffer.byteLength(content) <= AGENT_MEMORY_MAX_BYTES,
    "agent_memory_too_large",
    "Updated Agent memory exceeds the 4 MiB host update limit",
    409,
  );
  return { content, legacy: existing?.legacy ?? false };
}

/**
 * Always re-read on application, especially after a long runtime restart.
 * This preserves free memory written since preflight. Only the managed block
 * changes; no promise of a cross-file crash transaction is made here.
 */
export async function applyAgentMemory(
  writer: { atomic(path: string, content: string): Promise<void> },
  profile: AgentMemoryProfile,
) {
  const prepared = await prepareAgentMemory(profile);
  await writer.atomic(join(profile.directory, MEMORY_FILE), prepared.content);
  if (prepared.legacy) {
    const entries = await readdir(profile.directory);
    if (entries.includes(LEGACY_MEMORY_FILE)) {
      if (entries.includes(MEMORY_FILE))
        await unlink(join(profile.directory, LEGACY_MEMORY_FILE));
      else
        await rename(join(profile.directory, LEGACY_MEMORY_FILE), join(profile.directory, MEMORY_FILE));
    }
  }
}
