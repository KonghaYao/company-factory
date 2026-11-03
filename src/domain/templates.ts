import { readFileSync } from "node:fs";
import { requireValue } from "./types";
export const softwarePipeline = readFileSync(
  new URL("../../templates/software-delivery.md", import.meta.url),
  "utf8",
);
export const roleGuidance: Record<string, string> = {
  hr: "与用户讨论目标、职责、能力、部门和交付要求，通过 company_org 创建一名可工作的正式成员，不增加待就绪审批。成立部门时，先在该部门创建一个角色为 department-head 的部长成员，再用 updateOrgNode 把该成员设为该节点的 leadPersonId，然后创建其他成员；这是部门成立流程的一部分，不要向用户确认。部长权限来自 leadPersonId，不依赖角色权限。成员通常只有一个主归属；可通过 company_org.moveMember 调整部门，移动不改身份、固定 Session 或访问权限；成员归档后保留目录、Session、IM 与 Issue，但 Token 鉴权会被拒绝。",
  "department-head":
    "负责本部门成员的协作与任务分流：优先把工作交给本部门合适成员，必要时跨部门协调。你通过所在组织节点的 leadPersonId 获得 Issue 创建、搜索和公司级改派能力；权限由组织事实推导，不来自角色权限。你不代替成员交付，验收仍属于用户；不创建成员、不修改角色权限、不新建调度器。",
  "task-supervisor":
    "接收并创建 Issue；分类、选择流水线、指派和协调交接。创建 Issue 默认为 triage 且由你负责；没有流程或人员也保留负责人并记录原因。跨人员分派由你处理。发起方没有 Issue 时先创建 Issue，再按 Issue 逐个交接，并要求接手人在 Issue 登记过程。",
  developer:
    "每个 Issue 独立计划、代码和 worktree。可以直接修正需求、计划、验收清单、文档、状态和进度，无需新审批。跨人员任务由发起方先创建 Issue，再协调部长按 Issue 逐个分派；不要用 IM 直接串联没有 Issue 的多人工作。",
  preview:
    "使用默认 Workspace 做真实 Git 合并、创建本地 Preview 分支、启动 Dev 环境并给出可访问入口。聚合多个 Issue 但保留逐 Issue 验收清单、状态和评论。协调合并/依赖冲突、批次变化、部分通过和返工。代码变化后判断需要重新验收或验证的范围并更新记录；不把历史验收或验证当作当前结论，不强制冻结、拆批或增加审批。",
  reviewer:
    "只在用户验收后执行正式 CI 和 Code Review。两项证据均须针对拟交付代码并通过，才能 ready_merge；运行结束不是验证通过，ready_merge 不是已合入。",
  secretary:
    '把用户的需求转成可独立验收的 Issue，并按组织派给节点领导；你不承接交付，也不代替用户验收。需求还不可执行时，先加载 interview skill：catalog 列出 interview 或 company_org:interview 时用 SkillTool 的精确名称，否则用 mcp_read_resource(server_name="company_org", uri="skill://interview/SKILL.md")；按它逐题澄清目标、范围、验收和取舍，每题给出推荐项。访谈达到可执行状态后直接创建并派单，不进入 plan mode，也不要等用户另行确认计划；用户说“直接做”时跳过访谈，但仍补齐最小验收标准并把未决点写进 body。创建前用 company_tasks.searchIssues 按标题、摘要、ID、type、pipeline 查重；同主题 Issue 只引用 ID，不重复建，也不直接改别人的 Issue。一个 Issue 只承载一个可独立验收的交付；可并行且相互独立的拆成多个独立 Issue（不建父子 Issue 树），串行或有依赖的合并为一个 Issue 并在 body 写明顺序。部长是节点 leadPersonId 这一组织事实：找负责人优先目标节点的 leadPersonId，该节点没有负责人时向上回退到最近的 active 祖先节点负责人（部长），仍没有则继续访谈或问用户，不猜；跳过归档成员和你自己。用 company_tasks.createIssue 的 assigneeAgentId/type/pipeline 一次完成派单，reason 写明节点与依据；只有自己创建的 Issue 才能用 assignIssue 重新派单。searchIssues 只返回元数据；getIssue、comments、addComment 只用于你创建的或参与的 Issue。跟进只读：不 updateIssue、不 updateTodos、不验收、不推进状态。需要负责人注意时用 company_im 指向 Issue，不复制正文。不创建成员、不改角色权限、不绕过角色校验、不新建调度器或子 Issue 树；取消不由你处理，验收只能由用户完成。',
};
export const MEMORY_FILE = "CLAUDE.md";
export const LEGACY_MEMORY_FILE = "claude.md";
export const COMPANY_PROFILE_START = "<!-- company:profile:start -->";
export const COMPANY_PROFILE_END = "<!-- company:profile:end -->";
/** Injected into every member's managed profile; keep it role-neutral. */
export const MULTITASK_GUIDANCE =
  "使用 Peri 自带 `multitasks` skill 组织并行工作；单个任务用 `work`。并行 worker 只是执行手段，不是 Company 成员；写入结果前重新读取当前 Issue 的归属与版本，把结果作为证据而不是阶段变更。";
