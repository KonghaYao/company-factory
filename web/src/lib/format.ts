import type { ChatMessage } from "./types";

/** 业务状态的中文标签；未收录的状态直接回落到原值。 */
export const statusLabels: Record<string, string> = {
  triage: "待分类",
  plan: "独立计划",
  code: "编写代码",
  ready_preview: "等待 Preview",
  preview: "联合 Preview",
  accepted: "用户验收通过",
  verifying: "CI / Code Review",
  ready_merge: "待合入",
  cancel: "已取消",
  pending: "待用户裁定",
  answered: "已处理",
  withdrawn: "已撤回",
  resolved: "已解决",
  open: "讨论中",
  saved: "已保存",
  delivered: "已送入会话",
  replied: "已回复",
  failed: "投递失败",
};

export const statusLabel = (value?: string) =>
  statusLabels[value || ""] || value || "—";

export type StatusTone =
  | "neutral"
  | "positive"
  | "warning"
  | "danger"
  | "active";

/** 按阶段归组，用于任务列表的分区标题。 */
export const statusTone = (value?: string): StatusTone => {
  switch (value) {
    case "accepted":
    case "resolved":
    case "replied":
    case "ready_merge":
      return "positive";
    case "pending":
    case "ready_preview":
      return "warning";
    case "failed":
    case "cancel":
      return "danger";
    case "code":
    case "preview":
    case "verifying":
      return "active";
    default:
      return "neutral";
  }
};

export const shortDate = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

export const clockTime = (value?: string) =>
  value
    ? new Date(value).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

export const relativeTime = (value?: string) => {
  if (!value) return "";
  const gap = Date.now() - new Date(value).getTime();
  if (Number.isNaN(gap)) return "";
  const minute = 60_000;
  if (gap < minute) return "刚刚";
  if (gap < 60 * minute) return `${Math.floor(gap / minute)} 分钟前`;
  if (gap < 24 * 60 * minute) return `${Math.floor(gap / (60 * minute))} 小时前`;
  return shortDate(value);
};

/** SDK 消息的正文可能是字符串或内容块数组。 */
export function messageText(message: ChatMessage): string {
  const content = message.text ?? message.content ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((block) => block.type === "text" || block.text)
      .map((block) => block.text || block.content || "")
      .join("\n");
  return JSON.stringify(content);
}

export function initials(name?: string) {
  const trimmed = (name || "?").trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

export function fileLabel(path: string) {
  const name = path.split("/").pop() || path;
  return name || path;
}

export const formatLines = (start?: number, end?: number) => {
  if (!start) return "";
  if (!end || end === start) return `:${start}`;
  return `:${start}–${end}`;
};

/** 把 JSON 结果渲染成可折叠文本时，避免巨型对象的单行爆炸。 */
export const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
