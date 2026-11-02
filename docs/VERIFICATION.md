# Company Factory 验证报告

> **2026-11-02 架构变更：**Workspace 已改为本地运行，删除 Linux / bubblewrap 沙箱及 `COMPANY_SANDBOX`。本文 2026-10-31 的 live E2E 是沙箱版历史证据，不再代表当前实现；当前版本需要重新做 live 验收。下文提到的 `sandbox_unavailable`、bwrap 版本与 Linux 全量结果均不再适用。历史命令保留 npm 形式；当前项目统一使用 Bun（`bun install` / `bun run` / `bun test`）。

日期：2026-10-30（UTC）。最后更新：2026-11-02（UTC）。2026-11-02 的自主性优先裁定见 `SYSTEM-FOR-AGENT.md`；较早章节保留为历史证据。

## System For Agent 修复验证（2026-11-02）

基线：`7ae47ad229650fc8e7c688da63e1f81428599b41`。先落实顶层责任边界，再并行修复事实一致性、职责/记忆、Session/输入；集成复核补齐上下文发现入口和通知状态读取。

- `bun run typecheck`：通过。
- `bun run build`：通过，保留既有 Monaco chunk 体积提示。
- `bun test`：**449 pass / 24 skip / 0 fail**，473 项、2,410 断言、55 个文件（2026-11-02，macOS 本地复跑，含组织解耦、IM 投递、重启门禁、任务详情折叠与评论时间线、chat Markdown 复用、运行时诊断、direct prompt 视图投影与 UI 回归）。
- 补丁交付方在原 npm/沙箱基线上报告 186 pass / 29 skip / 1 fail；唯一失败来自 `src/storage/git-sandbox.test.ts` 的 bubblewrap 隔离测试（`Failed to create NETLINK_ROUTE socket: Operation not permitted`）。该测试已随 2026-11-02 本地运行裁定删除，本仓库不再要求 Linux 或 bubblewrap。
- 24 个跳过项需要真实 Peri/sqld 等外部条件；本轮没有重跑真实模型/WASM live E2E，也没有进行浏览器视觉验收。下文 2026-10-31 的 live 结论不能直接用于本补丁。

| 验证边界 | 本轮证据 |
| --- | --- |
| 业务事实 | 真文件/Company Git 的提交失败重试、初始化 roster 故障恢复、Preview 移除旧成员的完整权限与证据检查 |
| 职责与记忆 | saved/applied instructions 顺序、重启中再次保存与自由记忆更新、符号/硬链接和非法文档拒绝 |
| 会话与输入 | 实际宿主 bind → manifest → 冷热服务投影 → HTTP → 浏览器控制器；外部 sqld/SDK Chat/WS 使用明确替身；输入缓存容量、过期、未知结果不重投 |
| 自主性与上下文 | 新冻结提示词只含稳定边界；旧 Session load/restart 不重发 instructions；Issue/线程/Preview 独立分页及 32 KiB 投影预算；未回复发出线程和仍可见旧批次可重新发现 |
| 通知 | 真实 HTTP/MCP、Company Git、鉴权与重试；SDK admission 为替身；通知不推进状态，自己创建的工单不回送，失败/未知状态可经 HTTP 读取 |
| UTF-8 | 真实长驻子进程逐字节发送中文/emoji，两次请求与通知均完整，stderr 退出诊断完整；用 StringDecoder 避免 Bun 管道 setEncoding 停发事件，无增加测试超时 |

这些证据验证宿主控制流和接口不变量，不代表模型已能自主完成复杂真实项目。跨外部运行时与多文件的崩溃事务仍未承诺；发生应用后版本/记忆冲突会明确报错。未知通知不自动重送，需先查看固定 Session 与队列。

## 重启门禁实现验证（2026-11-02）

范围：新增 owner-only `GET /api/restart-readiness`、`bun run check:restart`、runtime `workState`/`activeScopes`、in-flight IM/notice 只读事实，以及 `/health.version` 动态读取 `package.json.version`。本轮只做实现与定向自动化验证；未重启 :3400 服务、未做浏览器验收、未跑 live E2E、未提交 Git。

