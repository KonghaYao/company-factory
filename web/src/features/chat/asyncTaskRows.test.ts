import { describe, expect, test } from "bun:test";
import type { AsyncTask } from "./asyncTaskRows";
import {
  formatTaskDuration,
  isAsyncTask,
  isTerminalTaskStatus,
  normalizeTaskStatus,
  parseTaskTime,
  selectAsyncTaskRows,
  taskDisplayTitle,
  taskStatusLabel,
  taskStatusTone,
  taskTickInterval,
} from "./asyncTaskRows";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function task(
  overrides: Partial<AsyncTask> & Pick<AsyncTask, "taskId">,
): AsyncTask {
  return {
    kind: "subagent",
    title: "任务",
    status: "running",
    ...overrides,
  };
}

describe("isAsyncTask", () => {
  test("只接收 subagent、background 与 isBackground 任务", () => {
    expect(isAsyncTask(task({ taskId: "s", kind: "subagent" }))).toBe(true);
    expect(
      isAsyncTask(task({ taskId: "b", kind: "background", isBackground: true })),
    ).toBe(true);
    expect(
      isAsyncTask(task({ taskId: "x", kind: "shell", isBackground: true })),
    ).toBe(true);
    expect(isAsyncTask(task({ taskId: "t", kind: "tool" }))).toBe(false);
  });
});

describe("task status mapping", () => {
  test("重启后状态保留未确认文案，但终态判断仍看原始状态", () => {
    expect(normalizeTaskStatus("unobserved:running")).toBe("running");
    expect(isTerminalTaskStatus("unobserved:completed")).toBe(true);
    expect(isTerminalTaskStatus("unobserved:running")).toBe(false);
    expect(taskStatusLabel("unobserved:running")).toBe("未确认");
    expect(taskStatusTone("unobserved:running")).toBe("unknown");
  });

  test("状态文案与色调覆盖活跃、终态与未知值", () => {
    expect(taskStatusLabel("running")).toBe("运行中");
    expect(taskStatusLabel("waiting")).toBe("等待");
    expect(taskStatusLabel("completed")).toBe("完成");
    expect(taskStatusLabel("failed")).toBe("失败");
    expect(taskStatusLabel("cancelled")).toBe("已取消");
    expect(taskStatusLabel("queued")).toBe("queued");
    expect(taskStatusLabel("  ")).toBe("未知");

    expect(taskStatusTone("running")).toBe("running");
    expect(taskStatusTone("waiting")).toBe("waiting");
    expect(taskStatusTone("completed")).toBe("done");
    expect(taskStatusTone("failed")).toBe("failed");
    expect(taskStatusTone("cancelled")).toBe("cancelled");
    expect(taskStatusTone("queued")).toBe("unknown");
  });

  test("title 为空时退到 summary，再退到占位文案", () => {
    expect(taskDisplayTitle(task({ taskId: "a", title: "  写测试 " }))).toBe(
      "写测试",
    );
    expect(
      taskDisplayTitle(task({ taskId: "b", title: " ", summary: "npm run dev" })),
    ).toBe("npm run dev");
    expect(taskDisplayTitle(task({ taskId: "c", title: "" }))).toBe("未命名任务");
  });
});

describe("formatTaskDuration", () => {
  test("紧凑格式覆盖秒、分、小时与非法值", () => {
    expect(formatTaskDuration(undefined)).toBeUndefined();
    expect(formatTaskDuration(-1)).toBeUndefined();
    expect(formatTaskDuration(Number.NaN)).toBeUndefined();
    expect(formatTaskDuration(0)).toBe("<1s");
    expect(formatTaskDuration(999)).toBe("<1s");
    expect(formatTaskDuration(1_000)).toBe("1s");
    expect(formatTaskDuration(59_000)).toBe("59s");
    expect(formatTaskDuration(65_000)).toBe("1m 05s");
    expect(formatTaskDuration(3_600_000)).toBe("1h 00m");
    expect(formatTaskDuration(3_723_000)).toBe("1h 02m");
  });

  test("只接受可解析的时间戳", () => {
    expect(parseTaskTime(undefined)).toBeUndefined();
    expect(parseTaskTime("not-a-date")).toBeUndefined();
    expect(parseTaskTime(iso(0))).toBe(NOW);
  });
});

