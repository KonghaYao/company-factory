# 决策记录（DECISIONS）

本文件只记录用户已明确拍板的决策，不记录推测、未确认方案或实现细节。日期均为 2026-11-01；以下条目均为用户拍板。

状态说明：**永久** 表示用户明确设为不可回退的长期约束；**生效中** 表示当前生效、尚未声明为永久。

## 1. 永不迁移到原生 `peri acp` 子进程

- **决策**：继续使用 `@peri-code/sdk` 0.3.0 的 WASM 运行时，不替换为原生 Peri ACP / child-process 传输。永不迁移。
- **理由/约束**：用户确定运行时边界；后续改造不得突破该边界。
- **影响**：
  - MCP 仍由宿主读取 `~/.company/agents/<agentId>/.mcp.json`（公司 MCP 为 HTTP），并在显式重启时注入。
  - workspace 继续使用 `peri mcp-start workspace --stdio`，由沙箱托管。
  - SDK WASM 不 spawn 任意 stdio MCP。
  - 未来 sandbox/MCP 改造（例如 `none` sandbox + 适配器）必须落在 SDK WASM 边界内。
- **状态**：永久

## 2. 系统提示词更新语义：固定 Session

- **决策**：`role` / `responsibilities` / `systemPrompt` 只在会话创建时写入 `session.instructions`；可变职责与长期记忆写入 `CLAUDE.md`（托管块 + 自由记忆区），由 Agent 开工前读取。旧 Session 不重建。
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
