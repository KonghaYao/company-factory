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

- **决策**：继续使用 `@peri-code/sdk` 0.3.0 的 WASM 运行时，不替换为原生 Peri ACP / child-process 传输。永不迁移。
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
