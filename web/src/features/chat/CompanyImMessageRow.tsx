import { useState } from "react";
import { Hash, MessageSquare } from "lucide-react";
import type { CompanyImEnvelope } from "./companyIm";

const LONG_MESSAGE_CHARS = 480;
const LONG_MESSAGE_LINES = 10;

function isLongMessage(text: string): boolean {
  return (
    text.length > LONG_MESSAGE_CHARS ||
    text.split("\n").length > LONG_MESSAGE_LINES
  );
}

export type CompanyImSenderView = {
  name?: string | null;
  role?: string | null;
};

export type CompanyImThreadView = {
  id?: string | null;
  subject?: string | null;
  question?: string | null;
};

const ROLE_LABELS: Record<string, string> = {
  hr: "HR",
  "department-head": "部长",
  "task-supervisor": "任务主管",
  developer: "开发",
  preview: "预览",
  reviewer: "评审",
  secretary: "秘书",
};

/** 未知 sender 的短 ID：保留头尾，避免撑破卡片，同时仍可人工对账。 */
export function shortSenderId(id: string): string {
  const value = id.trim();
  if (value.length <= 28) return value;
  return `${value.slice(0, 16)}…${value.slice(-8)}`;
}

/**
 * 同事经 company_im 发来的消息。
 *
 * 纯文本渲染（含代码块原文），不使用 raw HTML；正文信封已由解析器剥离。
 * 卡片左对齐、最大宽度 85%，与用户蓝色气泡、assistant 正文和系统通知区分。
 */
export function CompanyImMessageRow({
  message,
  sender,
  thread,
}: {
  message: CompanyImEnvelope;
  sender?: CompanyImSenderView | null;
  thread?: CompanyImThreadView | null;
}) {
  const senderId = message.senderId?.trim() || "";
  const senderName = sender?.name?.trim() || "";
  const displayName = senderName || (senderId ? shortSenderId(senderId) : "未知成员");
  const role = sender?.role?.trim() || "";
  const threadId = message.threadId || thread?.id?.trim() || "";
  const subject = thread?.subject?.trim() || thread?.question?.trim() || "";
  const threadLabel = threadId
    ? `${threadId}${subject ? ` · ${subject}` : ""}`
    : "话题未知";
  const [expanded, setExpanded] = useState(false);
  const collapsible = isLongMessage(message.body || "");
  const collapsed = collapsible && !expanded;

  return (
    <article
      className="flex w-full min-w-0 flex-col items-start gap-1"
      data-slot="peri-company-im-message"
      data-im-thread={threadId || "unknown"}
      data-im-message={message.messageId || "unknown"}
      data-im-sender={senderId || "unknown"}
      data-im-degraded={message.degraded ? "true" : undefined}
      aria-label={`来自 ${displayName} 的 IM 消息`}
    >
      <div className="flex max-w-[85%] min-w-0 flex-col gap-1.5 rounded-2xl border border-[var(--chat-border-2)] bg-[var(--chat-code-bg)] px-3.5 py-2.5 text-sm shadow-sm">
        <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4">
          <MessageSquare
            size={14}
            aria-hidden="true"
            className="shrink-0 text-[var(--chat-link)]"
          />
          <span
            className="text-muted-foreground min-w-0 truncate"
            title={senderId || displayName}
            data-slot="peri-company-im-sender"
          >
            {`来自 ${displayName}`}
          </span>
          {role && (
            <span
              className="text-muted-foreground rounded-full border border-[var(--chat-border-2)] px-1.5 py-0.5 text-[10px] font-medium leading-3"
              data-slot="peri-company-im-role"
            >
              {ROLE_LABELS[role] ?? role}
            </span>
          )}
        </header>

        <span
          className="text-muted-foreground inline-flex max-w-full items-center gap-1 self-start rounded-full border border-[var(--chat-border-1)] bg-background/60 px-2 py-0.5 text-[11px] leading-4"
          title={threadLabel}
          data-slot="peri-company-im-thread"
        >
          <Hash size={11} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 truncate">{threadLabel}</span>
        </span>

        <div
          className={`text-foreground min-w-0 whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere] ${
            collapsed ? "max-h-48 overflow-hidden" : ""
          }`}
          data-slot="peri-company-im-body"
          data-collapsed={collapsed ? "true" : undefined}
        >
          {message.body || "（无正文）"}
        </div>
        {collapsible && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground self-start text-[11px] font-medium"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起" : "展开全文"}
          </button>
        )}
      </div>
    </article>
  );
}
