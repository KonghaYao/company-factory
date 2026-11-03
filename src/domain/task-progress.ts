import {
  DomainError,
  requireValue,
  type Issue,
  type LatestUpdate,
  type TaskUpdate,
  type TaskUpdateKind,
  type TodoItem,
  type TodoStatus,
} from "./types";

/** Hard bounds are business invariants, not UI preferences. */
export const TODO_LIMIT = 50;
export const TODO_CHANGE_LIMIT = 20;
export const TODO_TEXT_MAX = 500;
export const UPDATE_LIMIT = 2000;
export const UPDATE_BODY_MAX = 4000;
export const UPDATE_NOTE_MAX = 2000;
export const UPDATE_PAGE_DEFAULT = 20;
export const UPDATE_PAGE_MAX = 50;
export const LATEST_UPDATE_EXCERPT_MAX = 180;
export const TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "done",
];
export const TASK_UPDATE_KINDS: readonly TaskUpdateKind[] = [
  "progress",
  "blocker",
  "decision",
];

export type TodoActor = { type: "user" | "agent"; id: string };
export type TodoCounts = { total: number; done: number; in_progress: number };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalidDocument(message: string): never {
  throw new DomainError("invalid_document", message, 500);
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    invalidDocument(`Invalid ${field} in stored todo/update record`);
  return value;
}

function actorType(value: unknown, field: string): "user" | "agent" {
  if (value !== "user" && value !== "agent")
    invalidDocument(`Invalid ${field} in stored todo/update record`);
  return value;
}

export function todoStatus(value: unknown): TodoStatus {
  if (typeof value !== "string" || !TODO_STATUSES.includes(value as TodoStatus))
    throw new DomainError(
      "invalid_input",
      `status must be one of ${TODO_STATUSES.join(", ")}`,
    );
  return value as TodoStatus;
}

export function taskUpdateKind(
  value: unknown,
  fallback: TaskUpdateKind = "progress",
): TaskUpdateKind {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    !TASK_UPDATE_KINDS.includes(value as TaskUpdateKind)
  )
    throw new DomainError(
      "invalid_input",
      `kind must be one of ${TASK_UPDATE_KINDS.join(", ")}`,
    );
  return value as TaskUpdateKind;
}

/** Single-line plain text; the UI must not render it as Markdown. */
export function cleanTodoText(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      value.trim().length > 0 &&
      !/[\r\n]/.test(value) &&
      characterLength(value) <= TODO_TEXT_MAX,
    "invalid_input",
    `todo text must be one nonempty line of at most ${TODO_TEXT_MAX} characters`,
  );
  return value;
}

export function cleanUpdateBody(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      value.trim().length > 0 &&
      characterLength(value) <= UPDATE_BODY_MAX,
    "invalid_input",
    `update body must be nonempty text of at most ${UPDATE_BODY_MAX} characters`,
  );
  return value;
}

export function cleanUpdateNote(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      value.trim().length > 0 &&
      characterLength(value) <= UPDATE_NOTE_MAX,
    "invalid_input",
    `note must be nonempty text of at most ${UPDATE_NOTE_MAX} characters`,
  );
  return value;
}

export function latestUpdateExcerpt(body: unknown): string {
  return Array.from(
    String(body ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, LATEST_UPDATE_EXCERPT_MAX)
    .join("");
}

export function todoCounts(todos: TodoItem[] | undefined | null): TodoCounts {
  const rows = Array.isArray(todos) ? todos : [];
  return {
    total: rows.length,
    done: rows.filter((item) => item.status === "done").length,
    in_progress: rows.filter((item) => item.status === "in_progress").length,
  };
}

function normalizeTodos(value: unknown): TodoItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalidDocument("Issue todos must be an array");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!isRecord(raw)) invalidDocument("Invalid todo item shape");
    const id = requiredString(raw.id, "todo id");
    if (seen.has(id)) invalidDocument("Duplicate todo id");
    seen.add(id);
    const text = requiredString(raw.text, "todo text");
    if (characterLength(text) > TODO_TEXT_MAX || /[\r\n]/.test(text))
      invalidDocument("Stored todo text is not a single short line");
    const status = raw.status;
    if (!TODO_STATUSES.includes(status as TodoStatus))
      invalidDocument("Invalid stored todo status");
    const created_by_type = actorType(raw.created_by_type, "created_by_type");
    const updated_by_type = actorType(raw.updated_by_type, "updated_by_type");
    const item: TodoItem = {
      id,
      text,
      status: status as TodoStatus,
      created_at: requiredString(raw.created_at, "todo created_at"),
      created_by_type,
      created_by_id: requiredString(raw.created_by_id, "created_by_id"),
      updated_at: requiredString(raw.updated_at, "todo updated_at"),
      updated_by_type,
      updated_by_id: requiredString(raw.updated_by_id, "updated_by_id"),
    };
    if (raw.done_at !== undefined && raw.done_at !== null)
      item.done_at = requiredString(raw.done_at, "done_at");
    return item;
  });
}

