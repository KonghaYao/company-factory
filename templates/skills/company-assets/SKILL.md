---
name: company-assets
description: "Use before reading, writing, or citing Company data: Company public facts, shared knowledge (knowledgebase), Agent-private resources, and host secrets. Defines the authoritative interface, write rules, and conflict handling for each. 公司资产、公共知识、私有资源、宿主秘密的边界与读写规则。"
---

# Company assets

## How to load this skill

- 首选：如果技能目录（catalog）列出了 `company-assets`，用 catalog 中的精确名称调用 `SkillTool`。名称可能是 `company-assets`，也可能是带 server 前缀的 `company_org:company-assets`。
- 保证路径：读取 `company_org` MCP 的只读 resource：
  `mcp_read_resource(server_name="company_org", uri="skill://company-assets/SKILL.md")`。
  如果客户端使用等价的 MCP 资源读取工具，URI 相同。
- 这是只读、全员共享的 MCP 资源；没有 per-Agent 文件，也不要寻找或创建本地 skill 副本。
- 资源读取失败时，报告错误并请 Owner 检查 `company_org` MCP；不要猜正文，也不要用旧笔记替代。

## TL;DR

- 公司公共事实 → 只走 `company_org` / `company_tasks` / `company_im`。
- 公司公共知识 → `knowledgebase/`，先搜索、优先更新、保留他人内容、不写秘密。
- 公司公共定义/模板 → Agent 只读；Owner/HR 通过 MCP 管理。
- Agent 私有 → 自己的 Workspace、`CLAUDE.md` 自由记忆、个人 `tasks/`、Agent Git。
- 宿主秘密与 `.mcp.json` / `.env` / `agent.yaml` 中的凭据 → 不读、不复制、不写。
- 本 skill 只解释现有接口，不授予权限，不绕过角色校验。

## 1. Why this skill exists

公司资产是**公司公共数据**，不是任何 Agent 的私有资源，也不是草稿区。它需要能被其他成员安全依赖，因此“事实、知识、过程、私有内容、秘密”必须分开。

四个常见错误：

1. 把业务事实写成文件（例如直接改 `tasks/*.md` 的负责人或状态）。
2. 把私有内容或秘密写进共享知识。
3. 重复创建或覆盖别人维护的公共知识。
4. 把当前任务的产物、日志或聊天记录当成公司资产。

本 skill 是分类与读写规则的权威说明；与系统提示词冲突时，系统提示词和 MCP 授权优先。

## 2. The boundary

三层公共资产（公共事实 / 公共知识 / 公共定义），两类非资产（Agent 私有 / 宿主秘密），以及不属于公司资产的项目代码和外部资源。

