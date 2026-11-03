import { ApiError } from "./api";
import type { StatusTone } from "./format";
import type { Issue, TaskUpdateKind, TodoItem, TodoStatus } from "./types";

export type TodoProgress = {
  total: number;
  done: number;
  inProgress: number;
  percent: number;
};

/** 待办进度只依赖 todo 数组；空数组不渲染 0/0。 */
export const todoProgress = (todos?: TodoItem[] | null): TodoProgress => {
  const list = todos ?? [];
  const done = list.filter((todo) => todo.status === "done").length;
  const inProgress = list.filter(
    (todo) => todo.status === "in_progress",
  ).length;
  return {
    total: list.length,
    done,
    inProgress,
    percent: list.length ? Math.round((done / list.length) * 100) : 0,
  };
};

export const todoStatusLabels: Record<TodoStatus, string> = {
  pending: "待开始",
  in_progress: "进行中",
  done: "已完成",
};

export const todoStatusOptions: { value: TodoStatus; label: string }[] = [
  { value: "pending", label: todoStatusLabels.pending },
  { value: "in_progress", label: todoStatusLabels.in_progress },
  { value: "done", label: todoStatusLabels.done },
];

export const taskUpdateKindLabels: Record<TaskUpdateKind, string> = {
  progress: "进展",
  blocker: "阻塞",
  decision: "决定",
};

export const taskUpdateKindTone: Record<TaskUpdateKind, StatusTone> = {
  progress: "active",
  blocker: "warning",
  decision: "positive",
};

/** 服务端要求整数 expectedVersion；缺省值不猜测，交给调用方提示刷新。 */
export const issueExpectedVersion = (issue: Issue): number | undefined => {
  const version =
    typeof issue.version === "number" ? issue.version : Number(issue.version);
  return Number.isInteger(version) ? version : undefined;
};

export const isVersionConflict = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "version_conflict";
