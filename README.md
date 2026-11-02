# Company Factory

一个 **Bun HTTP 服务 + 本地磁盘** 的 Agent 软件工厂。React 三栏工作台以 Agent 为第一维度，业务事实保存在 YAML / Markdown / Git；主 Agent 推理、Session 与控制面采用 **Peri SDK 0.3.0 WASM**，接入用户显式配置的本地 sqld 或宿主自动供给的单一共享本地 sqld；**官方 Peri 4.4.1 进程提供本地 Workspace MCP（无 OS 沙箱）**，不启动 native `peri acp`，不自动回退。

**System For Agent：Agent 自主性优先。** 代码提供可靠事实、能力入口、会话与身份边界；拆解、流程选择、协作和下一步行动由 Agent 决定。当前顶层设计见 [SYSTEM-FOR-AGENT](docs/SYSTEM-FOR-AGENT.md)。2026-10-31 的 live 证据属于历史版本；本轮改动的验证范围单独记录于 [VERIFICATION](docs/VERIFICATION.md)。

**当前交付不是模拟 Agent 演示。** 创建公司通过 WASM 创建真实 Peri Session；必须先配置显式本地存储或启用单一共享 sqld 自动供给，没有模型配置时明确拒绝发送，不伪造回答或投递成功。

**2026-11-02 架构变更：Workspace 本地运行。** 按所有者裁定，Agent 的官方 Workspace MCP 与宿主 Git 直接以宿主用户身份运行，不再依赖 Linux / bubblewrap，也不再提供 OS 级隔离；Agent 工具可访问该用户可访问的本机文件。`COMPANY_SANDBOX` 已移除；`COMPANY_WORKSPACE=disabled` 仅作为显式关闭 Agent Workspace 的调试开关。

**测试基线（2026-11-02，macOS）：** 全量 `449 pass / 24 skip / 0 fail`（473 项、2,410 断言、55 个文件）；`bun run typecheck` 与 `bun run build` 通过。历史 Linux live 验收（2026-10-31，沙箱版，`closure=true`）是过去实现的证据，**不代表当前本地架构**，需要重新做 live 验收；详见 [验证记录](docs/VERIFICATION.md)。

**未验证项，不能声称：** 独立 fable 模型仍未验证（供应商无独立 fable 模型）；四档 alias 路由可用，但不能声称四档四模型全部真实通过。历史 live 证据中的 `agentCiExecuted` 与 digest 口径仅对那轮沙箱版运行有效。

**历史安全披露（2026-10-31 沙箱版）：** 一次宿主范围 `ps` 带完整 args，瞬时工具输出带出一个与本任务无关的宿主进程凭据。该值未写入项目或证据、未用于任何请求；建议轮换所有可能出现在宿主进程列表中的无关凭据。详情见证据目录 `SECURITY-NOTICE.md`（不含具体值）。

[验证记录](docs/VERIFICATION.md) 的前半是 2026-10-30 历史接口验收；当前架构变更见该文顶部说明。

## 1. 启动

Agent 的 Workspace MCP 与宿主 Git 现在直接本地运行，不再要求 Linux 用户命名空间或 bubblewrap，也不再提供 OS 隔离。macOS/Linux 可直接运行公司/会话/聊天、Agent Workspace、所有者文件视图、Git、Preview 与 CI；Agent 工具拥有宿主用户的文件权限。所有者自己的**「文件」视图**同样直接运行，可浏览宿主任意路径（见 [USER-OVERRIDES.md](USER-OVERRIDES.md)）。

需要：Bun 1.4.4+、系统 Git、`tar`。项目以 Bun 作为唯一运行时与包管理器，不使用 npm / Node 脚本。

```bash
# 系统 Git 与 tar 需已安装

bun install
bun run setup:peri      # 官方发行包 + SHA256 校验，保存到 .tools/peri/（macOS/Linux/Windows）
bun run build
bun start
```

打开终端打印的私密 `http://127.0.0.1:3000/#access=...` 链接。访问口令仅用于本地所有者登录；浏览器完成登录后移除 URL fragment，使用 HttpOnly / SameSite cookie。不要把此链接交给 Agent 或其他人。若丢失链接，口令在 `$COMPANY_HOME/owner-token`，登录页也可手动输入。

