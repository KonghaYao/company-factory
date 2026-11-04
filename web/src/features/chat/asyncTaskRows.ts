import type { ChatDisplayState } from "../../peri/chat/runtime";

/**
 * Chat 异步任务简略栏的派生逻辑。
 *
 * 数据只来自 `ChatDisplayState.tasks`（WS 实时副本投影），这里不持有运行态。
 * `unobserved:` 表示服务重启后无法再观测：只影响文案与可见窗口，不冒充运行中。
 */
export type AsyncTask = ChatDisplayState["tasks"][number];

export type AsyncTaskKind = "subagent" | "background";

/** 状态色只做视觉分组，避免组件里散落状态字符串。 */
export type AsyncTaskTone =
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled"
  | "unknown";

export interface AsyncTaskRow {
  taskId: string;
  kind: AsyncTaskKind;
  kindLabel: string;
  title: string;
  status: string;
  statusLabel: string;
  tone: AsyncTaskTone;
  active: boolean;
  /** 终态优先用 durationMs；运行中由 startedAt 与渲染时钟计算。 */
  duration?: string;
}

/** 终态只保留最近 5 条，且不超过 10 分钟窗口（两个集合取交集）。 */
export const TERMINAL_TASK_LIMIT = 5;
export const TERMINAL_TASK_WINDOW_MS = 10 * 60_000;

/**
 * `unobserved:` 任务只在这段时间内可信。
 *
 * 服务重启后无法再观测任务真实状态；`unobserved:running` 若永久保留，会一直
 * 占用 1 秒刷新并显示「未确认」。窗口取与终态一致的 10 分钟：超窗后没有任何
 * 证据说明它仍相关，直接从栏位淡出（不降级成终态，避免伪造完成时间）。
 * `updatedAt` 与 `startedAt` 都缺失时同样视为过期：无法证明新鲜就不展示。
 */
export const UNOBSERVED_TASK_WINDOW_MS = 10 * 60_000;

/** 活跃任务按秒刷新时长，只剩终态时降频，没有可展示行时不排定时器。 */
export const ACTIVE_TASK_TICK_MS = 1_000;
export const IDLE_TASK_TICK_MS = 30_000;

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const UNOBSERVED_PREFIX = "unobserved:";

/** 后台 shell 与 subagent 之外的任务（工具调用等）不进简略栏。 */
export function isAsyncTask(task: AsyncTask): boolean {
  return (
    task.kind === "subagent" ||
    task.kind === "background" ||
    task.isBackground === true
  );
}

/** 去掉重启后的 `unobserved:` 前缀，仅用于判断终态与状态色。 */
export function normalizeTaskStatus(status: string): string {
  const value = status.trim();
  return value.startsWith(UNOBSERVED_PREFIX)
    ? value.slice(UNOBSERVED_PREFIX.length)
    : value;
}

export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(normalizeTaskStatus(status));
}

export function isUnobservedTaskStatus(status: string): boolean {
  return status.trim().startsWith(UNOBSERVED_PREFIX);
}

/** unobserved 任务的时间基准：优先 updatedAt，其次 startedAt；都没有返回 undefined。 */
export function unobservedTaskTimestamp(task: AsyncTask): number | undefined {
  return parseTaskTime(task.updatedAt) ?? parseTaskTime(task.startedAt);
}

/** 超窗或缺少时间戳的 unobserved 任务不再计入活跃、不参与渲染。 */
export function isUnobservedTaskFresh(task: AsyncTask, now: number): boolean {
  const at = unobservedTaskTimestamp(task);
  return at !== undefined && now - at <= UNOBSERVED_TASK_WINDOW_MS;
}

/** `unobserved:` 表示重启后不可观测，统一显示“未确认”，不冒充运行中。 */
export function taskStatusLabel(status: string): string {
  const value = status.trim();
  if (value.startsWith(UNOBSERVED_PREFIX)) return "未确认";
  switch (value) {
    case "running":
      return "运行中";
    case "waiting":
      return "等待";
    case "completed":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return value || "未知";
  }
}

