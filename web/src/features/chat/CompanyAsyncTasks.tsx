import { useCallback, useEffect, useId, useState } from "react";
import { ChevronDown, ChevronUp, ListTree } from "lucide-react";
import {
  selectAsyncTaskRows,
  taskTickInterval,
  type AsyncTask,
} from "./asyncTaskRows";

/**
 * 启动刷新定时器；`intervalMs` 为 undefined（空态）时不创建、不返回清理函数。
 * 组件 effect 直接返回它，任务清空后由 React 调用清理。
 */
export function startTaskTicker(
  intervalMs: number | undefined,
  tick: () => void,
): (() => void) | undefined {
  if (intervalMs === undefined) return undefined;
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

/**
 * 相对时长与新鲜度都依赖渲染时钟：intervalMs 变化时立即校准一次，
 * 避免栏位从空态恢复时沿用挂载时的旧时间。
 */
function useTaskClock(intervalMs: number | undefined, refresh: () => void) {
  useEffect(() => {
    if (intervalMs === undefined) return;
    refresh();
    return startTaskTicker(intervalMs, refresh);
  }, [intervalMs, refresh]);
}

/**
 * 输入框上方的异步任务简略栏。
 *
 * 每个 subagent / 后台 shell 一行，标题单行截断；没有可展示任务时返回 null，
 * 不为空栏预留高度。折叠状态只在本组件内保存，默认展开。
 */
export function CompanyAsyncTasks({ tasks }: { tasks: readonly AsyncTask[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const refreshNow = useCallback(() => setNow(Date.now()), []);
  const listId = useId();
  const rows = selectAsyncTaskRows(tasks, now);
  const hasActive = rows.some((row) => row.active);

  // 行数参与频率决策：rows.length 为 0 时 intervalMs 为 undefined，effect 不建定时器。
  useTaskClock(taskTickInterval(rows.length, hasActive), refreshNow);

  if (rows.length === 0) return null;

  return (
    <section data-slot="peri-company-async-tasks" aria-label="异步任务">
      <div data-slot="peri-company-async-tasks-header">
        <ListTree size={12} aria-hidden="true" />
        <span>异步任务 {rows.length}</span>
        <button
          type="button"
          data-slot="peri-company-async-tasks-toggle"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : listId}
          aria-label={collapsed ? "展开异步任务" : "收起异步任务"}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? (
            <ChevronDown size={12} aria-hidden="true" />
          ) : (
            <ChevronUp size={12} aria-hidden="true" />
          )}
        </button>
      </div>

      {!collapsed && (
        <ul
          id={listId}
          data-slot="peri-company-async-tasks-list"
          aria-live="polite"
        >
          {rows.map((row) => (
            <li
              key={row.taskId}
              data-slot="peri-company-async-task"
              data-kind={row.kind}
              data-status={row.status}
              data-tone={row.tone}
              data-active={row.active ? "true" : undefined}
            >
              <span data-slot="peri-company-async-task-kind">
                {row.kindLabel}
              </span>
              <span data-slot="peri-company-async-task-title" title={row.title}>
                {row.title}
              </span>
              <span data-slot="peri-company-async-task-status">
                {row.statusLabel}
              </span>
              {row.duration && (
                // 活跃任务每秒刷新时长；对读屏隐藏，避免 live region 每秒播报。
                <span
                  data-slot="peri-company-async-task-duration"
                  aria-hidden="true"
                >
                  {row.duration}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