function normalizeLatestUpdate(value: unknown): LatestUpdate | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) invalidDocument("Invalid latest_update projection");
  const kind = value.kind;
  if (!TASK_UPDATE_KINDS.includes(kind as TaskUpdateKind))
    invalidDocument("Invalid latest_update kind");
  return {
    id: requiredString(value.id, "latest_update id"),
    created_at: requiredString(value.created_at, "latest_update created_at"),
    author_type: actorType(value.author_type, "latest_update author_type"),
    author_id: requiredString(value.author_id, "latest_update author_id"),
    kind: kind as TaskUpdateKind,
    excerpt: requiredString(value.excerpt, "latest_update excerpt"),
  };
}

/**
 * Old Issues have no progress fields. Reads never rewrite their files merely to
 * upgrade the shape; every caller receives the same normalized view instead.
 */
export function normalizeIssueProgress(issue: Issue): Issue {
  const normalized: Issue = {
    ...issue,
    todos: normalizeTodos(issue.todos),
    latest_update: normalizeLatestUpdate(issue.latest_update),
  };
  if (
    issue.todo_seq === undefined ||
    !Number.isInteger(issue.todo_seq) ||
    issue.todo_seq < 0
  )
    delete normalized.todo_seq;
  return normalized;
}

export function nextTodoSeq(todos: TodoItem[], stored?: unknown): number {
  let sequence =
    Number.isInteger(stored) && Number(stored) >= 0 ? Number(stored) : 0;
  for (const item of todos) {
    const match = /-T(\d+)$/.exec(item.id);
    if (match) sequence = Math.max(sequence, Number(match[1]));
  }
  return sequence;
}

/** Apply validated todo changes in order; order is normalized separately. */
export function applyTodoChanges(options: {
  issueId: string;
  todos: TodoItem[];
  changes: unknown;
  actor: TodoActor;
  at: string;
  sequence: number;
}): { todos: TodoItem[]; sequence: number } {
  const { issueId, actor, at } = options;
  const todos = options.todos.map((item) => ({ ...item }));
  let sequence = options.sequence;
  const changes = options.changes;
  requireValue(
    Array.isArray(changes) &&
      changes.length >= 1 &&
      changes.length <= TODO_CHANGE_LIMIT,
    "invalid_input",
    `changes must contain 1-${TODO_CHANGE_LIMIT} todo operations`,
  );
  for (const raw of changes) {
    requireValue(
      isRecord(raw),
      "invalid_input",
      "Each todo change must be an object",
    );
    const op = raw.op;
    if (op === "add") {
      const text = cleanTodoText(raw.text);
      const status =
        raw.status === undefined ? "pending" : todoStatus(raw.status);
      sequence++;
      const item: TodoItem = {
        id: `${issueId}-T${sequence}`,
        text,
        status,
        created_at: at,
        created_by_type: actor.type,
        created_by_id: actor.id,
        updated_at: at,
        updated_by_type: actor.type,
        updated_by_id: actor.id,
      };
      if (status === "done") item.done_at = at;
      todos.push(item);
      continue;
    }
    if (op === "update") {
      requireValue(
        typeof raw.todoId === "string" && raw.todoId.length > 0,
        "invalid_input",
        "todoId is required",
      );
      requireValue(
        raw.text !== undefined || raw.status !== undefined,
        "invalid_input",
        "update requires text or status",
      );
      const index = todos.findIndex((item) => item.id === raw.todoId);
      requireValue(
        index >= 0,
        "not_found",
        "Todo was not found on this Issue",
        404,
      );
      const item = todos[index]!;
      if (raw.text !== undefined) item.text = cleanTodoText(raw.text);
      if (raw.status !== undefined) {
        const status = todoStatus(raw.status);
        if (status === "done") {
          if (item.status !== "done") item.done_at = at;
        } else delete item.done_at;
        item.status = status;
      }
      item.updated_at = at;
      item.updated_by_type = actor.type;
      item.updated_by_id = actor.id;
      continue;
    }
    if (op === "remove") {
      requireValue(
        typeof raw.todoId === "string" && raw.todoId.length > 0,
        "invalid_input",
        "todoId is required",
      );
      const index = todos.findIndex((item) => item.id === raw.todoId);
      requireValue(
        index >= 0,
        "not_found",
        "Todo was not found on this Issue",
        404,
      );
      todos.splice(index, 1);
      continue;
    }
    throw new DomainError("invalid_input", "op must be add, update or remove");
  }
  requireValue(
    todos.length <= TODO_LIMIT,
    "todo_limit",
    `An Issue may have at most ${TODO_LIMIT} todos; split the Issue or keep the long list in its body`,
    400,
  );
  return { todos, sequence };
}