export function taskStatusTone(status: string): AsyncTaskTone {
  const value = status.trim();
  if (value.startsWith(UNOBSERVED_PREFIX)) return "unknown";
  switch (value) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** 标题可能为空（旧记录或上游缺字段），先退到 summary，避免出现空行。 */
export function taskDisplayTitle(task: AsyncTask): string {
  return task.title.trim() || task.summary?.trim() || "未命名任务";
}

export function parseTaskTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 空态（没有可展示行）不排定时器，避免任务清空后 interval 继续空转。 */
export function taskTickInterval(
  rowCount: number,
  hasActive: boolean,
): number | undefined {
  if (rowCount <= 0) return undefined;
  return hasActive ? ACTIVE_TASK_TICK_MS : IDLE_TASK_TICK_MS;
}

/** 紧凑时长：<1s / 12s / 1m 05s / 1h 02m；非法或负值不显示。 */
export function formatTaskDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1_000) return "<1s";
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/**
 * 终态时间只认 completedAt / updatedAt。
 *
 * `startedAt` 不能证明任务「刚刚结束」：一个几天前开始、只带 startedAt 的
 * completed 记录若回退到 startedAt，会被误判为新鲜并常驻栏位。两者都缺失时
 * 返回 undefined，由 selector 直接省略。
 */
function terminalTimestamp(task: AsyncTask): number | undefined {
  return parseTaskTime(task.completedAt) ?? parseTaskTime(task.updatedAt);
}

function compareIds(left: AsyncTask, right: AsyncTask): number {
  return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
}

function compareActive(left: AsyncTask, right: AsyncTask): number {
  const leftStart = parseTaskTime(left.startedAt) ?? Number.POSITIVE_INFINITY;
  const rightStart = parseTaskTime(right.startedAt) ?? Number.POSITIVE_INFINITY;
  if (leftStart !== rightStart) return leftStart - rightStart;
  return compareIds(left, right);
}

function compareTerminal(left: AsyncTask, right: AsyncTask): number {
  const leftAt = terminalTimestamp(left) ?? Number.NEGATIVE_INFINITY;
  const rightAt = terminalTimestamp(right) ?? Number.NEGATIVE_INFINITY;
  if (leftAt !== rightAt) return rightAt - leftAt;
  return compareIds(left, right);
}

function taskDuration(
  task: AsyncTask,
  active: boolean,
  now: number,
): string | undefined {
  if (active) {
    const startedAt = parseTaskTime(task.startedAt);
    return startedAt === undefined
      ? undefined
      : formatTaskDuration(now - startedAt);
  }
  if (
    typeof task.durationMs === "number" &&
    Number.isFinite(task.durationMs) &&
    task.durationMs >= 0
  ) {
    return formatTaskDuration(task.durationMs);
  }
  const startedAt = parseTaskTime(task.startedAt);
  const endedAt = parseTaskTime(task.completedAt) ?? parseTaskTime(task.updatedAt);
  if (startedAt === undefined || endedAt === undefined) return undefined;
  return formatTaskDuration(endedAt - startedAt);
}

function toRow(task: AsyncTask, now: number): AsyncTaskRow {
  const active = !isTerminalTaskStatus(task.status);
  return {
    taskId: task.taskId,
    kind: task.kind === "subagent" ? "subagent" : "background",
    kindLabel: task.kind === "subagent" ? "Subagent" : "后台",
    title: taskDisplayTitle(task),
    status: task.status,
    statusLabel: taskStatusLabel(task.status),
    tone: taskStatusTone(task.status),
    active,
    duration: taskDuration(task, active, now),
  };
}

/**
 * 过滤、排序与限量：
 * - 活跃任务全部显示，按 startedAt 升序（缺时间排在后面）；
 * - `unobserved:` 活跃任务只在 10 分钟窗口内显示，超窗或缺时间戳即淡出；
 * - 终态任务按 completedAt/updatedAt 倒序，只保留最近 5 条且不超过 10 分钟；
 * - 缺 completedAt/updatedAt 的终态任务无法证明新鲜，直接省略。
 */
export function selectAsyncTaskRows(
  tasks: readonly AsyncTask[],
  now: number,
): AsyncTaskRow[] {
  const active: AsyncTask[] = [];
  const terminal: AsyncTask[] = [];
  for (const task of tasks) {
    if (!isAsyncTask(task)) continue;
    if (isTerminalTaskStatus(task.status)) {
      terminal.push(task);
      continue;
    }
    if (
      isUnobservedTaskStatus(task.status) &&
      !isUnobservedTaskFresh(task, now)
    ) {
      continue;
    }
    active.push(task);
  }

  active.sort(compareActive);
  terminal.sort(compareTerminal);

  const recentTerminal = terminal
    .slice(0, TERMINAL_TASK_LIMIT)
    .filter((task) => {
      const at = terminalTimestamp(task);
      return at !== undefined && now - at <= TERMINAL_TASK_WINDOW_MS;
    });

  return [...active, ...recentTerminal].map((task) => toRow(task, now));
}
