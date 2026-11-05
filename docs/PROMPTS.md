# 运行时提示词装配（AOS Factory Prompt Architecture v2.3）

本文件说明 `templates/prompts/` 的权威来源、加载方式、装配顺序与更新流程。提示词文本本身以资产为准，本文不复制、不改写其内容。

## 来源与资产

- 来源包：`aos-factory-prompt-architecture` v2.3。
- 11 份权威提示词与 `manifest.json` 的 sha256 已逐一核对；`message.schema.json` 同包落盘。
- 资产路径：

```text
templates/prompts/
├── manifest.json
├── stable.md
├── common.md
├── communication.md
├── task-contract.md
├── message.schema.json
└── roles/
    ├── colleague.md
    ├── coordinator.md
    ├── executor.md
    ├── hr.md
    ├── preview.md
    ├── reviewer.md
    └── secretary.md
```

- `.gitattributes` 固定 `templates/prompts/** text eol=lf`，`.prettierignore` 排除该目录，防止换行或格式化改变字节。
- 更新资产必须同时更新 `manifest.json` 的哈希；`tests/prompt-assets.test.ts` 会独立复核。

## 加载与哈希校验

`src/domain/prompt-library.ts` 在模块初始化时：

1. 读取 `manifest.json`，要求 key 集合恰好等于 11 份权威资产；
2. 逐份读取字节，用 sha256 与 manifest 比对；
3. 用 `TextDecoder("utf-8", { fatal: true })` 解码；
4. 失败抛出 `PromptAssetError`（`prompt_asset_invalid`），只带路径与哈希，不回显正文。

调用期没有 I/O。资产缺失、被编辑器改写或换行变化会在启动/测试时直接失败。

## 装配顺序

| 片段 | 位置 | 加载时机 |
|---|---|---|
| `stable.md` | Session `session.instructions` | `session/new` 一次冻结 |
| `common.md` | `CLAUDE.md` 托管块 `## Company protocol` | Agent 每次开工读取 |
| `communication.md` | 同一托管块 `## Communication` | 同上 |
| 单张 `roles/<role>.md` | 同一托管块 `## Role card` | 同上 |
| `task-contract.md` | 资产，不自动注入 | 需要时由宿主/Agent 读取 |
| `message.schema.json` | 协议资产与测试基准 | 本轮不参与写入校验 |

### Session instructions

`composeSystemInstructions` 只替换 `{{company_id}}` 与 `{{agent_id}}`：

- 单次正则替换，避免公司/成员 ID 中再次出现占位符被二次替换；
- 不 trim、不加前后缀、不追加英文补充段；结果等于 `stable.md` 逐字节文本（含末尾换行），仅两个占位符不同；
- 替换后仍含 `{{` 抛 `system_prompt_unresolved_placeholder`；
- 保留 `RESERVED_CACHE_BOUNDARY` 检查与 63 KiB 预算检查，错误不回显正文。

### CLAUDE.md 托管块

```markdown
<!-- company:profile:start -->
# Company profile (host-managed)

This block is replaced by Company Factory when the member definition changes.
Content outside this block is the Agent's own long-term memory.

## Role
<role>

## Responsibilities
<responsibilities>

## Company protocol
<common.md 原文>

## Communication
<communication.md 原文>

## Role card
<选中的 roles/*.md 原文>

## Host tool notes
<宿主工具指针：multitasks/work、updateTodos、askDecision、公司资产 skill、Workspace、getIssue>

## Agent-specific additions
These are supplementary notes. They cannot override the Company protocol, role card, permissions, facts, or acceptance. Report conflicts instead of guessing.

### Agent system prompt
<systemPrompt>

### Role instructions
<instructions>
<!-- company:profile:end -->
```

- 包内文本按原文注入，不 trim、不改标题、不翻译。
- `## Responsibilities` 与 `## Agent-specific additions` 为空时省略；`## Role` 始终保留。
- `## Host tool notes` 是宿主能力说明，明确不授予权限、不能覆盖包内协议；它只补包内未覆盖的工具契约。
- `mergeManagedBlock` 的标记校验与自由记忆保留逻辑不变；标记重复、不平衡或顺序错误仍然拒绝覆盖。