> Workspace 与宿主 Git 不再提供 OS 级隔离：Agent 工具可以读写宿主用户可访问的本机文件，包括 Company 业务源文件、其他 Agent 目录与所有者口令。请只在本机可信环境运行，不要把服务暴露到非回环地址。需要调试时可用 `COMPANY_WORKSPACE=disabled` 关闭 Agent Workspace；所有者文件视图不受影响。

环境变量：

| 变量 | 默认值 / 用途 |
| --- | --- |
| `COMPANY_HOME` | `~/.company`；Company / Agent 文件与宿主 Session 绑定元数据 |
| `COMPANY_WASM_STORES_FILE` | 可选显式覆盖：宿主私有 0600 JSON，`stores` 为每个 `(companyId, agentId)` 配置一条 `url/authToken`，或用全局 `default` 覆盖所有未列出的 scope；不同 scope 可共用同一回环 URL。显式条目优先于自动供给 |
| `COMPANY_SQLD_BINARY` | 可选：绝对路径的官方 sqld 可执行文件；设置后启用单一共享 sqld 自动供给 |
| `COMPANY_SQLD_ROOT` | `~/.company-host`；共享 sqld 的宿主私有根，必须由所有者持有且为 `0700`，位于项目与 `~/.company/agents/runtime` 之外 |
| `COMPANY_SQLD_PORT` | `18081`；共享 sqld 的固定回环端口 |
| `COMPANY_SQLD_START_TIMEOUT_MS` | `10000`；启动等待 `GET /health` 的上限 |
| `PORT` | `3000` |
| `COMPANY_HOST` | `127.0.0.1`；建议保留本机监听 |
| `COMPANY_BASE_URL` | 对应本机地址；写入 Agent 的三个 Company MCP 配置 |
| `COMPANY_WEB_TOKEN` | 可选：覆盖本地自动生成的所有者口令 |
| `COMPANY_WORKSPACE` | 可选：仅 `disabled` 时关闭 Agent 的宿主 Workspace MCP（公司/会话/聊天与所有者「文件」视图不受影响）；缺省启用本地官方 Workspace |
| `PERI_BINARY` | `.tools/peri/peri`；官方 4.4.1，仅用于 Workspace/MCP，不承载 Agent ACP |
| `COMPANY_MODEL_LIBRARY` | 可选：模型库 YAML 的绝对路径；默认 `$COMPANY_HOME/model-library.yaml`。不得位于 `agents/`、`companys/` 或 `runtime/workspace/` |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | 示例 provider 引用的端点与凭据环境变量**名**；实际名称由模型库的 `baseUrlEnv`/`apiKeyEnv` 指定 |
| `OPENAI_DEFAULT_<TIER>_MODEL` | 示例模型库引用的档位模型环境变量**名**；实际名称由 `modelEnv` 指定 |

例：模型库是宿主私有 0600 YAML，profile 通过 provider 绑定模型；环境变量只保存名称，值始终来自启动服务的宿主进程环境。**已有 Agent 需在工作台点击“重启 Agent”后应用。**

```yaml
# $COMPANY_HOME/model-library.yaml · 必须 0600，普通文件、当前用户所有、无符号链接
version: 2
activeProfile: default
providers:
  host-openai:
    type: openai                 # openai | anthropic
    baseUrlEnv: OPENAI_BASE_URL
    apiKeyEnv: OPENAI_API_KEY
profiles:
  default:
    activeAlias: sonnet          # fable | opus | sonnet | haiku
    tiers:
      fable:
        provider: host-openai
        modelEnv: OPENAI_DEFAULT_FABLE_MODEL
      opus:
        provider: host-openai
        modelEnv: OPENAI_DEFAULT_OPUS_MODEL
      sonnet:
        provider: host-openai
        modelEnv: OPENAI_DEFAULT_SONNET_MODEL
      haiku:
        provider: host-openai
        modelEnv: OPENAI_DEFAULT_HAIKU_MODEL
```

