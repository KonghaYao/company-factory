import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  CircleDot,
  FastForward,
  FileCode2,
  ListOrdered,
  Undo2,
  X,
} from "lucide-react";
import type { Issue, Scope } from "../../lib/types";
import { scopeKey } from "../../lib/types";
import { emptyLocal, useLocal, type LocalScope } from "../../lib/state";
import { useChat } from "../../peri/chat/runtime";
import { ChatShellView } from "../../peri/chat/components/ChatShell";
import { createCompanyChatApplication } from "./company-chat-application";

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
  onOpenSettings,
  injectedDraft,
  onInjectedDraft,
}: {
  scope: Scope;
  issues: Issue[];
  onOpenSettings: () => void;
  injectedDraft?: { text: string; revision: number };
  onInjectedDraft?: () => void;
}) {
  const local = useLocal((state) => state.scopes[scopeKey(scope)] || emptyLocal);
  const patch = useLocal((state) => state.patch);
  const application = useMemo(
    () => createCompanyChatApplication(scope),
    [scope.companyId, scope.agentId],
  );
  const chat = useChat(() => application);

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
    </div>
  );
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
          data-slot="company-input-queue"
          className="bg-muted/40 rounded-lg border px-2 py-1.5 text-[11px]"
        >
          <div className="text-muted-foreground mb-1 flex items-center gap-1.5 font-medium">
            <ListOrdered size={12} />
            待投递 <span>{queue.items.length}</span>
          </div>
          {queue.items.map((item) => (
            <div key={item.inputId} className="flex items-center gap-2 py-0.5">
              <code className="text-muted-foreground">{item.inputId.slice(0, 8)}</code>
              <span className="text-muted-foreground">{item.state}</span>
              <span className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  title="取回，不停止当前回复"
                  aria-label="取回输入"
                  className="hover:bg-accent rounded p-1"
                  onClick={() => void chat.takeBackInput(item.inputId)}
                >
                  <Undo2 size={12} />
                </button>
                <button
                  type="button"
                  title="立即投递"
                  aria-label="立即投递输入"
                  className="hover:bg-accent rounded p-1"
                  onClick={() => void chat.forceSendInput(item.inputId)}
                >
                  <FastForward size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
