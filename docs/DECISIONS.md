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
