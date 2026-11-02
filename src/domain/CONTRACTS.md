# Business interface contracts

`CompanyDomain` is the single application boundary; its context is constructed from a server-authenticated user cookie or an Agent's randomly generated bearer credential. Tool input must never select `type`, caller `id`, `companyId`, or role. Role authority is resolved from the fixed Agent binding and Company role permissions. Other than initial Company setup, all operations are scoped to an existing Company.

## Storage and normal concurrency

Every mutation requires a stable `requestId` (letters, numbers, `_`, `-`, max 96). Replay by the same caller and operation returns the prior result; reuse for different input is `idempotency_conflict`. Mutations serialize per Company; provisioning also locks the globally unique Agent ID. Input `version` is required on replacement/patch operations and stale versions are `version_conflict`. Append-only operations (create, new comments, exact-question answers, new messages) are serialized and do not replace an older snapshot. A targeted question answer preserves all other questions and appends its history without requiring a whole-Issue version.

YAML uses the Document API. Specified fields are changed on the latest document; unknown fields and YAML comments survive. Markdown body changes are explicit. Atomic temp-file rename protects each document. Every successful business operation is committed to the Company's local Git repository, and Agent configuration changes to the separate personal repository. The implementation does not claim a cross-file crash transaction, replay log, or cross-process recovery system. Initialization records complete/failed status and permits an identical request to retry incomplete provisioning; previously bound Agents are reused, never silently replaced with fake Sessions.

Only three custom MCP modules expose these services. Git, plain Markdown knowledge, and the official Workspace remain separate capabilities.

## Organization / internal Agent binding