**profile → provider → model 与冻结边界。** v2 模型库按 id 嵌套 `providers` 与 `profiles`，没有顶层 `models`，也没有 `bindings`；每个 profile 的 `tiers.<tier>` 直接写 `{ provider, model | modelEnv }`。v1 文件（`version: 1` 或旧的顶层数组）不会被猜测迁移，而是以 `library_version_unsupported` 拒绝。Agent 配置只引用 profile：`config.modelProfile` 为显式 profile，缺失或 `""` 时继承模型库 `activeProfile`；显式 profile 不存在或已禁用时**不回退**，运行时为未配置并给出诊断。保存配置时显式拒绝已退役的 `model/models/provider/baseUrl/apiKeyEnv` 键（`invalid_input`，提示改用 `modelProfile`），其他未知键保持 passthrough 语义。每 Agent 仍可用 `config.modelAlias` 覆盖活动档位（缺省为 `profile.activeAlias`，再缺省 `sonnet`；非法值抛 `invalid_model_configuration`）。档位绑定的模型不可用时不会回退；未绑定的档位按活动 alias → `sonnet` → 其他已绑定档回退，四档始终有输出。模型库 schema 严格拒绝未知字段（包括误贴的 `apiKey: sk-...`）、重复 ID 与未知引用。provider 只接受 `baseUrlEnv`/`apiKeyEnv` 环境变量**名**，不再接受字面 `baseUrl`；`model` 与 `modelEnv` 每档二选一。解析出的 endpoint 与凭据值只存在于宿主内存和 0600 快照中，不写回库文件、不出现在 API/UI。文件缺失、权限不是 0600、符号链接/硬链接、owner 不符或位于 Agent 可见目录时，服务继续运行但状态为 `insecure/missing/invalid`，发送在提交模型输入前以 `model_not_configured` 拒绝。

**只读展示与 revision。** 运行时快照暴露 `modelProfile/modelProvider/modelAlias/model/modelMissing/modelError/modelSource/modelLibraryRevision`，以及 v2 的 `modelTiers/modelTierProviders/modelTierSources/modelResolvedAt`；旧快照没有四档明细时给出 `modelTierNotice`，重启后补齐。`GET /api/model-library` 只返回 `status/error/issues/path/version/activeProfile/revision/profiles[]/providers[]`；profile 的四个档位带 `bound/provider/providerType/model/modelEnv/missing/ready`，provider 只返回 `baseUrlEnv/apiKeyEnv` 名称与 `endpointConfigured/credentialConfigured` 布尔，不返回任何值，也没有顶层 `models` 或 `bindings`。工作台顶栏「模型库」打开全局只读 Sheet（路径、短 revision、默认 profile、profile 四档与 provider 环境变量名）；右侧面板「模型」tab 显示当前 Agent 的已应用链路、已保存配置、四档表与库摘要；Agent 配置中的 profile/alias 选择器只修改 JSON 草稿，保存仍走现有 CAS，重启才应用。UI 不做写回，也不新增 PUT。

未配置模型时，只要显式本地存储或单一共享 sqld 自动供给已配置、Workspace 可用，仍可创建组织/真实固定 Session、手动操作 Issue 和文件；Chat 提示模型配置缺失。存储缺配会明确失败，不以空 Session 替代。

### 本地 sqld（显式配置或单一共享自动供给）

每个 `(companyId, agentId)` 必须有可解析的存储 scope；所有 scope 可以共用同一个宿主本地 sqld。解析按以下优先级：

1. **显式覆盖**：设置 `COMPANY_WASM_STORES_FILE` 指向宿主私有 `0600` JSON，为具体 scope 配置 `{companyId, agentId, url, authToken}`，或用全局 `default` 为所有未列出的 scope 提供同一端点。显式条目优先于自动供给，精确 scope 优先于 `default`；不同 scope 可使用同一回环 URL，同一 scope 重复配置会被拒绝。未启用自动供给时，缺失 scope 保持原来的 `wasm_store_not_configured` 错误。
2. **单一共享自动供给**：设置 `COMPANY_SQLD_BINARY` 后启用。服务只启动一个本地 sqld，所有未显式配置的 scope 共用 `$COMPANY_SQLD_ROOT/sqld/shared` 的数据、Ed25519 密钥与受限 JWT。

显式条目优先且不会被自动改写；如果既有条目仍指向旧的每 Agent 端点，它们继续使用旧库。共享实例的端口若与显式端点相同且该端点正在监听，自动启动会明确失败，不会接管或终止它。

