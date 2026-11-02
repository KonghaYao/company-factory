import { readFileSync } from "node:fs";
import { requireValue } from "./types";
export const softwarePipeline = readFileSync(
  new URL("../../templates/software-delivery.md", import.meta.url),
  "utf8",
);
export const roleGuidance: Record<string, string> = {
  hr: "与用户讨论目标、职责、能力、部门和交付要求，通过 company_org 创建一名可工作的正式成员，不增加待就绪审批。成员只能有一个部门，一期不能调组或离职。",
  "task-supervisor":
    "接收并创建 Issue；分类、选择流水线、指派和协调交接。创建 Issue 默认为 triage 且由你负责；没有流程或人员也保留负责人并记录原因。跨人员分派由你处理。",
  developer:
    "每个 Issue 独立计划、代码和 worktree。可以直接修正需求、计划、验收清单、文档、状态和进度，无需新审批。跨人员分派请协调任务主管。",
  preview:
    "使用默认 Workspace 做真实 Git 合并、创建本地 Preview 分支、启动 Dev 环境并给出可访问入口。聚合多个 Issue 但保留逐 Issue 验收清单、状态和评论。协调合并/依赖冲突、批次变化、部分通过和返工。代码变化后判断需要重新验收或验证的范围并更新记录；不把历史验收或验证当作当前结论，不强制冻结、拆批或增加审批。",
  reviewer:
    "只在用户验收后执行正式 CI 和 Code Review。两项证据均须针对拟交付代码并通过，才能 ready_merge；运行结束不是验证通过，ready_merge 不是已合入。",
};
export const MEMORY_FILE = "CLAUDE.md";
export const LEGACY_MEMORY_FILE = "claude.md";
export const COMPANY_PROFILE_START = "<!-- company:profile:start -->";
export const COMPANY_PROFILE_END = "<!-- company:profile:end -->";

export function assertNoManagedMarkers(
  values: Record<string, unknown>,
  label = "Agent profile",
) {
  for (const [field, value] of Object.entries(values)) {
    if (typeof value !== "string") continue;
    requireValue(
      !value.includes(COMPANY_PROFILE_START) &&
        !value.includes(COMPANY_PROFILE_END),
      "invalid_input",
      `${label} ${field} must not contain Company managed-block markers`,
    );
  }
}

function managedSection(heading: string, value: unknown) {
  const text = String(value ?? "").trim();
  return text ? `## ${heading}\n${text}\n` : "";
}

/** The only part of `CLAUDE.md` that the host owns. */
export function memoryManagedBlock(input: {
  role: string;
  responsibilities: string;
  systemPrompt?: string;
  instructions?: string;
}) {
  assertNoManagedMarkers(input);
  const guidance = roleGuidance[input.role] ?? "";
  return `${COMPANY_PROFILE_START}
# Company profile (host-managed)

This block is replaced by Company Factory when the member definition changes.
Content outside this block is the Agent's own long-term memory.

${managedSection("Role", input.role)}${managedSection("Responsibilities", input.responsibilities)}${managedSection("Agent system prompt", input.systemPrompt)}${managedSection("Role instructions", input.instructions)}${managedSection("Role guidance", guidance)}${COMPANY_PROFILE_END}`;
}

/**
 * Replace only the managed block. Missing blocks are inserted at the top so
 * legacy memory written before the managed format is preserved as free text.
 * Duplicate or unbalanced markers are a conflict rather than a guess.
 */
export function mergeManagedBlock(existing: string, block: string) {
  const starts = existing.split(COMPANY_PROFILE_START).length - 1;
  const ends = existing.split(COMPANY_PROFILE_END).length - 1;
  if (starts === 0 && ends === 0) {
    const free = existing.trimStart();
    return free ? `${block}\n\n${free}` : `${block}\n`;
  }
  requireValue(
    starts === 1 && ends === 1,
    "invalid_document",
    "CLAUDE.md contains duplicate or unbalanced Company profile markers; refusing to overwrite",
    409,
  );
  const start = existing.indexOf(COMPANY_PROFILE_START);
  const end = existing.indexOf(COMPANY_PROFILE_END);
  requireValue(
    start < end,
    "invalid_document",
    "CLAUDE.md Company profile markers are out of order; refusing to overwrite",
    409,
  );
  const after = existing.slice(end + COMPANY_PROFILE_END.length);
  return `${existing.slice(0, start)}${block}${after}`;
}

export function memoryTemplate(input: {
  name: string;
  role: string;
  responsibilities: string;
  systemPrompt?: string;
  instructions?: string;
  knowledgeDirectory: string;
}) {
  const block = memoryManagedBlock(input);
  return `${block}

# ${input.name} · 持续学习记忆

## 工作记录规则
遇到问题，先记录现象、已知事实、当前假设和下一步验证，执行 Git commit，再继续。待验证内容明确标记；验证后修正结论。详细记录可引用 Issue 和固定 Session。

## 多任务和协作
使用 Peri 自带 multitasks / work 能力推进多个 Issue；Subagent 是外包，不是正式成员，不创建 Company 子 Issue 树。任务调整、交接、用户干预和外包协调复用 company_im 与默认 Workspace 的 work。迟到成果作为证据或评论，不自动复活 cancel 的任务。

## 公司知识
知识目录：${input.knowledgeDirectory}
遇到领域问题，先自行搜索上述 Markdown 文件夹，再按需阅读。个人经验保存在本 CLAUDE.md；可复用公司知识整理到上述目录。无需强制索引、知识状态或专门 Skill。

## 业务边界
组织、任务状态、分派、问题、验收、验证、评论和 IM 通过三个 Company MCP 修改，不直接改业务源文件。普通聊天、同事回复、运行时 answer、send 接收回执、工具运行结束都不代表用户裁定、验收或 Issue 完成。
`;
}