- `bun run typecheck`：通过。
- 定向测试：`bun test src/runtime/input-receipts.test.ts src/runtime/work-state.test.ts src/domain/im-delivery.test.ts tests/agent-work-notices.test.ts tests/restart-readiness.test.ts scripts/restart-check.test.ts` → **46 pass / 0 fail**，268 断言，6 个文件。
- `bun run build`：通过；仅有既有的 Monaco/Editor chunk 体积提示。
- 覆盖：idle/offline/archived、九类 busy reason 合并、archived 有 live work 仍阻止、初始化未完成公司不永久阻塞但仍阻止 Provision 锁、roster 外 bound scope、IM/notice 在途投递生命周期、状态源抛错与超时 fail closed、`companyId` 过滤与 404、无 cookie/Agent bearer 401、HTTP 200/409/503、脚本 0/2/3 映射与 token 不出现在 URL/headers、`/health.version === package.json.version`。
- 未执行：浏览器与视觉验收、真实模型/WASM live 检查。因此本记录不构成整体验收结论。
- 后续补充（同日）：重启门禁相关全量为 **437 pass / 24 skip / 0 fail**（461 项、2,355 断言、53 文件）；任务详情改版后全量为 **449 pass / 24 skip / 0 fail**（473 项、2,410 断言、55 文件）。两次 `bun run typecheck`、`bun run build` 均通过。:3400 实际重启后调用 `bun run check:restart`：第一次返回 `BUSY`（supervisor `prompt_in_flight`），据此定位并修复「执行失败通知后 `promptInFlight` 租约残留」缺陷（`src/runtime/index.ts` 在 `recordNoticePromptFailure` 清空租约，回归测试 `src/runtime/binding-recovery.test.ts`）；部署修复后的第二次重启返回 `SAFE`（exit 0），`/health` 200。

## 最终 live E2E 事实（2026-10-31）

以下只更新 2026-10-30 历史章节中“未执行 live / 未验证外部模型”的表述，不覆盖上方 2026-11-02 的修复验证范围。

- **结论**：按计划 §11 字面口径 `closure=true`；Stage 2 `--mode=linux-full` 的 E00–E19 全部 `passed`。运行 `91201b67`。证据：`/tmp/cf-e2e-delivery-round2.n5TgK726/`。下方 A01–A15 与命令记录保留为 2026-10-30 的历史接口验收。
- **真实执行范围**：Linux 容器内官方 Peri 4.4.1、sqld 0.24.32、bwrap 0.8.0；真实模型端点与真实 Session；Workspace/Git/Preview/CI/Review、重启与 IM 均实际执行。
- **测试（历史沙箱版）**：Linux 全量 `101 pass / 24 skip / 0 fail`；宿主 macOS 全量 `100 pass / 24 skip / 1 fail`，唯一失败是既有 `sandbox_unavailable`（`src/storage/git-sandbox.test.ts`，要求 Linux bubblewrap），不是 live 轮引入。该测试与失败项已随 2026-11-02 裁定删除。
- **fable 限制**：原始 `PERI_MODEL_ID_FABLE` 请求返回 HTTP 400；供应商 `/models` 无独立 fable 模型。测试用项目外临时 0600 env 将 fable 映射到 opus 档模型 ID。四档 alias 路由已验证，但**独立 fable 模型未验证**；不能声称“四档四模型全部真实通过”。
- **M1 限制**：`agentCiExecuted=true` 是真实 Session 中 Bash 调用的 args/result 匹配，不是密码学证明；宿主独立 CI digest 是权威；恶意 Agent 理论上可用 `echo "<challenge> <digest>"` 伪造。E12 transcript 的 canonical JSON 已由独立 Verifier 复算，与宿主 digest 一致。
- **证据缺口**：多数步骤的 `toolCalls` 数组为空，只有 E12/E13 有 toolCallId/flags 与 transcript；E13 的 canonical JSON 未保存，无法仅凭交付文件独立重算其 digest。E07 的 `resolveDecision` 返回 `invalid_state`（decision 已 answered），报告中的 `resolved=true` 表示业务终态，不是该工具调用成功。
- **macOS 边界**：macOS Stage 1 的 Workspace/File/Git/Preview/CI 仍 fail closed；macOS 上不能算全业务通过。
- **安全事件**：上一轮 live 执行中一次宿主范围 `ps` 带完整 args，瞬时工具输出带出一个与本任务无关的宿主进程凭据。该值未写入项目或证据、未用于任何请求；扫描未发现实际 secret（模式命中仅为 request id 子串）。具体值不在任何交付文件或本文中。建议轮换所有可能出现在宿主进程列表中的无关凭据；详见 `/tmp/cf-e2e-delivery-round2.n5TgK726/SECURITY-NOTICE.md`。

