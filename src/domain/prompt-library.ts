/**
 * Authoritative prompt assets from `aos-factory-prompt-architecture` v2.3.
 *
 * Assets are loaded once at module initialization; calls do no I/O. Every
 * asset is verified against `manifest.json` before use so an edited or missing
 * file fails fast instead of silently changing agent behaviour. Errors carry
 * only the path and hashes, never the prompt body.
 *
 * `stable.md` freezes Session identity. `common.md`, `communication.md` and one
 * role card are composed into the `CLAUDE.md` managed block. `task-contract.md`
 * is an asset only; this module does not inject it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type PromptAssetErrorCode = "prompt_asset_invalid";

export class PromptAssetError extends Error {
  readonly status = 500;
  constructor(
    readonly code: PromptAssetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PromptAssetError";
  }
}

/** Exactly the files listed by the package manifest. */
export const PROMPT_ASSET_PATHS = [
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
] as const;

const PROMPTS_DIRECTORY = new URL("../../templates/prompts/", import.meta.url);

function assetUrl(relativePath: string) {
  return new URL(relativePath, PROMPTS_DIRECTORY);
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseManifest(): Record<string, string> {
  const url = assetUrl("manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(url, "utf8"));
  } catch (error: any) {
    throw new PromptAssetError(
      "prompt_asset_invalid",
      `Prompt manifest is unreadable or invalid JSON: ${url.pathname} (${error?.code ?? "parse_error"})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new PromptAssetError(
      "prompt_asset_invalid",
      `Prompt manifest must be an object: ${url.pathname}`,
    );
  const manifest = parsed as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  const expected = [...PROMPT_ASSET_PATHS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    throw new PromptAssetError(
      "prompt_asset_invalid",
      `Prompt manifest entries do not match the 11 authoritative assets: ${url.pathname}`,
    );
  for (const [key, value] of Object.entries(manifest))
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
      throw new PromptAssetError(
        "prompt_asset_invalid",
        `Prompt manifest hash is invalid for ${key}: ${url.pathname}`,
      );
  return manifest as Record<string, string>;
}

function loadPrompts() {
  const manifest = parseManifest();
  const prompts: Record<string, string> = {};
  for (const relativePath of PROMPT_ASSET_PATHS) {
    const url = assetUrl(relativePath);
    let bytes: Buffer;
    try {
      bytes = readFileSync(url);
    } catch (error: any) {
      throw new PromptAssetError(
        "prompt_asset_invalid",
        `Prompt asset is missing or unreadable: ${url.pathname} (${error?.code ?? "read_error"})`,
      );
    }
    const actual = sha256(bytes);
    const expected = manifest[relativePath]!;
    if (actual !== expected)
      throw new PromptAssetError(
        "prompt_asset_invalid",
        `Prompt asset hash mismatch for ${relativePath}: expected ${expected}, got ${actual}`,
      );
    try {
      prompts[relativePath] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new PromptAssetError(
        "prompt_asset_invalid",
        `Prompt asset is not valid UTF-8: ${relativePath}`,
      );
    }
  }
  return prompts as Record<(typeof PROMPT_ASSET_PATHS)[number], string>;
}

const PROMPTS = loadPrompts();

export const STABLE_PROMPT = PROMPTS["stable.md"];
export const COMMON_PROMPT = PROMPTS["common.md"];
export const COMMUNICATION_PROMPT = PROMPTS["communication.md"];
export const TASK_CONTRACT_PROMPT = PROMPTS["task-contract.md"];

export type RoleCardName =
  | "colleague"
  | "coordinator"
  | "executor"
  | "hr"
  | "preview"
  | "reviewer"
  | "secretary";

export const ROLE_PROMPTS: Readonly<Record<RoleCardName, string>> = Object.freeze({
  colleague: PROMPTS["roles/colleague.md"],
  coordinator: PROMPTS["roles/coordinator.md"],
  executor: PROMPTS["roles/executor.md"],
  hr: PROMPTS["roles/hr.md"],
  preview: PROMPTS["roles/preview.md"],
  reviewer: PROMPTS["roles/reviewer.md"],
  secretary: PROMPTS["roles/secretary.md"],
});

/**
 * Repository role aliases -> package role card. Exact, case-sensitive match;
 * no trimming or fuzzy inference. `task-supervisor` deliberately does not map
 * to `coordinator`: the package removes that role, and a coordinator card would
 * imply coordination authority. Anything unknown falls back to `colleague`.
 */
export const ROLE_CARD_ALIASES: Readonly<Record<string, RoleCardName>> = Object.freeze({
  hr: "hr",
  "department-head": "coordinator",
  secretary: "secretary",
  developer: "executor",
  preview: "preview",
  reviewer: "reviewer",
  coordinator: "coordinator",
  executor: "executor",
  colleague: "colleague",
});

export const FALLBACK_ROLE_CARD: RoleCardName = "colleague";

/** Select exactly one role card; empty, unknown and legacy roles fall back. */
export function roleCardFor(role?: string | null): string {
  const name =
    typeof role === "string" && Object.hasOwn(ROLE_CARD_ALIASES, role)
      ? ROLE_CARD_ALIASES[role]!
      : FALLBACK_ROLE_CARD;
  return ROLE_PROMPTS[name];
}

export function roleCardNameFor(role?: string | null): RoleCardName {
  return typeof role === "string" && Object.hasOwn(ROLE_CARD_ALIASES, role)
    ? ROLE_CARD_ALIASES[role]!
    : FALLBACK_ROLE_CARD;
}
