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

## Fixed Sessions and configuration

- Provision executes actual `ChatUserAction.createNewSession`; the returned persistent UUID is written into the Agent's business record.
- Provision 在可信 WASM binding 完成后关闭初次 activation，再由业务层写入最终 `agent.yaml`，首次 wake 的 Workspace 挂载该身份文件为只读。
- Wake executes actual `changeSessionTo` with the fixed UUID. One per-scope serialization gate prevents concurrent duplicate active instances.
- Restart 关闭原 SDK Chat/Workspace activation，确认回收后再使用同一 Session 与新组装的模型/MCP settings。任何未确认关闭都不算重启成功。
- Ordinary wake uses the business layer's `effectiveConfig` and the persisted resolved-provider snapshot, not newly saved configuration or reread environment variables.
- Resolved provider settings (including credential/endpoint/model matrix) and MCP descriptors are snapshotted **only** at successful provision/explicit restart in `runtime/effective-config/<agentId>.json` (mode `0600`, parent `0700`). This is host-only configuration outside all Agent mounts. Ordinary cold wake reuses it; changing server environment does not silently apply a new key/model/endpoint. The Agent-owned `.env` is **not** a model-settings input at all: it is mounted read-only in the Workspace sandbox and ignored by model resolution, so an Agent cannot redirect the host credential on a later explicit restart. Memory remains normal editable Markdown, not part of this provider snapshot.
- Four-tier model resolution is a pure, tested matrix. The active tier is `config.modelAlias ?? "sonnet"` (only `fable`/`opus`/`sonnet`/`haiku`). Each tier resolves `config.models[tier]` → legacy `config.model` for the active tier only → `PERI_MODEL_ID_<TIER>` → `PERI_MODEL_ID` → `unconfigured`. `config.model` fills all four tiers only when no four-tier source exists (`config.models` tier or any `PERI_MODEL_ID_<TIER>`); once a four-tier source exists it never leaks into non-active tiers. Only exact uppercase tier suffixes are accepted; unknown or lowercase/mixed-case `PERI_MODEL_ID_*` names are rejected with `invalid_model_configuration` before the snapshot is written; the message names the variable, never its value. `config.settings` is reserved and never spread into PeriConfig.
- PeriConfig shape uses `config.active_alias`, `config.providers[0].models` with all four tiers, and `config.profiles` entries that only bind `{provider: "company-model"}`. Provider type/baseUrl/apiKey remain shared across tiers. The `configured` gate only requires the active tier's model plus apiKey/baseUrl; missing non-active tiers are diagnostic and do not block the Agent. Runtime snapshots expose only the non-secret `modelAlias` and active model ID, never apiKey or baseUrl.
- Provider values are assembled from the user-owned effective Agent config and the **trusted host process environment only**. `PERI_MODEL_PROVIDER`, `PERI_MODEL_BASE_URL`, `PERI_MODEL_API_KEY`, `PERI_MODEL_ID` and tier IDs are never read from an Agent-writable file or a merged environment. External MCP/Workspace child processes receive only `PATH`/`LANG`/`HOME`, not model credentials. Secrets remain out of browser responses. Missing provider credentials do not prevent genuine Session creation, but **send is rejected before submitting model input** with `model_not_configured`.
- Company HTTP MCPs 仍显式读取 `.mcp.json`，外部 `config.mcp` 只在 provision/显式 restart 合并；保留名称限制不变。SDK 0.3.0 WASM 不负责任意 stdio 进程，外部非 HTTP 描述符明确报 `wasm_mcp_transport_unsupported`，不静默忽略，不扩大为通用桥；`workspace` 由宿主独立注入。

**Upstream frozen-prompt nuance:** current `session/load` intentionally restores a frozen system-context snapshot and does not replace its `instructions`. Model/MCP settings do reload. To apply changed role text without replacing Session identity or modifying native Store internals, the host supplies the **applied** responsibilities/instructions plus the member's dedicated `systemPrompt` as explicit effective-configuration context with each subsequent send. The initial system instructions declare earlier role text historical after an explicit restart. This is a host-context adaptation, not a claim that upstream's immutable system prompt was overwritten. `claude.md` remains a normal learning file the Agent can read/update.

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

官方 Workspace 本身不是 OS 沙箱；WASM 也不自动保护宿主文件。Agent Workspace bridge 与浏览器 Workspace 仍通过 **Linux bubblewrap** 启动，Git 隔离保持。主 Agent 不再启动 native ACP：

- Separate user/PID/IPC/UTS namespaces; isolated `/proc`; private `/tmp`; child dies with parent.
- 只挂载此 Agent 活动目录、所属 Company 知识库、独立 Workspace 工具目录和显式授权项目根；不挂载 native sessions.db、WASM binding、有效配置快照或存储凭据文件。
- The Company home is otherwise an empty **read-only** mount, so other company source records, Agents' tokens and Sessions are neither exposed nor writable.
- `agent.yaml` and `.mcp.json` are read-only file mounts even though the activity directory is writable.
- Child environment is whitelisted (`PATH`, `LANG`, isolated `HOME`); owner web tokens and unrelated host environment secrets are not inherited.
- Project roots may not include or fall within Company data. User-specified project roots are explicit additional authority.
- Host file-view policy independently checks canonical paths and rejects protected aliases and hard-linked file edits.
- Outbound/loopback networking is retained for model providers, Company MCP and development work. Owner Web APIs therefore require their separate login secret; localhost origin alone is not authority.

**隔离实现要求 Linux 与可用的非特权 bubblewrap。** 缺少 bwrap 或非 Linux 保持 fail closed；macOS/Windows 无隔离后备模式。WASM 并未改变此权限边界，本轮没有运行或验证沙箱。

## 用户自行验收与本轮边界

本轮仅实施文件修改，未执行命令、HTTP 请求、安装、测试、typecheck、build、lint 或服务启动；没有真实 WASM→sqld 运行成功结论。历史 native 测试结果不适用于此切换。

已更新真实 runtime/integration 测试代码并新增配置/backend 单测（均未运行）。runtime 测试要求 Linux bubblewrap、官方 Peri 与所有者预先配置的专用空 sqld：`COMPANY_TEST_SQLD_URL`、`COMPANY_TEST_SQLD_TOKEN`。HTTP/MCP integration 使用 `COMPANY_TEST_INTEGRATION_STORES_FILE`（同 stores 格式），每个生成公司固定 Agent、`integrated-dev`、`integrated-preview` 各用独立空端点；不能指向真实用户数据。测试不会自动安装/启动 sqld。缺少显式条件时 SKIP，不是通过。

测试代码覆盖同 Session create/resume/restart、backend hash/旧 Session 拒绝、配置冻结、快照不含 Workspace 工厂与 sqld token，以及既有 Workspace 文件/Git/控制面契约。标明的本地模型协议 fixture 不是 live-model 推理、真实外部供应商连通性或自主多 Issue 工作成果。用户仍需自行执行实际启动、持久恢复、工具隔离、queue/cancel/history 与模型验收。