显式配置文件必须位于 Agent、知识库、项目挂载范围之外，由宿主所有且 `0600`。未设置该变量、或文件中没有当前 scope 时才会回退到共享供给；设置了路径但文件不可读、权限不安全或 JSON 无效属于配置错误，不会静默回退。格式如下，所有尖括号内容均为占位符：

```json
{
  "stores": [
    {
      "companyId": "<BACKEND_GENERATED_COMPANY_ID>",
      "agentId": "<AGENT_ID>",
      "url": "http://127.0.0.1:<SQLD_PORT>",
      "authToken": "<HOST_ONLY_SQLD_TOKEN>"
    }
  ],
  "default": {
    "url": "http://127.0.0.1:<SQLD_PORT>/db/<TENANT>/<DATABASE>/<BRANCH>",
    "authToken": "<HOST_ONLY_SQLD_TOKEN>"
  }
}
```

`default` 可省略；省略时只有 `stores` 中精确匹配的 scope 能解析。`url` 仅接受明确 `127.0.0.1` / `[::1]` 的 HTTP 端点，可带数据库路径以适配按路径路由的 Hrana 网关（如 peri-loom），不接受远端、URL 内凭据、query、fragment。不要把配置放入任何 Agent 可见目录或提交到 Git。

自动供给的宿主私有目录为 `$COMPANY_SQLD_ROOT/sqld/shared`，默认 `$COMPANY_SQLD_ROOT=$HOME/.company-host`。根目录及其 `sqld/shared` 子目录必须是所有者所有的 `0700` 真实目录，且不得位于项目目录或 `~/.company/agents/runtime` 内；服务不会自动 chmod 既有目录。目录内含 `auth.key`（`0600`）、`auth.pub`（`0600`）、无秘密的 `manifest.json`（`0600`，只记录 backend、版本与端口）以及 sqld 的 `db`。JWT 仅在内存中按需签发，使用 Ed25519（`EdDSA`）与 `{"p":{"rw":{"ns":["default"]}},"exp":<now+365d>}` 权限声明；私钥和 token 不进入 argv、子进程环境、Agent 目录、effective-config、`stores.json`、日志或 HTTP 响应。

自动供给在首次解析时启动 sqld：`--db-path <shared>/db --http-listen-addr 127.0.0.1:$COMPANY_SQLD_PORT --auth-jwt-key-file <shared>/auth.pub --no-welcome`，等待 `GET /health` 后复用同一进程。本进程已有该实例且 `/health` 正常时复用；服务重启后按 `manifest.json` 校验端口与数据目录，在端口空闲时用同一密钥与数据目录重新启动。端口被未知进程占用时明确失败，不连接、不复用、不终止占用者；崩溃后遗留的孤儿 sqld 需所有者手工停止。`close()` 对服务自己启动的进程发送 `SIGTERM`，超时后 `SIGKILL`；未确认退出则报错并保留句柄供重试，不删除密钥、manifest 或数据库。并发首次解析共享同一初始化 Promise。

自动供给不在日志、health 或任何 HTTP 响应中打印 token，也不会写入 `stores.json`。若要把既有显式条目改为共享端点，应移除该显式条目让自动供给按需签发，或由所有者用 `auth.key` 自行签发受限 JWT（同样不要落盘或提交）；保留旧 token 的显式条目仍会覆盖自动供给并可能认证失败。

共享实例意味着所有 Agent 的 Session 落在同一个数据库；宿主通过各 Agent 的 cwd 与 scope 绑定隔离 Session，数据库 token 仍是全库 `rw` 凭据，只留在宿主进程内。需要数据库级隔离时应使用显式独立端点。

**后端生成 ID 不需要预先猜测：** 首次创建若缺配，会在宿主 `runtime/store-requests/<scope-hash>.json` 写入无秘密的 `companyId/agentId`，公司初始化保留 failed 状态。补齐显式映射或启用共享自动供给后，以**相同 `requestId` 与相同输入**重试；HR 成功后若主管缺配，再按新请求补配并重试，已完成绑定复用。也可由宿主在 `createApplication({ storeProvider })` 注入 `resolve(scope)` 钩子；注入的 provider 优先于环境自动供给。

