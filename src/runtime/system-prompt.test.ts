import { describe, expect, test } from "bun:test";
import {
  RESERVED_CACHE_BOUNDARY,
  SYSTEM_PROMPT_BYTE_BUDGET,
  composeSystemInstructions,
} from "./system-prompt";

const base = {
  agentId: "dev-1",
  companyId: "acme",
  name: "Developer",
  role: "ROLE_SENTINEL",
  responsibilities: "RESPONSIBILITIES_SENTINEL",
  systemPrompt: "SYSTEM_PROMPT_SENTINEL",
  instructions: "CONFIG_INSTRUCTIONS_SENTINEL",
};

describe("composeSystemInstructions", () => {
  test("freezes identity and capability boundaries while mutable profiles share one current source", () => {
    const text = composeSystemInstructions(base);
    expect(text).not.toContain("ROLE_SENTINEL");
    expect(text).not.toContain("RESPONSIBILITIES_SENTINEL");
    expect(text).not.toContain("SYSTEM_PROMPT_SENTINEL");
    expect(text).not.toContain("CONFIG_INSTRUCTIONS_SENTINEL");
    expect(text).not.toContain("Developer");
    expect(text).toContain("dev-1");
    expect(text).toContain("acme");
    expect(text).toContain("CLAUDE.md");
    expect(text).toContain("<!-- company:profile:start -->");
    expect(text).toContain("<!-- company:profile:end -->");
    expect(text).toContain("company_org");
    expect(text).toContain("company_tasks");
    expect(text).toContain("company_im");
    expect(text).toContain("fixed Session");
    expect(text).toContain("multitasks");
    expect(text).toContain("skill");
    expect(text).toContain("contractors");
    expect(text).toContain("Trust a colleague's report by default");
    expect(text).toContain("do not re-run their checks");
    expect(text).toContain("contradictory facts");
    expect(text).toContain("specific point in doubt");
    expect(text).toContain("You decide how to decompose work");
    expect(text).toContain("getIssue(issueId)");
    expect(text).toContain("getPreview(batchId)");
    expect(text).toContain("updateTodos");
    expect(text).toContain("note");
    expect(text).toContain("comment");
    expect(text).toContain("todo_snapshot");
    expect(text).toContain("no separate progress-record tool");
    expect(text).toContain("askDecision");
    expect(text).toContain("options");
    expect(text).toContain("2–6");
    expect(text).toContain("mutually exclusive");
    expect(text).not.toContain("addUpdate");
    expect(text).not.toContain("`updates`");
    expect(text).not.toContain("latest update");
    expect(text).toContain("knowledgebase");
    expect(text).toContain("公司资产（公共知识）");
    expect(text).toContain("Company assets");
    expect(text).toContain("Your Workspace is your own working area");
    expect(text).toContain("Keep intermediate data in your Workspace");
    expect(text).toContain("not in Company business records");
    expect(text).toContain("only for shared, reusable knowledge");
    expect(text).toContain("publish there only when the material is communal");
    expect(text).not.toContain("sandbox");
    expect(text).toContain("credentials");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(
      SYSTEM_PROMPT_BYTE_BUDGET,
    );
    expect(text).not.toContain("PROFILE_MEMORY_BODY_SENTINEL");
    expect(
      composeSystemInstructions({
        ...base,
        name: "new name",
        role: "new role",
        responsibilities: "new responsibilities",
        systemPrompt: "new prompt",
        instructions: "new instructions",
      }),
    ).toBe(text);
  });

  test("rejects Peri's reserved cache boundary without echoing the prompt", () => {
    const secret = "SENSITIVE_PROFILE_BODY";
    let error: any;
    try {
      composeSystemInstructions({
        ...base,
        agentId: `${secret} ${RESERVED_CACHE_BOUNDARY} ${secret}`,
      });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe("system_prompt_reserved_boundary");
    expect(error.message).not.toContain(secret);
  });

  test("rejects an over-budget UTF-8 prompt without echoing the body", () => {
    let error: any;
    try {
      composeSystemInstructions({
        ...base,
        agentId: "汉".repeat(SYSTEM_PROMPT_BYTE_BUDGET),
      });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe("system_prompt_too_large");
    expect(error.message).toContain("UTF-8 bytes");
    expect(error.message).not.toContain("汉汉汉");
  });

  test("large mutable instructions do not consume the frozen transport budget", () => {
    const text = composeSystemInstructions({
      agentId: "dev-1",
      companyId: "acme",
      role: "developer",
      systemPrompt: "汉".repeat(SYSTEM_PROMPT_BYTE_BUDGET),
      instructions: RESERVED_CACHE_BOUNDARY,
    });
    expect(text).not.toContain("## Role\ndeveloper");
    expect(text).not.toContain("汉汉汉");
    expect(text).not.toContain(RESERVED_CACHE_BOUNDARY);
    expect(text).not.toContain("## Agent-specific system prompt");
    expect(text).not.toContain("## Role instructions");
    expect(text.endsWith("\n")).toBe(false);
  });
});
