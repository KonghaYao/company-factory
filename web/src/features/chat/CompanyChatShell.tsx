import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  CircleDot,
  FileCode2,
  ListOrdered,
  X,
} from "lucide-react";
import type { Agent, Issue, Runtime, Scope, Thread } from "../../lib/types";
import { agentId, scopeKey } from "../../lib/types";
import { emptyLocal, useLocal, type LocalScope } from "../../lib/state";
import { useChat, type Entry } from "../../peri/chat/runtime";
import { ChatShellView } from "../../peri/chat/components/ChatShell";
import {
  UserMessagePresentationContext,
  type UserMessagePresentation,
} from "../../peri/chat/timeline/rows/UserMessageRow";
import { CompanyImMessageRow } from "./CompanyImMessageRow";
import { parseCompanyImMessage } from "./companyIm";
import { createCompanyChatApplication } from "./company-chat-application";

const NO_AGENTS: Agent[] = [];
const NO_THREADS: Thread[] = [];

/**
 * Company 的 Peri ChatShell 宿主。
 *
 * 数据链只有一条：Peri ChatController → `POST /api/chats` → WebSocket
 * HELLO/SNAPSHOT/UPDATE → `ChatReplica`。公司只补三件事：scope、Issue/引用
 * 上下文与输入队列操作入口。
 */
export function CompanyChatShell({
  scope,
  issues,
  agents = NO_AGENTS,
  threads = NO_THREADS,
  onOpenSettings,
  actualRuntime,
  injectedDraft,
  onInjectedDraft,
}: {
  scope: Scope;
  issues: Issue[];
  /** 公司目录：把 IM senderId 还原成姓名/角色。 */
  agents?: Agent[];
  /** 当前 Agent 参与的话题：把 threadId 还原成 subject。 */
  threads?: Thread[];
  onOpenSettings: () => void;
  /** App 已轮询的 runtime 快照：提供 promptInFlight / promptFailure，不新增端点。 */
  actualRuntime?: Runtime;
  injectedDraft?: { text: string; revision: number };
  onInjectedDraft?: () => void;
}) {
  const local = useLocal((state) => state.scopes[scopeKey(scope)] || emptyLocal);
  const patch = useLocal((state) => state.patch);
  const application = useMemo(
    () => createCompanyChatApplication(scope),
    [scope.companyId, scope.agentId],
  );
  const chat = useChat(() => application, { actualRuntime });

  // 目录就绪后自动打开唯一的固定会话；失败由 ChatBanners 的重载入口恢复。
  const autoSelected = useRef(false);
  useEffect(() => {
    if (autoSelected.current) return;
    const first = chat.chats[0];
    if (!first) return;
    autoSelected.current = true;
    void chat.selectChat(first);
  }, [chat.chats, chat.selectChat]);

  const send = useCallback(
    async (text: string) => {
      const outcome = await chat.send(withCompanyContext(text, local));
      // 引用只服务下一条消息；Issue 关联保持在当前工作上下文里（与旧行为一致）。
      if (outcome.delivered && local.references.length)
        patch(scope, { references: [] });
      return outcome;
    },
    [chat, local, patch, scope],
  );

  const shellChat = useMemo(() => ({ ...chat, send }), [chat, send]);

  return (
    <div className="peri-chat h-full min-h-0" data-slot="company-chat-shell">
      <CompanyImPresentationProvider agents={agents} threads={threads}>
        <ChatShellView
          chat={shellChat}
          onOpenSettings={onOpenSettings}
          chrome={{ sidebar: false, details: false }}
          beforeTimeline={<LoadEarlier chat={chat} />}
          composerExtras={
            <CompanyComposerExtras
              chat={chat}
              scope={scope}
              issues={issues}
              local={local}
            />
          }
          injectedDraft={injectedDraft}
          onInjectedDraft={onInjectedDraft}
        />
      </CompanyImPresentationProvider>
    </div>
  );
}

