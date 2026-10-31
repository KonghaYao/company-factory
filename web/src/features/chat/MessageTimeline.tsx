import { useState } from "react";
import { ChevronDown, CornerDownRight, MessageSquare } from "lucide-react";
import type { Agent, ChatMessage, FileReference } from "../../lib/types";
import { clockTime, formatLines, messageText, pretty } from "../../lib/format";
import { groupMeta, groupTimeline } from "../../lib/timeline";
import { Avatar, ErrorBox, Loading } from "../../ui/primitives";
import { Markdown } from "../../ui/Markdown";

/**
 * 时间线按「用户回合 / Agent 工作组」两种条目渲染。
 * 工具调用折叠为一条活动行，避免把会话切碎成几十个气泡。
 */
export function MessageTimeline({
  agent,
  messages,
  loading,
  error,
  hasMore,
  loadingMore,
  busy,
  onLoadMore,
  onSuggestion,
  onOpenReference,
}: {
  agent: Agent;
  messages: ChatMessage[];
  loading: boolean;
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  busy: boolean;
  onLoadMore: () => void;
  onSuggestion: (text: string) => void;
  onOpenReference: (reference: FileReference) => void;
}) {
  const entries = groupTimeline(messages);
  let lastDay = "";

  if (loading) return <Loading label="读取固定会话…" />;

  if (!messages.length)
    return (
      <div className="chat-empty">
        <span className="chat-empty-mark">
          <MessageSquare size={24} />
        </span>
        <h2>与 {agent.name} 开始工作</h2>
        <p>
          在这里讨论目标、推进工作和协调任务。
          <br />
          不同 Issue 共用这一个连续会话。
        </p>
        <div className="suggestion-list">
          <button
            onClick={() =>
              onSuggestion("请介绍你的职责、工作方式和当前可用能力。")
            }
          >
            <CornerDownRight size={14} />
            了解职责与能力
          </button>
          <button
            onClick={() =>
              onSuggestion("我们先梳理一下工作目标和需要明确的问题。")
            }
          >
            <CornerDownRight size={14} />
            一起明确工作目标
          </button>
        </div>
      </div>
    );

  return (
    <div className="timeline">
      <ErrorBox error={error} />
      {hasMore && (
        <button
          className="history-pill"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? "正在加载…" : "加载较早消息"}
        </button>
      )}
      {entries.map((entry) => {
        const anchor = entry.kind === "user" ? entry.message : entry.messages[0];
        const day = dayLabel(anchor.created_at || anchor.timestamp);
        const showDay = day && day !== lastDay;
        if (showDay) lastDay = day;
        return (
          <div key={entry.id}>
            {showDay && <div className="day-divider">{day}</div>}
            {entry.kind === "user" ? (
              <UserTurn
                message={entry.message}
                onOpenReference={onOpenReference}
              />
            ) : (
              <AgentTurn
                agent={agent}
                messages={entry.messages}
                onOpenReference={onOpenReference}
              />
            )}
          </div>
        );
      })}
      {busy && (
        <div className="turn-working" aria-live="polite">
          <Avatar name={agent.name} size="xs" />
          <span className="working-dots">
            <i />
            <i />
            <i />
          </span>
          <span>{agent.name} 正在工作</span>
        </div>
      )}
    </div>
  );
}

function UserTurn({
  message,
  onOpenReference,
}: {
  message: ChatMessage;
  onOpenReference: (reference: FileReference) => void;
}) {
  return (
    <article className="turn turn-user">
      <div className="turn-meta">
        <span>你</span>
        <time>{clockTime(message.created_at || message.timestamp)}</time>
      </div>
      <div className="turn-body user-bubble">
        <Markdown>{messageText(message)}</Markdown>
        <ReferenceChips
          references={message.references}
          onOpen={onOpenReference}
        />
      </div>
    </article>
  );
}

function AgentTurn({
  agent,
  messages,
  onOpenReference,
}: {
  agent: Agent;
  messages: ChatMessage[];
  onOpenReference: (reference: FileReference) => void;
}) {
  const meta = groupMeta(messages);
  const time = clockTime(meta.last?.created_at || meta.last?.timestamp);
  return (
    <article className="turn turn-agent">
      <header className="turn-meta">
        <Avatar name={agent.name} size="xs" />
        <strong>{agent.name}</strong>
        <time>{time}</time>
        {meta.tools > 0 && (
          <span className="turn-activity">{meta.tools} 次工具调用</span>
        )}
      </header>
      <div className="turn-body">
        {messages.map((message, index) =>
          message.role === "tool" ? (
            <ToolRow key={message.id || index} message={message} />
          ) : (
            <AssistantBlock
              key={message.id || index}
              message={message}
              onOpenReference={onOpenReference}
            />
          ),
        )}
      </div>
    </article>
  );
}

function AssistantBlock({
  message,
  onOpenReference,
}: {
  message: ChatMessage;
  onOpenReference: (reference: FileReference) => void;
}) {
  const text = messageText(message);
  return (
    <div className={`assistant-block ${message.role === "system" ? "is-system" : ""}`}>
      {text && <Markdown>{text}</Markdown>}
      <ReferenceChips
        references={message.references}
        onOpen={onOpenReference}
      />
      {message.error && (
        <div className="notice notice-danger">
          {typeof message.error === "string"
            ? message.error
            : message.error.message || "运行返回错误"}
        </div>
      )}
    </div>
  );
}

function ToolRow({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const text = messageText(message);
  const name =
    message.type && message.type !== "tool"
      ? message.type
      : firstLine(text) || "工具活动";
  const failed = Boolean(message.error) || message.status === "error";
  return (
    <div className={`tool-row ${failed ? "is-failed" : ""}`}>
      <button className="tool-summary" onClick={() => setOpen(!open)}>
        <ChevronDown size={13} className={open ? "is-open" : ""} />
        <span className="tool-name">{name}</span>
        {message.status && <span className="tool-status">{message.status}</span>}
      </button>
      {open && (
        <pre className="tool-output">
          {text ? pretty(text) : JSON.stringify(message.tools || message, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ReferenceChips({
  references,
  onOpen,
}: {
  references?: FileReference[];
  onOpen: (reference: FileReference) => void;
}) {
  if (!references?.length) return null;
  return (
    <div className="ref-chips">
      {references.map((reference, index) => (
        <button
          key={`${reference.path}-${index}`}
          className="ref-chip"
          onClick={() => onOpen(reference)}
          title={reference.path}
        >
          {reference.path}
          <span>{formatLines(reference.startLine, reference.endLine)}</span>
        </button>
      ))}
    </div>
  );
}

function firstLine(text: string) {
  const line = text.trim().split("\n")[0] || "";
  return line.length > 72 ? `${line.slice(0, 72)}…` : line;
}

function dayLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today)) return "今天";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}