- `createCompany`：仅用户可调用，输入 `name/goal?/config?/requestId`，禁止提交 `id`。后端以可信调用者的 `type/id` 和 `requestId` 的 SHA-256 前 32 位生成 `c-` 前缀的公司 ID，不使用显示名称或公司作用域；相同调用者、请求和输入重试复用公司与已完成绑定，改变输入仍报 `idempotency_conflict`。现存公司目录和 ID 不变。通过注入的 runtime port 创建总部、HR、任务主管、流水线、知识目录、个人文件与真实 Session 绑定；仅在两个绑定都成功后返回 `{company,organization,groups,agents}`，调用方使用返回的 `company.id`。runtime 失败向上传递。新公司直接写 `organization.yaml`（headquarters 根节点）与 roster v2，不写 `groups.yaml`；人员 `agent.yaml` 不含 `groupId`。
- `createCompany` 的 runtime 使用 WASM 与宿主自动供给的单一共享本地 sqld（显式 store 绑定优先）。缺配以 `wasm_store_not_configured` 明确失败，宿主 `runtime/store-requests/<scope-hash>.json` 提供实际生成的 `companyId/agentId`；旧 native Session 无可信 WASM backend binding 时拒绝恢复、不迁移或替换。未确认的 Session 创建保留 `creating` 标记并拒绝自动重建；已完成可信 binding 的领域重试恢复相同 Session。
- `createGroup`: HR/user, `id/name/responsibilities/requestId` plus optional `parentId/kind/order`; compatibility alias of `createOrgNode`.
- 组织存储：`organization.yaml` 保存 `{schema:"company-org/v1",version,nodes[],placements[]}`；`roster.yaml` v2 只保存 `{agentId,status,joinedAt}`。`organization()` 与 `members()` 的 `groupId`/`orgPath` 从 placement 派生，不读取人员旧字段。没有 `organization.yaml` 的旧公司从 `groups.yaml` + roster v1 在内存合成投影；只读请求不落盘。首次组织写升级为 `organization.yaml` + roster v2，保留两个既有根节点且不互相挂接，不改写 `agent.yaml`/`groups.yaml`。
- `createOrgNode`: user/HR, `id/name/kind?/parentId?/order?/responsibilities?/leadPersonId?/requestId`。父节点必须存在且 active；同级 `order` 唯一，缺省追加末尾；最大深度 16。`updateOrgNode` 另外接受 `expectedVersion`，校验自指/环与重挂后的深度（不能把节点挂到自身或子树下）；`deleteOrgNode` 只删空叶子，非空必须提供 `reassignTo` 并先迁移该节点及子树的全部 placement；`archiveOrgNode` 要求**整棵子树**没有 active 子节点且没有任何 placement（否则 409 `org_node_not_empty`），归档后不再接收 placement。
- `createMember`: authenticated HR Agent only, `agentId/name/groupId?/role/responsibilities/systemPrompt?/config?/requestId`. `groupId` 是可选初始 placement；节点必须 active，`role` 必须在 `company.yaml.roles` 中存在。Agent ID 全局唯一；人员文件与目录不按部门嵌套。HR 可设置 `config.modelProfile`（model-library profile id，`""` 继承默认）与 `config.modelAlias` 及角色 `responsibilities`/`instructions`；provider、baseUrl、apiKeyEnv、MCP、workspaceRoots 与保留的 settings 仍只能由用户配置。
- `updateMember`: user only, `agentId/name?/responsibilities?/systemPrompt?/version/requestId`。编辑固定 Agent 的展示名、职责与专属提示词。Agent ID 与访问角色不可变；组织归属由组织树独立管理。它原子更新 `agent.yaml`，只替换 `CLAUDE.md` 中宿主托管块，保留自由记忆；不触碰已保存运行配置，也不要求重启。固定 Session 保持冻结的系统提示词。
- `moveMember`: user/HR, `agentId/nodeId/title?/order?/expectedVersion/requestId`。只写 `organization.yaml`（旧公司首次写同时升级 roster v2），更新 placement 的 `previousNodeId/movedAt/movedBy/version`；相同 requestId 或相同目标幂等 no-op；版本不匹配 409。写前/写后校验 `agent.yaml`、`CLAUDE.md`、`.mcp.json`、token、`sessionId`、directory、binding、effective-config、Workspace 目录标识、Agent Git HEAD/状态与 roster 条目；不一致恢复 organization 原文并报 `integrity_violation`。不改目录、agentId、role、Session、MCP、IM、Issue、权限，不 wake、不发 IM、不提交 Agent Git。
- `archiveMember` / `restoreMember`: user/HR, `agentId/expectedVersion/requestId`（restore 可选 `nodeId`）。归档移除 placement、清除节点负责人并把 roster 标为 archived；身份与 token 文件保留，但 `access`/`authenticateAgent` 拒绝。`restoreMember` 只接受 archived 成员（active 成员报 409 `member_not_archived`，改节点应走 `moveMember`），恢复只改 roster/placement，不重建 Session；不传 `nodeId` 时成员恢复为 active 但未分配，组织 UI 的“未分配成员”区必须可见并可移动/归档/编辑。恢复不会绕过 `moveMember` 的人员/会话完整性自检，因为不存在第二条“active 成员改 placement”路径。
- 生命周期权限假设（用户仅明确授权 move=user+HR）：`createOrgNode/updateOrgNode/deleteOrgNode/archiveOrgNode/archiveMember/restoreMember` 目前都使用 user+HR。保持现状待产品确认；若按最小授权收紧，应至少把 delete/archive/restore 限制为 user。
- `setRolePermissions`: HR/user, `role/permissions/version/requestId`; phase one only supports `issue.create`.
- `getAgent`, `workspace`: user or that same Agent only. `members` and Agent-context `organization` never expose private directories, Sessions, tokens or other members' system prompts.
- `saveAgentConfiguration`: user only, versioned saved config; validates `modelProfile` (safe id or `""`) and `modelAlias` (four tiers) and `workspaceRoots` through the same schema; a profile that does not exist is not rejected at save time and surfaces as a runtime diagnostic. Retired model fields (`model/models/provider/baseUrl/apiKeyEnv`) are rejected with `invalid_input` and a hint to use `config.modelProfile`; other unknown keys keep passthrough behavior. It does not touch effective config or a running instance. `markAgentConfigurationApplied` is called internally only after explicit successful restart and checks the saved config revision. Protected Company/default Workspace MCP identities cannot be replaced by config, and `config.settings` is reserved rather than spread into runtime settings.

## Issues, comments and decisions