describe("selectAsyncTaskRows", () => {
  test("过滤非异步任务；活跃在前按 startedAt 升序，终态在后", () => {
    const rows = selectAsyncTaskRows(
      [
        task({ taskId: "s1", startedAt: iso(-5_000) }),
        task({
          taskId: "b1",
          kind: "background",
          isBackground: true,
          startedAt: iso(-30_000),
        }),
        task({ taskId: "s2", startedAt: undefined }),
        task({
          taskId: "c1",
          status: "completed",
          startedAt: iso(-60_000),
          completedAt: iso(-1_000),
        }),
        task({ taskId: "tool", kind: "tool", startedAt: iso(-90_000) }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.taskId)).toEqual(["b1", "s1", "s2", "c1"]);
    expect(rows.map((row) => row.active)).toEqual([true, true, true, false]);
    expect(rows[0].kindLabel).toBe("后台");
    expect(rows[1].kindLabel).toBe("Subagent");
  });

  test("同一 kind 的终态按 completedAt/updatedAt 倒序", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "old",
          status: "completed",
          completedAt: iso(-5 * 60_000),
          updatedAt: iso(-5 * 60_000),
        }),
        task({
          taskId: "new",
          status: "completed",
          completedAt: iso(-60_000),
          updatedAt: iso(-60_000),
        }),
        task({ taskId: "updated", status: "failed", updatedAt: iso(-2 * 60_000) }),
        task({ taskId: "without-time", status: "completed" }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.taskId)).toEqual(["new", "updated", "old"]);
  });

  test("活跃任务全部展示，终态最多 5 条", () => {
    const active = Array.from({ length: 8 }, (_, index) =>
      task({
        taskId: `a${index}`,
        startedAt: iso(-(index + 1) * 1_000),
      }),
    );
    const completed = Array.from({ length: 7 }, (_, index) =>
      task({
        taskId: `c${index}`,
        status: "completed",
        startedAt: iso(-60_000),
        completedAt: iso(-(index + 1) * 1_000),
      }),
    );

    const rows = selectAsyncTaskRows([...active, ...completed], NOW);

    expect(rows.filter((row) => row.active)).toHaveLength(8);
    expect(rows.filter((row) => !row.active).map((row) => row.taskId)).toEqual([
      "c0",
      "c1",
      "c2",
      "c3",
      "c4",
    ]);
  });

  test("终态同时受 10 分钟窗口限制，缺时间戳的旧记录不展示", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "stale",
          status: "completed",
          completedAt: iso(-11 * 60_000),
        }),
        task({
          taskId: "fresh",
          status: "completed",
          completedAt: iso(-30_000),
        }),
        task({ taskId: "unknown-time", status: "completed" }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.taskId)).toEqual(["fresh"]);
  });

  test("终态新鲜度只认 completedAt/updatedAt，只有 startedAt 的记录不展示", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "started-only",
          status: "completed",
          startedAt: iso(-60_000),
        }),
        task({
          taskId: "updated-only",
          status: "completed",
          startedAt: iso(-120_000),
          updatedAt: iso(-60_000),
        }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.taskId)).toEqual(["updated-only"]);
  });

  test("时长：运行中由 startedAt 计算，终态优先用 durationMs", () => {
    const rows = selectAsyncTaskRows(
      [
        task({ taskId: "running", startedAt: iso(-12_000) }),
        task({ taskId: "no-start" }),
        task({
          taskId: "measured",
          status: "completed",
          durationMs: 4_500,
          completedAt: iso(-1_000),
        }),
        task({
          taskId: "computed",
          status: "completed",
          startedAt: iso(-10_000),
          completedAt: iso(0),
        }),
      ],
      NOW,
    );

    expect(rows.map((row) => [row.taskId, row.duration])).toEqual([
      ["running", "12s"],
      ["no-start", undefined],
      ["computed", "10s"],
      ["measured", "4s"],
    ]);
  });

  test("没有异步任务时返回空数组", () => {
    expect(
      selectAsyncTaskRows([task({ taskId: "tool", kind: "tool" })], NOW),
    ).toEqual([]);
  });
});

describe("unobserved 任务的时间窗口", () => {
  const WINDOW = 10 * 60_000;

  test("窗口内（含边界）仍然展示并标记为活跃", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "fresh",
          status: "unobserved:running",
          startedAt: iso(-2_000),
          updatedAt: iso(-(WINDOW - 1)),
        }),
        task({
          taskId: "boundary",
          status: "unobserved:waiting",
          startedAt: iso(-1_000),
          updatedAt: iso(-WINDOW),
        }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.taskId)).toEqual(["fresh", "boundary"]);
    expect(rows.every((row) => row.active)).toBe(true);
    expect(rows.map((row) => row.statusLabel)).toEqual(["未确认", "未确认"]);
  });

  test("超窗、缺时间戳或 updatedAt 已过期的任务淡出", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "stale-updated",
          status: "unobserved:running",
          updatedAt: iso(-(WINDOW + 1)),
        }),
        task({
          taskId: "stale-started",
          status: "unobserved:waiting",
          startedAt: iso(-(WINDOW + 1)),
        }),
        task({ taskId: "no-time", status: "unobserved:running" }),
        task({
          taskId: "updated-wins",
          status: "unobserved:running",
          startedAt: iso(-1_000),
          updatedAt: iso(-(WINDOW + 1)),
        }),
        task({
          taskId: "fresh-started",
          status: "unobserved:waiting",
          startedAt: iso(-1_000),
        }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.taskId)).toEqual(["fresh-started"]);
  });

  test("普通运行中任务没有时间戳或超过窗口仍然展示", () => {
    const rows = selectAsyncTaskRows(
      [
        task({ taskId: "running-old", startedAt: iso(-(WINDOW + 1)) }),
        task({ taskId: "running-no-time" }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.taskId)).toEqual([
      "running-old",
      "running-no-time",
    ]);
    expect(rows.every((row) => row.active)).toBe(true);
  });
});

describe("taskTickInterval", () => {
  test("空态不排定时器；活跃秒刷，只有终态时降频", () => {
    expect(taskTickInterval(0, false)).toBeUndefined();
    expect(taskTickInterval(0, true)).toBeUndefined();
    expect(taskTickInterval(1, true)).toBe(1_000);
    expect(taskTickInterval(1, false)).toBe(30_000);
  });
});
