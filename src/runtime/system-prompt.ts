/**
 * 会话创建时一次性冻结的系统提示词。
 *
 * Peri only sends `session.instructions` on `session/new`; `session/load`
 * restores the frozen snapshot. After `prompt-library` performs its one-time
 * asset load this module is pure: it freezes identity and stable boundaries
 * only. Mutable profile, Company protocol and the role card have one current
 * source, the `CLAUDE.md` managed block.
 */
import { STABLE_PROMPT } from "../domain/prompt-library";

/** Peri rejects `peri.instructions` above this size. */
export const SYSTEM_PROMPT_BYTE_LIMIT = 64 * 1024;
/** Leave headroom below the transport limit for provider/system wrappers. */
export const SYSTEM_PROMPT_BYTE_BUDGET = 63 * 1024;
/** Peri refuses to freeze instructions containing its cache boundary token. */
export const RESERVED_CACHE_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

export interface SystemPromptProfile {
  agentId: string;
  companyId: string;
  name?: string;
  role?: string;
  responsibilities?: string;
  systemPrompt?: string;
  /** Profile fields are accepted for compatibility but never frozen. */
  instructions?: string;
}

export type SystemPromptErrorCode =
  | "system_prompt_too_large"
  | "system_prompt_reserved_boundary"
  | "system_prompt_unresolved_placeholder";

export class SystemPromptError extends Error {
  readonly status = 500;
  constructor(
    readonly code: SystemPromptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SystemPromptError";
  }
}

/**
 * Build the fixed Session instructions from `stable.md` by replacing exactly
 * `{{company_id}}` and `{{agent_id}}`. The result otherwise equals the asset
 * byte-for-byte, including its trailing newline. It intentionally does not
 * embed `CLAUDE.md`: that file carries the mutable protocol, role card and
 * Agent memory, so edits do not require a new Session.
 */
export function composeSystemInstructions(input: SystemPromptProfile): string {
  const instructions = STABLE_PROMPT.replace(
    /\{\{(company_id|agent_id)\}\}/g,
    (_, key: "company_id" | "agent_id") =>
      key === "company_id" ? input.companyId : input.agentId,
  );

  if (instructions.includes("{{"))
    throw new SystemPromptError(
      "system_prompt_unresolved_placeholder",
      "Stable Session instructions contain an unresolved placeholder after composition.",
    );
  if (instructions.includes(RESERVED_CACHE_BOUNDARY))
    throw new SystemPromptError(
      "system_prompt_reserved_boundary",
      "Stable Session instructions contain Peri's reserved cache boundary token.",
    );
  const bytes = new TextEncoder().encode(instructions).byteLength;
  if (bytes > SYSTEM_PROMPT_BYTE_BUDGET)
    throw new SystemPromptError(
      "system_prompt_too_large",
      `Stable Session instructions are ${bytes} UTF-8 bytes; the transport budget is ${SYSTEM_PROMPT_BYTE_BUDGET}.`,
    );
  return instructions;
}