- `createIssue`: user or a role with `issue.create`; title/body/summary; always `triage` assigned to task supervisor, never creator by assumption. Forbidden attempts create no task file.
- `updateIssue`: current responsible Agent/user; versioned patch limited to title, summary, progress, body, status, plan/code/worktree refs. Other fields require dedicated operations. Independent plans/worktrees cannot be reused across Issues. Current-code delivery gates apply to accepted/verifying/ready_merge; no progress text inference.
- `assignIssue`: task supervisor/user; versioned classification, selected existing pipeline, current owner and collaborators; records handoff history. Cannot reassign canceled work. Archived members are rejected with 409 `member_archived` as new owners or collaborators; `members()` still includes archived rows for organization/history display.
- `cancelIssue`: current owner/user, version/reason required; existing artifacts and comments survive, later results cannot revive it.
- `comments/addComment/updateComment`: user and related Agents. Server assigns ID/author/time; only the author may edit. Comments never advance state. Cursor pagination uses stable append ordering.
- `askDecision`: current owner/user, versioned append of a stable Q number.
- `answerDecision`: user only, exact Issue ID + question ID, appends answer/history and a comment; does not automatically process or clear the question.
- `resolveDecision`: current responsible Agent only; pending question must have a user answer. Marks answered and recomputes `needs_user` immediately.
- `withdrawDecision`: current owner/user, versioned; late answers remain history without reopening.

## Preview and verification

`savePreview` requires Preview role or existing batch owner (or user), a version for edits, current ownership of every Issue whose state is changed, independent plan/worktree references, branch, current per-Issue code refs, http(s) environment URL and per-Issue checklists. All validation happens before business documents are changed. Batch changes retain prior acceptance/verification history; changed code does not inherit old conclusions.

`acceptPreview` is user-only, identifies batch version + Issue + exact current code, stores checklist/evidence, appends a comment and advances only that Issue (or returns it to plan/code).

`recordVerification` is current owner/user, only after current-code user acceptance. Kind is `ci` or `review`; boolean result and evidence are mandatory. It records actual supplied conclusions, not a simulated CI executor. Both latest conclusions for the current code must pass before the owner can set `ready_merge`, which is never “merged”. CI execution and review are performed by the Agent using real Workspace/project tools.

## IM

`ask/reply` require a real Agent identity; users instruct Agents through Chat rather than impersonating them. Participants must belong to the same Company. New `ask` recipients must be active members: an archived recipient is rejected with 409 `member_archived`. Messages are committed before the nonblocking injected work delivery begins. `saved`, `delivered`, `failed`, `unknown`, and an explicit reply are different facts. `delivered` is prompt admission only; `failed` is confirmed not sent; `unknown` is an attempted delivery with an unconfirmed outcome and is never auto-resent. Missing credentials or a confirmed pre-send failure become `failed` with a code/disposition and an error, never a successful delivery. Replayed requests do not redeliver already-delivered or pending messages.

`thread/inbox`: `thread` is participant-scoped, while `inbox` is self-scoped for Agents (requesting another Agent's `agentId` is `forbidden` and must use `thread`). The user may inspect the selected Agent's records. Only the asking Agent can `closeThread` as resolved/withdrawn. Late replies are retained and do not reopen threads. IM creates neither Issue nor Session. There is no group chat/broadcast, recovery queue or additional work MCP.

## Events and errors

Successful writes call `onChange({companyId,kind,id?,agentIds?})` after commit for the existing resource/subscription adapter. Delivery status changes emit separate events; events are not a wakeup mechanism. Real work delivery uses the injected port.

Stable error codes include `forbidden`, `not_current_owner`, `version_conflict`, `idempotency_conflict`, `not_found`, `invalid_input`, `terminal_issue`, `missing_acceptance`, `missing_verification`, `stale_evidence`, and `shared_issue_artifact`. A runtime provisioning failure remains an error, not a placeholder member.

## Host capability boundary

An HR Agent may define a new member's model-library profile (`modelProfile`) and active tier (`modelAlias`), responsibilities and instructions. It cannot grant provider endpoints/credential selectors, external MCP processes or filesystem roots through `createMember`; those are trusted user configuration, not a business approval phase. Unsupported capability keys are rejected before creating files or calling the runtime.

The generated `<agent>/.env` is Git-tracked; the runtime never reads it for model resolution. Provider endpoint/credential values and tier model IDs come only from the trusted host process environment, referenced by name from the host-owned `model-library.yaml` (plus user-owned `modelProfile`/`modelAlias` in `agent.yaml`). An explicit Agent restart therefore cannot redirect the host credential through this file. Agent tools now run locally without an OS sandbox, so this is a runtime rule, not a filesystem permission boundary.

Personal repositories are Agent-writable, including `.git/hooks`, `.git/config`, fsmonitor commands and clean filters. Host-triggered Git operations on an Agent repository run the actual `/usr/bin/git` directly as the host user, with a minimal environment rather than host secrets. There is no OS isolation: hooks and filters can access whatever the host user can access. Company business repositories retain the trusted host Git path.
