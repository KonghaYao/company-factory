import type { ChatMessage } from "./types";
import { messageText } from "./format";

/**
 * 时间线条目：用户消息单独成条，其余角色（assistant / tool / system）
 * 连续出现时合并成一组，避免每个工具调用都占一条独立气泡。
 */
export type TimelineEntry =
  | { kind: "user"; id: string; message: ChatMessage }
  | { kind: "group"; id: string; messages: ChatMessage[] };

const isUser = (message: ChatMessage) => message.role === "user";
const isError = (message: ChatMessage) =>
  Boolean(message.error) || message.status === "error";

export function groupTimeline(messages: ChatMessage[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let pending: ChatMessage[] = [];

  const flush = () => {
    if (!pending.length) return;
    entries.push({
      kind: "group",
      id: pending[0].id || `group-${entries.length}`,
      messages: pending,
    });
    pending = [];
  };

  messages.forEach((message, index) => {
    if (isUser(message)) {
      flush();
      entries.push({
        kind: "user",
        id: message.id || `user-${index}`,
        message,
      });
      return;
    }
    pending.push(message);
  });
  flush();
  return entries;
}

export function groupMeta(messages: ChatMessage[]) {
  const tools = messages.filter((message) => message.role === "tool");
  const assistant = messages.filter((message) => message.role === "assistant");
  const hasError = messages.some(isError);
  const chars = messages.reduce(
    (total, message) => total + messageText(message).length,
    0,
  );
  return {
    tools: tools.length,
    assistant: assistant.length,
    hasError,
    chars,
    last: messages[messages.length - 1],
  };
}

/** 把一条消息里的待展开内容拆出来，供折叠面板使用。 */
export function messageParts(message: ChatMessage) {
  const text = messageText(message);
  return {
    text,
    tools: message.tools || [],
    references: message.references || [],
    isTool: message.role === "tool",
    error: message.error,
  };
}
