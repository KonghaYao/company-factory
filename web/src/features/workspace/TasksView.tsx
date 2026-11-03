import { ArrowUpRight, GitBranch, Plus } from "lucide-react";
import type { Agent, Issue, Preview, Scope } from "../../lib/types";
import { statusLabel, statusTone } from "../../lib/format";
import { todoProgress } from "../../lib/taskProgress";
import { Badge, Button, EmptyState } from "../../ui/primitives";
import { IssueDetail } from "./tasks/IssueDetail";

/** 任务页签只在「列表」与「详情」之间切换，详情逻辑独立在 tasks/ 下。 */
export function TasksView({
  scope,
  issues,
  previews,
  selected,
  onSelect,
  onCreate,
  onAgent,
  agents,
}: {
  scope: Scope;
  issues: Issue[];
  previews: Preview[];
  selected?: string;
  onSelect: (id?: string) => void;
  onCreate: () => void;
  onAgent: (id: string) => void;
  agents: Agent[];
}) {
  const issue = issues.find((item) => String(item.id) === selected);
  if (issue)
    return (
      <IssueDetail
        key={`${scope.companyId}:${scope.agentId}:${issue.id}`}
        scope={scope}
        issue={issue}
        previews={previews}
        agents={agents}
        onBack={() => onSelect(undefined)}
        onAgent={onAgent}
      />
    );

  return (
    <div className="panel-scroll">
      <header className="section-head section-head-lg">
        <div>
          <h2>关联任务</h2>
          <p>{issues.length} 个 Issue · 状态由 Agent 通过 Company MCP 维护</p>
        </div>
        <Button
          variant="primary"
          size="sm"
          data-testid="create-issue"
          onClick={onCreate}
        >
          <Plus size={14} />
          新建 Issue
        </Button>
      </header>

      {issues.length ? (
        <div className="task-list">
          {issues.map((item) => {
            const owner = agents.find(
              (agent) => (agent.agentId || agent.id) === item.agent_id,
            );
            const pending =
              item.decisions?.filter(
                (decision) => decision.status === "pending",
              ).length || 0;
            const todo = todoProgress(item.todos);
            return (
              <button
                key={item.id}
                className="task-card"
                data-testid={`issue-${item.id}`}
                onClick={() => onSelect(String(item.id))}
              >
                <div className="task-card-top">
                  <span className="task-number">#{item.id}</span>
                  <Badge
                    value={statusLabel(item.status)}
                    tone={statusTone(item.status)}
                  />
                  {pending > 0 && (
                    <span className="pending-flag">{pending} 待裁定</span>
                  )}
                </div>
                <strong>{item.title}</strong>
                {todo.total > 0 && (
                  <div
                    className="task-card-progress"
                    data-testid={`issue-${item.id}-todo-progress`}
                    role="progressbar"
                    aria-label="待办进度"
                    aria-valuemin={0}
                    aria-valuemax={todo.total}
                    aria-valuenow={todo.done}
                  >
                    <span className="task-card-progress-track">
                      <span
                        className="task-card-progress-fill"
                        style={{ width: `${todo.percent}%` }}
                      />
                    </span>
                    <span className="task-card-progress-label">
                      {todo.done}/{todo.total}
                      {todo.inProgress > 0 &&
                        ` · ${todo.inProgress} 进行中`}
                    </span>
                  </div>
                )}
                <p>{item.progress || item.summary || "尚未填写摘要"}</p>
                <div className="task-card-foot">
                  <span>{owner?.name || item.agent_id}</span>
                  <ArrowUpRight size={13} />
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<GitBranch size={22} />}
          title="还没有关联任务"
          description="新建一个 Issue，部门部长会接收并分派；聊天不会被自动记成任务。"
        >
          <Button variant="secondary" size="sm" onClick={onCreate}>
            <Plus size={14} />
            新建 Issue
          </Button>
        </EmptyState>
      )}
    </div>
  );
}