| 类别 | 包含 | 读取 | 写入 / 权威接口 | 禁止 | 版本 / 冲突 / 幂等 |
| --- | --- | --- | --- | --- | --- |
| **公司公共事实** | 组织树、placement、角色权限；roster；Issue 标题/状态/负责人/流水线/todo/decision；评论；pipeline；Preview/验收/验证；IM 线程与消息；成员颜色 | `company_org.organization`；`company_im.members`；`company_tasks.listIssues` / `getIssue` / `comments` / `workspace` / `getPreview`；`company_im.inbox` / `thread`；按角色与参与范围 | **只通过** `company_org.*`、`company_tasks.*`、`company_im.*` MCP。变更带 `requestId`；版本化写入带 `expectedVersion`；todo 仅当前 owner；评论仅作者可编辑 | 直接改 `companys/<id>/{company.yaml,organization.yaml,roster.yaml,tasks/,comments/,pipelines/,previews/,im/}`；写 SQL；伪造 Git 提交；用 IM 代替 Issue；把聊天或回执当验收 | 服务端 CAS；同 `requestId` 精确重放；`version_conflict` 重读后重试；`idempotency_conflict` 不复用；评论与消息 append-only 去重 |
| **公司公共知识** | `knowledgebase/**` 的 Markdown；可复用的小型 SQL/脚本/图表文本；领域结论、接口与数据约定、操作手册、复盘、决策依据 | 所有成员；先用 `Grep`/`Glob` 搜同主题；绝对路径来自 `CLAUDE.md` 的 `## 公司资产（公共知识）`；Owner UI 根名「公司资产（公共知识）」 | **Workspace 文件工具**（Read / Edit / Write / Grep / Glob）；先读后写、优先更新、合并、保留他人内容 | 密钥、token、密码、连接串、个人隐私、客户敏感数据；任务日志、Issue/IM 全文、临时文件；大型二进制；近似重复文档；删除他人内容；在公司仓库运行 `git` | **无 CAS**；读后写、冲突重读合并；文件在 Company Git 工作树，但直接写入不自动 commit；需要版本化时请 Owner 通过文件视图提交 |
| **公司公共定义/模板** | `company.yaml`、`organization.yaml`、`roster.yaml`、`pipelines/*.md`、角色与权限、成员颜色 | 通过 MCP 快照或只读文件 | Owner/HR 通过 `company_org` / `company_tasks` MCP；Agent 只读 | Agent 直接编辑 YAML、模板或流水线；自建流水线文件；绕过角色与权限校验 | 公司版本/CAS；域提交 Company Git；Agent 无写入口 |
| **Agent 私有资源** | 固定 Session、Workspace、`CLAUDE.md` 自由记忆、个人 `tasks/`、`.claude/agents`、Agent Git、草稿/日志/实验、项目代码根 | 仅本人；宿主/Owner 运维可读；其他 Agent 禁止 | 本人通过 Workspace 与 `CLAUDE.md`；配置变更由 Owner 保存并显式重启 | 读取其他 Agent 目录；把私有内容写入 `knowledgebase/`、Issue 正文或 IM；在 `CLAUDE.md` 写密钥；把任务产物当公共知识 | Agent Git；自由记忆由 Agent 维护；`agent.yaml`/config 需 Owner 重启生效 |
| **宿主秘密** | `owner-token`、`model-library.yaml`、sqld `auth.key`/JWT、模型 API key/env、`runtime/effective-config/*.json`、`runtime/wasm-stores/*.json`、`runtime/store-requests/*.json`、诊断日志、OAuth token；Agent 目录内 `.mcp.json`、`.env`、`agent.yaml` 的 authToken | 仅宿主 | 仅宿主 | 读取、打印、复制、粘贴到 Issue/IM/`CLAUDE.md`/`knowledgebase`；在命令中使用；提交到 Git；把值写进“报告” | 不适用；发现即停止，只报告路径/类型，不回显值 |
| **非公司资产** | 项目代码、外部 URL、Preview 环境、用户主目录 | 按项目/工具规则 | 按项目/工具规则 | 未经审核发布为公共知识；把项目产物塞进 `knowledgebase/` | 按项目规则 |

备注：公共事实的“读取”仍受角色与参与范围限制；公共知识面向所有成员，但不因此包含敏感数据。

## 3. Decision order

每次读写前按顺序问：

1. **是秘密、凭据、个人或客户敏感数据吗？** → 不读、不复制、不写；只报告类型/路径。
2. **是别人必须作为事实来行动的公司状态吗？**（组织、成员、Issue、状态、负责人、todo、决策、评论、pipeline、Preview、验收、验证、IM）→ 走 `company_org` / `company_tasks` / `company_im` MCP。
3. **是可复用、其他成员做领域工作时该看的知识吗？**（结论、接口与数据约定、手册、复盘、决策依据）→ `knowledgebase/`。
4. **是当前任务的过程、计划、日志、实验或产物吗？** → Issue 评论/todo 或自己的 Workspace/项目目录，**不进** `knowledgebase/`。
5. **是个人的观察、偏好或经验教训吗？** → `CLAUDE.md` 托管块外的自由记忆。
6. **是公司定义或模板吗？** → Agent 只读；Owner/HR 通过 MCP 改。
7. **是项目代码或外部资源吗？** → 按项目规则；不自动成为公司资产。

一句话记忆：**事实走 MCP，知识进 knowledgebase，过程留 Issue/Workspace，经验留 CLAUDE.md，秘密永不出宿主。**

## 4. Company public facts

读取常用入口：

- 组织与成员：`company_org.organization`、`company_im.members`。
- Issue：`company_tasks.listIssues`、`getIssue`、`comments`、`workspace`、`getPreview`、`listPipelines`。
- IM：`company_im.inbox`、`company_im.thread`。

