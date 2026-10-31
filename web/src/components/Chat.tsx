import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Square,
  ChevronDown,
  AtSign,
  Hash,
  X,
  MessageSquare,
  Sparkles,
  Paperclip,
  Terminal,
  FileCode2,
  RotateCcw,
  AlertCircle,
} from "lucide-react";
import type {
  Scope,
  Agent,
  Runtime,
  Issue,
  ChatMessage,
  FileReference,
} from "../lib/types";
import { api, scoped, post, requestId, list } from "../lib/api";
import { useLocal, emptyLocal } from "../lib/state";
import { scopeKey } from "../lib/types";
import { Markdown, ErrorBox, Empty, Loading, shortDate } from "./Common";
import { InputQueue } from "./InputQueue";
import { RuntimeInputs } from "./RuntimeInputs";
function messageText(m: ChatMessage): string {
  const c = m.text ?? m.content ?? "";
  return typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c
          .filter((x) => x.type === "text" || x.text)
          .map((x) => x.text || x.content || "")
          .join("\n")
      : JSON.stringify(c);
}
export function Chat({
  scope,
  agent,
  runtime,
  issues,
  onFile,
}: {
  scope: Scope;
  agent: Agent;
  runtime?: Runtime;
  issues: Issue[];
  onFile: (ref: FileReference) => void;
}) {
  const qc = useQueryClient();
  const local = useLocal((s) => s.scopes[scopeKey(scope)] || emptyLocal);
  const patch = useLocal((s) => s.patch);
  const clearSent = useLocal((s) => s.clearSent);
  const viewport = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const oldHeight = useRef(0);
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [showReference, setShowReference] = useState(false);
  const [referencePath, setReferencePath] = useState("");
  const [inputError, setInputError] = useState<unknown>(null);
  const q = useQuery({
    queryKey: ["chat", scope.companyId, scope.agentId],
    queryFn: () => api(scoped(scope, "chat")),
    refetchInterval: runtime?.busy ? 800 : 3000,
  });
  const history = useMutation({
    mutationFn: () =>
      api(
        scoped(scope, "chat", {
          cursor: q.data?.nextCursor || q.data?.next_cursor,
        }),
      ),
    onSuccess: (data) =>
      qc.setQueryData(["chat", scope.companyId, scope.agentId], data),
  });
  const messages = list<ChatMessage>(q.data, "messages");
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
    mutationFn: () =>
      post(scoped(scope, "stop"), { companyId: scope.companyId }),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["runtime", scope.companyId, scope.agentId],
      }),
  });
  // 仅用户显式触发；SDK restart 保留原 Session，不替换绑定。
  const restart = useMutation({
    mutationFn: () =>
      post(scoped(scope, "restart"), { companyId: scope.companyId }),
    onSuccess: () => {
      setInputError(null);
      qc.invalidateQueries();
    },
  });
  const submit = () => {
    if (local.draft.trim() && !send.isPending)
      send.mutate({
        scope: { ...scope },
        text: local.draft,
        issueId: local.issueId,
        references: local.references,
      });
  };
  const contentSignature = messages
    .map((m) => `${m.id}:${messageText(m).length}`)
    .join("|");
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (oldHeight.current) {
      node.scrollTop = node.scrollHeight - oldHeight.current;
      oldHeight.current = 0;
    } else if (atBottom.current) node.scrollTop = node.scrollHeight;
  }, [contentSignature]);
  useEffect(() => {
    atBottom.current = true;
    setShowCapabilities(false);
    setShowReference(false);
    setInputError(null);
  }, [scope.companyId, scope.agentId]);
  const selected = issues.find((i) => String(i.id) === local.issueId);
  const session =
    q.data?.sessionId ||
    runtime?.sessionId ||
    agent.sessionId ||
    agent.session_id;
  const capabilities = runtime?.capabilities;
  // 只按 SDK 契约事实判断需要恢复；不用 busy 猜测。
  const needsRecovery = Boolean(
    runtime &&
      (runtime.status === "error" ||
        runtime.executionBlocked ||
        runtime.closed),
  );
  const commands = [
    ...(capabilities?.commands || []),
    ...(capabilities?.skills || []),
  ]
    .map((c: any) => (typeof c === "string" ? c : c.name || c.id || c.command))
    .filter(Boolean);
  return (
    <section className="chat-panel">
      <header className="chat-heading">
        <div className="avatar large">{agent.name.slice(0, 1)}</div>
        <div>
          <h1>{agent.name}</h1>
          <p>
            {agent.role} <span className="heading-separator">/</span> 固定会话
          </p>
        </div>
        <span
          className="session-indicator"
          title={session || "等待读取会话绑定"}
        >
          <span className="connected-dot" />
          SESSION
        </span>
      </header>
      <div
        ref={viewport}
        className="chat-viewport"
        onScroll={(e) => {
          const n = e.currentTarget;
          atBottom.current = n.scrollHeight - n.scrollTop - n.clientHeight < 80;
        }}
      >
        {q.data?.nextCursor && (
          <button
            className="history-button"
            disabled={history.isPending}
            onClick={() => {
              oldHeight.current = viewport.current?.scrollHeight || 0;
              history.mutate();
            }}
          >
            {history.isPending ? "正在加载…" : "加载较早消息"}
          </button>
        )}
        <ErrorBox error={q.error || history.error} />
        {q.isLoading ? (
          <Loading label="读取固定会话…" />
        ) : messages.length === 0 ? (
          <Empty
            icon={<MessageSquare size={29} />}
            title={`与 ${agent.name} 开始工作`}
          >
            <p>
              在这里讨论目标、推进工作和协调任务。
              <br />
              不同 Issue 共用这一个连续会话。
            </p>
            <div className="chat-suggestions">
              <button
                onClick={() =>
                  patch(scope, {
                    draft: "请介绍你的职责、工作方式和当前可用能力。",
                  })
                }
              >
                了解职责与能力 <ArrowUp size={12} />
              </button>
              <button
                onClick={() =>
                  patch(scope, {
                    draft: "我们先梳理一下工作目标和需要明确的问题。",
                  })
                }
              >
                一起明确工作目标 <ArrowUp size={12} />
              </button>
            </div>
          </Empty>
        ) : (
          messages.map((m, index) => (
            <article
              key={`${m.id || index}-${index}`}
              className={`chat-message message-${m.role}`}
            >
              <div className="message-heading">
                <span
                  className={`avatar tiny ${m.role === "user" ? "user-avatar" : ""}`}
                >
                  {m.role === "user"
                    ? "我"
                    : m.role === "assistant"
                      ? agent.name.slice(0, 1)
                      : "⌘"}
                </span>
                <strong>
                  {m.role === "user"
                    ? "你"
                    : m.role === "assistant"
                      ? agent.name
                      : m.role === "tool"
                        ? "工具活动"
                        : m.role}
                </strong>
                <time>
                  {shortDate(
                    m.created_at || m.timestamp || (m as any).createdAt,
                  )}
                </time>
                {m.status && <small className="muted">{m.status}</small>}
              </div>
              {m.role === "tool" ? (
                <details className="tool-activity">
                  <summary>
                    <Terminal size={13} />
                    工具结果
                  </summary>
                  <pre>{messageText(m)}</pre>
                </details>
              ) : (
                <Markdown>{messageText(m)}</Markdown>
              )}
              {m.error && (
                <ErrorBox
                  error={`${m.error.code}: ${m.error.message}`}
                />
              )}
              {m.tools?.map((t, i) => (
                <details className="tool-activity" key={i}>
                  <summary>
                    <Terminal size={13} />
                    {t.name || t.toolName || "工具调用"}{" "}
                    <span className="muted">{t.status || ""}</span>
                  </summary>
                  <pre>{JSON.stringify(t, null, 2)}</pre>
                </details>
              ))}
              {m.references?.map((r, i) => (
                <button
                  key={i}
                  className="file-reference"
                  onClick={() => onFile(r)}
                >
                  <FileCode2 size={13} />
                  {r.path}
                  {r.startLine
                    ? `:${r.startLine}${r.endLine !== r.startLine ? `–${r.endLine}` : ""}`
                    : ""}
                </button>
              ))}
            </article>
          ))
        )}
        {runtime?.busy && (
          <div className="live-indicator">
            <span />
            <span />
            <span />
            正在运行
          </div>
        )}
      </div>
      <div className="composer-wrap">
        {runtime && <InputQueue scope={scope} runtime={runtime} />}{" "}
        {runtime?.interactions?.length ? (
          <RuntimeInputs
            scope={scope}
            interactions={runtime.interactions}
            onInputError={setInputError}
          />
        ) : null}
        {needsRecovery && (
          <div className="error-box" role="alert">
            <AlertCircle size={15} />
            <div>
              <strong>运行时需要恢复</strong>
              <p className="muted">
                会话已保留。重启只重建运行时句柄，不会替换 Session 或删除历史。
              </p>
              {runtime?.activeTurn?.stopReason && (
                <p className="muted">
                  最近一轮停止原因：{runtime.activeTurn.stopReason}
                </p>
              )}
              {runtime?.closedReason && (
                <p className="muted">
                  {runtime.closedReason.code}: {runtime.closedReason.message}
                </p>
              )}
              <ErrorBox error={restart.error} />
              <button
                className="secondary small"
                disabled={restart.isPending}
                onClick={() => restart.mutate()}
              >
                <RotateCcw size={12} />
                {restart.isPending ? "正在重启…" : "重启 Agent（保留会话）"}
              </button>
            </div>
          </div>
        )}
        <ErrorBox error={inputError} />
        {runtime?.error && <ErrorBox error={runtime.error} />}
        <ErrorBox error={send.error || stop.error} />
        <div className="composer">
          {selected && (
            <div className="composer-context">
              <Hash size={12} />
              <span>
                #{selected.id} {selected.title}
              </span>
              <button
                aria-label="清除 Issue 上下文"
                onClick={() => patch(scope, { issueId: undefined })}
              >
                <X size={12} />
              </button>
            </div>
          )}
          {local.references.length > 0 && (
            <div className="composer-references">
              {local.references.map((r, i) => (
                <span key={i}>
                  <button onClick={() => onFile(r)}>
                    <FileCode2 size={12} />
                    {r.path.split("/").pop()}
                    {r.startLine ? `:${r.startLine}–${r.endLine}` : ""}
                  </button>
                  <button
                    aria-label="移除引用"
                    onClick={() =>
                      patch(scope, {
                        references: local.references.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            aria-label={`向 ${agent.name} 发送消息`}
            placeholder={`与 ${agent.name} 讨论，或引用文件…`}
            value={local.draft}
            onChange={(e) => patch(scope, { draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            rows={3}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <button
                className="icon-button"
                title="引用文件路径"
                aria-label="引用文件"
                onClick={() => {
                  setShowReference(!showReference);
                  setShowCapabilities(false);
                }}
              >
                <AtSign size={16} />
              </button>
              {commands.length > 0 && (
                <button
                  className="icon-button"
                  title="实际可用命令与技能"
                  onClick={() => {
                    setShowCapabilities(!showCapabilities);
                    setShowReference(false);
                  }}
                >
                  <Terminal size={16} />
                </button>
              )}
              <span className="model-label">
                {runtime?.model || "Agent 默认模型"}
              </span>
            </div>
            <div className="composer-send">
              <span className="key-hint">⌘ / Ctrl ↵</span>
              {runtime?.busy && capabilities?.stop && (
                <button
                  className="stop-button"
                  onClick={() => stop.mutate()}
                  disabled={stop.isPending}
                  title="停止当前回复，不取消业务任务"
                >
                  <Square size={13} />
                </button>
              )}
              <button
                className="send-button"
                aria-label="发送消息"
                disabled={!local.draft.trim() || send.isPending}
                onClick={submit}
              >
                <ArrowUp size={18} />
              </button>
            </div>
          </div>
          {showReference && (
            <form
              className="composer-popover"
              onSubmit={(e) => {
                e.preventDefault();
                if (referencePath.trim()) {
                  patch(scope, {
                    references: [
                      ...local.references,
                      { path: referencePath.trim() },
                    ],
                  });
                  setReferencePath("");
                  setShowReference(false);
                }
              }}
            >
              <label>引用当前 Agent 可访问的文件</label>
              <div>
                <input
                  autoFocus
                  value={referencePath}
                  onChange={(e) => setReferencePath(e.target.value)}
                  placeholder="claude.md 或绝对路径"
                />
                <button className="secondary small">加入引用</button>
              </div>
              <small>精确代码选区可在右侧文件编辑器中添加。</small>
            </form>
          )}
          {showCapabilities && (
            <div className="composer-popover">
              <label>由运行时提供的可用能力</label>
              {commands.map((c) => (
                <button
                  key={c}
                  className="command-row"
                  onClick={() => {
                    patch(scope, {
                      draft: `${local.draft}${local.draft ? "\n" : ""}/${c} `,
                    });
                    setShowCapabilities(false);
                  }}
                >
                  <Terminal size={12} />
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="composer-footnote">
          Enter 换行 · 发送仅表示输入已接收，不代表 Issue 完成
        </div>
      </div>
    </section>
  );
}
