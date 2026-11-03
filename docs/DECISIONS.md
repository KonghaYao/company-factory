# 决策记录（DECISIONS）

本文件记录用户已明确拍板的决策。第 1–5 项日期为 2026-11-01；新增裁定单独标明日期。

状态说明：**永久** 表示用户明确设为不可回退的长期约束；**生效中** 表示当前生效、尚未声明为永久。

## 2026-11-02 System For Agent 为第一优先级

- **决策**：弱化代码系统的流程控制，优先 Agent 自主性；代码结构按顶层设计的责任边界开展。
- **影响**：代码提供事实、能力、身份隔离、可靠通知与上下文读取。拆解、流程选择、并发协作和推进由 Agent 决定。通知接受不推进工单状态；验收和验证仍记录真实事实。
- **修复范围**：同意 7ae47ad 架构与上下文审查的修复意见，沿现有模块修正，不引入临时表或新的工作流引擎。
- **设计**：[System For Agent 顶层设计](SYSTEM-FOR-AGENT.md)。
- **状态**：生效中，本轮第一优先级。

## 1. 永不迁移到原生 `peri acp` 子进程

- **决策**：继续使用 `@peri-code/sdk` 0.4.0 的 WASM 运行时，不替换为原生 Peri ACP / child-process 传输。永不迁移。
- **理由/约束**：用户确定运行时边界；后续改造不得突破该边界。
- **影响**：
  - MCP 仍由宿主读取 `~/.company/agents/<agentId>/.mcp.json`（公司 MCP 为 HTTP），并在显式重启时注入。
  - workspace 继续使用 `peri mcp-start workspace --stdio`；2026-11-02 起本地直接运行，不再套 OS 沙箱。
  - SDK WASM 不 spawn 任意 stdio MCP。
  - 未来 MCP 改造必须落在 SDK WASM 边界内，不得改为 native `peri acp`。
- **状态**：永久

## 2. 系统提示词更新语义：固定 Session

- **决策（2026-11-02 按自主性优先修订）**：新 Session 的 `session.instructions` 只冻结稳定身份、能力入口与事实边界；`role` / `responsibilities` / `systemPrompt` / 已应用 `config.instructions` 统一写入 `CLAUDE.md` 托管块，由 Agent 开工前读取。自由记忆由 Agent 维护。旧 Session 保留原冻结快照，不重建、不改写历史。
- **理由/约束**：固定 Session，不为更新提示词而重建旧会话；提示词与可变记忆分离。
- **影响**：更新职责或长期记忆不触发 Session 重建；`CLAUDE.md` 作为可变职责与长期记忆的载体。
- **状态**：生效中

## 3. 模型管理库：文件配置 + UI 只读展示

- **决策**：模型库以文件 `~/.company/model-library.yaml` 为准（权限 0600，只存环境变量名）；全局「模型库」Sheet 与右侧「模型」tab 只读；不在 UI 写回文件。
- **理由/约束**：文件是唯一配置源，UI 不承担写入。
- **影响**：模型库变更直接编辑文件；界面仅展示。
- **状态**：生效中

## 4. 不兼容旧底层模型字段

- **决策**：Agent 只引用 profile（`config.modelProfile`）；`model` / `models` / `provider` / `baseUrl` / `apiKeyEnv` 从 schema 与运行时退役，保存时明确拒绝。
- **理由/约束**：统一由 profile 解析模型，不保留旧字段兼容路径。
- **影响**：含旧字段的保存请求被拒绝；运行时不再读取这些字段。
- **状态**：永久

## 5. 禁用 `--watch`

- **决策**：不使用 `--watch` 模式；服务改动一律先停再起。
- **理由/约束**：服务变更必须通过显式停止与启动生效，不引入 watch 模式。
- **影响**：所有服务改动均先停再起。
- **状态**：永久

## 6. Workspace 本地运行，不使用 OS 沙箱

- **决策**：Agent Workspace MCP 与宿主 Git 直接以宿主用户身份运行；删除 Linux / bubblewrap 依赖、沙箱命令包装与 `COMPANY_SANDBOX` 开关。
- **理由/约束**：产品基于本地运行，不绑定 Linux 与 bubblewrap；接受 Agent 工具拥有宿主用户的文件权限。
- **影响**：
  - `COMPANY_WORKSPACE=disabled` 仅用于显式关闭 Agent Workspace，与 Git 能力解耦。
  - 所有者文件视图、Preview、CI 等能力保留；不再声称 OS 级隔离。
  - macOS 可直接运行 Workspace 与宿主 Git，不再 fail closed。