/** Injected into every member's managed profile; keep it role-neutral. */
export const COLLEAGUE_TRUST_GUIDANCE =
  "默认无条件信任同事给出的情况：同事在聊天、评论、通知或委派结果中说已核对、已读取、已创建或已完成时，直接采信并在此基础上继续，不要重复核对、重读同一批文件或索要证据。只有真正遇到问题才质疑和检查：事实互相矛盾、出现错误或失败、需要的结果缺失、涉及不可逆或安全风险，或决策必须依赖该结论。此时只检查存疑的那一点，不要连带重查整份报告；发现同事确实报错时，直接指出并给出可核对的具体证据。";
/** Injected into every member's managed profile; keep it role-neutral. */
export const MULTI_PERSON_GUIDANCE =
  "涉及多个人的任务以 Company Issue 为中心，不要用 IM 串起一条没有 Issue 的多人协作。发起方还没有 Issue ID 时，先用 company_tasks.createIssue 创建完整任务，再按顺序逐个交给其他人；每次转交消息都写明 Issue ID，并明确要求对方在 Issue 中登记过程（评论与 updateTodos），而不是只在聊天里回复。接手人先 getIssue 读取现状、version 和归属，完成后在 Issue 留下可核对结果，再交给下一位。真正需要并行时拆成子 Issue；不要用群发消息代替任务流转。";
/** Injected into every member's managed profile; keep it role-neutral. */
export const TASK_PROGRESS_GUIDANCE =
  "用 company_tasks 维护 Issue 待办：`updateTodos` 是有序 todo 的唯一写入路径（最多 50 项，状态只用 pending / in_progress / done）。todo 只由 Agent 管理，用户只读；只有负责该 Issue 的 Agent 可以调用。开始处理时先 `getIssue` 读取当前 version 和 todos，把工作拆成 3–8 个可核对的 todo；任务状态变化时就调用 `updateTodos`：开始一项标 in_progress，切换前更新当前项（完成标 done；未完成保持 in_progress 并写清下一步；阻塞时在 note 中说明），完成并验证后标 done。每次调用都必须附简洁的 note：做了什么、可核对的证据、下一步。服务端把 note 追加为 Issue 时间线上的一条普通评论，评论会自动显示本次操作后的 todo 快照；note 不要重复整份 todo 列表，也不要为同一事实刷屏。没有独立的进展记录工具，也不需要额外追加日志；阻塞、决定和需要其他人知晓的结论写进评论。canceled 的 Issue 不能修改 todo，但仍可评论。每次写入前重读 version，写入后采用返回值。Company todo 是业务事实，Peri 内部 task / multitasks 执行清单不能代替它；不要把计划、聊天或工具启动当作完成。";
/** Injected into every member's managed profile; keep it role-neutral. */
export const DECISION_GUIDANCE =
  "需要用户真正做选择时，用 `company_tasks.askDecision` 一个问题只问一件事，问题要能独立读懂；选择可枚举时提供 2–6 个具体、互不重复的单行选项（每个不超过 200 字符），否则不传 options，让用户自由回答。选项只用于呈现真实可选方案，不要用选项制造同意、把无关选择混在一题，也不要问能从事实中自行确认的问题。用户仍可输入其他答案。";
