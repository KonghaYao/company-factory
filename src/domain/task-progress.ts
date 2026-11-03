import {
  DomainError,
  requireValue,
  type Issue,
  type TodoItem,
  type TodoStatus,
} from "./types";

/** Hard bounds are business invariants, not UI preferences. */
export const TODO_LIMIT = 50;
export const TODO_CHANGE_LIMIT = 20;
export const TODO_TEXT_MAX = 500;
export const TODO_NOTE_MAX = 2000;
export const TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "done",
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
    invalidDocument(`Invalid ${field} in stored todo record`);
  return value;
}

function actorType(value: unknown, field: string): "user" | "agent" {
  if (value !== "user" && value !== "agent")
    invalidDocument(`Invalid ${field} in stored todo record`);
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

export function cleanTodoNote(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      value.trim().length > 0 &&
      characterLength(value) <= TODO_NOTE_MAX,
    "invalid_input",
    `note must be nonempty text of at most ${TODO_NOTE_MAX} characters`,
  );
  return value;
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

/**
 * Old Issues have no progress fields. Reads never rewrite their files merely to
 * upgrade the shape; every caller receives the same normalized view instead.
 * A legacy `latest_update` key is dropped from the view and never written back.
 */
export function normalizeIssueProgress(
  issue: Issue & { latest_update?: unknown },
): Issue {
  const { latest_update: _legacyLatestUpdate, ...rest } = issue;
  const normalized: Issue = {
    ...rest,
    todos: normalizeTodos(rest.todos),
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