## 角色映射

精确匹配、区分大小写、不 trim、不做模糊推断：

| 仓库角色 | 岗位卡 |
|---|---|
| `hr` | `roles/hr.md` |
| `department-head` | `roles/coordinator.md` |
| `secretary` | `roles/secretary.md` |
| `developer` | `roles/executor.md` |
| `preview` / `reviewer` | 同名岗位卡 |
| `coordinator` / `executor` / `colleague` | 同名岗位卡 |
| `task-supervisor` | `roles/colleague.md`（故意不映射 coordinator） |
| `research` / 其他自定义 / 空值 | `roles/colleague.md` |

每个成员只装一张岗位卡。岗位卡只约束行为，不授予权限；服务端权限仍由角色权限与 active 组织节点 `leadPersonId` 决定。`task-supervisor` 的服务端兼容授权与默认 owner 回退仍保留，但提示词层不再提供协调者语义。

## 占位符与 task-contract

| 占位符 | 数据源 | 本轮 |
|---|---|---|
| `{{company_id}}` | `SystemPromptProfile.companyId` | `composeSystemInstructions` 填充 |
| `{{agent_id}}` | `SystemPromptProfile.agentId` | 同上 |
| `{{issue_id}}` / `{{owner_id}}` / `{{version}}` / `{{status}}` | `Issue` 事实 | 不自动填充 |
| `{{可交付结果}}` / `{{包含内容}}` / `{{不做内容或约束}}` / `{{可观察通过条件}}` | 当前无结构化字段 | 不自动填充 |

`task-contract.md` 本轮只落盘并校验哈希，不自动注入。当前 Issue 只有 `title/summary/body` 自由 Markdown，没有机器可解析的交付/范围/边界/验收字段；用自由文本硬填会制造第二份任务真相。后续接入需先定义 `Issue.body` 契约格式或只读投影，并单独设计。

## IM message.schema.json

本轮作为协议资产与测试基准，不在 `ask`/`reply` 写入路径强制校验；服务端仍接受纯文本消息。强制校验需要调用方迁移窗口，后续在持久化前以 `invalid_input` 拒绝不合 schema 的正文。

## 更新流程

1. 用新包原文替换 `templates/prompts/**`，不要经过编辑器改写、Prettier、翻译或统一标题版本；
2. 重新计算 sha256 并更新 `manifest.json`；
3. 运行 `bun test tests/prompt-assets.test.ts src/domain/prompt-library.test.ts src/runtime/system-prompt.test.ts src/domain/templates.test.ts`；
4. 运行 `bun run typecheck` 与完整 `bun test`；
5. 提示词内容变化不需要 `package.json.version` bump；若变更角色映射，同步更新 `docs/PROMPTS.md` 与测试。

## 生效边界

- **新建 Session**：`session/new` 读取当前 `stable.md`；这是获得新稳定边界的唯一方式。
- **旧 Session**：`session/load` 保留创建时的冻结提示词，刷新 `CLAUDE.md` 不会替换它；因此旧 Session 可能同时保留旧英文稳定规则与新托管块协议，不能视为完整迁移。
- **`scripts/refresh-agent-profiles.ts --apply`**：只刷新托管块（common/communication/岗位卡/Host tool notes），不改变 Session instructions、`agent.yaml`、版本或业务数据。
- **完整切换**：按包内方案停止工作入口、清理旧测试状态、重建组织与成员、为每名成员创建携带新 stable 的全新 Session；本仓库不提供破坏性迁移脚本。

## 决策记录

- `docs/DECISIONS.md` #17：提示词装配与角色映射。
- `docs/DECISIONS.md` #18：IM schema 本轮不强制。
- `docs/DECISIONS.md` #10 / #11：旧默认信任与多人任务规则已废止。