> `SOURCE-MANIFEST.sha256` 是历史快照，已过期且不包含后续新增的 `scripts/e2e-live.ts`、`scripts/e2e-ci-runner.ts` 等文件。它不得作为当前源码完整性或 E2E 证据；如需要，应先重新生成并校验。

## 结论与验收范围

按用户最新裁定，使用 **真实 HTTP / MCP 接口模拟用户及已鉴权岗位** 验收，不要求浏览器。服务、文件、Git、官方 Peri Session 和默认 Workspace 都是真实实例；接口测试没有用 fake runtime 替代。

- 前端 TypeScript 与生产构建通过；UI scope/draft/receipt/conflict 等状态单测通过。
- 业务单测使用明确标注的 runtime double，只用于业务规则，不充当 Peri 接入证据。
- SDK/Workspace 测试（历史沙箱版）使用官方 Peri 4.4.1、SDK 0.3.0、真实 SQLite 与 Git；2026-11-02 起 Workspace 本地运行，不再使用 bubblewrap。
- 本地 provider **协议 fixture** 验证真实 Peri 请求/流式投影/投递/生效配置，不是外部模型推理能力验收（历史轮次；live 轮已改用真实模型端点，见上）。
- 双 Issue 软件示例实际创建独立 Git worktree/计划/提交，真实合并到 Preview 分支，HTTP Preview 读取合并产物，CI 校验产物和同一 SHA；用户验收与 Review 记录由接口模拟者提交并明确标为测试证据。
- **历史轮次（2026-10-30）没有声称**外部真实模型已自动完成 HR 对话、复杂多任务编码、真实同事推理回复，或真实项目已通过人工验收。2026-10-31 live 轮已用真实模型验证 HR `createGroup`、Session 回复、IM 往返与 Preview/CI/Review；仍不声称用户自有真实项目的复杂编码或人工验收已通过。

## 实际执行命令

```bash
# 实际安装并校验了官方 Peri 发行包
npm run setup:peri

npm run typecheck
npm run build
PERI_BINARY=/tmp/peri-inspect/native/peri npm test
PERI_BINARY=/tmp/peri-inspect/native/peri npm run test:integration
npm audit --json
```

`/tmp/peri-inspect/native/peri` 是本次检查过的官方 4.4.1 二进制；交付项目内 `npm run setup:peri` 也已实际执行成功，其目标是 `.tools/peri/peri`。二进制不打入源码 ZIP，避免将特定主机产物当作跨平台源码。

最终同版本汇总：**51 tests passed，0 failed，261 assertions**（7 个测试文件）；TypeScript 和 Vite 构建通过。另将源码复制到全新临时目录，实际执行 `npm ci`、`npm run typecheck`、`npm run build` 全部通过。详见 `test-results.txt`、`build-results.txt`、`clean-install-results.txt` 与 `dependency-audit.json`。DOMPurify 的传递版本告警已通过锁定 `3.4.17` override 修复，最终 npm audit 为 0 已知漏洞。构建有 Monaco 大 chunk 的体积提示，不是编译错误；编辑器延迟加载，worker 打包在本地。

## A01–A15：逐项接口验收

