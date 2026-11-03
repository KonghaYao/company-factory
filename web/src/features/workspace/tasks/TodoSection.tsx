import type { Issue } from "../../../lib/types";
import { todoProgress } from "../../../lib/taskProgress";
import { CollapsibleSection } from "../../../ui/CollapsibleSection";
import { TodoStatusText } from "./TodoStatusText";

/**
 * Issue 待办分区：只读展示负责 Agent 维护的待办列表与进度。
 *
 * todo 只由负责该 Issue 的 Agent 通过 MCP 写入；界面不提供增删、改状态
 * 或排序控件。每次 todo 写入会在评论时间线留下只读快照。
 */
export function TodoSection({ issue }: { issue: Issue }) {
  const todos = issue.todos ?? [];
  const progress = todoProgress(todos);

  return (
    <CollapsibleSection
      className="panel-section todo-section"
      testId="todos-section"
      title="待办"
      description={
        progress.total > 0
          ? `已完成 ${progress.done}/${progress.total}${
              progress.inProgress > 0
                ? ` · ${progress.inProgress} 进行中`
                : ""
            }`
          : "尚未拆分待办"
      }
      defaultOpen
      collapsedHeight={220}
    >
      {progress.total > 0 && (
        <div
          className="todo-progress"
          data-testid="todo-progress"
          role="progressbar"
          aria-label="待办进度"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
        >
          <span className="todo-progress-track">
            <span
              className="todo-progress-fill"
              style={{ width: `${progress.percent}%` }}
            />
          </span>
          <span className="todo-progress-label">
            {progress.done}/{progress.total} · {progress.percent}%
          </span>
        </div>
      )}

      {progress.total > 0 && (
        <ol className="todo-list" data-testid="todo-list" role="list">
          {todos.map((todo) => (
            <li
              key={todo.id}
              className={`todo-item${todo.status === "done" ? " is-done" : ""}`}
              data-testid="todo-item"
              data-status={todo.status}
              data-todo-id={todo.id}
            >
              <div className="todo-main">
                <TodoStatusText status={todo.status} />
                <span className="todo-text" title={todo.text}>
                  {todo.text}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}

      {progress.total === 0 && (
        <p className="section-empty" data-testid="todo-empty">
          还没有待办。负责该 Issue 的 Agent 会在开始处理时拆分 3–8
          项可核对的工作。
        </p>
      )}
    </CollapsibleSection>
  );
}
