# Vendored Peri Chat

本目录是 Peri 官方 Chat 前端与服务端协议面的只读副本，供 Company 工作台复用。

## 基线

- 仓库：`/Users/mino/code/peri`（Peri）
- commit：`47dff27b968a36e9371e69088ed9e94651af3e2c`
- 源目录：`npm-packages/peri-cf/`
- 许可：Apache-2.0（见同目录 `LICENSE`）
- vendor 文件数：90；逐文件 sha256 汇总：
  `43bd24c5cad94914c74ab6207053b650e4a49f426a3c52bf144e60f5a945b50a`
  （计算方式：`find . -type f ! -name VENDOR.md ! -path './patches/*' -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256`）
- 补丁汇总：`patches/company-chat.patch`（相对本目录，`patch -p1` 应用）

## 来源 → 目标

| 源（Peri） | 目标 |
|---|---|
| `frontend/remote/*.ts`（不含 `monitor.ts` 与测试） | `web/src/peri/remote/` |
| `frontend/chat/**`（不含测试） | `web/src/peri/chat/` |
| `frontend/components/assistant-ui/**`（不含测试） | `web/src/peri/components/assistant-ui/` |
| `frontend/lib/**`、`frontend/hooks/**`（不含测试） | `web/src/peri/lib/`、`web/src/peri/hooks/` |
| `frontend/styles/*.css` | `web/src/peri/styles/` |
| `frontend/tailwind.css` | `web/src/peri/peri-tailwind.css`（实际入口为 `web/src/styles/peri-chat.css`） |
| `server/api/sync.ts`、`server/api/errors.ts`、`server/logging.ts` | `src/server/peri/` |
| 仓库根 `LICENSE` | `web/src/peri/LICENSE` |

**未 vendor**：`frontend/app/**`（设置页/监控页）、`frontend/remote/monitor.ts`、
`server/registry.ts`（公司按固定 Session 语义重写）、`server/sandbox.ts`、`server/projects.ts`。

## 补丁清单

| # | 文件 | 改动 |
|---|---|---|
| P1 | `chat/runtime/useChat.ts` | `useChat(createApplication = createChatApplication)`，允许宿主注入组合根；导出队列/历史命令 |
| P2 | `remote/controller.ts` | SDK 缺少 `setConfigOption` 时返回 `{ok:false}`，不抛 `TypeError`；SDK 0.4.0 已有该动作，Company 服务端仍拒绝会话内改配置 |
| P3 | `chat/components/ChatShell.tsx` | `h-dvh`→`h-full`；`chrome.sidebar/details` 开关；`beforeTimeline`/`composerExtras`/`injectedDraft` 宿主插槽 |
| P4 | `chat/components/ChatHeader.tsx` | `showSidebar`/`showDetails` 为 false 时不渲染触发器 |
| P5 | `chat/composer/composerLimits.ts`、`draftStorage.ts` | SDK 未导出 `CHAT_SEND_TEXT_MAX_LENGTH` 时改用本地 `32_768`；SDK 0.4.0 已导出，本地值保持不变 |
| P6 | `chat/components/shell/ChatBanners.tsx` | “关闭并新建” → “重启会话”（Company DELETE 语义） |
| P7 | `remote/controller.ts` | `rebuildChat` 重开同一固定 Session；新增 `loadEarlierHistory`/`takeBackInput`/`forceSendInput` |
| P8 | `remote/index.ts` | 移除 `./monitor` 导出（公司不 vendor 监控页） |
| P9 | 多个 `@/lib`、`@/hooks` 导入 | 改为相对路径；项目不配置 `@/*` 别名 |
| P10 | `server/api/sync.ts` → `src/server/peri/sync.ts` | `logError` 导入改为同目录 `./logging` |
| P11 | `chat/composer/ChatComposer.tsx` | Composer 改版：删除 Enter/Shift+Enter 快捷键提示与占位符长文案；新增 `peri-composer-input`/`textarea`/`send` 三个 `data-slot`，供公司作用域样式绑定 |
| P12 | `chat/timeline/rows/UserMessageRow.tsx` | 新增可选 `UserMessagePresentationContext`：宿主可把 `role === "user"` 的条目替换为公司 IM 卡片；无 Provider 时保持 Peri 原气泡，Provider 返回 `null` 时交回默认渲染 |
| P13 | `chat/timeline/rows/UserMessageRow.tsx` | 超长用户输入（>480 字或 >10 行）默认限制高度，提供“展开全文/收起”；短消息与复制按钮行为不变 |

P3/P7 是 Company 单会话外壳的宿主适配；P2/P5 是 SDK 与 Peri HEAD 的版本漂移守卫（当前 SDK 0.4.0）。
除以上补丁外，`remote/` 与 `chat/` 的行为代码保持 Peri 原件。

P11 只改文案与 `data-slot` 标记，不改发送/停止/IME/斜杠命令等行为。
Composer 的视觉皮肤放在公司自有 `web/src/styles/peri-chat.css`（`.peri-chat [data-slot="composer-shell"]` 等作用域），
不 vendor 进 Peri 源码；重新 vendor 后按 P11 重放标记即可继续生效。

P12 只增加可选展示上下文与分支，不改变默认用户气泡、复制按钮或时间线数据结构。
P13 只增加超长用户输入的折叠状态，不改变消息内容、复制或时间线数据结构。
Company IM 的解析与卡片位于公司自有 `web/src/features/chat/companyIm.ts` 与
`CompanyImMessageRow.tsx`；重新 vendor 后按 P12 重放上下文导出即可继续生效。

## Tailwind 接入

- `web/src/styles/peri-chat.css` 只引 `tailwindcss/theme.css` 与 `utilities.css`，**不引 preflight**。
- 主题变量收敛到 `.peri-chat`，避免覆盖公司 `tokens.css` 的 `--accent`/`--border`/`--muted` 等。
- 作用域 preflight 子集放在 `@layer base`；公司 `base.css` 的元素重置也移入 base 层，
  这样 Peri 子树里的 utilities 才能覆盖 `button { background:none }` 等未分层规则。
- `--chat-*`（`styles/chat-tokens.css`）保留在 `:root`，供 `installOpenUITheme()` 读取。

## 更新方式

1. 在 Peri 仓库切到目标 commit，确认没有未提交改动。
2. 按上表重新复制文件（排除测试、`monitor.ts`、`frontend/app/**`）。
3. 依据 `patches/company-chat.patch` 重放补丁；更新本文件的 commit 与 sha256。
4. `npx tsc --noEmit && npx vite build && bun test`。
