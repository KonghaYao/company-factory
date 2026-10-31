import { describe, expect, test } from "bun:test";
import {
  extractAgentToolCalls,
  findAgentCiExecution,
  isCommandToolName,
  type AgentToolCall,
} from "./e2e-agent-evidence";

const CHALLENGE = "0123456789abcdef0123456789abcdef";
const DIGEST = "a".repeat(64);
const FIXTURE = "/tmp/company-e2e.root/projects/app/.e2e-ci/run/ci/check.ts";

function call(overrides: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    toolCallId: "tool-1",
    name: "Bash",
    status: "completed",
    argumentsText: JSON.stringify({
      command: `bun '${FIXTURE}' ci /subject /inputs.json ${CHALLENGE} | sha256sum`,
    }),
    resultText: JSON.stringify({
      stdout: `${CHALLENGE}\n${DIGEST}  -\n`,
      stderr: "",
      exitCode: 0,
    }),
    resultInline: true,
    resultRefOnly: false,
    error: "",
    ...overrides,
  };
}

describe("agent tool-call evidence", () => {
  test("extracts view.toolCalls and entry-block fallbacks", () => {
    const calls = extractAgentToolCalls({
      view: {
        toolCalls: [
          { toolCallId: "a", name: "Bash", status: "completed", arguments: { command: "x" }, result: "y" },
        ],
        entries: [
          {
            blocks: [
              {
                type: "tool_call",
                tool: { toolCallId: "b", name: "Bash", status: "error", arguments: {}, result: "" },
              },
            ],
          },
        ],
      },
    });
    expect(calls.map((item) => item.toolCallId)).toEqual(["a", "b"]);
    expect(calls[0]?.resultInline).toBe(true);
  });

  test("accepts a completed Bash call with challenge and digest", () => {
    const execution = findAgentCiExecution([call()], {
      challenge: CHALLENGE,
      digest: DIGEST,
      fixturePath: FIXTURE,
    });
    expect(execution.ok).toBe(true);
    expect(execution.toolCallId).toBe("tool-1");
    expect(execution.commandHadChallenge).toBe(true);
    expect(execution.resultHadDigest).toBe(true);
  });

  test("rejects a result that only has a payload reference", () => {
    const execution = findAgentCiExecution(
      [
        call({
          resultText: `${CHALLENGE} ${DIGEST}`,
          resultInline: false,
          resultRefOnly: true,
        }),
      ],
      { challenge: CHALLENGE, digest: DIGEST, fixturePath: FIXTURE },
    );
    expect(execution.ok).toBe(false);
    expect(execution.reason).toBe("tool_result_not_inline");
  });

  test("rejects missing challenge, missing fixture, missing digest and wrong digest", () => {
    const missingChallenge = call({ argumentsText: `bun ${FIXTURE} ci` });
    expect(
      findAgentCiExecution([missingChallenge], {
        challenge: CHALLENGE,
        digest: DIGEST,
        fixturePath: FIXTURE,
      }).reason,
    ).toBe("challenge_missing_from_command");
    const missingFixture = call({
      argumentsText: `bun check.ts ci ${CHALLENGE} | sha256sum`,
    });
    expect(
      findAgentCiExecution([missingFixture], {
        challenge: CHALLENGE,
        digest: DIGEST,
        fixturePath: FIXTURE,
      }).reason,
    ).toBe("fixture_missing_from_command");
    const missingDigest = call({ resultText: CHALLENGE });
    expect(
      findAgentCiExecution([missingDigest], {
        challenge: CHALLENGE,
        digest: DIGEST,
        fixturePath: FIXTURE,
      }).reason,
    ).toBe("digest_missing_from_result");
    const wrongDigest = call({ resultText: `${CHALLENGE} ${"b".repeat(64)}` });
    expect(
      findAgentCiExecution([wrongDigest], {
        challenge: CHALLENGE,
        digest: DIGEST,
        fixturePath: FIXTURE,
      }).ok,
    ).toBe(false);
  });

  test("ignores non-command tools, failed calls and text-only claims", () => {
    const recordVerification = call({
      name: "recordVerification",
      argumentsText: JSON.stringify({
        evidence: `e2e-ci-digest:${DIGEST}`,
        challenge: CHALLENGE,
      }),
    });
    expect(
      findAgentCiExecution([recordVerification], {
        challenge: CHALLENGE,
        digest: DIGEST,
        fixturePath: FIXTURE,
      }).reason,
    ).toBe("no_bash_tool_call");
    expect(
      findAgentCiExecution([call({ status: "error", error: "failed" })], {
        challenge: CHALLENGE,
        digest: DIGEST,
        fixturePath: FIXTURE,
      }).reason,
    ).toBe("bash_tool_not_completed");
    expect(
      findAgentCiExecution([], {
        challenge: CHALLENGE,
        digest: DIGEST,
        fixturePath: FIXTURE,
      }).reason,
    ).toBe("no_tool_calls");
    expect(isCommandToolName("Bash")).toBe(true);
    expect(isCommandToolName("mcp__shell__run")).toBe(true);
    expect(isCommandToolName("recordVerification")).toBe(false);
  });

  test("a stale challenge from another round does not pass", () => {
    const stale = call({
      argumentsText: `bun ${FIXTURE} ci ${"f".repeat(32)} | sha256sum`,
      resultText: `${"f".repeat(32)} ${DIGEST}`,
    });
    expect(
      findAgentCiExecution([stale], {
        challenge: CHALLENGE,
        digest: DIGEST,
        fixturePath: FIXTURE,
      }).ok,
    ).toBe(false);
  });
});