/** 只替换能从文本信封识别的同事 IM；返回 null 时 Peri 继续渲染默认用户气泡。 */
function CompanyImPresentationProvider({
  agents,
  threads,
  children,
}: {
  agents: Agent[];
  threads: Thread[];
  children: ReactNode;
}) {
  const presentation = useMemo<UserMessagePresentation>(
    () => (entry) => {
      const message = parseCompanyImMessage(entryText(entry));
      if (!message) return null;
      const sender = message.senderId
        ? agents.find((agent) => agentId(agent) === message.senderId)
        : undefined;
      const thread = message.threadId
        ? threads.find((item) => item.id === message.threadId)
        : undefined;
      return (
        <CompanyImMessageRow
          message={message}
          sender={sender}
          thread={thread}
        />
      );
    },
    [agents, threads],
  );

  return (
    <UserMessagePresentationContext.Provider value={presentation}>
      {children}
    </UserMessagePresentationContext.Provider>
  );
}

/** 与 vendored UserMessageRow 的 userText 保持一致：只取 text block。 */
function entryText(entry: Entry): string {
  return entry.blocks
    .filter(
      (block): block is Extract<Entry["blocks"][number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

function withCompanyContext(text: string, local: LocalScope) {
  return [
    local.issueId
      ? `[Company Issue context: ${local.issueId}; same fixed Session]`
      : "",
    local.references.length
      ? `[File references]\n${JSON.stringify(local.references)}`
      : "",
    text,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 历史分页入口：页数据经 SDK 的 history-page fact 进入 Yjs，再以 UPDATE 推送。 */
function LoadEarlier({ chat }: { chat: ReturnType<typeof useChat> }) {
  if (!chat.state) return null;
  return (
    <div className="flex shrink-0 justify-center px-3 pt-2 md:px-5">
      <button
        type="button"
        data-slot="company-load-earlier"
        className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-md px-2 py-1 text-[11px]"
        onClick={() => void chat.loadEarlierHistory()}
      >
        加载更早历史
      </button>
    </div>
  );
}

/** Issue / 文件引用 chips 与输入队列：公司业务事实，不进 Peri 的 Yjs 文档。 */
function CompanyComposerExtras({
  chat,
  scope,
  issues,
  local,
}: {
  chat: ReturnType<typeof useChat>;
  scope: Scope;
  issues: Issue[];
  local: LocalScope;
}) {
  const patch = useLocal((state) => state.patch);
  const issue = issues.find((item) => String(item.id) === local.issueId);
  const queue = chat.state?.inputQueue;

  if (!issue && !local.references.length && !queue?.items.length) return null;

  return (
    <div className="mb-2 space-y-2" data-slot="company-composer-extras">
      {(issue || local.references.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {issue && (
            <span className="bg-accent text-accent-foreground inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]">
              <CircleDot size={12} />
              <span className="max-w-[16rem] truncate">
                #{issue.id} {issue.title}
              </span>
              <button
                type="button"
                aria-label="取消关联任务"
                onClick={() => patch(scope, { issueId: undefined })}
              >
                <X size={11} />
              </button>
            </span>
          )}
          {local.references.map((reference, index) => (
            <span
              key={`${reference.path}-${index}`}
              className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]"
            >
              <FileCode2 size={12} />
              <span className="max-w-[18rem] truncate">
                {reference.path}
                {reference.startLine
                  ? `:${reference.startLine}${reference.endLine ? `-${reference.endLine}` : ""}`
                  : ""}
              </span>
              <button
                type="button"
                aria-label={`移除引用 ${reference.path}`}
                onClick={() =>
                  patch(scope, {
                    references: local.references.filter((_, i) => i !== index),
                  })
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {queue && queue.items.length > 0 && (
        <div
          data-slot="company-input-queue-readonly"
          className="bg-muted/40 text-muted-foreground rounded-lg border px-2 py-1.5 text-[11px]"
        >
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <ListOrdered size={12} />
            旧队列（只读，不会自动执行）
            <span>{queue.items.length} 条</span>
          </div>
          <p>旧队列只读，请重启会话清理。</p>
        </div>
      )}
    </div>
  );
}