- **状态**：生效中

## 7. 服务重启前置检查与版本更新门禁

- **决策**：每次重启服务前，必须先确认没有人员正在工作。新增 owner-only `GET /api/restart-readiness` 与只读脚本 `bun run check:restart`；检查只在当前进程内聚合执行事实，不引入自动重启、进程管理或新的工作流状态机。
- **“工作中”的裁定**：只包括运行中的 Chat turn、未结算的 prompt admission、runtime 操作锁、legacy 输入队列、待用户回答/权限、运行中的 Session task、在途 Company IM 投递和在途 Agent work-notice。`threads.agent_status=active`、`session_bindings` 存在、IM thread `open`、`delivered`/`accepted` admission、Issue 工作流阶段、Preview URL、`executionBlocked`/`closed`、`needs_user` decision 都不算忙。归档人员仍有 live work 时同样阻止重启；无 bound chat 的 active 人员计为 offline，不算忙。
- **失败闭合**：任一状态源失败或 5 秒超时，返回 `verified=false` / `safeToRestart=false` / HTTP 503；检查脚本以 exit `3` 失败。绝不在未知状态报告 SAFE。初始化未完成的公司不读取 roster，只检查 runtime 锁与已绑定工作，避免历史失败状态永久阻塞。
- **版本更新**：应用版本唯一来源是 `package.json.version`；`/health.version` 动态读取同一字段，不新增版本写入 API。固定流程为：`bun run verify` → `bun run check:restart` exit 0 → 才修改版本 → 人工停止并 `bun start` → `/health` 确认新版本 → 重启后再检查一次。
- **理由/约束**：用户要求“每次重启服务时，检查人员是否在工作”“下个版本检查之后才能更新版本”。当前架构是单 Bun 进程，没有 supervisor；自动杀进程/拉起会引入新的进程管理责任，因此脚本只检查，停止与启动保持人工显式操作。
- **影响**：检查是 advisory，不是分布式锁；检查通过到停止之间仍可能出现新工作。外部宿主进程、外部 Preview 与手工终端任务不在覆盖范围。Agent bearer 与 Company MCP 不能访问该接口。
- **状态**：生效中

## 8. 任务 todo、评论快照与公司资产命名（2026-11-02，2026-11-03 修订）

- **决策**：任务 todo 是 Issue 的内嵌业务事实，只由负责该 Issue 的 Agent 通过 `company_tasks.updateTodos` 维护；每次调用必须附带 1..2000 字符的 note。服务端先写入 Issue，再追加一条普通 Issue 评论：评论正文为 note，`todo_snapshot` 记录操作后有序 todo 的只读 `{id,text,status}` 快照。删除独立进展记录子系统（`addUpdate` / `updates` 工具、`updates/` 文件读取、`TaskUpdate` 类型、`latest_update` 投影与 UI 分区），不新建数据库、并行任务系统或第四个 MCP 模块。公司公共知识继续使用现有 `companys/<companyId>/knowledgebase/`，统一命名为「公司资产（公共知识）」，不新建资产目录或资产子系统。
- **边界**：快照只含 `{id,text,status}`，不复制 todo 审计字段；评论正文可编辑，快照只读；`TodoSection` 与评论快照使用相同的图标+文字状态；用户不能写 todo；canceled Issue 拒绝 todo 变更，但普通评论仍可追加。Issue 写入与评论追加是两个文件，失败窗口不做跨文件事务声明。
- **兼容**：旧 `updates/` 文件与 Issue 的 `latest_update` 键直接忽略；新公司不再创建 `updates/` 目录；不迁移、不删除旧文件，旧评论没有 `todo_snapshot` 时正常渲染。
- **提示词分层**：系统提示词只保留工具名、事实边界和资产边界；操作细节放在 `CLAUDE.md` 托管块的 `## Task progress` 与 `## Company assets`。旧 Session 的系统提示词保持冻结，已有成员通过托管块迁移获得新指引，不重建 Session。
- **公司资产边界**：只放可复用的公共知识；个人经验放 `CLAUDE.md`，任务过程放 Issue/评论，代码与产物放项目目录。禁止写入密钥、token、密码、连接串、个人隐私、客户敏感数据和大型二进制。
- **Workspace 所有权**：每个 Agent 对自己的 Workspace 有操作所有权，可自由加载可访问的数据、执行操作，并把中间数据、实验、日志和临时产物留在自己的 Workspace；中间数据不写入 Company 业务记录。只有其他成员可复用的公用知识才写入公司资产 `knowledgebase/`，个人经验、任务过程与任务产物不进入公司资产。该边界是产品约定，不构成 OS 隔离。
- **迁移策略**：`scripts/refresh-agent-profiles.ts` 默认 dry-run，只输出成员、变更块标题和 commit，不打印正文；`--apply` 时逐成员只替换托管块并各提交一个 Agent Git commit，块外自由记忆保留。脚本不修改 `agent.yaml`、`agent.version`/`configVersion`、Session 或 Company 业务数据；重复或不平衡的托管块标记直接报错、不覆盖。
- **理由/约束**：沿用 Issue 的公司锁、CAS、Git 与 Workspace 文件能力，避免新增存储和 schema；提示词与命名变更不需要版本 bump。
- **状态**：生效中

