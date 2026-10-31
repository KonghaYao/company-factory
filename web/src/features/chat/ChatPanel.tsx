import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, RotateCcw } from "lucide-react";
import type {
  Agent,
  ChatMessage,
  FileReference,
  Issue,
  Runtime,
  Scope,
} from "../../lib/types";
import { scopeKey } from "../../lib/types";
import { api, list, post, requestId, scoped } from "../../lib/api";
import { messageText } from "../../lib/format";
import { useLocal, emptyLocal } from "../../lib/state";
import { Button, ErrorBox } from "../../ui/primitives";
import { ChatHeader } from "./ChatHeader";
import { MessageTimeline } from "./MessageTimeline";
import { Composer } from "./Composer";
import { RuntimeInputs } from "./RuntimeInputs";
import { InputQueue } from "./InputQueue";

/**
 * 一个 Agent 一个固定会话。Chat 只负责会话本身：
 * 时间线、运行时交互、输入队列与 Composer；业务数据留在右侧工作区。
 */
export function ChatPanel({
  scope,
  agent,
  runtime,
  issues,
  onOpenReference,
}: {
  scope: Scope;
  agent: Agent;
  runtime?: Runtime;
  issues: Issue[];
  onOpenReference: (reference: FileReference) => void;
}) {
  const qc = useQueryClient();
  const local = useLocal(
    (state) => state.scopes[scopeKey(scope)] || emptyLocal,
  );
  const patch = useLocal((state) => state.patch);
  const clearSent = useLocal((state) => state.clearSent);

  const viewport = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const previousHeight = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [inputError, setInputError] = useState<unknown>(null);

  const chat = useQuery({
    queryKey: ["chat", scope.companyId, scope.agentId],
    queryFn: () => api(scoped(scope, "chat")),
    refetchInterval: runtime?.busy ? 800 : 3000,
  });
  const messages = list<ChatMessage>(chat.data, "messages");
  const nextCursor = chat.data?.nextCursor || chat.data?.next_cursor;

  const history = useMutation({
    mutationFn: () => api(scoped(scope, "chat", { cursor: nextCursor })),
    onSuccess: (data) =>
      qc.setQueryData(["chat", scope.companyId, scope.agentId], data),
  });

  const send = useMutation({
    mutationFn: (capture: {
      scope: Scope;
      text: string;
      issueId?: string;
      references: FileReference[];
    }) =>
      post(scoped(capture.scope, "chat"), {
        companyId: capture.scope.companyId,
        text: capture.text,
        issueId: capture.issueId,
        references: capture.references,
        requestId: requestId(),
      }),
    onSuccess: (_receipt, capture) => {
      clearSent(capture.scope, capture.text, capture.references);
      qc.invalidateQueries({
        queryKey: ["chat", capture.scope.companyId, capture.scope.agentId],
      });
      qc.invalidateQueries({
        queryKey: ["runtime", capture.scope.companyId, capture.scope.agentId],
      });
    },
  });
  const stop = useMutation({
    mutationFn: () => post(scoped(scope, "stop"), { companyId: scope.companyId }),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["runtime", scope.companyId, scope.agentId],
      }),
  });
  const restart = useMutation({
    mutationFn: () =>
      post(scoped(scope, "restart"), { companyId: scope.companyId }),
    onSuccess: () => {
      setInputError(null);
      qc.invalidateQueries();
    },
  });

  const signature = messages
    .map((message) => `${message.id}:${messageText(message).length}`)
    .join("|");

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (previousHeight.current) {
      node.scrollTop = node.scrollHeight - previousHeight.current;
      previousHeight.current = 0;
    } else if (atBottom.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [signature]);

  const submit = () => {
    if (!local.draft.trim() || send.isPending) return;
    send.mutate({
      scope: { ...scope },
      text: local.draft,
      issueId: local.issueId,
      references: local.references,
    });
  };

  const session =
    chat.data?.sessionId ||
    runtime?.sessionId ||
    agent.sessionId ||
    agent.session_id;
  const needsRecovery = Boolean(
    runtime &&
      (runtime.status === "error" ||
        runtime.executionBlocked ||
        runtime.closed),
  );
  const busy = Boolean(
    runtime?.busy ||
      runtime?.running ||
      runtime?.activeTurn?.status === "running",
  );

  return (
    <section className="chat-panel">
      <ChatHeader
        agent={agent}
        runtime={runtime}
        session={session}
        needsUser={issues.some((issue) => issue.needs_user)}
        onRestart={() => restart.mutate()}
        restarting={restart.isPending}
      />

      <div
        ref={viewport}
        className="chat-scroll"
        onScroll={(event) => {
          const node = event.currentTarget;
          const nearBottom =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          atBottom.current = nearBottom;
          setShowJump(!nearBottom);
        }}
      >
        <div className="chat-column">
          <MessageTimeline
            agent={agent}
            messages={messages}
            loading={chat.isLoading}
            error={chat.error || history.error}
            hasMore={Boolean(nextCursor)}
            loadingMore={history.isPending}
            busy={busy}
            onLoadMore={() => {
              previousHeight.current = viewport.current?.scrollHeight || 0;
              history.mutate();
            }}
            onSuggestion={(text) => patch(scope, { draft: text })}
            onOpenReference={onOpenReference}
          />
        </div>
        {showJump && messages.length > 0 && (
          <button
            className="jump-latest"
            onClick={() => {
              const node = viewport.current;
              if (!node) return;
              node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
              atBottom.current = true;
              setShowJump(false);
            }}
          >
            <ArrowDown size={13} />
            回到最新
          </button>
        )}
      </div>

      <div className="chat-dock">
        {needsRecovery && (
          <div className="notice notice-warn recovery">
            <span>Peri 会话需要恢复；绑定关系保持不变。</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={restart.isPending}
              onClick={() => restart.mutate()}
            >
              <RotateCcw size={12} />
              {restart.isPending ? "正在恢复…" : "恢复会话"}
            </Button>
          </div>
        )}
        {runtime?.configured === false && (
          <div className="notice notice-warn">
            模型尚未配置。组织、任务与文件仍可使用；开始推理前请按 README 配置模型服务。
          </div>
        )}
        <RuntimeInputs
          scope={scope}
          interactions={runtime?.interactions || []}
          onInputError={setInputError}
        />
        <InputQueue scope={scope} runtime={runtime} />
        <Composer
          agentName={agent.name}
          draft={local.draft}
          references={local.references}
          issueId={local.issueId}
          issues={issues}
          runtime={runtime}
          sending={send.isPending}
          stopping={stop.isPending}
          error={send.error || stop.error || restart.error || inputError}
          onDraft={(text) => patch(scope, { draft: text })}
          onReferences={(references) => patch(scope, { references })}
          onIssue={(issueId) => patch(scope, { issueId })}
          onSend={submit}
          onStop={() => stop.mutate()}
        />
        <ErrorBox error={history.error} />
      </div>
    </section>
  );
}
