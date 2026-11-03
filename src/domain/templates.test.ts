import { describe, expect, test } from "bun:test";
import {
  COMPANY_ASSETS_GUIDANCE,
  DECISION_GUIDANCE,
  MULTITASK_GUIDANCE,
  TASK_PROGRESS_GUIDANCE,
  memoryManagedBlock,
  memoryTemplate,
  mergeManagedBlock,
} from "./templates";

describe("member managed profile", () => {
  test("injects multitasking, task progress, decision and company asset guidance for every role", () => {
    for (const role of [
      "hr",
      "task-supervisor",
      "developer",
      "preview",
      "reviewer",
      "custom-role",
    ]) {
      const block = memoryManagedBlock({ role, responsibilities: "Work" });
      expect(block).toContain("## Multitasking");
      expect(block).toContain(MULTITASK_GUIDANCE);
      expect(block).toContain("multitasks");
      expect(block).toContain("## Task progress");
      expect(block).toContain(TASK_PROGRESS_GUIDANCE);
      expect(block).toContain("updateTodos");
      expect(block).toContain("note");
      expect(block).toContain("评论");
      expect(block).toContain("快照");
      expect(block).toContain("没有独立的进展记录工具");
      expect(block).not.toContain("addUpdate");
      expect(block).not.toContain("`updates`");
      expect(block).not.toContain("latest_update");
      expect(block).toContain("## Decisions");
      expect(block).toContain(DECISION_GUIDANCE);
      expect(block).toContain("askDecision");
      expect(block).toContain("2–6");
      expect(block).toContain("200");
      expect(block).toContain("不要用选项制造同意");
      expect(block).toContain("## Company assets");
      expect(block).toContain(COMPANY_ASSETS_GUIDANCE);
      expect(block).toContain("公司资产（公共知识）");
      expect(block).toContain("每个 Agent 拥有自己的 Workspace");
      expect(block).toContain("中间数据留在自己的 Workspace");
      expect(block).toContain("不要写入 Company 业务记录");
      expect(block).toContain("只有确认是公用知识时才写入公司资产");
      expect(block).not.toContain("沙箱");
      expect(block.indexOf("## Multitasking")).toBeLessThan(
        block.indexOf("## Task progress"),
      );
      expect(block.indexOf("## Task progress")).toBeLessThan(
        block.indexOf("## Decisions"),
      );
      expect(block.indexOf("## Decisions")).toBeLessThan(
        block.indexOf("## Company assets"),
      );
    }
  });

  test("keeps agent-owned memory outside the managed block", () => {
    const merged = mergeManagedBlock(
      "my own notes",
      memoryManagedBlock({ role: "developer", responsibilities: "Work" }),
    );
    expect(merged).toContain("my own notes");
    expect(merged).toContain("## Multitasking");
    expect(merged).toContain("## Task progress");
    expect(merged).toContain("## Decisions");
    expect(merged).toContain("## Company assets");
  });

  test("replaces an older managed block in place and is idempotent", () => {
    const old = [
      "BEFORE_FREE_NOTES",
      "<!-- company:profile:start -->",
      "# Company profile (host-managed)",
      "",
      "## Role",
      "developer",
      "<!-- company:profile:end -->",
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
    expect(merged).not.toContain("## Role\ndeveloper\n<!-- company:profile:end -->");
    expect(mergeManagedBlock(merged, block)).toBe(merged);
    expect(merged.split("<!-- company:profile:start -->")).toHaveLength(2);
  });

  test("rejects duplicate, unbalanced and out-of-order markers without overwriting", () => {
    const block = memoryManagedBlock({ role: "developer", responsibilities: "Work" });
    for (const existing of [
      "<!-- company:profile:start -->\nfree",
      "free\n<!-- company:profile:end -->",
      "<!-- company:profile:start -->\na\n<!-- company:profile:start -->\nb\n<!-- company:profile:end -->",
      "<!-- company:profile:end -->\na\n<!-- company:profile:start -->",
    ]) {
      expect(() => mergeManagedBlock(existing, block)).toThrow();
    }
  });

  test("new member memory names the company asset root and keeps boundaries", () => {
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
  });
});
