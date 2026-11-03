import { describe, expect, test } from "bun:test";
import {
  COLLEAGUE_TRUST_GUIDANCE,
  COMPANY_ASSETS_GUIDANCE,
  COMPANY_ASSETS_SKILL_GUIDANCE,
  DECISION_GUIDANCE,
  MULTITASK_GUIDANCE,
  MULTI_PERSON_GUIDANCE,
  TASK_PROGRESS_GUIDANCE,
  memoryManagedBlock,
  memoryTemplate,
  mergeManagedBlock,
} from "./templates";

describe("member managed profile", () => {
  test("injects multitasking, colleague trust, task progress, decision and company asset guidance for every role", () => {
    for (const role of [
      "hr",
      "department-head",
      "task-supervisor",
      "secretary",
      "developer",
      "preview",
      "reviewer",
      "custom-role",
    ]) {
      const block = memoryManagedBlock({ role, responsibilities: "Work" });
      expect(block).toContain("## Multitasking");
      expect(block).toContain(MULTITASK_GUIDANCE);
      expect(block).toContain("multitasks");
      expect(block).toContain("## Colleague trust");
      expect(block).toContain(COLLEAGUE_TRUST_GUIDANCE);
      expect(block).toContain("无条件信任");
      expect(block).toContain("不要重复核对");
      expect(block).toContain("只检查存疑");
      expect(block).toContain("## Multi-person tasks");
      expect(block).toContain(MULTI_PERSON_GUIDANCE);
      expect(block).toContain("以 Company Issue 为中心");
      expect(block).toContain("写明 Issue ID");
      expect(block).toContain("登记过程");
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
      expect(block).toContain("## Company assets skill");
      expect(block).toContain(COMPANY_ASSETS_SKILL_GUIDANCE);
      expect(block).toContain("skill://company-assets/SKILL.md");
      expect(block).toContain("company_org");
      expect(block).toContain("mcp_read_resource");
      expect(block).toContain("SkillTool");
      expect(block).toContain("宿主秘密");
      expect(block).toContain("私有");
      expect(block).not.toContain(".claude/skills");
      if (role === "secretary") {
        expect(block).toContain("interview");
        expect(block).toContain("skill://interview/SKILL.md");
        expect(block).toContain("searchIssues");
        expect(block).toContain("assignIssue");
        expect(block).toContain("不承接交付");
        expect(block).toContain("leadPersonId");
        expect(block).not.toContain("回退任务主管");
      } else {
        expect(block).not.toContain("interview");
      }
      expect(block.indexOf("## Multitasking")).toBeLessThan(
        block.indexOf("## Colleague trust"),
      );
      expect(block.indexOf("## Colleague trust")).toBeLessThan(
        block.indexOf("## Multi-person tasks"),
      );
      expect(block.indexOf("## Multi-person tasks")).toBeLessThan(
        block.indexOf("## Task progress"),
      );
      expect(block.indexOf("## Task progress")).toBeLessThan(
        block.indexOf("## Decisions"),
      );
      expect(block.indexOf("## Decisions")).toBeLessThan(
        block.indexOf("## Company assets"),
      );
      expect(block.indexOf("## Company assets")).toBeLessThan(
        block.indexOf("## Company assets skill"),
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
    expect(merged).toContain("## Company assets skill");
    expect(merged).toContain("skill://company-assets/SKILL.md");
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
