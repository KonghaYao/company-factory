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

/**
 * 同一真实任务的 subagent 投影与 background 投影按 `startedAt` 配对的容差。
 *
 * 两个投影各自打点：subagent 在 `subagent_started` 到达时取本机时间，
 * background 用上游 `started_at`，正常只差毫秒级。5 秒足以吸收送达抖动，
 * 又不会把两个先后启动的后台任务串成一对。
 *
 * 上游没有可精确关联两者的身份字段：background 的 `task_id` 是 `bg-<uuid>`，
 * 这个 uuid 与 subagent 的 `instance_id`（child_thread_id）是 spawn 时两次独立
 * 生成的 UUID；投影里也只保留各自 taskId，不保留 instance_id 或元数据。
 * 因此只能在时间窗内配对，且时间窗重叠时必须按「歧义」处理。
 */
export const TASK_PROJECTION_PAIR_TOLERANCE_MS = 5_000;

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

/** 背景投影：`bg-task-*` 事件落的行，标题是 prompt 首行，带 durationMs。 */
function isBackgroundProjection(task: AsyncTask): boolean {
  return task.kind === "background";
}

/**
 * 候选重复的 subagent 投影：只有 `isBackground === true` 才可能是某个后台任务
 * 的另一副面孔。普通前台 subagent 调用（字段缺失或 false）没有对应的
 * background 事件，不能被当成重复行删掉。
 */
function isSubagentProjection(task: AsyncTask): boolean {
  return task.kind === "subagent" && task.isBackground === true;
}

function addProjectionCandidate(
  candidates: Map<AsyncTask, Set<AsyncTask>>,
  task: AsyncTask,
  candidate: AsyncTask,
): void {
  const existing = candidates.get(task);
  if (existing) {
    existing.add(candidate);
    return;
  }
  candidates.set(task, new Set([candidate]));
}

/** 只有恰好一个候选才算无歧义；0 个表示不参与，多个表示有竞争。 */
function onlyProjectionCandidate<T>(candidates: ReadonlySet<T>): T | undefined {
  if (candidates.size !== 1) return undefined;
  for (const candidate of candidates) return candidate;
  return undefined;
}

/**
 * 双方都终态时，新鲜度依据取两侧 `completedAt`/`updatedAt` 中较新的一侧。
 *
 * 背景投影可能停留在更早的终态（`bg-task-*` 事件先到），subagent 投影反而
 * 记录了真正结束的时刻。固定取后台会让新的终态被旧时间戳掩盖，整行被 10 分钟
 * 窗口滤掉。时间戳相同时以后台为准，保持 `bg-task-*` 的权威字段。
 */
function newerTerminalProjection(
  background: AsyncTask,
  subagent: AsyncTask,
): AsyncTask {
  const backgroundAt = terminalTimestamp(background);
  const subagentAt = terminalTimestamp(subagent);
  if (subagentAt === undefined) return background;
  if (backgroundAt === undefined) return subagent;
  return subagentAt > backgroundAt ? subagent : background;
}

/**
 * 同一真实任务的两副投影合并成一行，后台投影为主。
 *
 * - 标题、taskId、kind 一律取后台投影：subagent 的标题多为 `fork` 这类线程名，
 *   没有信息量；后台标题是 prompt 首行。
 * - 只要任一侧仍活跃（非 completed/failed/cancelled），合并结果就保持活跃：
 *   另一侧的终态可能只是一条过时投影，不能拿它把运行中的任务淡出。展示活跃侧
 *   的 status（后台活跃时用后台的），且不套用终态 10 分钟窗口。代价只是任务
 *   实际已结束却短暂显示运行中，不会让运行中的任务消失。
 * - 双方都终态时，状态、时间戳与时长统一取终态时间较新的一侧，避免旧的后台
 *   时间戳掩盖刚结束的 subagent，也避免状态与时长自相矛盾。
 * - 双方都终态且都没有 `completedAt`/`updatedAt` 时，合并结果同样没有时间戳，
 *   由 selector 省略（无法证明新鲜）。
 * - `startedAt` 取更完整的一侧，避免合并后因后台投影缺 startedAt 而丢掉时长。
 */
function mergeTaskProjections(
  background: AsyncTask,
  subagent: AsyncTask,
): AsyncTask {
  const backgroundTerminal = isTerminalTaskStatus(background.status);
  const subagentTerminal = isTerminalTaskStatus(subagent.status);

  if (!backgroundTerminal || !subagentTerminal) {
    const statusSource = backgroundTerminal ? subagent : background;
    return {
      ...background,
      status: statusSource.status,
      startedAt: background.startedAt ?? subagent.startedAt,
      // 活跃行不携带另一侧的终态时间戳，避免后续判断把运行中误当已结束。
      completedAt: statusSource.completedAt,
      updatedAt: statusSource.updatedAt,
      durationMs:
        statusSource.durationMs ?? background.durationMs ?? subagent.durationMs,
    };
  }

  const timeSource = newerTerminalProjection(background, subagent);
  return {
    ...background,
    status: timeSource.status,
    startedAt: timeSource.startedAt ?? background.startedAt ?? subagent.startedAt,
    completedAt: timeSource.completedAt,
    updatedAt: timeSource.updatedAt,
    durationMs: timeSource.durationMs,
  };
}

