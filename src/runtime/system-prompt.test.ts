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
  test("includes the fixed role profile and CLAUDE.md pointer without embedding memory", () => {
    const text = composeSystemInstructions(base);
    expect(text).toContain("ROLE_SENTINEL");
    expect(text).toContain("RESPONSIBILITIES_SENTINEL");
    expect(text).toContain("SYSTEM_PROMPT_SENTINEL");
    expect(text).toContain("CONFIG_INSTRUCTIONS_SENTINEL");
    expect(text).toContain("dev-1");
    expect(text).toContain("acme");
    expect(text).toContain("CLAUDE.md");
    expect(text).toContain("<!-- company:profile:start -->");
    expect(text).toContain("<!-- company:profile:end -->");
    expect(text).toContain("company_org");
    expect(text).toContain("company_tasks");
    expect(text).toContain("company_im");
    expect(text).toContain("fixed Session");
    expect(text).toContain("contractors");
    expect(text).not.toContain("PROFILE_MEMORY_BODY_SENTINEL");
  });

  test("rejects Peri's reserved cache boundary without echoing the prompt", () => {
    const secret = "SENSITIVE_PROFILE_BODY";
    let error: any;
    try {
      composeSystemInstructions({
        ...base,
        systemPrompt: `${secret} ${RESERVED_CACHE_BOUNDARY} ${secret}`,
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
        systemPrompt: "汉".repeat(SYSTEM_PROMPT_BYTE_BUDGET),
      });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe("system_prompt_too_large");
    expect(error.message).toContain("UTF-8 bytes");
    expect(error.message).not.toContain("汉汉汉");
  });

  test("separates optional sections and tolerates an empty profile", () => {
    const text = composeSystemInstructions({
      agentId: "dev-1",
      companyId: "acme",
      role: "developer",
    });
    expect(text).toContain("## Role\ndeveloper");
    expect(text).not.toContain("## Agent-specific system prompt");
    expect(text).not.toContain("## Role instructions");
    expect(text.endsWith("\n")).toBe(false);
  });
});