写入规则：

- 只通过三个 Company MCP；不要直接编辑 `companys/<id>/` 下的业务文件，也不要写 SQL/sqlite。
- 每个变更使用唯一 `requestId`；同一意图的相同重试才复用，不同输入复用会得到 `idempotency_conflict`。
- 版本化写入必须带 `expectedVersion`；收到 `version_conflict` 时重读当前事实、合并意图后再写，不盲目覆盖。
- todo 只有当前 Issue owner 可写，`note` 必填；服务端把 note 追加为普通评论并生成只读 `todo_snapshot`。
- 评论 append-only，只有作者可编辑；IM 用于指路和同步，多人交接必须写明 Issue ID 并要求在 Issue 登记过程。
- 写后读回或采用返回值；不要把“工具已启动”“聊天已回复”“通知已收到”当作验收或完成。

禁止：

- 直接改 `tasks/`、`comments/`、`im/`、`pipelines/`、`previews/` 或 `*.yaml` 来制造事实。
- 在业务库上执行 SQL，或伪造 Git 提交。
- 用 IM 代替 Issue 记录多人协作。

## 5. Company shared knowledge

`knowledgebase/` 只放其他成员可复用的公共知识。

**该写**：领域结论、接口/数据约定、操作手册、复盘、决策依据、可复用的小型 SQL 或脚本说明。

**不该写**：密钥、token、密码、连接串、个人隐私、客户敏感数据；任务日志、Issue/IM 全文、临时文件；大型二进制；与既有文档近似重复的内容；其他人的私有内容。

**根路径**：

- 优先使用 `CLAUDE.md` 的 `## 公司资产（公共知识）` 小节给出的绝对路径。
- 若该小节缺失，Agent 工作区根（`$COMPANY_HOME/agents/<agentId>`）到知识库的相对路径是 `../../companys/<companyId>/knowledgebase`。
- `## Company assets` 是规则摘要，不含路径，不要把它当路径。

**先搜再写**：

1. 用 `Grep`/`Glob` 搜主题和同义词。
2. 读最接近的 1–3 篇。
3. 优先更新既有 canonical 文档，不新建近似重复。

**路径与文档头**：

- 路径约定 `knowledgebase/<domain>/<topic>.md`；一个文件一个主题；文件名稳定。
- 已有目录（例如 `efficiency-research/`）沿用，不随意重命名或搬动。
- 建议在正文顶部写三行，不强制 YAML frontmatter：

  ```markdown
  - 适用范围：
  - 更新日期：YYYY-MM-DD
  - 来源：Issue <id> / <URL> / <实验>
  ```

**写入方式**：

- 已有文档优先 `Read` + `Edit`；`Write` 只用于新文档或完整重写，且必须先读。
- 写入前若发现文件已变化，重读并合并，保留他人内容。
- 不删除他人的段落或结论；不静默覆盖。

**冲突**：

- 两篇文档结论冲突时，不删除、不静默覆盖；在文档中加“分歧/待确认”小节并链接两边。
- 必要时用 `company_tasks.askDecision` 请 Owner 裁定。

**溯源**：

- 从任务产出的知识，在相关 Issue 加一条评论，写路径 + 一句话摘要。
- 不要把 Issue 全文复制进知识库；引用时给路径 + 适用范围。

**版本化限制**：

- 没有专用的知识写入 API；知识库就是普通 Markdown 文件，使用 Workspace 文件工具读写。
- 文件位于 Company Git 工作树，但 Agent 的直接写入**不会自动提交 Company Git**，也没有 CAS。
- 不要在 Agent 工作区或公司仓库运行公司 `git` 命令。
- 需要提交时，请 Owner 通过文件视图提交。

**敏感**：

- 密钥、token、密码、连接串、个人隐私、客户敏感数据、大型二进制一律不写；不确定是否敏感就不写。

## 6. Company definitions and templates

- 包括 `company.yaml`、`organization.yaml`、`roster.yaml`、`pipelines/*.md`、角色权限、成员颜色。
- Agent 只读；Owner/HR 通过 `company_org` / `company_tasks` 管理。
- 不自建流水线文件，不直接编辑 YAML 或模板，不绕过角色/权限校验。