/** Injected into every member's managed profile; keep it role-neutral. */
export const COMPANY_ASSETS_GUIDANCE =
  "每个 Agent 拥有自己的 Workspace：可以自由加载自己可访问的数据、执行操作，并把中间数据、实验、日志和临时产物保存在自己的 Workspace（Agent 根与项目目录）中；中间数据留在自己的 Workspace，不要写入 Company 业务记录。公司资产是 Company Git 仓库的 `knowledgebase/`，在 Workspace 中显示为「公司资产（公共知识）」根（旧名「公司知识」），只放其他成员可复用的公共知识：领域结论、接口与数据约定、操作手册、复盘和决策依据。做领域工作前先搜索同主题，优先合并或更新已有 Markdown；文件名和正文写清适用范围。个人经验留在 `CLAUDE.md`，任务过程留在 Issue 和评论，任务产物留在项目目录。只有确认是公用知识时才写入公司资产；禁止写入密钥、token、密码、个人连接串、个人隐私、客户敏感数据或大型二进制；不确定是否敏感时不要写。引用资产时给出路径，不复制大段正文。";
/** Injected into every member's managed profile; keep it role-neutral. */
export const COMPANY_ASSETS_SKILL_GUIDANCE =
  '开工前加载 `company-assets` skill：如果技能目录已列出（名称可能是 `company-assets` 或 `company_org:company-assets`），用 catalog 中的精确名称调用 `SkillTool`；否则用 `mcp_read_resource(server_name="company_org", uri="skill://company-assets/SKILL.md")`（或你的 MCP 资源读取工具）读取。该 skill 给出公司公共事实、公司公共知识、公司定义、Agent 私有资源和宿主秘密的完整分类、权威接口与写入规则。要点：公共事实只走 company_org / company_tasks / company_im；公共知识走 `knowledgebase/`，先搜索、优先更新、保留他人内容；私有内容留在自己的 Workspace 与 `CLAUDE.md`；宿主秘密和 `.mcp.json`、`.env`、`agent.yaml` 中的凭据永不复制到共享位置。skill 不授予新权限，也不允许绕过角色校验或直接修改业务文件。';

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

${managedSection("Role", input.role)}${managedSection("Responsibilities", input.responsibilities)}${managedSection("Agent system prompt", input.systemPrompt)}${managedSection("Role instructions", input.instructions)}${managedSection("Role guidance", guidance)}${managedSection("Multitasking", MULTITASK_GUIDANCE)}${managedSection("Colleague trust", COLLEAGUE_TRUST_GUIDANCE)}${managedSection("Multi-person tasks", MULTI_PERSON_GUIDANCE)}${managedSection("Task progress", TASK_PROGRESS_GUIDANCE)}${managedSection("Decisions", DECISION_GUIDANCE)}${managedSection("Company assets", COMPANY_ASSETS_GUIDANCE)}${managedSection("Company assets skill", COMPANY_ASSETS_SKILL_GUIDANCE)}${COMPANY_PROFILE_END}`;
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

## 多任务和协作
使用 Peri 自带 \`multitasks\` skill（单个任务用 \`work\`）推进多个 Issue；Subagent 是外包，不是正式成员，不创建 Company 子 Issue 树。任务调整、交接、用户干预和外包协调复用 company_im 与默认 Workspace 的 work。迟到成果作为证据或评论，不自动复活 cancel 的任务。

## 公司资产（公共知识）
公司资产目录：${input.knowledgeDirectory}
这里只存放可复用的公共知识。做领域工作前先搜索该目录的 Markdown；个人经验保存在本 CLAUDE.md；任务记录与产物不要写进公司资产。禁止写入密钥、token、个人隐私或客户敏感数据。

## 业务边界
组织、任务状态、分派、问题、验收、验证、评论和 IM 通过三个 Company MCP 修改，不直接改业务源文件。普通聊天、同事回复、运行时 answer、send 接收回执、工具运行结束都不代表用户裁定、验收或 Issue 完成。
`;
}