/**
 * 归一去重：同一个后台任务会同时产生 subagent 投影（`kind: "subagent"`，
 * `taskId` 是 instance_id，标题是线程名）和 background 投影（`kind: "background"`，
 * `taskId` 是 `bg-<uuid>`，标题是 prompt 首行）。两者没有可关联的身份字段，
 * 只能按 `startedAt` 的时间窗配对。
 *
 * 规则：
 * - 只配对 `isBackground === true` 的 subagent，前台 subagent 永不参与；
 * - 只有 1:1 独占候选才合并：任一侧在同一窗口内还有别的候选即为歧义；
 * - 歧义窗口内的后台型 subagent 直接抑制——它们只是同一批后台任务的重复
 *   投影；宁可少显示一行，也不能留下 `fork` 残行或串用另一任务的状态；
 * - 时间窗内没有任何 background 候选的后台型 subagent 不是重复投影，照常显示；
 * - 任一侧缺 `startedAt` 时不建立候选边，因此不会被误配或抑制。
 *
 * 返回新数组，元素仍是原任务对象（被合并的后台投影替换为合并结果），顺序沿用
 * 输入顺序，方便调用方继续排序。
 */
export function dedupeAsyncTaskProjections(
  tasks: readonly AsyncTask[],
): AsyncTask[] {
  const backgrounds = tasks.filter(isBackgroundProjection);
  const subagents = tasks.filter(isSubagentProjection);
  if (backgrounds.length === 0 || subagents.length === 0) return [...tasks];

  const candidatesByBackground = new Map<AsyncTask, Set<AsyncTask>>();
  const candidatesBySubagent = new Map<AsyncTask, Set<AsyncTask>>();
  for (const background of backgrounds) {
    const backgroundStart = parseTaskTime(background.startedAt);
    if (backgroundStart === undefined) continue;
    for (const subagent of subagents) {
      const subagentStart = parseTaskTime(subagent.startedAt);
      if (subagentStart === undefined) continue;
      if (
        Math.abs(backgroundStart - subagentStart) >
        TASK_PROJECTION_PAIR_TOLERANCE_MS
      ) {
        continue;
      }
      addProjectionCandidate(candidatesByBackground, background, subagent);
      addProjectionCandidate(candidatesBySubagent, subagent, background);
    }
  }

  const mergedBackgrounds = new Map<AsyncTask, AsyncTask>();
  const pairedSubagents = new Set<AsyncTask>();
  const ambiguousSubagents = new Set<AsyncTask>();
  for (const subagent of subagents) {
    const backgroundCandidates = candidatesBySubagent.get(subagent);
    if (!backgroundCandidates) continue;
    const background = onlyProjectionCandidate(backgroundCandidates);
    const subagentCandidates = background
      ? candidatesByBackground.get(background)
      : undefined;
    if (!background || !subagentCandidates || subagentCandidates.size !== 1) {
      ambiguousSubagents.add(subagent);
      continue;
    }
    mergedBackgrounds.set(
      background,
      mergeTaskProjections(background, subagent),
    );
    pairedSubagents.add(subagent);
  }

  const result: AsyncTask[] = [];
  for (const task of tasks) {
    if (pairedSubagents.has(task) || ambiguousSubagents.has(task)) continue;
    result.push(mergedBackgrounds.get(task) ?? task);
  }
  return result;
}

/**
 * 过滤、排序与限量：
 * - 活跃任务全部显示，按 startedAt 升序（缺时间排在后面）；
 * - `unobserved:` 活跃任务只在 10 分钟窗口内显示，超窗或缺时间戳即淡出；
 * - 同一真实任务的 subagent / background 两副投影先去重（见
 *   {@link dedupeAsyncTaskProjections}），重复投影不能白占终态名额；
 * - 合并结果只要任一侧活跃就保持活跃，不套用终态窗口；只有双方都终态时才按
 *   两侧较新的 completedAt/updatedAt 校验 10 分钟窗口，再倒序取最近 5 条；
 * - 缺 completedAt/updatedAt 的终态任务无法证明新鲜，直接省略；
 * - 表头计数因此等于去重、限量后的任务数。
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

  // 顺序不可交换：先去重，再校验新鲜度，最后才按名额截断。
  // 反过来先用未去重的终态占满 5 个名额，会让第 6 个不同任务被重复投影挤掉。
  const visible = dedupeAsyncTaskProjections([...active, ...terminal]);

  const mergedActive: AsyncTask[] = [];
  const mergedTerminal: AsyncTask[] = [];
  for (const task of visible) {
    if (isTerminalTaskStatus(task.status)) mergedTerminal.push(task);
    else mergedActive.push(task);
  }

  // 合并不会把活跃投影改成终态；只有双方都终态的合并结果才需要重新证明新鲜
  // （时间戳取两侧较新的一侧），超窗记录不能借合并混进来。
  const recentTerminal = mergedTerminal
    .filter((task) => {
      const at = terminalTimestamp(task);
      return at !== undefined && now - at <= TERMINAL_TASK_WINDOW_MS;
    })
    .sort(compareTerminal)
    .slice(0, TERMINAL_TASK_LIMIT);

  mergedActive.sort(compareActive);

  return [...mergedActive, ...recentTerminal].map((task) => toRow(task, now));
}
