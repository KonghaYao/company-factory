# Business interface contracts

`CompanyDomain` is the single application boundary; its context is constructed from a server-authenticated user cookie or an Agent's randomly generated bearer credential. Tool input must never select `type`, caller `id`, `companyId`, or role. Role authority is resolved from the fixed Agent binding and Company role permissions. Other than initial Company setup, all operations are scoped to an existing Company.

## Storage and normal concurrency

Every mutation requires a stable `requestId` (letters, numbers, `_`, `-`, max 96). Replay by the same caller and operation returns the prior result; reuse for different input is `idempotency_conflict`. Mutations serialize per Company; provisioning also locks the globally unique Agent ID. Input `version` is required on replacement/patch operations and stale versions are `version_conflict`. Append-only operations (create, new comments, exact-question answers, new messages) are serialized and do not replace an older snapshot. A targeted question answer preserves all other questions and appends its history without requiring a whole-Issue version.

YAML uses the Document API. Specified fields are changed on the latest document; unknown fields and YAML comments survive. Markdown body changes are explicit. Atomic temp-file rename protects each document. Every successful business operation is committed to the Company's local Git repository, and Agent configuration changes to the separate personal repository. The implementation does not claim a cross-file crash transaction, replay log, or cross-process recovery system. Initialization records complete/failed status and permits an identical request to retry incomplete provisioning; previously bound Agents are reused, never silently replaced with fake Sessions.

Only three custom MCP modules expose these services. Git, plain Markdown knowledge, and the official Workspace remain separate capabilities.

## Organization / internal Agent binding

- `createCompany`：仅用户可调用，输入 `name/goal?/config?/requestId`，禁止提交 `id`。后端以可信调用者的 `type/id` 和 `requestId` 的 SHA-256 前 32 位生成 `c-` 前缀的公司 ID，不使用显示名称或公司作用域；相同调用者、请求和输入重试复用公司与已完成绑定，改变输入仍报 `idempotency_conflict`。现存公司目录和 ID 不变。通过注入的 runtime port 创建总部、HR、任务主管、流水线、知识目录、个人文件与真实 Session 绑定；仅在两个绑定都成功后返回 `{company,groups,agents}`，调用方使用返回的 `company.id`。runtime 失败向上传递。
- `createCompany` 的 runtime 使用 WASM 与宿主自动供给的单一共享本地 sqld（显式 store 绑定优先）。缺配以 `wasm_store_not_configured` 明确失败，宿主 `runtime/store-requests/<scope-hash>.json` 提供实际生成的 `companyId/agentId`；旧 native Session 无可信 WASM backend binding 时拒绝恢复、不迁移或替换。未确认的 Session 创建保留 `creating` 标记并拒绝自动重建；已完成可信 binding 的领域重试恢复相同 Session。
- `createGroup`: HR/user, `id/name/responsibilities/requestId`; no move/delete API.
- `createMember`: authenticated HR Agent only, `agentId/name/groupId/role/responsibilities/systemPrompt?/config?/requestId`. Group and role must exist. Agent ID is globally unique and department immutable. HR may set `config.model`, `config.modelAlias` and `config.models` (four tiers) plus role `responsibilities`/`instructions`; provider, baseUrl, apiKeyEnv, MCP, workspaceRoots and reserved settings remain trusted user-only configuration.
- `updateMember`: user only, `agentId/name?/responsibilities?/systemPrompt?/version/requestId`. Edits the fixed Agent's definition and dedicated system prompt. Agent ID, department and role remain immutable. The edited role text and system prompt are supplied with the next input, without touching the saved runtime configuration or requiring a restart.
- `setRolePermissions`: HR/user, `role/permissions/version/requestId`; phase one only supports `issue.create`.
- `getAgent`, `workspace`: user or that same Agent only. `members` and Agent-context `organization` never expose private directories, Sessions, tokens or other members' system prompts.
- `saveAgentConfiguration`: user only, versioned saved config; validates `modelAlias` (four tiers), strict `models` tier keys and `workspaceRoots` through the same schema. It does not touch effective config or a running instance. `markAgentConfigurationApplied` is called internally only after explicit successful restart and checks the saved config revision. Protected Company/default Workspace MCP identities cannot be replaced by config, and `config.settings` is reserved rather than spread into runtime settings.

## Issues, comments and decisions

- `createIssue`: user or a role with `issue.create`; title/body/summary; always `triage` assigned to task supervisor, never creator by assumption. Forbidden attempts create no task file.
- `updateIssue`: current responsible Agent/user; versioned patch limited to title, summary, progress, body, status, plan/code/worktree refs. Other fields require dedicated operations. Independent plans/worktrees cannot be reused across Issues. Current-code delivery gates apply to accepted/verifying/ready_merge; no progress text inference.
- `assignIssue`: task supervisor/user; versioned classification, selected existing pipeline, current owner and collaborators; records handoff history. Cannot reassign canceled work.
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

`ask/reply` require a real Agent identity; users instruct Agents through Chat rather than impersonating them. Participants must belong to the same Company. Messages are committed before the nonblocking injected work delivery begins. `saved`, `delivered`, and an explicit reply are different facts. Missing credentials or delivery failure become `failed` with an error, never a successful delivery. Replayed requests do not redeliver already-delivered or pending messages.

`thread/inbox` are participant-scoped for Agents; the user may inspect the selected Agent's records. Only the asking Agent can `closeThread` as resolved/withdrawn. Late replies are retained and do not reopen threads. IM creates neither Issue nor Session. There is no group chat/broadcast, recovery queue or additional work MCP.

## Events and errors

Successful writes call `onChange({companyId,kind,id?,agentIds?})` after commit for the existing resource/subscription adapter. Delivery status changes emit separate events; events are not a wakeup mechanism. Real work delivery uses the injected port.

Stable error codes include `forbidden`, `not_current_owner`, `version_conflict`, `idempotency_conflict`, `not_found`, `invalid_input`, `terminal_issue`, `missing_acceptance`, `missing_verification`, `stale_evidence`, and `shared_issue_artifact`. A runtime provisioning failure remains an error, not a placeholder member.

## Host capability boundary

An HR Agent may define a new member's model, per-tier model overrides (`modelAlias`/`models`), responsibilities and instructions. It cannot grant provider endpoints/credential selectors, external MCP processes or filesystem roots through `createMember`; those are trusted user configuration, not a business approval phase. Unsupported capability keys are rejected before creating files or calling the runtime.

The generated `<agent>/.env` is Git-tracked but mounted read-only in the Workspace sandbox; the runtime never reads it for model resolution. `PERI_MODEL_PROVIDER`, `PERI_MODEL_BASE_URL`, `PERI_MODEL_API_KEY`, `PERI_MODEL_ID` and tier IDs come only from the trusted host process environment (plus user-owned `modelAlias`/`models`/`baseUrl`/`apiKeyEnv` in `agent.yaml`). An explicit Agent restart therefore cannot redirect the host credential through an Agent-writable file.

Personal repositories are Agent-writable, including `.git/hooks`, `.git/config`, fsmonitor commands and clean filters. Consequently **all host-triggered Git operations on an Agent repository** use the actual `/usr/bin/git` inside the same Linux bubblewrap namespace as the official Workspace. The child receives a minimal environment, not host secrets. This protects initialization, config writes, add/status/commit and history equally; simply disabling commit hooks would be insufficient. Missing OS isolation is an explicit failure. Company business repositories retain the trusted host Git path. The real-process regression `src/storage/git-sandbox.test.ts` exercises malicious pre-commit, fsmonitor and filter commands, verifies their permitted inside-directory writes and denies outside writes and inherited host secrets.
