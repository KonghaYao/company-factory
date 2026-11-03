import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { Issue, Scope, TodoItem, TodoStatus } from "../../../lib/types";
import type { TodoChange } from "../../../lib/api";
import { updateTodos } from "../../../lib/api";
import { uuid } from "../../../lib/uuid";
import {
  isVersionConflict,
  issueExpectedVersion,
  todoProgress,
  todoStatusOptions,
} from "../../../lib/taskProgress";
import { Button, ErrorBox } from "../../../ui/primitives";
import { CollapsibleSection } from "../../../ui/CollapsibleSection";

const TODO_LIMIT = 50;

/**
 * Issue 待办分区：用户直接增删、改状态、排序。
 *
 * 每次写操作都带当前 Issue version 与新的 requestId；成功后父级把服务端
 * 返回的 issue 写回 Query cache，下一次操作立即使用新版本。
 */
export function TodoSection({
  scope,
  issue,
  onIssue,
  onRefresh,
}: {
  scope: Scope;
  issue: Issue;
  onIssue: (issue: Issue) => void;
  onRefresh: () => void;
}) {
  const [addText, setAddText] = useState("");
  const mutation = useMutation({
    mutationFn: (patch: { changes?: TodoChange[]; order?: string[] }) => {
      const expectedVersion = issueExpectedVersion(issue);
      if (expectedVersion === undefined)
        throw new Error("任务版本缺失，请刷新后重试。");
      return updateTodos(scope.companyId, {
        issueId: String(issue.id),
        expectedVersion,
        requestId: uuid(),
        ...patch,
      });
    },
    onSuccess: (result) => {
      onIssue(result.issue);
      onRefresh();
    },
    onError: (error) => {
      // 冲突时只刷新版本，不清空用户输入，也不自动重放。
      if (isVersionConflict(error)) onRefresh();
    },
  });

  const todos = issue.todos ?? [];
  const progress = todoProgress(todos);
  const pending = mutation.isPending;
  const atLimit = progress.total >= TODO_LIMIT;
  const conflict = isVersionConflict(mutation.error);

  const addTodo = () => {
    const text = addText.trim();
    if (!text || pending || atLimit) return;
    mutation.mutate(
      { changes: [{ op: "add", text }] },
      {
        onSuccess: () =>
          setAddText((current) => (current.trim() === text ? "" : current)),
      },
    );
  };

  const changeStatus = (todo: TodoItem, status: TodoStatus) => {
    if (todo.status === status) return;
    mutation.mutate({
      changes: [{ op: "update", todoId: todo.id, status }],
    });
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= todos.length) return;
    const order = todos.map((todo) => todo.id);
    [order[index], order[target]] = [order[target], order[index]];
    mutation.mutate({ order });
  };

  const remove = (todo: TodoItem) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`删除待办「${todo.text}」？`)
    )
      return;
    mutation.mutate({ changes: [{ op: "remove", todoId: todo.id }] });
  };

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
      footer={
        <form
          className="todo-add"
          data-testid="todo-add"
          onSubmit={(event) => {
            event.preventDefault();
            addTodo();
          }}
        >
          <input
            aria-label="新待办内容"
            value={addText}
            maxLength={500}
            disabled={pending || atLimit}
            onChange={(event) => setAddText(event.target.value)}
            placeholder="添加一项可核对的工作…"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!addText.trim() || pending || atLimit}
          >
            <Plus size={13} />
            添加
          </Button>
          {atLimit && (
            <small className="todo-hint">待办已达 {TODO_LIMIT} 项上限。</small>
          )}
        </form>
      }
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
          {todos.map((todo, index) => (
            <li
              key={todo.id}
              className={`todo-item${todo.status === "done" ? " is-done" : ""}`}
              data-testid="todo-item"
              data-status={todo.status}
              data-todo-id={todo.id}
            >
              <div className="todo-main">
                <select
                  className="todo-status"
                  data-testid="todo-toggle"
                  aria-label={`状态：${todo.text}`}
                  value={todo.status}
                  disabled={pending}
                  onChange={(event) =>
                    changeStatus(todo, event.target.value as TodoStatus)
                  }
                >
                  {todoStatusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="todo-text" title={todo.text}>
                  {todo.text}
                </span>
              </div>
              <div className="todo-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`上移：${todo.text}`}
                  disabled={pending || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={12} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`下移：${todo.text}`}
                  disabled={pending || index === todos.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={12} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`删除待办：${todo.text}`}
                  disabled={pending}
                  onClick={() => remove(todo)}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {progress.total === 0 && (
        <p className="section-empty" data-testid="todo-empty">
          还没有待办。Agent 开始处理时应拆分 3–8 项可核对的工作。
        </p>
      )}

      <ErrorBox error={mutation.error} />
      {conflict && (
        <p className="todo-hint">
          任务版本已变化，已请求最新数据；请确认列表后重试，输入会保留。
        </p>
      )}
    </CollapsibleSection>
  );
}
