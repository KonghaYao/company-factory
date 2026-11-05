import { describe, expect, test } from "bun:test";
import {
  COMMON_PROMPT,
  COMMUNICATION_PROMPT,
  FALLBACK_ROLE_CARD,
  ROLE_PROMPTS,
  TASK_CONTRACT_PROMPT,
  roleCardFor,
  roleCardNameFor,
} from "./prompt-library";
import { HOST_TOOL_GUIDANCE, memoryManagedBlock } from "./templates";

describe("role card mapping", () => {
  test("maps repository roles to exactly one package role card", () => {
    for (const [role, card] of [
      ["hr", "hr"],
      ["department-head", "coordinator"],
      ["secretary", "secretary"],
      ["developer", "executor"],
      ["preview", "preview"],
      ["reviewer", "reviewer"],
      ["coordinator", "coordinator"],
      ["executor", "executor"],
      ["colleague", "colleague"],
    ] as const) {
      expect(roleCardNameFor(role)).toBe(card);
      expect(roleCardFor(role)).toBe(ROLE_PROMPTS[card]);
    }
  });

  test("falls back to the colleague card for legacy, research, unknown and empty roles", () => {
    for (const role of [
      "task-supervisor",
      "research",
      "researcher",
      "custom-role",
      "UNKNOWN",
      undefined,
      null,
      "",
    ]) {
      expect(roleCardNameFor(role)).toBe(FALLBACK_ROLE_CARD);
      expect(roleCardFor(role)).toBe(ROLE_PROMPTS.colleague);
    }
    expect(roleCardFor("task-supervisor")).not.toBe(ROLE_PROMPTS.coordinator);
  });

  test("matches aliases exactly and case-sensitively without trimming", () => {
    for (const role of ["HR", "Developer", " department-head", "department-head ", "Department-head"]) {
      expect(roleCardNameFor(role)).toBe("colleague");
    }
  });
});

describe("managed block assembly", () => {
  test("uses the package text verbatim in package order", () => {
    const block = memoryManagedBlock({
      role: "developer",
      responsibilities: "Work",
    });
    const order = [
      "## Role\n",
      "## Company protocol",
      "## Communication",
      "## Role card",
      "## Host tool notes",
    ];
    const positions = order.map((heading) => block.indexOf(heading));
    expect(positions.every((index) => index >= 0)).toBe(true);
    for (let index = 1; index < positions.length; index++)
      expect(positions[index - 1]!).toBeLessThan(positions[index]!);
    expect(block.indexOf(COMMON_PROMPT)).toBeGreaterThan(
      block.indexOf("## Company protocol"),
    );
    expect(block.indexOf(COMMUNICATION_PROMPT)).toBeGreaterThan(
      block.indexOf("## Communication"),
    );
    expect(block.indexOf(ROLE_PROMPTS.executor)).toBeGreaterThan(
      block.indexOf("## Role card"),
    );
  });

  test("host tool notes are host-owned and cannot override the package protocol", () => {
    expect(HOST_TOOL_GUIDANCE).toContain("grants no permission");
    expect(HOST_TOOL_GUIDANCE).toContain("cannot override the Company protocol");
    expect(HOST_TOOL_GUIDANCE).toContain("updateTodos");
    expect(HOST_TOOL_GUIDANCE).toContain("askDecision");
    expect(HOST_TOOL_GUIDANCE).toContain("multitasks");
    expect(HOST_TOOL_GUIDANCE).toContain("company-assets");
    expect(HOST_TOOL_GUIDANCE).toContain("Workspace");
    expect(HOST_TOOL_GUIDANCE).not.toContain("默认信任");
    expect(HOST_TOOL_GUIDANCE).not.toContain("子 Issue");
    expect(HOST_TOOL_GUIDANCE).not.toContain("3–8");
  });

  test("never injects task-contract automatically", () => {
    const block = memoryManagedBlock({
      role: "secretary",
      responsibilities: "Dispatch",
    });
    expect(block).not.toContain(TASK_CONTRACT_PROMPT);
    expect(block).not.toContain("{{issue_id}}");
    expect(block).not.toContain("任务上下文模板");
  });
});
