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

  test("终态先去重再占名额：重复投影不会挤掉第 6 个不同终态", () => {
    const unique = ["u1", "u2", "u3", "u4", "u5"].map((taskId, index) =>
      task({
        taskId,
        status: "completed",
        completedAt: iso(-(index + 2) * 1_000),
        updatedAt: iso(-(index + 2) * 1_000),
      }),
    );
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "dup-bg",
          kind: "background",
          isBackground: true,
          title: "重复任务",
          status: "completed",
          startedAt: iso(-60_000),
          completedAt: iso(-1_000),
          durationMs: 59_000,
        }),
        task({
          taskId: "dup-inst",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          status: "completed",
          startedAt: iso(-59_900),
          completedAt: iso(-1_100),
        }),
        ...unique,
      ],
      NOW,
    );

    expect(rows.map((row) => row.taskId)).toEqual([
      "dup-bg",
      "u1",
      "u2",
      "u3",
      "u4",
    ]);
    expect(rows).toHaveLength(5);
    expect(rows.some((row) => row.title === "fork")).toBe(false);
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

  test("合并后的终态按两侧较新的时间戳校验 10 分钟窗口", () => {
    const WINDOW = 10 * 60_000;
    const merged = (backgroundOffset: number, subagentOffset: number) =>
      selectAsyncTaskRows(
        [
          task({
            taskId: "bg-window",
            kind: "background",
            isBackground: true,
            title: "独立核验",
            status: "completed",
            startedAt: iso(-15 * 60_000),
            completedAt: iso(backgroundOffset),
            updatedAt: iso(backgroundOffset),
          }),
          task({
            taskId: "inst-window",
            kind: "subagent",
            isBackground: true,
            title: "fork",
            status: "completed",
            startedAt: iso(-15 * 60_000 + 200),
            completedAt: iso(subagentOffset),
            updatedAt: iso(subagentOffset),
          }),
        ],
        NOW,
      );

    // 双方都超窗：合并后依然省略。
    expect(merged(-(WINDOW + 1_000), -(WINDOW + 1_000))).toEqual([]);
    // 旧后台 + 新 subagent：以新的一侧为准，边界仍显示。
    expect(
      merged(-(WINDOW + 1_000), -WINDOW).map((row) => [row.taskId, row.status]),
    ).toEqual([["bg-window", "completed"]]);
    // 反向也不能让旧 subagent 掩盖新的后台终态。
    expect(
      merged(-(WINDOW - 1_000), -(WINDOW + 1_000)).map((row) => [
        row.taskId,
        row.status,
      ]),
    ).toEqual([["bg-window", "completed"]]);
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

describe("同一任务的双投影去重", () => {
  test("活跃的后台任务与其 subagent 投影只出一行，标题取后台 summary", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-1",
          kind: "background",
          isBackground: true,
          title: "复核发布清单",
          summary: "复核发布清单",
          startedAt: iso(-30_000),
        }),
        task({
          taskId: "inst-1",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          startedAt: iso(-29_600),
        }),
      ],
      NOW,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: "bg-1",
      kind: "background",
      kindLabel: "后台",
      title: "复核发布清单",
      status: "running",
      statusLabel: "运行中",
      active: true,
      duration: "30s",
    });
  });

  test("已完成的重复对只出一行，标题取后台投影，时长按较新终态计算", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-1",
          kind: "background",
          isBackground: true,
          title: "独立核验",
          status: "completed",
          startedAt: iso(-70_000),
          completedAt: iso(-1_000),
          updatedAt: iso(-1_000),
          durationMs: 69_000,
        }),
        task({
          taskId: "inst-1",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          status: "completed",
          startedAt: iso(-70_400),
          completedAt: iso(-800),
        }),
      ],
      NOW,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: "bg-1",
      kindLabel: "后台",
      title: "独立核验",
      status: "completed",
      active: false,
      duration: "1m 09s",
    });
  });

  test("活跃后台 + 旧终态 subagent：合并后仍为运行中，不因终态窗口消失", () => {
    const background = task({
      taskId: "bg-long",
      kind: "background",
      isBackground: true,
      title: "长任务",
      status: "running",
      startedAt: iso(-12 * 60_000),
    });
    const staleSubagent = task({
      taskId: "inst-stale",
      kind: "subagent",
      isBackground: true,
      title: "fork",
      status: "completed",
      startedAt: iso(-12 * 60_000 + 200),
      completedAt: iso(-11 * 60_000),
      updatedAt: iso(-11 * 60_000),
    });

    expect(selectAsyncTaskRows([background], NOW)).toHaveLength(1);

    const rows = selectAsyncTaskRows([background, staleSubagent], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: "bg-long",
      kindLabel: "后台",
      title: "长任务",
      status: "running",
      statusLabel: "运行中",
      active: true,
    });
  });

  test("旧终态后台 + 活跃 subagent：合并后仍为运行中", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-stale",
          kind: "background",
          isBackground: true,
          title: "长任务",
          status: "completed",
          startedAt: iso(-12 * 60_000),
          completedAt: iso(-11 * 60_000),
          updatedAt: iso(-11 * 60_000),
        }),
        task({
          taskId: "inst-active",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          status: "running",
          startedAt: iso(-12 * 60_000 + 200),
        }),
      ],
      NOW,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: "bg-stale",
      title: "长任务",
      status: "running",
      statusLabel: "运行中",
      active: true,
    });
  });

  test("活跃后台 + 终态 subagent 缺终态时间戳：仍保持活跃", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-long",
          kind: "background",
          isBackground: true,
          title: "长任务",
          status: "running",
          startedAt: iso(-12 * 60_000),
        }),
        task({
          taskId: "inst-no-time",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          status: "completed",
          startedAt: iso(-12 * 60_000 + 200),
        }),
      ],
      NOW,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: "bg-long",
      status: "running",
      active: true,
    });
  });

  test("双方终态：新鲜度与时长取较新的一侧，旧后台时间戳不掩盖新 subagent", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-1",
          kind: "background",
          isBackground: true,
          title: "独立核验",
          status: "completed",
          startedAt: iso(-11 * 60_000),
          completedAt: iso(-11 * 60_000),
          updatedAt: iso(-11 * 60_000),
          durationMs: 69_000,
        }),
        task({
          taskId: "inst-1",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          status: "completed",
          startedAt: iso(-11 * 60_000 + 200),
          completedAt: iso(-60_000),
          updatedAt: iso(-60_000),
          durationMs: 60_000,
        }),
      ],
      NOW,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: "bg-1",
      title: "独立核验",
      status: "completed",
      active: false,
      // 后台的 69s 是旧终态的时长；新终态来自 subagent，展示它的 60s。
      duration: "1m 00s",
    });
  });

  test("双方终态且都无终态时间戳：无法证明新鲜，整行省略", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-1",
          kind: "background",
          isBackground: true,
          title: "独立核验",
          status: "completed",
          startedAt: iso(-30_000),
        }),
        task({
          taskId: "inst-1",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          status: "completed",
          startedAt: iso(-29_800),
        }),
      ],
      NOW,
    );

    expect(rows).toEqual([]);
  });

  test("没有 isBackground 标记的 subagent 照常显示，不被误删", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-1",
          kind: "background",
          isBackground: true,
          title: "复核发布清单",
          startedAt: iso(-30_000),
        }),
        task({
          taskId: "foreground",
          kind: "subagent",
          title: "阅读代码",
          startedAt: iso(-30_000),
        }),
        task({
          taskId: "explicit-false",
          kind: "subagent",
          isBackground: false,
          title: "跑测试",
          startedAt: iso(-29_800),
        }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.taskId)).toEqual([
      "bg-1",
      "foreground",
      "explicit-false",
    ]);
    expect(rows.map((row) => row.kindLabel)).toEqual([
      "后台",
      "Subagent",
      "Subagent",
    ]);
  });

  test("只有 background 投影时正常显示", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-1",
          kind: "background",
          isBackground: true,
          title: "npm run dev",
          startedAt: iso(-12_000),
        }),
      ],
      NOW,
    );

    expect(rows.map((row) => [row.taskId, row.kindLabel, row.title])).toEqual([
      ["bg-1", "后台", "npm run dev"],
    ]);
  });

  test("两个并发后台任务逐对配对：不合并成一行，也不丢任务，活跃侧状态优先", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-a",
          kind: "background",
          isBackground: true,
          title: "任务 A",
          startedAt: iso(-30_000),
        }),
        task({
          taskId: "bg-b",
          kind: "background",
          isBackground: true,
          title: "任务 B",
          startedAt: iso(-20_000),
        }),
        task({
          taskId: "inst-a",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          status: "completed",
          startedAt: iso(-30_400),
          completedAt: iso(-1_000),
        }),
        task({
          taskId: "inst-b",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          startedAt: iso(-19_000),
        }),
      ],
      NOW,
    );

    // bg-a 的 subagent 投影已完成，但后台侧仍 running：任一侧活跃即保持活跃，
    // 两行都活跃后按 startedAt 升序排列（bg-a 先启动）。
    expect(rows.map((row) => [row.taskId, row.status, row.title])).toEqual([
      ["bg-a", "running", "任务 A"],
      ["bg-b", "running", "任务 B"],
    ]);
  });

  test("启动时间接近时不做跨对配对：歧义投影被抑制，状态不串用", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-a",
          kind: "background",
          isBackground: true,
          title: "任务 A",
          status: "running",
          startedAt: iso(-60_000),
        }),
        task({
          taskId: "bg-b",
          kind: "background",
          isBackground: true,
          title: "任务 B",
          status: "completed",
          startedAt: iso(-56_000),
          completedAt: iso(-1_000),
          durationMs: 55_000,
        }),
        task({
          taskId: "inst-a",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          status: "running",
          startedAt: iso(-55_950),
        }),
        task({
          taskId: "inst-b",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          status: "completed",
          startedAt: iso(-55_900),
          completedAt: iso(-1_000),
        }),
      ],
      NOW,
    );

    expect(rows.map((row) => [row.taskId, row.status, row.title])).toEqual([
      ["bg-a", "running", "任务 A"],
      ["bg-b", "completed", "任务 B"],
    ]);
  });

  test("容差边缘的第三个 subagent 投影不残留为 fork 行", () => {
    const rows = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-a",
          kind: "background",
          isBackground: true,
          title: "任务 A",
          startedAt: iso(-60_000),
        }),
        task({
          taskId: "bg-b",
          kind: "background",
          isBackground: true,
          title: "任务 B",
          status: "completed",
          startedAt: iso(-55_000),
          completedAt: iso(-1_000),
        }),
        task({
          taskId: "inst-a",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          startedAt: iso(-55_100),
        }),
        task({
          taskId: "inst-b",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          startedAt: iso(-54_900),
        }),
      ],
      NOW,
    );

    expect(rows.map((row) => [row.taskId, row.kindLabel, row.title])).toEqual([
      ["bg-a", "后台", "任务 A"],
      ["bg-b", "后台", "任务 B"],
    ]);
    expect(rows.some((row) => row.title === "fork")).toBe(false);
  });

  test("时间戳缺失时不配对，宁可多显示一行也不丢任务", () => {
    const subagentWithoutStart = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-1",
          kind: "background",
          isBackground: true,
          title: "复核发布清单",
          startedAt: iso(-30_000),
        }),
        task({
          taskId: "inst-1",
          kind: "subagent",
          isBackground: true,
          title: "fork",
        }),
      ],
      NOW,
    );
    expect(subagentWithoutStart.map((row) => row.taskId)).toEqual([
      "bg-1",
      "inst-1",
    ]);

    const backgroundWithoutStart = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-2",
          kind: "background",
          isBackground: true,
          title: "独立核验",
        }),
        task({
          taskId: "inst-2",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          startedAt: iso(-5_000),
        }),
      ],
      NOW,
    );
    expect(backgroundWithoutStart.map((row) => row.taskId)).toEqual([
      "inst-2",
      "bg-2",
    ]);
  });

  test("配对容差含边界，超出容差不再配对", () => {
    const atBoundary = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-1",
          kind: "background",
          isBackground: true,
          title: "复核发布清单",
          startedAt: iso(-30_000),
        }),
        task({
          taskId: "inst-1",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          startedAt: iso(-25_000),
        }),
      ],
      NOW,
    );
    expect(atBoundary.map((row) => row.taskId)).toEqual(["bg-1"]);

    const beyondBoundary = selectAsyncTaskRows(
      [
        task({
          taskId: "bg-2",
          kind: "background",
          isBackground: true,
          title: "复核发布清单",
          startedAt: iso(-30_000),
        }),
        task({
          taskId: "inst-2",
          kind: "subagent",
          isBackground: true,
          title: "fork",
          startedAt: iso(-24_999),
        }),
      ],
      NOW,
    );
    expect(beyondBoundary.map((row) => row.taskId)).toEqual(["bg-2", "inst-2"]);
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
