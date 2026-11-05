import { describe, expect, test } from "bun:test";
import { STABLE_PROMPT } from "../domain/prompt-library";
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

const expected = STABLE_PROMPT.replace("{{company_id}}", "acme").replace(
  "{{agent_id}}",
  "dev-1",
);

describe("composeSystemInstructions", () => {
  test("freezes stable.md verbatim with only the two identity placeholders replaced", () => {
    const text = composeSystemInstructions(base);
    expect(text).toBe(expected);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("{{");
    expect(text).not.toContain("ROLE_SENTINEL");
    expect(text).not.toContain("RESPONSIBILITIES_SENTINEL");
    expect(text).not.toContain("SYSTEM_PROMPT_SENTINEL");
    expect(text).not.toContain("CONFIG_INSTRUCTIONS_SENTINEL");
    expect(text).not.toContain("Developer");
    expect(text).toContain("dev-1");
    expect(text).toContain("acme");
    expect(text).toContain("CLAUDE.md");
    expect(text).toContain("company_org");
    expect(text).toContain("company_tasks");
    expect(text).toContain("company_im");
    expect(text).toContain("固定 Session");
    expect(text).toContain("当前 owner、状态、版本和验收以实时业务记录为准");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(
      SYSTEM_PROMPT_BYTE_BUDGET,
    );
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(
      Buffer.byteLength(STABLE_PROMPT, "utf8") + 64,
    );
  });

  test("does not freeze the retired English operating rules", () => {
    const text = composeSystemInstructions(base);
    for (const retired of [
      "## Company operating rules",
      "## Current profile and memory",
      "Trust a colleague's report by default",
      "Company Issue is the center",
      "Use sub-Issues",
      "do not re-run their checks",
      "3–8",
      "todo_snapshot",
      "company-assets",
    ])
      expect(text).not.toContain(retired);
  });

  test("profile changes never change the frozen Session instructions", () => {
    const text = composeSystemInstructions(base);
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

  test("rejects a nested placeholder without a second replacement pass", () => {
    let error: any;
    try {
      composeSystemInstructions({
        ...base,
        agentId: "dev-{{company_id}}",
        companyId: "acme",
      });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe("system_prompt_unresolved_placeholder");
    expect(error.message).not.toContain("dev-");
    expect(error.message).not.toContain("公司身份与边界");
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
    expect(error.message).not.toContain("公司身份与边界");
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
    expect(error.message).not.toContain("公司身份与边界");
  });

  test("large mutable instructions do not consume the frozen transport budget", () => {
    const text = composeSystemInstructions({
      agentId: "dev-1",
      companyId: "acme",
      role: "developer",
      systemPrompt: "汉".repeat(SYSTEM_PROMPT_BYTE_BUDGET),
      instructions: RESERVED_CACHE_BOUNDARY,
    });
    expect(text).toBe(expected);
    expect(text).not.toContain("汉汉汉");
    expect(text).not.toContain(RESERVED_CACHE_BOUNDARY);
  });
});