/** Reorder must be a complete, duplicate-free permutation of current ids. */
export function applyTodoOrder(todos: TodoItem[], order: unknown): TodoItem[] {
  requireValue(
    Array.isArray(order) && order.length === todos.length && order.length > 0,
    "invalid_input",
    "order must list every current todo exactly once",
  );
  const byId = new Map(todos.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const result: TodoItem[] = [];
  for (const id of order) {
    requireValue(
      typeof id === "string" && byId.has(id) && !seen.has(id),
      "invalid_input",
      "order must list every current todo exactly once",
    );
    seen.add(id);
    result.push(byId.get(id)!);
  }
  return result;
}

/** Validate an append-only record read from disk; unknown schemas are errors. */
export function normalizeTaskUpdate(
  value: unknown,
  expectedIssueId?: string,
): TaskUpdate {
  if (!isRecord(value) || value.schema !== "company-update/v1")
    invalidDocument("Unsupported task update schema");
  if (value.version !== 1)
    invalidDocument("Unsupported task update record version");
  const kind = value.kind;
  if (!TASK_UPDATE_KINDS.includes(kind as TaskUpdateKind))
    invalidDocument("Invalid task update kind");
  const issueId = requiredString(value.issue_id, "issue_id");
  if (expectedIssueId !== undefined && issueId !== expectedIssueId)
    invalidDocument("Task update belongs to another Issue");
  const counts = value.todo_counts;
  if (!isRecord(counts)) invalidDocument("Invalid task update todo_counts");
  for (const key of ["total", "done", "in_progress"])
    if (!Number.isInteger(counts[key]) || Number(counts[key]) < 0)
      invalidDocument("Invalid task update todo_counts");
  const status = value.status;
  if (
    ![
      "triage",
      "plan",
      "code",
      "ready_preview",
      "preview",
      "accepted",
      "verifying",
      "ready_merge",
      "cancel",
    ].includes(String(status))
  )
    invalidDocument("Invalid task update status snapshot");
  if (typeof value.body !== "string")
    invalidDocument("Invalid task update body");
  return {
    schema: "company-update/v1",
    id: requiredString(value.id, "id"),
    issue_id: issueId,
    author_type: actorType(value.author_type, "author_type"),
    author_id: requiredString(value.author_id, "author_id"),
    kind: kind as TaskUpdateKind,
    created_at: requiredString(value.created_at, "created_at"),
    version: 1,
    status: status as TaskUpdate["status"],
    todo_counts: {
      total: Number(counts.total),
      done: Number(counts.done),
      in_progress: Number(counts.in_progress),
    },
    body: value.body,
  };
}