## 9. 待裁定问题进入左侧栏并支持选项快答（2026-11-02）

- **决策**：Agent 通过 `askDecision` 提出的待回答 decision 在公司范围左侧栏顶部集中展示；问题可携带 2–6 个具体选项，用户单选并提交，仍可自由回答。回答成功后即使 Agent 尚未 `resolveDecision`，也从左侧栏隐藏。
- **边界**：`answerDecision` 保持自由文本；`options` 只用于真实可枚举的选择，不用于制造同意；旧 decision 无 options 继续工作；归档成员的问题仍可回答；不新增 MCP 工具或数据库迁移。
- **接口**：owner-only `GET /api/decisions/pending?companyId=...` 返回最小投影；答案仍经 `/api/action` 的 `answerDecision` 提交。
- **状态**：生效中

## 10. 默认信任同事报告（2026-11-02）

- **决策**：Agent 默认无条件采信同事在聊天、评论、通知或委派结果中给出的情况，直接在此基础上继续，不重复核对、重跑检查或索要证据。
- **边界**：仅在事实矛盾、错误或失败、关键结果缺失、不可逆或安全敏感步骤、决策必须依赖该结论时才质疑；核查只针对存疑点，不重查整份报告；发现错误时给出可核对的具体证据。
- **落地**：全局 system prompt「Company operating rules」与每个成员托管块 `## Colleague trust`；旧 Session 的系统提示词保持冻结，成员通过托管块迁移获得规则。
- **状态**：生效中

## 11. 多人任务以 Issue 为中心（2026-11-02）

- **决策**：涉及多个人的任务必须先有 Company Issue。发起方还没有 Issue ID 时，先用 `company_tasks.createIssue` 创建完整任务，再按顺序逐个交给其他人；转交消息必须写明 Issue ID，并要求对方在 Issue 中登记过程（评论与 `updateTodos`），不能只在聊天里回复。
- **边界**：接手人先 `getIssue` 读取现状、version 与归属，完成后留下可核对结果再转交；真正并行的工作拆成子 Issue；IM 只用于指向 Issue 和同步，不替代任务事实；单负责人/协作评论模型不变。
- **落地**：全局 system prompt「Company operating rules」、每个成员托管块 `## Multi-person tasks`、任务主管与开发角色指引，以及 `company_im` 工具描述；旧 Session 系统提示词保持冻结，成员通过托管块迁移获得规则。
- **状态**：生效中

## 12. 成员头像颜色是 Company 业务事实（2026-11-02）

- **决策**：成员头像颜色使用 12 个固定调色板 id（不接受任意 hex），存入 `companys/<companyId>/company.yaml` 的可选 `memberColors: Record<agentId, paletteId>`，随 Company Git 提交；不写入 `agent.yaml`、`CLAUDE.md`、roster、runtime 配置或浏览器本地状态。
- **权限与默认**：只有 user-only 的 `updateMember` 能改色；HR 通过 `createMember` 显式传色返回 `forbidden`，新建成员由公司锁内的默认分配从未使用/最少使用颜色中随机选色。默认色写入 `company.yaml` 并做 Company version CAS，Agent 文件仍使用原有 `agent.version` CAS。
- **旧数据兼容**：旧公司无 `memberColors` 时按 agentId 做确定性 FNV-1a 回退；读取永不写盘、不做启动迁移。新建成员或 owner 改色时先把 roster 中缺失颜色的旧成员回退色一次性冻结写入，之后不再漂移；保留未知/历史 key。
- **投影**：`organization()` 与 `members()` 的成员行增加 `avatarColor`；`AgentRecord` 和 `agent.yaml` 不新增该字段。不新增 MCP 工具、HTTP 路由、数据库或迁移脚本。
- **状态**：生效中