配置文件按 activation 读取，token 轮转不改变 backend 身份。首次成功创建后，在 `runtime/wasm-stores` 持久化 scope、endpoint hash 与 Session 绑定。endpoint 改变、cwd 不符或无可信绑定都会明确拒绝。普通 wake 仅在可信绑定指向的 Session 确认缺失时创建替代 Session；manifest 与冷热快照统一使用新 ID，并显式记录 `replacesSessionId`，界面提示原历史未恢复。初始化补花名册的 provision 则必须确认原 Session，缺失时不替代。既有绑定不会因为改用共享实例而自动迁移：原 binding 指向另一个 URL 时，解析会以 `wasm_store_backend_changed` 拒绝，需要所有者先决定保留旧端点还是人工处理迁移。旧 native `sessions.db/sessionId` 原样保留、不迁移、不写 schema，也不会自动新建替代。创建过程只留下 `creating` 标记而未完成可信绑定时，重试明确报错，需所有者人工处理未确认创建；本期不提供自动恢复/迁移工具。

## 2. 使用流程

1. 创建 Company，自动生成总部、HR、任务主管和两个真实 Session。
2. “组织设置”可创建/编辑组织节点（父子、排序、归档、删除空节点或显式迁移后删除）；成员定义送入 HR 的固定 Chat 草稿，由 HR 的可信 MCP 身份创建成员。不会借用户界面伪装 HR。组织树支持把成员移动到任意 active 节点、归档与恢复；移动只改 `organization.yaml`，不改身份、目录、固定 Session、token、权限或 Issue/IM 归属。
3. 侧栏员工行右侧的编辑按钮可修改姓名、职责和该员工专属的系统提示词；变更会更新 `CLAUDE.md` 的 Company 托管块，作为长期职责权威。系统提示词只在 Session 创建时组装一次，已有固定 Session 不会被字面重建；Agent 开工前读取 `CLAUDE.md`，因此职责/记忆更新不需要新开 Session。
4. 用户创建 Issue 后进入 `triage`，负责人是任务主管。主管分类、选择 `software-delivery`、指派；Dev 独立维护计划/代码/worktree。
5. 为需要代码仓库的成员，在配置中设置 `workspaceRoots` 为**公司数据目录之外、由用户授权的真实 Git 仓库**绝对路径，保存后手动重启。同一配置面可设置 `modelProfile`（模型库 profile）与 `modelAlias`（活动档位覆盖）。HR 可定义成员的 profile 档位与职责/指导，但不能自行授予 provider、baseUrl、apiKeyEnv、MCP 或文件系统挂载。
6. Preview Agent 经默认 Workspace 创建本地集成分支/启动 Dev 环境，通过 `company_tasks` 记录批次、代码、环境入口和逐 Issue 清单。用户针对明确 Issue/代码验收；之后记录 CI 与 Code Review，二者均通过才可 `ready_merge`。本期不自动合入/发布。
7. 黄色行对应未处理的具体裁定问题。答复先落盘，再向当前 Agent 投递处理提示；问题由该 Agent 标记 answered，其他 pending 继续保留。
8. 文件页提供完整树、搜索、Monaco 编辑、Git Diff/commit、代码选区引用、外部修改冲突保留。个人记忆、知识和项目文件可用；Company 业务源文件和可信身份配置不能借文件编辑绕过服务。

## 3. 配置与固定 Session 的实际语义

- `agentId`、活动目录、`sessionId` 固定。并发唤醒复用同一实例；初始化 Session 后可无存活实例。
- 保存只改 `config`，普通唤醒仍使用 `effectiveConfig`。手动重启应用新配置且保留 Session。
- 当前 Peri 的 **frozen system context 不支持在同一 Session 上重建**，且 `session/load` 不会替换创建时的 instructions。本适配不篡改 Peri SQLite。新 Session 仅冻结身份、能力入口与稳定事实边界；可变职责、Agent 专属 systemPrompt、已应用 `config.instructions` 和长期记忆统一从 `CLAUDE.md` 读取。已有 Session 的普通 wake/显式 restart 保留原冻结提示词和历史。保存配置不提前发布 instructions，显式重启成功后更新 CLAUDE 托管块及 applied version。模型/MCP 连接按官方 Session load 路径重绑。请阅读 [SDK 接入依据](docs/SDK-INTEGRATION.md)，不要把“固定 Session 重启”理解为删除/重写历史系统消息。
- 新建工单、指派信息更新和明确答复会发出携带 Issue 引用的简短通知，Agent 自主决定如何响应；通知不推进状态。运行面板显示最近通知与确定失败后的重试入口。Agent MCP 的工作区返回有界索引与详情读取入口，完整历史按需读取。
- 运行时授权/问答与 Company 决策分开；停止和输入队列使用 SDK 原生控制。未接通的附件上传能力不开放。