“已通过”限定为用户授权的接口模拟验收。界面视觉、真实外部模型质量不混入该结果。

| 编号 | 状态 | 实际依据与边界 |
| --- | --- | --- |
| A01 创建 Company | 已通过 | HTTP 创建，实际总部/HR/主管、个人/公司 Git、跟踪 `.env`、官方原生 UUID Session 和 per-Agent SQLite。初始化失败不返回伪成功；相同请求可继续未完成初始化。 |
| A02 HR 创建 Agent | 已通过（历史接口验收；组织解耦 Phase 3 仅领域/组件测试） | 通过真实 bearer 鉴权的 HR MCP 创建部门及成员；伪报角色、用户冒充 HR 拒绝。全局同 Agent ID 并发竞争回归保证仅一方成功。后续能力：user/HR 可移动成员、归档/恢复成员、管理组织树；移动只写 organization.yaml 并自检人员/会话/binding 不变。本轮组织解耦的 move/archive/restore/树管理由领域与 UI 组件测试覆盖，真实 Session/浏览器验收尚未执行（24 个集成测试仍 skip，不冒充通过）。 |
| A03 保存与重启 | 已通过 | HTTP 保存与重启、SDK 同 Session 加载；真实本地 provider 捕获证明保存未重启保留旧模型/职责，重启应用新值。模型凭据/端点只来自可信宿主环境；Agent 可写的 `.env` 对模型解析无效且在工作区只读，恶意改写不能重定向凭据。普通冷唤醒保留旧模型/密钥与 host-only 生效快照，显式重启才按宿主 env 刷新。host-only 生效快照不可由 Agent 读写。底层 frozen system prompt 不重写，职责通过宿主当前输入上下文装配，已明确记录。 |
| A04 用户/角色建单 | 已通过 | 用户 HTTP、主管 MCP、用户授权后的 Dev MCP 均可创建；未授权角色 MCP 拒绝且无任务文件。新单 `triage`、主管负责；payload 自报身份不能授权。 |
| A05 文件与评论 | 已通过 | Issue 描述/头部、用户/Agent 评论真实落盘；本人编辑、他人拒绝；普通评论不改状态。版本冲突、幂等冲突、未知 YAML 字段保留与并发 patch 有回归。 |
| A06 Agent 范围切换 | 已通过（接口/状态层） | 并行 HTTP workspace 查询返回各自 Company/Agent scope；UI 单测覆盖双维 query keys、草稿/文件缓存隔离、迟到回执不清较新草稿。按用户要求不进行浏览器视觉验收。 |
| A07 同 Agent 多 Issue | 已通过 | 两条 Issue 指派同一 Agent、独立计划/worktree，Chat 及重启保持原 Session；并发唤醒单绑定。无外包组织节点/自建调度器；真正复杂多任务运行负载未作外部模型测试。 |
| A08 指定问题裁定 | 已通过 | Q1/Q2 各自稳定编号；用户明确答 Q1 后由当前 Agent MCP 标 answered，Q2 仍 pending。撤回后晚到答复只留历史；普通评论/聊天不替代裁定。答复落盘后投递当前 Agent，投递失败不抹除答复。 |
| A09 IM | 已通过（接口/协议） | 跨部门发现与点对点 MCP 询问/回复、去重、关闭后迟到回复；无新 Issue/Session。无模型配置时真实记录 failed，不伪报 delivered；本地协议 fixture 验证真实 SDK 投递原 Session。外部模型自动同事回复未验证（历史记录；2026-10-31 live E15 已用真实模型验证 IM 回复）。 |
| A10 文件工作区 | 已通过（接口/状态层） | 通过官方 Workspace 的真实树、隐藏/依赖目录、读写/新文件/搜索/HEAD Diff/Git commit；旧 SHA 保存拒绝，缓冲/磁盘双方保留；代码引用包含路径/行/版本。OS sandbox 阻止原生 Read/Write/Bash 跨 Company 和身份文件写入；Agent 仓库宿主 Git hooks/fsmonitor/filter 也隔离。 |
| A11 知识目录 | 已通过 | 实际 `claude.md` 写入 Company 知识路径；官方 Grep 搜索普通 Markdown，知识根可读写；无知识/文件专用 MCP。 |
| A12 软件交付 | 已通过（接口示例） | 两个真实 worktree/独立计划/分支提交，真实 `preview/joint` 合并；Dev HTTP 环境读取两份合并产物；逐 Issue 验收/评论，未把一项通过自动扩展到整批。旧批次不能验收已迁入新批的 Issue。真实用户项目的自动开发尚需模型配置。 |
| A13 验证/待合入 | 已通过（接口示例） | 验收后执行针对 Preview 产物和精确 SHA 的实际 Bun 断言；明确标注的脚本 Review 证据经真实 MCP 记录。缺任一验证、旧代码或旧批次均拒绝；最终为 `ready_merge`，没有执行实际合入主分支/发布。 |
| A14 自主修正/cancel | 已通过 | 当前 Dev 经 MCP 改描述/阶段；主管交接、非 owner 状态修改拒绝；cancel 保留计划/代码及原因，迟到更新不能复活。 |
| A15 MCP/部署 | 已通过 | 一个 Bun HTTP 服务托管构建产物/Web API/三个 MCPP mono 路由；真实 2026-07-28 tool/resource 请求及 `subscriptions/listen` 收到业务落盘后的更新。SDK/Workspace 为官方工作子进程，本地 SQLite；没有额外 Company MCP、数据库服务或自建 Workspace。 |

