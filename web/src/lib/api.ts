import type {
  Issue,
  Scope,
  TaskUpdate,
  TaskUpdateKind,
  TodoStatus,
} from "./types";
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown,
    public status = 500,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
/** SDK 契约原因码（例如 answer_failed 下的 unknown_interaction）。 */
export const errorCauseCode = (error: unknown): string | undefined => {
  if (!(error instanceof ApiError)) return undefined;
  const details = error.details;
  if (!details || typeof details !== "object") return undefined;
  const code = (details as { causeCode?: unknown }).causeCode;
  return typeof code === "string" ? code : undefined;
};
export async function api<T = any>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = data.error;
    throw new ApiError(
      typeof error === "string"
        ? error
        : error?.message || data.message || `请求失败 (${res.status})`,
      error?.code || data.code || String(res.status),
      error?.details || data.details,
      res.status,
    );
  }
  return data;
}
export const post = <T = any>(url: string, body: unknown) =>
  api<T>(url, { method: "POST", body: JSON.stringify(body) });
export const scoped = (
  scope: Scope,
  path: string,
  params: Record<string, string | undefined> = {},
) => {
  const search = new URLSearchParams({ companyId: scope.companyId });
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) search.set(key, value);
  return `/api/agents/${encodeURIComponent(scope.agentId)}/${path}?${search}`;
};
export const action = <T = any>(
  companyId: string,
  module: string,
  operation: string,
  input: unknown = {},
) => post<T>("/api/action", { companyId, module, operation, input });
export const list = <T = any>(value: any, key: string): T[] =>
  Array.isArray(value) ? value : value?.[key] || value?.items || [];

/** 与服务端 `updateTodos.changes` 对齐；文本 1..500，单次 1..20 项。 */
export type TodoChange =
  | { op: "add"; text: string; status?: TodoStatus }
  | { op: "update"; todoId: string; text?: string; status?: TodoStatus }
  | { op: "remove"; todoId: string };

export type TaskUpdatePage = {
  items: TaskUpdate[];
  nextCursor: string | null;
};

export type TaskUpdatesResult = {
  issue: Issue;
  update: TaskUpdate | null;
};

export const fetchTaskUpdates = (
  companyId: string,
  input: { issueId: string; cursor?: string; limit?: number },
) =>
  action<TaskUpdatePage>(companyId, "company_tasks", "updates", input);

export const updateTodos = (
  companyId: string,
  input: {
    issueId: string;
    expectedVersion: number;
    requestId: string;
    changes?: TodoChange[];
    order?: string[];
    note?: string;
    kind?: TaskUpdateKind;
  },
) =>
  action<TaskUpdatesResult>(companyId, "company_tasks", "updateTodos", input);

export const addTaskUpdate = (
  companyId: string,
  input: {
    issueId: string;
    expectedVersion: number;
    requestId: string;
    kind?: TaskUpdateKind;
    body: string;
  },
) =>
  action<{ issue: Issue; update: TaskUpdate }>(
    companyId,
    "company_tasks",
    "addUpdate",
    input,
  );