### 重启与版本更新门禁

服务重启前必须先确认没有人员正在工作。门禁是只读检查，不会停止、启动或拉起任何进程：

```bash
bun run check:restart                  # 检查本机默认服务
bun run check:restart --company <id>   # 只检查一个公司
bun run check:restart --json           # 机器可读输出
```

退出码：`0` SAFE（可以重启）、`2` BUSY（列出仍工作的公司与人员及原因）、`3` UNVERIFIED（无法确认，按失败闭合处理）、`1` 用法错误或缺少 owner token。token 依次读取 `COMPANY_WEB_TOKEN`、`$COMPANY_HOME/owner-token`（默认 `~/.company/owner-token`），脚本不会打印 token 或 cookie。也可以直接以 owner 会话调用 `GET /api/restart-readiness`（可选 `?companyId=`）：`200` 安全、`409` 有人员在工作、`503` 无法确认、`401` 未登录、`404` 公司不存在；Agent bearer 不能调用，接口也不暴露到 Company MCP。

“工作中”只按当前服务进程内的执行事实判断：运行中的 Chat turn、尚未结算的 prompt admission、runtime 的 wake/bind/restart/provision 操作锁、legacy 输入队列、等待用户回答/权限、`running`/`in_progress` 的 Session task、正在投递的 Company IM 消息和 Agent work-notice。peri-loom 的 `threads.agent_status=active`、Issue 工作流阶段、Preview URL、IM thread 的 `open`，以及已 `delivered`/`accepted` 的 admission 都不算忙。初始化未完成的公司不会因为历史失败状态永久阻塞：只检查其 runtime 锁与已绑定工作。任一状态源读取失败或 5 秒超时，都会返回 `503 verified=false`。

固定重启与版本更新顺序：

1. `bun run verify` 通过。
2. `bun run check:restart` 必须 exit `0`；记录输出中的 `serverVersion` 与 `checkedAt`。
3. 检查通过后，才修改 `package.json` 的 `version`。应用版本唯一来源是该字段；`/health.version` 动态读取它，没有版本写入 API。
4. 人工停止服务，执行 `bun start`。
5. 用 `/health` 确认 `version` 已是新值，再执行一次 `bun run check:restart`，确认新版本启动后仍为 SAFE。

门禁不是分布式锁：检查通过后、停止进程前仍可能有新输入或新投递。当前架构只有单个 Bun 服务进程；Agent 通过 Workspace 启动的宿主进程、外部 Preview 服务或手工终端任务不在检查范围内。

## 4. 数据和安全边界

```text
~/.company/
  owner-token                   # 本地用户访问口令，不挂给 Agent
  model-library.yaml            # 宿主私有模型库，必须 0600；只存环境变量名，不存密钥
  companys/<company-id>/         # 此拼写按任务书保留
    company.yaml  organization.yaml  roster.yaml
    groups.yaml                 # 仅旧公司只读兼容；新代码不再写入
    tasks/  comments/  pipelines/  previews/  knowledgebase/
    im/threads/  im/messages/  events/
  agents/<agent-id>/
    agent.yaml  CLAUDE.md  .mcp.json  .env  tasks/  .git/   # .env 对 Agent 只读，不用于模型配置
  runtime/effective-config/<agent-id>.json  # host-only 已生效模型/MCP快照，0600
  runtime/agents/<agent-id>/
    sessions.db                 # 仅旧 native 数据，原样保留，不读写迁移
    home/                       # 旧 native HOME 原样保留
  runtime/wasm-stores/<scope-hash>.json  # 无秘密 backend/endpoint hash/Session binding
  runtime/store-requests/<scope-hash>.json  # 缺配时的 companyId/agentId，便于补配
  runtime/workspace/<scope-hash>/home/  # 官方 Workspace 本地活动目录，无 sqld token

# 仅启用 COMPANY_SQLD_BINARY 时；默认根在 COMPANY_HOME 之外
$COMPANY_SQLD_ROOT/sqld/shared/
  auth.key  auth.pub  manifest.json  db/  # 0700 目录；密钥/manifest 为 0600，无 token
```