## 独立审查修复与复测

独立 reviewer 的临时目录探针复现并确认修复了：

1. IM 字段映射不一致、失败回执误写 delivered。
2. 全局 Agent ID 跨公司创建竞争。
3. 文件编辑 canonical/symlink/hardlink 绕过。
4. 默认 Workspace 本身无隔离：新增真实 OS namespace，并验证直接原生工具也不能越界。
5. Agent 私有 Git hooks / fsmonitor / clean filters 逃逸到宿主：宿主 Git 也隔离。
6. HR 通过成员 config 自授项目挂载/宿主凭据：拒绝，能力配置只由用户授权。
7. 旧 Preview 批次验收当前 Issue、代码引用过期。
8. 配置 draft 版本与查询最新版本混用、保存时清除较新输入。
9. SDK immutable frozen context 的实际语义：明确使用宿主生效职责上下文，并捕获真实 Peri outbound 验证。
10. `.env` 冷唤醒/显式重启触发的凭据或端点漂移：模型解析只读可信宿主环境，Agent `.env` 不被读取且在 Workspace 只读；生效快照 host-only，并用真实请求回归。

## 前端实现选择

实际使用 React、TanStack Query、Zustand、ReactMarkdown、Monaco 与 Lucide，离线 worker、本地 CSS。分栏、输入框、文件树采用项目内 React 实现，而不是声称已接入 Tiptap / shadcn / react-arborist / Streamdown。对应的 scope/draft、原生队列、引用、滚动、权限问答与冲突能力由真实适配器驱动。附件上传未接通，因此不展示虚假的可用上传入口。

## 剩余用户侧验证条件

- 在你自己的本机环境配置真实模型 endpoint / model / key，并手动重启 Agent；历史 live 轮在隔离容器和测试公司中完成，未使用你的生产数据。
- 授予所需真实 Git 项目根，运行自己的工程命令和 CI；外部 MCP 仅按你的实际配置使用。
- 真实自然语言 HR 创建与 Agent 间推理往返已在 2026-10-31 live 轮用真实模型验证；用户自有项目的复杂多任务编码、真实项目人工验收仍待你的环境验证。
- 2026-10-31 live 轮验证的是 Linux arm64 沙箱版；2026-11-02 起 Workspace 本地运行，macOS 本地产品级运行仍需重新验收。
- 浏览器已被用户排除，本报告不声称做过视觉验收。早期启动限制保留在 `browser-results.json` 作为历史记录，不是当前验收阻塞。
