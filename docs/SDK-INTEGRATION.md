# Peri / Workspace integration evidence

## Pinned upstream, inspected 2026-10-30

- `@peri-code/sdk@0.3.0`, npm `latest` at inspection, published 2026-10-29. npm gitHead/tag `73447b864f4fac20499eac36286cb6468c44e1dc`.
- npm tarball integrity: `sha512-oRmlNXmSaM9DhyvMJ8zi9m/jgc2wRpuAIusqOUWejzUEc9Ba0RMiClSEtaAdcashVH3EsEDyH6DZ3OqSTc+cqA==`.
- Official native **Peri 4.4.1**, release tag `agent-v4.4.1`, peeled commit `de1a93ab538b2a695c548b5460ced7371c8e7cc4`.
- Linux x86_64 release archive SHA256 verified: `f25d665d7f3119108d7e6dbc9dfa3f4309bee11206693262f300eb47e5ebbef8`.
- Current repository HEAD inspected: `421d653bd5910de752674a79e65030220d01f09e` (not a substitute for the pinned release).
- Official sources: [SDK](https://github.com/KonghaYao/peri/tree/sdk-v0.3.0/npm-packages/%40peri-sdk), [Peri release](https://github.com/KonghaYao/peri/releases/tag/agent-v4.4.1), [Workspace source](https://github.com/KonghaYao/peri/tree/agent-v4.4.1/mcp-packages/workspace).

The current default Workspace is a Rust builtin in the official Peri executable. There is **no** published `@peri-code/workspace` dependency. We do not invent one.

## 当前架构：WASM 与独立本地 sqld

一个 Bun HTTP 产品服务承载 UI、Web adapters 和三个自定义 Company HTTP MCP。主 Agent 使用 `@peri-code/sdk@0.3.0` 的 `ChatManager`、`ChatUserAction`、`ChatViewRegistry` 与 `ChatReplica`，`runtime.kind = "wasm"`。不启动 `peri acp`，不回退 native。SDK 随包 artifact 通过 `@peri-code/sdk/wasm-node` 的 `instantiatePeriWasm` 装载；每次 activation 独立提供 Node network/DNS hooks，SDK 负责 native/scheduler/ACP 生命周期，宿主封装等待网络 close/drain，Manager 关停还回收未进入 native.start 的端口。

每个 `(companyId, agentId)` 独立创建 `TursoStorage` 与 `ChatManager`。`store.storage = storage.storageConfig` 是 `{url,authToken}`，没有 `kind`；SDK 在 bootstrap 内注入该 store 与既有持久 UUID `machineId`。Manager 的只读 `database` 使用 scoped adapter，将 `getSession/listSessions` 限定为此 Agent 的可信 Session 与 cwd；数据库写入/schema 完全由 WASM Peri 负责，宿主不手写 Peri schema。

本地 SQLite 文件不等于 WASM storage API，但用户预先配置的本地 sqld/libSQL **HTTP** 端点可以作为连接。宿主配置 `COMPANY_WASM_STORES_FILE`（宿主所有、0600、非符号/硬链接、不得位于 Agent/知识库/项目/工具挂载范围），格式：

```json
{"stores":[{"companyId":"<BACKEND_GENERATED_COMPANY_ID>","agentId":"<AGENT_ID>","url":"http://127.0.0.1:<INDEPENDENT_SQLD_PORT>","authToken":"<HOST_ONLY_TOKEN>"}]}
```

也可通过 `createApplication({ storeProvider })` 注入 `resolve(scope)`，为当前后端生成的精确 scope 返回 `{url,authToken}`。仅允许明确回环 `127.0.0.1` / `[::1]` 的 HTTP 根端点；拒绝外域、userinfo、子路径、query、fragment。重复 scope 或跨 Agent 同端点被拒绝，IPv4/IPv6 同端口也保守视为冲突。token 只存在宿主和 SDK 内存，不进 Agent env/YAML、配置快照、manifest、日志或响应。sqld 磁盘路径和认证由用户准备；不自动安装/启动服务、不签 JWT、不建容器/云资源、不管理 namespace。

后端 ID 缺配流程：`runtime/store-requests/<scope-hash>.json` 记录无秘密的 scope。用户补齐此映射后以同一个 `requestId`、同样创建输入重试，不必猜 ID 或改成由用户选择公司 ID；已有领域初始化幂等逻辑复用完成的 Agent。绑定文件 `runtime/wasm-stores/<scope-hash>.json` 记录 backend `wasm-sqld-v1`、scope/cwd、规范化 endpoint hash（不含 token）和可信 Session ID。先独占写入 `creating` 标记，`createNewSession` 成功后原子写入 `bound`；若结果未确认，明确报错并保留标记，禁止自动新建。可信 binding 存在而业务 Agent 文件尚未完成时，provision 重试 load 同一 Session。

旧 native `sessions.db` 与 `sessionId` 原样保留；没有可信 WASM binding 的已有 Session 报 `legacy_session_backend`，不迁移、不写 native schema、不连接任意新端点隐式创建会话。端点 hash 改变、Session 缺失、cwd/Session/backend 不匹配都 fail closed；token 轮转不影响 endpoint 身份。`NativeSessionStore/Directory` 留作只读 legacy 代码，不再接入主路径。`TursoStorage` 无 close/dispose API，不伪造数据库关闭；每个 Manager、replica、view 和端口的关停失败会保留 handle 并上报未确认状态。

**热重载复用**：`bun --watch` 在同一进程内重跑模块，上一实例 spawn 的 sqld 仍是本进程的直接子进程。`SharedSqldProvider` 在端口被占用时，只复用 `binary`、`--db-path`、`--http-listen-addr` 与 manifest 全部匹配的**直接子进程**；不向候选进程发送任何凭据，也不终止无法确认归属的进程。缺省关闭路径不会终止这种复用进程，因此重载/重启不需要停掉共享 sqld。

## Chat transport: Peri `/api/chats` + WebSocket sync

聊天不再使用 `GET /api/agents/:id/chat` 轮询。服务端在 `src/server/peri/` 暴露 Peri 官方协议面，浏览器端在 `web/src/peri/` 运行 Peri 的 `ChatController` + `ChatReplica`：

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/api/chats?companyId=&agentId=` | 该 Agent 的目录（只读绑定，不 wake） |
| POST | `/api/chats` | 取得固定 Session 句柄；空 body 不创建新 Session |
| POST | `/api/chats/:chatId/actions` | `send` / `cancel` / `take_back` / `force_send` / `answer` / `load_earlier_history` |
| DELETE | `/api/chats/:chatId` | 重启同一 Session；运行中 409，不删除持久绑定 |
| GET | `/api/chats/:chatId/projection` | 只读投影（`messages` + `view`），供诊断与 live 验收 |
| GET | `/api/chats/:chatId/payload/:refId?bytes=` | 工具全文 |
| GET | `/api/chats/:chatId/sync` | WS：HELLO → SNAPSHOT/UPDATE → ACK |
| GET | `/api/projects` | 空项目目录（公司不暴露项目） |

- 公司策略：`create_new_session` 一律 400 `invalid_action`；`change_session` 只允许切到当前固定 Session；同 Session 的换绑是无操作（Peri 客户端对已绑定句柄仍按空句柄目标发送）。
- 鉴权顺序固定为 `AccessControl.user` → Agent 归属 → `chatId` 归属 → `views.attach`；WS 握手与其他 HTTP 请求走同一 Host/Origin/Cookie 检查。
- 脱敏：`ChatViewRegistry` 只 attach `ChatFactSource` 脱敏代理（`database.redact` 逐条 fact），服务端 replica 与浏览器收到同一份文档；Yjs 原文不直出。
- 旧 `/api/agents/:id/{chat,stop,answer,queue/*}` HTTP 路由已删除；`AgentService` 的同名方法保留给 IM/MCP 内部投递。`GET /api/chats/:chatId/projection` 是只读诊断/验收投影，替代旧 `/chat` 的消息读取；所有写操作仍必须走 `/actions`。
- `load_earlier_history` 翻到最早一页时，SDK 以 `HistoryPageUnavailableError("exhausted")` 表示分页终止；API 将其映射为成功空页（202，`applied: 0, nextCursor: null, exhausted: true`），不当作 500 存储故障。
- `DELETE /api/chats/:chatId` 与显式重启先按 SDK 契约重试一次 `ChatCloseIncompleteError`：WASM 运行时的 sqld Hrana HTTP stream 会在空闲后过期，重试会建立新 stream 完成关闭；只有重试仍失败才保留 handle 并返回 503 `wasm_cleanup_unconfirmed`。
- vendor 来源、补丁与基线 commit 见 `web/src/peri/VENDOR.md`。

## Fixed Sessions and configuration

- Provision executes actual `ChatUserAction.createNewSession`; the returned persistent UUID is written into the Agent's business record.
- Provision 在可信 WASM binding 完成后关闭初次 activation，再由业务层写入最终 `agent.yaml`，首次 wake 的 Workspace 挂载该身份文件为只读。
- Wake executes actual `changeSessionTo` with the fixed UUID. One per-scope serialization gate prevents concurrent duplicate active instances.
- Restart 关闭原 SDK Chat/Workspace activation，确认回收后再使用同一 Session 与新组装的模型/MCP settings。任何未确认关闭都不算重启成功。
- Ordinary wake uses the business layer's `effectiveConfig` and the persisted resolved-provider snapshot, not newly saved configuration or reread environment variables.
- Resolved provider settings (including credential/endpoint/per-tier model profile) and MCP descriptors are snapshotted **only** at successful provision/explicit restart in `runtime/effective-config/<agentId>.json` (mode `0600`, parent `0700`). This is host-only configuration. Ordinary cold wake reuses it; changing server environment or the model library does not silently apply a new key/model/endpoint. The Agent-owned `.env` is **not** a model-settings input at all and is ignored by model resolution. Agent tools now run locally without an OS sandbox, so this is a runtime rule rather than a filesystem permission boundary. Memory remains normal editable Markdown, not part of this provider snapshot.
- Model resolution is profile → provider → model. `$COMPANY_HOME/model-library.yaml` (override: absolute `COMPANY_MODEL_LIBRARY`; never inside `agents/`, `companys/` or `runtime/workspace/`) is a strict **v2** schema: `version: 2`, `activeProfile`, and id-keyed `providers`/`profiles` maps. Each profile declares `activeAlias` and `tiers.<tier> = {provider, model | modelEnv}`; there is no top-level `models` or `bindings`. v1 files (`version: 1` or the legacy arrays) are rejected with `library_version_unsupported`, never guessed-migrated. The file must be a regular, single-link, current-owner file with mode `0600`; symlinks/hardlinks/other modes produce a non-fatal `insecure` state. Providers accept only `baseUrlEnv`/`apiKeyEnv` **names** (defaults per provider type); a literal `baseUrl` is rejected. Schema is strict, so unknown fields (including a pasted `apiKey: sk-...`), duplicate IDs and unknown profile/provider references are rejected.
- An Agent selects a profile only through `config.modelProfile` (missing or `""` inherits the library `activeProfile`). An explicit profile that is missing or disabled is final: `configured:false` with a diagnostic, never a fallback. The active tier is `config.modelAlias ?? profile.activeAlias ?? "sonnet"`; an invalid alias throws `invalid_model_configuration`. Tier bindings resolve their own `model`/`modelEnv`; an unavailable bound model does not silently fall back. Unbound tiers fall back to the active alias, then `sonnet`, then another bound tier, so all four tiers are emitted. `config.settings` is reserved and never spread into PeriConfig. Legacy `model/models/provider/baseUrl/apiKeyEnv` are retired from the runtime; saving them through `saveAgentConfiguration` is rejected with `invalid_input` and a hint to use `config.modelProfile`.
- PeriConfig uses `config.active_alias` and per-tier `config.profiles[tier] = {provider, model}`. Only providers actually referenced by resolved tiers are emitted. Provider endpoint/credential values are resolved from the **trusted host process environment** using the library's `baseUrlEnv`/`apiKeyEnv` names; they never enter the library file, snapshots' non-secret metadata, browser responses or logs. The `configured` gate requires the active tier's model plus its provider's base URL and credential; missing values and environment names are exposed as diagnostic codes. Missing credentials do not prevent genuine Session creation, but **send is rejected before submitting model input** with `model_not_configured`. External MCP/Workspace child processes receive only `PATH`/`LANG`/`HOME`, not model credentials.
- Runtime snapshots expose only `modelProfile`, `modelProvider`, `modelAlias`, active model ID, `modelMissing` (names/codes), `modelError`, `modelSource` and `modelLibraryRevision`, never apiKey/baseUrl. v2 snapshots additionally carry `modelTiers`, `modelTierProviders`, `modelTierSources` (`bound|fallback|unbound`) and `modelResolvedAt`; a snapshot without tier detail reports `modelTierNotice` (“重启后显示四档明细”) instead of being rebuilt implicitly. `GET /api/model-library` (owner cookie) is read-only and returns `status/error/issues/path/version/activeProfile/revision/profiles[]/providers[]` only: each profile always expands to four tier entries with `bound/provider/providerType/model/modelEnv/missing/ready`, and each provider exposes `baseUrlEnv/apiKeyEnv` names plus `endpointConfigured/credentialConfigured` booleans. There are no top-level `models` or `bindings`, and no endpoint/credential values. The workbench exposes this projection in a header “模型库” sheet and a per-Agent “模型” tab; the Agent configuration picker edits only the JSON draft. UI never writes the library; a revision mismatch prompts an explicit restart.
- Company HTTP MCPs 仍显式读取 `.mcp.json`，外部 `config.mcp` 只在 provision/显式 restart 合并；保留名称限制不变。SDK 0.3.0 WASM 不负责任意 stdio 进程，外部非 HTTP 描述符明确报 `wasm_mcp_transport_unsupported`，不静默忽略，不扩大为通用桥；`workspace` 由宿主独立注入。

**Upstream frozen-prompt nuance:** current `session/load` intentionally restores a frozen system-context snapshot and does not replace its `instructions`. Model/MCP settings do reload. Company therefore treats the system prompt as **fixed at Session creation**: `session.instructions` is assembled from the applied role, responsibilities, Agent-specific `systemPrompt`, `config.instructions`, Company hard constraints and a `CLAUDE.md` pointer only on provision or when a missing bound Session must be replaced. Ordinary wake and explicit restart of an existing Session never rebuild or resend instructions. Mutable role/memory lives in `CLAUDE.md` (host-managed `<!-- company:profile:start -->` … `<!-- company:profile:end -->` block plus a free memory area); the Agent reads it before starting work. Old messages that still contain historical host context remain valid history, while new sends contain only the user text plus this turn's Issue/reference metadata. This is a host-context adaptation, not a claim that upstream's immutable system prompt was overwritten.

## Default Workspace and file views

WASM settings 显式设 `meta_harness.WorkspaceMiddleware = false`。Agent 的 `session.mcpServers.workspace` 注入 `{type:"acp", server:createWorkspaceMcpServerFactory(...)}`，由 SDK 每 activation 创建/连接/关闭一个官方 Workspace stdio 桥实例；工厂函数不写 JSON 快照。浏览器 view adapter 保留自己的独立连接，二者都只启动官方实现：

```
peri mcp-start workspace --stdio --workspace <AgentDirectory>
```

不新增 Company Workspace URL、file MCP 或替代后端。桥不发送 settings bootstrap，也不自行 initialize；由 SDK/WASM 握手，原样转发 JSON-RPC id/result/error/cancel，使用有界帧/队列/关联表，关停依次 EOF、SIGTERM、SIGKILL 并等待真实进程 close。SDK `AcpMcpTransport` 不能出站 server notification，server→client 请求目前返回 `-32601`；这不是完整双向 MCP 能力声明。历史 native discovery 的工具列表不能当作本轮 WASM 运行证据。

The view adapter maps:

- Tree → existing Workspace `Bash`, producing bounded JSON directory pages, including dotfiles and dependency directories. Upstream `Glob` deliberately excludes dependency/cache directories and cannot provide the specified full tree.
- Exact editor bytes → existing Workspace `Bash`, SHA256 and bounded base64 pages. Upstream `Read` is line-numbered model presentation with truncation; stripping those decorations would corrupt editor data.
- Search → actual default `Grep`, with its native documented ignore rules.
- Save → actual default `Write` to a unique draft file, then one Workspace `Bash` invocation to check the expected SHA256 and atomically rename; new files use an exclusive hard-link operation. Existing stale drafts are rejected; error responses leave the client buffer intact. As with upstream atomic file writes, optimistic filesystem checks are not an OS-wide lock respected by arbitrary external programs.
- Git status, paged exact HEAD diff and commits → existing Workspace `Bash` running system Git. Commits are not Issue acceptance or workflow completion.

Text editing is bounded to 1 MiB. Binary files are explicitly rejected for text editing. `Grep` retains upstream ignore semantics; it does not claim a custom all-files index. Attachments are not advertised because no upload capability has been integrated/verified. Runtime queue controls and interactions use the actual SDK actions rather than a fabricated queue.

## Filesystem and credential boundary

按 2026-11-02 所有者裁定，Workspace 本地运行，不使用 OS 沙箱。Agent Workspace MCP 与宿主 Git 直接以宿主用户身份运行；主 Agent 仍不启动 native ACP：

- Agent 工具可访问宿主用户可访问的本机文件，包括 Company 业务源文件、其他 Agent 目录与所有者口令；不再声称只挂载活动目录或隔离 Company 数据。
- 子进程环境只传 `PATH`/`LANG`/`HOME`，避免把模型凭据等无关宿主环境变量直接注入工具进程；这不是文件权限边界。
- 所有者文件视图同样直接运行，可浏览、搜索和编辑本机任意路径。
- 宿主针对 Agent 个人仓库执行 Git 时直接使用 `/usr/bin/git`；仓库 hooks/filters 会以宿主用户身份执行。
- Outbound/loopback networking is retained for model providers, Company MCP and development work. Owner Web APIs therefore require their separate login secret; localhost origin alone is not authority.
- `COMPANY_WORKSPACE=disabled` 仅关闭 Agent Workspace，不影响所有者文件视图或宿主 Git。

**平台要求：** 不再要求 Linux 或 bubblewrap。`bun run setup:peri` 按当前平台安装官方 Peri 4.4.1，macOS/Linux/Windows 资产均可用。

## 用户自行验收与本轮边界

本文件的运行时边界随 2026-11-02 裁定更新；历史 native/沙箱验收结果不适用于当前 Workspace 本地实现。

已更新真实 runtime/integration 测试代码并新增配置/backend 单测。runtime 测试要求官方 Peri 与所有者预先配置的专用空 sqld：`COMPANY_TEST_SQLD_URL`、`COMPANY_TEST_SQLD_TOKEN`。HTTP/MCP integration 使用 `COMPANY_TEST_INTEGRATION_STORES_FILE`（同 stores 格式），每个生成公司固定 Agent、`integrated-dev`、`integrated-preview` 各用独立空端点；不能指向真实用户数据。测试不会自动安装/启动 sqld。缺少显式条件时 SKIP，不是通过。

测试代码覆盖同 Session create/resume/restart、backend hash/旧 Session 拒绝、配置冻结、快照不含 Workspace 工厂与 sqld token，以及既有 Workspace 文件/Git/控制面契约。标明的本地模型协议 fixture 不是 live-model 推理、真实外部供应商连通性或自主多 Issue 工作成果。用户仍需自行执行实际启动、持久恢复、工具行为、queue/cancel/history 与模型验收。