WASM Session/消息由本地 sqld 落盘：显式模式由所有者准备端点，自动模式使用单一共享实例（宿主按 Agent cwd/scope 隔离 Session）；既有库不会由 Company 服务自动迁移。

`organization.yaml` 保存独立的组织节点树与人员 placement；`roster.yaml` v2 只保留 `{agentId,status,joinedAt}` 的平铺索引。人员 `agent.yaml` 不再把部门当作身份事实，`organization()`/`members()` 的 `groupId`/`orgPath` 由 placement 派生。没有 `organization.yaml` 的旧公司会在读取时从 `groups.yaml` + roster v1 在内存合成，只读请求不落盘；首次组织写才升级为 `organization.yaml` + roster v2，保留既有两个根节点且不改写 `agent.yaml`/`groups.yaml`。成员移动只写 `organization.yaml`；归档保留目录、Session、token 文件、IM 与 Issue，但拒绝后续鉴权。

旧 Agent 的小写 `claude.md` 可用 `bun scripts/migrate-agent-memory.ts --dry-run` 预览，再运行一次完成迁移；脚本把 `agent.yaml` 的当前档案写入托管块、保留自由记忆区，遇到同名 `CLAUDE.md` 与 `claude.md` 共存时只报告冲突而不覆盖，也不会自动提交 Agent 仓库。

恰好三个自定义 MCP：`/company_org/mcp`、`/company_tasks/mcp`、`/company_im/mcp`，使用 `@peri-code/mcpp` 的 MCP **2026-07-28** mono 路由、资源与订阅。Workspace 沿用官方实际 stdio 传输，本地直接运行（无 OS 沙箱），不虚构 Company Workspace URL。AgentSystem 只在服务内部。

各 Agent 的官方 Workspace MCP 子进程以宿主用户身份本地运行，不再有 bubblewrap / 命名空间隔离。Agent 工具可读取与写入宿主用户可访问的本机文件；子进程环境只传 `PATH`/`LANG`/`HOME`，避免把模型凭据直接注入，但这不构成文件权限边界。主推理进程内使用 WASM，不启动 native ACP；数据库凭据只留在宿主/SDK，不写入模型/MCP 快照。公司业务写入仍应通过业务接口；这是产品约束，不是 OS 强制。所有者自己的「文件」视图与 Agent Workspace 都是本地直接运行。外部 HTTP MCP 保持，任意 stdio/SSE/ACP 外部描述符在 WASM 模式明确拒绝；只有官方 Workspace 接入宿主桥，不提供通用 MCP 进程桥。网络仍用于已配置的模型/MCP 与项目工作；建议仅监听本机。

按任务书，**生成的 Agent 个人仓库会跟踪 `.env`**。该文件不承载模型配置；Agent 工具现在可写本机文件，因此不要在其中写入任何秘密，也不要公开推送或打包个人数据目录。此交付 ZIP 不包含任何运行数据、生成的口令或模型凭据。

最新用户裁定已经彻底移除 Forgejo：没有依赖、配置、`forgejo_issue` 字段或外部 Issue 同步。原附件原样保留仅作历史输入，现行覆盖见 [USER-OVERRIDES.md](USER-OVERRIDES.md)。

## 5. 验证与示例

```bash
bun run typecheck
bun run build
bun test                        # domain + 真实 SDK/Workspace + HTTP/MCP 集成
bun run test:integration
# 可选，用户已排除浏览器验收：bun run test:browser
bun run example                  # 在隔离临时目录运行真实双 Issue 交付示例
```

当前代码已实际执行 `bun run typecheck`、`bun run build` 与全量测试（macOS `449 pass / 24 skip / 0 fail`）；`bun run example` 与浏览器套件未执行。真实 runtime 套件还需设置专用空库的 `COMPANY_TEST_SQLD_URL/COMPANY_TEST_SQLD_TOKEN`；HTTP/MCP 集成套件使用 `COMPANY_TEST_INTEGRATION_STORES_FILE`（相同 stores 格式），为生成公司固定成员及 `integrated-dev/integrated-preview` 准备显式测试端点（可共用同一回环端点）。缺少 Peri 二进制或显式测试存储时套件 SKIP，不计为通过；不能使用生产数据库。集成套件使用固定 `requestId: initialize` 与所有者身份，缺配时可从其临时根的请求文件取得真实生成 ID。Domain 测试替身只证明业务规则，不冒充 WASM/存储证据；测试代码不自动安装或启动 sqld。

