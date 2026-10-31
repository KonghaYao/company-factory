/**
 * Read-only evidence extraction for the live E2E.
 *
 * The Agent conversation endpoint (`GET /api/agents/:id/chat`) already returns
 * the Session projection including `view.toolCalls`. This module turns that
 * projection into a small, non-secret record and checks that the Reviewer Agent
 * really used its Bash-equivalent tool to execute the host-controlled CI fixture
 * with this run's random challenge.
 *
 * It deliberately keeps only booleans/ids in the result. Raw tool arguments and
 * results may contain Agent-generated text and must never be written to evidence.
 */

export type AgentToolCall = {
  toolCallId: string;
  name: string;
  status: string;
  /** Serialized arguments (or a preview when only a payload reference exists). */
  argumentsText: string;
  /** Serialized result (empty when only a payload reference exists). */
  resultText: string;
  /** Whether a full inline `result` was projected by the Session view. */
  resultInline: boolean;
  /** Whether the Session view only exposes a result payload reference/preview. */
  resultRefOnly: boolean;
  error: string;
};

export type AgentCiExecution = {
  ok: boolean;
  reason: string;
  toolCallId?: string;
  toolName?: string;
  commandHadChallenge: boolean;
  resultHadChallenge: boolean;
  resultHadDigest: boolean;
  fixtureMentioned: boolean;
};

const MAX_TOOL_TEXT = 2 * 1024 * 1024;

function safeText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, MAX_TOOL_TEXT);
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text.slice(0, MAX_TOOL_TEXT) : "";
  } catch {
    return "";
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function previewOf(value: unknown): string {
  const ref = objectValue(value);
  return typeof ref?.preview === "string" ? ref.preview.slice(0, MAX_TOOL_TEXT) : "";
}

function callFromRow(raw: unknown): AgentToolCall | undefined {
  const row = objectValue(raw);
  if (!row) return undefined;
  const toolCallId = typeof row.toolCallId === "string" ? row.toolCallId : "";
  const name = typeof row.name === "string" ? row.name : "";
  if (!toolCallId || !name) return undefined;
  const hasResult = row.result !== undefined;
  const resultRef = objectValue(row.resultRef);
  const error = objectValue(row.error);
  return {
    toolCallId,
    name,
    status: typeof row.status === "string" ? row.status : "",
    argumentsText: safeText(row.arguments) || previewOf(row.argumentsRef),
    resultText: hasResult
      ? safeText(row.result)
      : previewOf(row.resultRef),
    resultInline: hasResult,
    resultRefOnly: !hasResult && Boolean(resultRef),
    error: typeof error?.message === "string" ? error.message : "",
  };
}

/**
 * Extract tool calls from the Session projection returned by the conversation
 * API. `view.toolCalls` is the primary source; entry blocks are a compatibility
 * fallback for older projections. Unknown shapes are ignored, never thrown.
 */
export function extractAgentToolCalls(conversation: unknown): AgentToolCall[] {
  const root = objectValue(conversation);
  const view = objectValue(root?.view);
  const calls: AgentToolCall[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    const call = callFromRow(raw);
    if (!call || seen.has(call.toolCallId)) return;
    seen.add(call.toolCallId);
    calls.push(call);
  };
  const rows = view?.toolCalls;
  if (Array.isArray(rows)) for (const row of rows) add(row);
  const entries = view?.entries;
  if (Array.isArray(entries)) {
    for (const rawEntry of entries) {
      const entry = objectValue(rawEntry);
      const blocks = entry?.blocks;
      if (!Array.isArray(blocks)) continue;
      for (const rawBlock of blocks) {
        const block = objectValue(rawBlock);
        if (block?.type === "tool_call") add(block.tool);
      }
    }
  }
  return calls;
}

/** Bash or an equivalent command-execution tool. */
export function isCommandToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized === "exec" ||
    normalized === "command" ||
    normalized.includes("bash") ||
    normalized.includes("shell")
  );
}

/**
 * Prove that this exact turn contains a completed Bash tool call which:
 * - mentions the staged fixture and this run's random challenge in its arguments;
 * - has an inline result containing both the challenge and the expected digest;
 * - did not fail.
 *
 * A `resultRef` preview is not accepted: the full result must be projected so
 * the check cannot pass on a truncated preview alone.
 */
export function findAgentCiExecution(
  calls: AgentToolCall[],
  input: { challenge: string; digest: string; fixturePath: string },
): AgentCiExecution {
  const challenge = input.challenge.toLowerCase();
  const digest = input.digest.toLowerCase();
  const result: AgentCiExecution = {
    ok: false,
    reason: "no_tool_calls",
    commandHadChallenge: false,
    resultHadChallenge: false,
    resultHadDigest: false,
    fixtureMentioned: false,
  };
  if (!Array.isArray(calls) || calls.length === 0) return result;
  const commandCalls = calls.filter((call) => isCommandToolName(call.name));
  if (commandCalls.length === 0) return { ...result, reason: "no_bash_tool_call" };
  const completed = commandCalls.filter(
    (call) => call.status === "completed" && !call.error,
  );
  if (completed.length === 0) return { ...result, reason: "bash_tool_not_completed" };
  let sawRefOnly = false;
  let sawChallenge = false;
  let sawFixture = false;
  for (const call of completed) {
    const args = call.argumentsText.toLowerCase();
    const output = call.resultText.toLowerCase();
    const commandHadChallenge = args.includes(challenge);
    const fixtureMentioned = args.includes(input.fixturePath.toLowerCase());
    const resultHadChallenge = output.includes(challenge);
    const resultHadDigest = output.includes(digest);
    if (call.resultRefOnly && !call.resultInline) sawRefOnly = true;
    if (!call.resultInline) continue;
    if (commandHadChallenge) sawChallenge = true;
    if (fixtureMentioned) sawFixture = true;
    if (commandHadChallenge && fixtureMentioned && resultHadChallenge && resultHadDigest)
      return {
        ok: true,
        reason: "verified",
        toolCallId: call.toolCallId,
        toolName: call.name,
        commandHadChallenge,
        resultHadChallenge,
        resultHadDigest,
        fixtureMentioned,
      };
  }
  const last = completed[completed.length - 1]!;
  const lastArgs = last.argumentsText.toLowerCase();
  const lastOutput = last.resultText.toLowerCase();
  if (sawRefOnly) return { ...result, reason: "tool_result_not_inline" };
  return {
    ...result,
    reason: !sawChallenge
      ? "challenge_missing_from_command"
      : !sawFixture
        ? "fixture_missing_from_command"
        : !lastOutput.includes(challenge)
          ? "challenge_missing_from_result"
          : "digest_missing_from_result",
    commandHadChallenge: lastArgs.includes(challenge),
    resultHadChallenge: lastOutput.includes(challenge),
    resultHadDigest: lastOutput.includes(digest),
    fixtureMentioned: lastArgs.includes(input.fixturePath.toLowerCase()),
    toolCallId: last.toolCallId,
    toolName: last.name,
  };
}
