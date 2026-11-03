import type { TodoItem, TodoStatus } from "./types";

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