## 7. Agent-private resources

- 包括固定 Session、Workspace、`CLAUDE.md` 自由记忆、个人 `tasks/`、`.claude/agents`、Agent Git、草稿/日志/实验、项目代码根。
- 仅本人可读写；其他 Agent 禁止读取。需要别人的结果时通过 Issue/IM 请求，不直接翻文件。
- 托管块是 host-owned，不编辑；自由记忆可写，但不写密钥。
- 私有内容不复制到 `knowledgebase/`、Issue 正文或 IM。

## 8. Host secrets

- 包括 `owner-token`、`model-library.yaml`、sqld key/JWT、模型凭据、`runtime/effective-config`、`runtime/wasm-stores`、`runtime/store-requests`、诊断日志、OAuth token。
- Agent 目录内 `.mcp.json`、`.env`、`agent.yaml` 的 authToken 也按秘密处理。
- 不读、不打印、不复制、不粘贴、不提交。
- 发现秘密出现在共享位置：停止使用、不回显值，只报告路径/类型并通知 Owner。
- 需要 MCP 能力时直接使用工具，不需要读取 `.mcp.json`。

## 9. Conflict, idempotency, evidence

- **事实**：`requestId` + `expectedVersion`；相同请求可精确重放；`version_conflict` 重读后重试；`idempotency_conflict` 不复用请求号。
- **知识**：无 CAS；读后写、合并；实质冲突记录并请 Owner 裁定。
- **证据**：写后读回或采用返回值；引用路径/Issue ID；不把计划、聊天、通知接收或工具启动当完成。

## 10. Before/after checklists

Before business write:

- [ ] 用 MCP，不写文件
- [ ] 读当前 version 和 owner
- [ ] 使用唯一 `requestId`；只有相同重试才复用
- [ ] 写后读回或采用返回值

Before knowledge write:

- [ ] 搜过同主题并读过最接近的文档
- [ ] 是其他成员可复用的知识，不只是我的任务
- [ ] 无秘密、隐私、客户数据或任务日志
- [ ] 更新 canonical 文档，不建重复
- [ ] 有来源、适用范围和日期

Before publishing anything:

- [ ] 不是别的 Agent 的私有内容
- [ ] 不是宿主秘密或凭据
- [ ] 不是大型二进制或生成产物

## 11. Anti-patterns and examples

反例与正例：

- ❌ 把 Issue 的完整过程复制到 `knowledgebase/issue-123.md`。
  ✅ 提炼可复用的结论或接口约定，并链接 Issue ID。
- ❌ 把调试日志、临时 SQL、实验数据放进 `knowledgebase/`。
  ✅ 日志留 Workspace；可复用的查询模式提炼成小文档。
- ❌ 把“我喜欢用 tabs”写进公司知识。
  ✅ 个人偏好留 `CLAUDE.md`；团队约定经确认后进 `knowledgebase/`。
- ❌ 直接编辑 `tasks/<issue>.md` 改状态。
  ✅ 用 `company_tasks.updateIssue` + `expectedVersion`。
- ❌ 把 `.mcp.json` 的 bearer 复制到 Issue 里“方便排查”。
  ✅ 只报告“token 鉴权失败”，不带值。
- ❌ 在 `knowledgebase/` 里建 `agent-<id>-notes.md`。
  ✅ 个人记忆留 `CLAUDE.md`；公共知识用主题命名。
- ✅ 一次 Issue 复盘 → 一篇 `knowledgebase/<domain>/<topic>.md` + Issue 评论链接。
- ✅ 一次调试 → 日志留 Workspace，可复用查询模式提炼成小文档。

## 12. Non-permissions

- 本 skill 不授予访问权限，不绕过角色检查，也不允许直接修改业务文件。
- 工具拒绝时不要寻找文件 workaround；报告事实并请 Owner 处理。
- 本 skill 不是 OS ACL，也不是文件系统强制隔离；它依赖每个成员遵守。Agent 工具仍以宿主用户身份运行，技术上可能访问宿主文件。目标是在正常工作中选对接口、不泄露秘密，而不是声称“阻止”了访问。