`SOURCE-MANIFEST.sha256` 是历史源码快照，已过期：2026-10-31 复核有 24/62 项不匹配，且不包含 `scripts/e2e-live.ts`、`scripts/e2e-ci-runner.ts` 等文件。它不得作为当前源码完整性或 E2E 证据；需要时重新生成。

Live E2E 的证据口径：独立 CI/Review 的宿主执行结果与 digest 是权威；Reviewer 的 `recordVerification` 文本或 digest 本身不证明执行，只有 Session 投影中真实 Bash 工具调用同时包含“本轮随机 challenge + 宿主 digest”才记为 `agentCiExecuted`。该记录证明 Agent 确实调用了命令工具并观察到本轮结果，但不构成对恶意 Agent 伪造 stdout 的密码学防护；若 Session 投影只给出 result 引用而非完整结果，E12/E13 直接失败、`agentCiExecuted=false`、`closure=false`。`--dry-run` 只读探测所选 Docker/bwrap backend，缺失时直接失败；不会启动服务、容器或拉取镜像。

入口：`src/server/index.ts`。业务：`src/domain/`、`src/storage/`。真实适配：`src/runtime/`。工作台：`web/`。`docs/INTERFACES.md` 与 `src/domain/CONTRACTS.md` 说明身份、输入、错误、事件、版本与幂等规则。

## 6. Runtime diagnostics（临时诊断）

服务端默认写入本地 JSONL 诊断日志，由 `pino` + `pino-roll` 托管，用于定位 `agent_execution_failed`、WASM 持久化错误与 chat action 5xx；公共 HTTP 错误契约、`activeTurn.error` 与前端 schema 均不改变。

- 位置：`${COMPANY_DIAGNOSTICS_DIR:-$TMPDIR/company-factory}/runtime.<n>.jsonl`；`current.log` 是指向当前文件的稳定 symlink。
- 权限与保留：目录 `0700`、文件 `0600`；默认单文件 1 MB、最多 3 个文件（总量约 3 MB）。重启后追加到编号最高的文件，不覆盖旧日志；每行带 `bootId` 区分进程代次。
- 捕获范围：进程启动、`agent_execution_failed` notice 的公共 `value.message`、`im_delivery_failed`（含 code/disposition/attempt/messageId）、allowlist 后的 WASM `printErr`、chat action 5xx 的脱敏元数据。普通回合除 `process_start` 外不产生噪声。
- 脱敏：所有自由文本统一处理 URL → `[url]`、32+ token → `[redacted]`、`Authorization`/`token`/`api_key`/`password` 键值 → `[redacted]`，并限制长度；不记录用户消息、工具参数/输出、文件内容、`event_json`、`item.content` 或原始 `RpcError`/snapshot。
- 只读端点：`GET /api/diagnostics/runtime?limit=N`（`N` 为 1–200，默认 50），仅接受现有 `company_session` owner cookie；响应再次脱敏并只返回白名单字段。没有写入、删除或任意路径读取接口。

```bash
DIR="${COMPANY_DIAGNOSTICS_DIR:-$(bun -e 'process.stdout.write(require("node:os").tmpdir()+"/company-factory")')}"
ls -la "$DIR"
tail -f "$DIR/current.log"
```

| 变量 | 默认值 / 用途 |
| --- | --- |
| `COMPANY_DIAGNOSTICS` | 设为 `0` 完全关闭诊断；默认开启 |
| `COMPANY_DIAGNOSTICS_DIR` | 覆盖诊断目录；相对路径按 cwd 解析 |
| `COMPANY_PERI_WASM_STDERR` | 设为 `1` 才启用 WASM `printErr` allowlist；默认关闭 |
| `COMPANY_DIAGNOSTICS_STDERR` | 设为 `1` 时把 error 级诊断镜像到宿主 stderr（同样脱敏）；默认关闭 |

诊断是临时排障设施，建议保留 1–2 周；确认不再需要后移除监听或设置 `COMPANY_DIAGNOSTICS=0`。