## 13. 公司资产 skill 由 `company_org` MCP 以只读资源投递（2026-11-03）

- **决策**：`company-assets` skill 的唯一源文件是 `templates/skills/company-assets/SKILL.md`；通过已有的 `company_org` MCP 用 `@peri-code/mcpp/skills` 的 `ResourceForSkills` 挂载为只读 resource，URI 为 `skill://company-assets/SKILL.md`。不新增 MCP 路由，不新增知识写入 API，不修改 `.mcp.json`。
- **读取路径**：`resources/list` 与 `resources/read` 返回 `text/markdown` 正文，复用 `/company_org/mcp` 的 Agent bearer 鉴权。Peri 的 `SkillTool` catalog 发现是 best-effort（当前栈不提供 `skills/list` / `skills/get`）；保证路径是 `mcp_read_resource(server_name="company_org", uri="skill://company-assets/SKILL.md")`。提示词同时覆盖 catalog 命中与资源读取，不引用本地 `.claude/skills` 路径。
- **提示词分层**：新 Session 的冻结系统提示词只放短指针，并在权威规则行加入 `skills`；完整分类、读写规则、冲突与反例在 `SKILL.md`。`CLAUDE.md` 托管块新增 `## Company assets skill`，覆盖所有角色；旧 Session 不重建，运行 `scripts/refresh-agent-profiles.ts --apply` 只更新托管块，Agent Git 提交仅包含 profile 文件。
- **无每 Agent 安装**：不创建每 Agent 的 skill 副本，不在 Agent Git 中版本化 skill，不写安装脚本；skill 由 MCP 在每次 list/read 时实时扫描模板目录。
- **分类与边界**：公共事实只走 `company_org` / `company_tasks` / `company_im`；公共知识是 `knowledgebase/` 普通 Markdown，先搜索、读后写、合并、保留他人内容；公司定义/模板 Agent 只读；Agent 私有内容留在 Workspace / `CLAUDE.md`；宿主秘密与 `.mcp.json` / `.env` / `agent.yaml` 凭据不读、不复制、不写。
- **知识库写入保持现状**：无 CAS、无自动 Company Git commit；Agent 直接写入后需要版本化时由 Owner 通过文件视图提交。不新增知识写入接口、资产子系统或第四个 MCP。
- **不是 OS ACL**：本 skill 是产品约定与操作指引，不授予权限、不绕过角色校验，也不提供文件系统强制隔离。
- **状态**：生效中

## 14. 秘书角色、interview skill 与 Issue 元数据搜索（2026-11-03）

- **决策**：新增内置 `secretary` 角色，新公司默认创建 `<companyId>-secretary` 成员，placement 在总部，权限为 `issue.create` / `issue.assign` / `issue.search`。秘书是 Owner 与组织之间的入口和路由角色，不是调度器，也不是交付者：只负责把需求问清楚、把任务派给对的人。
- **不设审批门**：需求不可执行时，秘书先加载 `interview` skill 逐题澄清目标、范围、验收、约束、取舍和负责人依据；访谈收敛后直接 `createIssue` 并派单，不要求 Owner 另行确认计划。用户说“直接做”时跳过访谈，但仍补齐最小验收标准。
- **派单语义**：`createIssue` 可选 `assigneeAgentId/type/pipeline/reason`，允许 user、`task-supervisor` 或持有 `issue.assign` 的 Agent 一次完成创建与派单；`assignIssue` 对 `issue.assign` 只开放“自己创建的 Issue，且不能派给自己”，不改变任务主管和 user 的原有权限。秘书不承接交付、不推进状态、不验收，`acceptPreview` 与决策回答仍只属于 user。
- **Issue 可见性**：Issue 记录 `created_by_type/created_by_id`，创建者与 owner、collaborator、history 一样可读；不新增 `issue.read_all`。
- **搜索而非全量读取**：新增只读 `searchIssues`，仅 user 或持有 `issue.search` 的角色可用，按 `id/title/summary/type/pipeline` 做大小写不敏感子串匹配，返回 `{items,total,truncated}` 元数据，不含正文、评论、决策或代码引用；它不扩大 `getIssue`/`comments` 的可见范围，用于去重、引用和跟进。
- **interview skill 投递**：源文件为 `templates/skills/interview/SKILL.md`，经既有 `company_org` MCP 的 `ResourceForSkills` 提供 `skill://interview/SKILL.md`；只由 `roleGuidance.secretary` 引用，不进入冻结系统提示词，也不是每 Agent 安装。
- **权限授予**：`setRolePermissions` 白名单扩展为 `issue.create` / `issue.assign` / `issue.search`，仍由 HR/user 授予，与既有 `issue.create` 一致。
- **状态**：生效中

