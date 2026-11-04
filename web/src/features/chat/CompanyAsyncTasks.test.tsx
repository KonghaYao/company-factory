import { describe, expect, jest, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanyAsyncTasks, startTaskTicker } from "./CompanyAsyncTasks";
import { taskTickInterval, type AsyncTask } from "./asyncTaskRows";

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

function rowCount(html: string): number {
  return (html.match(/data-slot="peri-company-async-task"/g) ?? []).length;
}

describe("CompanyAsyncTasks", () => {
  test("每个异步任务一行，标题带完整文本，状态与时长可见", () => {
    const html = renderToStaticMarkup(
      <CompanyAsyncTasks
        tasks={[
          task({
            taskId: "b1",
            kind: "background",
            isBackground: true,
            title: "npm run dev",
          }),
          task({
            taskId: "s1",
            title: "检查发布清单",
            status: "completed",
            durationMs: 5_000,
            completedAt: new Date().toISOString(),
          }),
        ]}
      />,
    );

    expect(rowCount(html)).toBe(2);
    expect(html).toContain("异步任务 2");
    expect(html).toContain('title="npm run dev"');
    expect(html).toContain('title="检查发布清单"');
    expect(html).toContain("后台");
    expect(html).toContain("Subagent");
    expect(html).toContain("运行中");
    expect(html).toContain("完成");
    expect(html).toContain("5s");
    expect(html).toContain('data-tone="done"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain('aria-expanded="true"');
  });

  test("同一后台任务的两副投影只渲染一行，表头计数等于去重后的任务数", () => {
    const now = Date.now();
    const isoAgo = (ms: number) => new Date(now - ms).toISOString();
    const html = renderToStaticMarkup(
      <CompanyAsyncTasks
        tasks={[
          task({
            taskId: "bg-1",
            kind: "background",
            isBackground: true,
            title: "复核发布清单",
            startedAt: isoAgo(30_000),
          }),
          task({
            taskId: "inst-1",
            isBackground: true,
            title: "fork",
            startedAt: isoAgo(30_200),
          }),
          task({
            taskId: "bg-2",
            kind: "background",
            isBackground: true,
            title: "独立核验",
            status: "completed",
            startedAt: isoAgo(70_000),
            completedAt: isoAgo(1_000),
            durationMs: 69_000,
          }),
          task({
            taskId: "inst-2",
            isBackground: true,
            title: "fork",
            status: "completed",
            startedAt: isoAgo(70_300),
            completedAt: isoAgo(1_000),
          }),
        ]}
      />,
    );

    expect(rowCount(html)).toBe(2);
    expect(html).toContain("异步任务 2");
    expect(html).toContain('title="复核发布清单"');
    expect(html).toContain('title="独立核验"');
    expect(html).not.toContain("fork");
  });

  test("启动时间接近的并发任务只渲染后台行，歧义投影不残留 fork", () => {
    const now = Date.now();
    const isoAgo = (ms: number) => new Date(now - ms).toISOString();
    const html = renderToStaticMarkup(
      <CompanyAsyncTasks
        tasks={[
          task({
            taskId: "bg-a",
            kind: "background",
            isBackground: true,
            title: "任务 A",
            startedAt: isoAgo(60_000),
          }),
          task({
            taskId: "bg-b",
            kind: "background",
            isBackground: true,
            title: "任务 B",
            status: "completed",
            startedAt: isoAgo(55_000),
            completedAt: isoAgo(1_000),
          }),
          task({
            taskId: "inst-a",
            isBackground: true,
            title: "fork",
            startedAt: isoAgo(55_100),
          }),
          task({
            taskId: "inst-b",
            isBackground: true,
            title: "fork",
            startedAt: isoAgo(54_900),
          }),
        ]}
      />,
    );

    expect(rowCount(html)).toBe(2);
    expect(html).toContain("异步任务 2");
    expect(html).toContain('title="任务 A"');
    expect(html).toContain('title="任务 B"');
    expect(html).not.toContain("fork");
  });

  test("没有任务或只有非异步任务时完全不渲染", () => {
    expect(renderToStaticMarkup(<CompanyAsyncTasks tasks={[]} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <CompanyAsyncTasks
          tasks={[task({ taskId: "tool", kind: "tool", title: "Read" })]}
        />,
      ),
    ).toBe("");
  });

  test("超过 10 分钟的终态任务不再渲染，避免栏位堆积", () => {
    const html = renderToStaticMarkup(
      <CompanyAsyncTasks
        tasks={[
          task({
            taskId: "old",
            status: "completed",
            completedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
          }),
        ]}
      />,
    );

    expect(html).toBe("");
  });

  test("活跃任务与旧终态投影合并后仍渲染，整栏不消失", () => {
    const now = Date.now();
    const isoAgo = (ms: number) => new Date(now - ms).toISOString();
    const html = renderToStaticMarkup(
      <CompanyAsyncTasks
        tasks={[
          task({
            taskId: "bg-long",
            kind: "background",
            isBackground: true,
            title: "长任务",
            status: "running",
            startedAt: isoAgo(12 * 60_000),
          }),
          task({
            taskId: "inst-stale",
            isBackground: true,
            title: "fork",
            status: "completed",
            startedAt: isoAgo(12 * 60_000 - 200),
            completedAt: isoAgo(11 * 60_000),
            updatedAt: isoAgo(11 * 60_000),
          }),
        ]}
      />,
    );

    expect(rowCount(html)).toBe(1);
    expect(html).toContain("异步任务 1");
    expect(html).toContain('title="长任务"');
    expect(html).toContain("运行中");
    expect(html).toContain('data-active="true"');
    expect(html).not.toContain("fork");
  });

  test("重启后超过 10 分钟的 unobserved 任务不再渲染，也不再占用刷新", () => {
    const html = renderToStaticMarkup(
      <CompanyAsyncTasks
        tasks={[
          task({
            taskId: "unobserved",
            status: "unobserved:running",
            updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
          }),
        ]}
      />,
    );

    expect(html).toBe("");
  });

  test("折叠按钮通过 aria-controls 指向列表，列表是 polite live region", () => {
    const html = renderToStaticMarkup(
      <CompanyAsyncTasks
        tasks={[task({ taskId: "s1", title: "检查发布清单" })]}
      />,
    );

    const listId =
      /id="([^"]+)" data-slot="peri-company-async-tasks-list"/.exec(html)?.[1];
    expect(listId).toBeDefined();
    expect(html).toContain(`aria-controls="${listId}"`);
    expect(html).toContain('aria-live="polite"');
  });

  test("每秒变化的时长对读屏隐藏，避免 live region 持续播报", () => {
    const html = renderToStaticMarkup(
      <CompanyAsyncTasks
        tasks={[
          task({
            taskId: "measured",
            status: "completed",
            durationMs: 5_000,
            completedAt: new Date().toISOString(),
          }),
        ]}
      />,
    );

    expect(html).toMatch(
      /<span data-slot="peri-company-async-task-duration" aria-hidden="true">5s<\/span>/,
    );
  });
});

describe("startTaskTicker", () => {
  test("空态不创建 interval，清空后清理函数会清除定时器", () => {
    const setIntervalSpy = jest.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = jest.spyOn(globalThis, "clearInterval");

    try {
      expect(startTaskTicker(undefined, () => {})).toBeUndefined();
      expect(setIntervalSpy).not.toHaveBeenCalled();

      const tick = () => {};
      const stop = startTaskTicker(taskTickInterval(1, true), tick);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(tick, 1_000);

      stop?.();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
