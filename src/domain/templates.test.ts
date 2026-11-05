import { describe, expect, test } from "bun:test";
import {
  COMMON_PROMPT,
  COMMUNICATION_PROMPT,
  ROLE_PROMPTS,
  roleCardFor,
} from "./prompt-library";
import {
  COMPANY_PROFILE_END,
  COMPANY_PROFILE_START,
  HOST_TOOL_GUIDANCE,
  memoryManagedBlock,
  memoryTemplate,
  mergeManagedBlock,
} from "./templates";

const ROLES = [
  "hr",
  "department-head",
  "task-supervisor",
  "secretary",
  "developer",
  "preview",
  "reviewer",
  "custom-role",
  "",
];

describe("member managed profile", () => {
  test("injects the package protocol, communication and exactly one role card for every role", () => {
    for (const role of ROLES) {
      const block = memoryManagedBlock({ role, responsibilities: "Work" });
      expect(block).toContain(COMMON_PROMPT);
      expect(block).toContain(COMMUNICATION_PROMPT);
      expect(block).toContain(roleCardFor(role));
      expect(block.split("## Role card")).toHaveLength(2);
      const included = Object.values(ROLE_PROMPTS).filter((card) =>
        block.includes(card),
      );
      expect(included).toHaveLength(1);
      expect(included[0]).toBe(roleCardFor(role));
      expect(block).toContain("## Host tool notes");
      expect(block).toContain(HOST_TOOL_GUIDANCE);
      expect(block).toContain("multitasks");
      expect(block).toContain("updateTodos");
      expect(block).toContain("askDecision");
      expect(block).toContain("skill://company-assets/SKILL.md");
      expect(block).toContain("grants no permission and cannot override");
      expect(block).not.toContain(".claude/skills");
      expect(block.indexOf("## Role\n")).toBeLessThan(
        block.indexOf("## Company protocol"),
      );
      expect(block.indexOf("## Company protocol")).toBeLessThan(
        block.indexOf("## Communication"),
      );
      expect(block.indexOf("## Communication")).toBeLessThan(
        block.indexOf("## Role card"),
      );
      expect(block.indexOf("## Role card")).toBeLessThan(
        block.indexOf("## Host tool notes"),
      );
      expect(block).not.toContain("## Role guidance");
      expect(block).not.toContain("## Colleague trust");
      expect(block).not.toContain("## Multi-person tasks");
      expect(block).not.toContain("## Task progress");
      expect(block).not.toContain("## Decisions");
      expect(block).not.toContain("## Company assets");
    }
  });

  test("does not carry the retired trust, sub-Issue or fixed-todo instructions", () => {
    const block = memoryManagedBlock({
      role: "developer",
      responsibilities: "Work",
    });
    expect(block).not.toContain("无条件信任");
    expect(block).not.toContain("不要重复核对");
    expect(block).not.toContain("以 Company Issue 为中心");
    expect(block).not.toContain("写明 Issue ID");
    expect(block).not.toContain("把工作拆成 3–8");
    expect(block).not.toContain("默认无条件信任");
    expect(block).toContain("不强制 3–8 todo");
  });

  test("keeps Agent-specific additions outside the package protocol", () => {
    const block = memoryManagedBlock({
      role: "developer",
      responsibilities: "Work",
      systemPrompt: "SYSTEM_SENTINEL",
      instructions: "INSTRUCTION_SENTINEL",
    });
    expect(block).toContain("## Agent-specific additions");
    expect(block).toContain("cannot override the Company protocol");
    expect(block).toContain("### Agent system prompt\nSYSTEM_SENTINEL");
    expect(block).toContain("### Role instructions\nINSTRUCTION_SENTINEL");
    expect(block.indexOf("## Host tool notes")).toBeLessThan(
      block.indexOf("## Agent-specific additions"),
    );
    expect(block.indexOf("SYSTEM_SENTINEL")).toBeLessThan(
      block.indexOf("INSTRUCTION_SENTINEL"),
    );
  });

  test("omits empty responsibilities and additions but always keeps the Role heading", () => {
    const block = memoryManagedBlock({ role: "developer", responsibilities: "" });
    expect(block).toContain("## Role\ndeveloper");
    expect(block).not.toContain("## Responsibilities");
    expect(block).not.toContain("## Agent-specific additions");
    expect(block).toContain("## Company protocol");
  });

  test("keeps agent-owned memory outside the managed block", () => {
    const merged = mergeManagedBlock(
      "my own notes",
      memoryManagedBlock({ role: "developer", responsibilities: "Work" }),
    );
    expect(merged).toContain("my own notes");
    expect(merged).toContain("## Host tool notes");
    expect(merged).toContain("skill://company-assets/SKILL.md");
    expect(merged).toContain(COMMON_PROMPT);
  });

  test("replaces an older managed block in place and is idempotent", () => {
    const old = [
      "BEFORE_FREE_NOTES",
      COMPANY_PROFILE_START,
      "# Company profile (host-managed)",
      "",
      "## Role",
      "developer",
      "## Colleague trust",
      "OLD TRUST RULE",
      COMPANY_PROFILE_END,
      "AFTER_FREE_NOTES",
    ].join("\n");
    const block = memoryManagedBlock({
      role: "developer",
      responsibilities: "Work",
    });
    const merged = mergeManagedBlock(old, block);
    expect(merged).toContain("BEFORE_FREE_NOTES");
    expect(merged).toContain("AFTER_FREE_NOTES");
    expect(merged.startsWith("BEFORE_FREE_NOTES")).toBe(true);
    expect(merged).not.toContain("OLD TRUST RULE");
    expect(merged).not.toContain("## Colleague trust");
    expect(mergeManagedBlock(merged, block)).toBe(merged);
    expect(merged.split(COMPANY_PROFILE_START)).toHaveLength(2);
  });

  test("rejects duplicate, unbalanced and out-of-order markers without overwriting", () => {
    const block = memoryManagedBlock({ role: "developer", responsibilities: "Work" });
    for (const existing of [
      `${COMPANY_PROFILE_START}\nfree`,
      `free\n${COMPANY_PROFILE_END}`,
      `${COMPANY_PROFILE_START}\na\n${COMPANY_PROFILE_START}\nb\n${COMPANY_PROFILE_END}`,
      `${COMPANY_PROFILE_END}\na\n${COMPANY_PROFILE_START}`,
    ]) {
      expect(() => mergeManagedBlock(existing, block)).toThrow();
    }
  });

  test("new member memory names the company asset root without repeating protocol", () => {
    const knowledgeDirectory = "/tmp/company/companys/acme/knowledgebase";
    const memory = memoryTemplate({
      name: "Developer",
      role: "developer",
      responsibilities: "Work",
      knowledgeDirectory,
    });
    expect(memory).toContain("## 公司资产（公共知识）");
    expect(memory).toContain(knowledgeDirectory);
    expect(memory).toContain("个人经验保存在本 CLAUDE.md");
    expect(memory).toContain("禁止写入密钥、token、个人隐私或客户敏感数据");
    expect(memory).not.toContain("\n## 公司知识\n");
    expect(memory).not.toContain("## 多任务和协作");
    expect(memory).not.toContain("## 业务边界");
    expect(memory).toContain(COMMON_PROMPT);
    expect(memory).toContain("## Host tool notes");
  });

  test("does not inject the task contract into the managed block", () => {
    const block = memoryManagedBlock({
      role: "developer",
      responsibilities: "Work",
    });
    expect(block).not.toContain("# 任务上下文模板");
    expect(block).not.toContain("{{issue_id}}");
    expect(block).not.toContain("{{owner_id}}");
  });
});