## 15. 部门部长取代默认任务主管（2026-11-03）

- **决策**：新公司只创建总部、HR 和秘书两个默认成员，不再预置 `task-supervisor` 成员或角色。部门部长成为默认负责人：只要是 active 组织节点的 `leadPersonId`，运行时即获得 `issue.create`、`issue.assign`、`issue.search`，不依赖 `company.yaml.roles` 中给部长角色配置权限。
- **组织事实**：`department-head` 是默认标签角色，`permissions` 为空；谁是部长完全由组织节点 `leadPersonId` 决定。`archiveMember` 清空节点 `leadPersonId` 后，部长权限自动失效。`assignIssue` 的部长授权是公司级改派，可改派任意未取消 Issue，但仍禁止任何 Agent 把 Issue 派给自己。
- **默认 owner**：`createIssue` 未传 `assigneeAgentId` 时，优先总部 `leadPersonId`，其次按 `organization.nodes` 顺序第一个 active 节点负责人；旧公司仍可回退 active `task-supervisor`。两者都没有时返回 `invalid_state`，提示先创建部门与部长。
- **HR 建部门流程**：HR 成立部门时先创建 `department-head` 部长成员，再 `updateOrgNode` 设为该节点 `leadPersonId`，然后创建其他成员；这是部门成立流程的一部分，不向用户确认，也不新增“原子创建部门+部长”的服务端接口。
- **秘书派单**：秘书继续使用 `company_org.organization` 返回的 `responsibilities`、`orgPath` 与节点 `leadPersonId`，按“目标节点负责人 → 最近 active 祖先节点负责人 → 继续访谈/追问用户”找负责人，不再回退任务主管，也不新增查询接口。
- **兼容**：旧公司的 `task-supervisor` 角色、成员、默认 owner 回退和公司级改派能力原样保留；不做静默迁移。UI 新成员岗位下拉不再提供任务主管，但历史消息标签保留。
- **边界**：不新增 MCP 操作、通知类型、状态机、调度器或工作流引擎；部长不是新的硬编码权限角色。
- **状态**：生效中

## 16. 会话存储只使用显式 url + token（2026-11-03）

- **决策**：移除 `SharedSqldProvider` / `ExplicitFirstStoreProvider` 与 `COMPANY_SQLD_*` 本地 sqld 自动供给。会话存储的唯一来源是 `COMPANY_WASM_STORES_FILE` 指向的宿主私有 JSON：`stores` 精确匹配 `(companyId, agentId)`，未列出的 scope 可用 `default` 回退。
- **启动拒绝**：`COMPANY_SQLD_BINARY`、`COMPANY_SQLD_ROOT`、`COMPANY_SQLD_PORT`、`COMPANY_SQLD_START_TIMEOUT_MS` 任一非空时，`createApplication` 直接抛出清晰错误；不启动 sqld、不签 JWT、不读取旧的 sqld 根目录，避免旧配置静默回退。
- **不变语义**：既有端点、`wasm-sqld-v1` backend identity、`runtime/wasm-stores` binding、endpoint 变更拒绝与 Session 恢复语义保持不变。未配置 stores 文件时应用仍可启动，但 Session 解析以 `wasm_store_not_configured` 失败；health 明确显示 `storage.storesFile` 为 `configured` 或 `missing`。
- **测试与 e2e**：真实 runtime、HTTP/MCP 集成与 live E2E 均使用外部显式端点（`COMPANY_TEST_STORE_URL/TOKEN`、`COMPANY_TEST_INTEGRATION_STORES_FILE`、`COMPANY_WASM_STORES_FILE`）；脚本与测试不再安装、启动或检查本地 sqld，存储服务由调用者提供。
- **状态**：生效中
