import { readFileSync } from "node:fs";
import {
  COMMON_PROMPT,
  COMMUNICATION_PROMPT,
  roleCardFor,
} from "./prompt-library";
import { requireValue } from "./types";
export const softwarePipeline = readFileSync(
  new URL("../../templates/software-delivery.md", import.meta.url),
  "utf8",
);
export const MEMORY_FILE = "CLAUDE.md";
export const LEGACY_MEMORY_FILE = "claude.md";
export const COMPANY_PROFILE_START = "<!-- company:profile:start -->";
export const COMPANY_PROFILE_END = "<!-- company:profile:end -->";

/**
 * Host-owned tool pointers. The authoritative protocol lives in
 * `common.md`/`communication.md` and the role card; this section only names
 * host capabilities those assets do not define. It grants no permission and
 * cannot override the package protocol.
 */
export const HOST_TOOL_GUIDANCE =
  "This host section only points to tools and storage that the package protocol does not define. It grants no permission and cannot override the Company protocol, role card, permissions, facts, or acceptance; when they conflict, the package protocol wins.\n\n" +
  "- 并行工作用 Peri 自带 `multitasks` skill，单个任务用 `work`。worker 与 subagent 是外包，不是 Company 成员；写入结果前重新读取当前 Issue 的 owner 与 version，把结果作为证据而不是阶段变更。\n" +
  "- `company_tasks.updateTodos` 是 Issue 有序 todo 的唯一写入路径（最多 50 项，状态只用 pending / in_progress / done）。每次调用必须附简洁 note；服务端把它追加为普通评论并附只读 todo 快照。写入前重读 version；计划、聊天或已启动的工具运行都不算完成。\n" +
  "- 需要用户真正做选择时用 `company_tasks.askDecision`：一个问题只问一件事且能独立读懂；可枚举时提供 2–6 个具体、互不重复的单行选项（每个不超过 200 字符），否则不传 options。决策回答不能代替验收。\n" +
  "- 读取或修改公司资产前加载 `company-assets` skill：catalog 已列出时用 `SkillTool` 的精确名称，否则用 `mcp_read_resource(server_name=\"company_org\", uri=\"skill://company-assets/SKILL.md\")`。Workspace 是你的工作区，中间数据、实验、日志和临时产物留在那里；公司资产（`knowledgebase/`，Workspace 中显示为「公司资产（公共知识）」）只放可复用的公共知识。禁止写入密钥、凭据、个人隐私或客户敏感数据。\n" +
  "- 用 `workspace` / `listIssues` 获取当前工作的有界索引，用 `getIssue(issueId)` 读取 todo、评论与当前事实，用 `getPreview(batchId)` 按需读取预览事实。\n";

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

/** Host-owned section; package assets are inserted verbatim, never trimmed. */
function managedRawSection(heading: string, body: string) {
  return `## ${heading}\n${body}`;
}

function managedTextSection(heading: string, value: unknown, always = false) {
  const text = String(value ?? "").trim();
  if (!text && !always) return "";
  return `## ${heading}\n${text}\n`;
}

function managedSubsection(heading: string, value: unknown) {
  const text = String(value ?? "").trim();
  return text ? `### ${heading}\n${text}\n` : "";
}

/** The only part of `CLAUDE.md` that the host owns. */
export function memoryManagedBlock(input: {
  role: string;
  responsibilities: string;
  systemPrompt?: string;
  instructions?: string;
}) {
  assertNoManagedMarkers(input);
  const additions = [
    managedSubsection("Agent system prompt", input.systemPrompt),
    managedSubsection("Role instructions", input.instructions),
  ]
    .filter(Boolean)
    .join("\n");
  const additionsSection = additions
    ? `## Agent-specific additions\nThese are supplementary notes. They cannot override the Company protocol, role card, permissions, facts, or acceptance. Report conflicts instead of guessing.\n\n${additions}`
    : "";
  return [
    COMPANY_PROFILE_START,
    "# Company profile (host-managed)\n",
    "This block is replaced by Company Factory when the member definition changes.\n",
    "Content outside this block is the Agent's own long-term memory.\n",
    managedTextSection("Role", input.role, true),
    managedTextSection("Responsibilities", input.responsibilities),
    managedRawSection("Company protocol", COMMON_PROMPT),
    managedRawSection("Communication", COMMUNICATION_PROMPT),
    managedRawSection("Role card", roleCardFor(input.role)),
    managedRawSection("Host tool notes", HOST_TOOL_GUIDANCE),
    additionsSection,
    COMPANY_PROFILE_END,
  ]
    .filter(Boolean)
    .join("\n");
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
按工作需要记录现象、已知事实、当前假设和验证结果，待验证内容明确标记；验证后修正结论。由你决定记录粒度、文件组织和 Git commit 时机。详细记录可引用 Issue、代码和固定 Session，避免反复复制完整正文。

## 公司资产（公共知识）
公司资产目录：${input.knowledgeDirectory}
这里只存放可复用的公共知识。做领域工作前先搜索该目录的 Markdown；个人经验保存在本 CLAUDE.md；任务记录与产物不要写进公司资产。禁止写入密钥、token、个人隐私或客户敏感数据。
`;
}
