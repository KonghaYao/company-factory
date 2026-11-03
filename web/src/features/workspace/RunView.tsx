import { ArrowUpRight, GitBranch, Hash, Terminal } from "lucide-react";
import type {
  Agent,
  Issue,
  Preview,
  Runtime,
  Scope,
  WorkNotice,
} from "../../lib/types";
import { statusLabel, statusTone } from "../../lib/format";
import { modelReason } from "../../lib/model";
import { Badge, EmptyState, ErrorBox } from "../../ui/primitives";
import { RunSummary } from "./RunSummary";
import { WorkNotices } from "./WorkNotices";

/** 概览回答「现在发生了什么」：运行态、待裁定、任务与交付物。 */
export function RunView({
  scope,
  agent,
  runtime,
  issues,
  previews,
  notices,
  onIssue,
  onModel,
}: {
  scope: Scope;
  agent: Agent;
  runtime?: Runtime;
  issues: Issue[];
  previews: Preview[];
  notices: WorkNotice[];
  onIssue: (id: string) => void;
  onModel: () => void;
}) {
  const pending = issues.flatMap((issue) =>
    (issue.decisions || [])
      .filter((decision) => decision.status === "pending")
      .map((decision) => ({ issue, decision })),
  );
  const activities = runtime?.activities || [];

  return (
    <div className="panel-scroll">
      <div className="run-view">
        <RunSummary runtime={runtime} onModel={onModel} />

        <ErrorBox error={runtime?.error} />
        {runtime?.configured === false && (
          <div className="notice notice-warn">
            模型尚未配置：{modelReason(runtime.modelError, runtime.modelMissing)}
            。 组织、任务和文件功能仍可使用；请检查模型库后手动重启该 Agent。
          </div>
        )}

        {pending.length > 0 && (
          <section className="panel-section">
            <header className="section-head">
              <h3>需要你的裁定</h3>
              <span className="count-pill">{pending.length}</span>
            </header>
            {pending.map(({ issue, decision }) => (
              <button
                className="decision-row"
                key={decision.id}
                onClick={() => onIssue(String(issue.id))}
              >
                <span className="decision-code">{decision.id}</span>
                <strong>{decision.question}</strong>
                <ArrowUpRight size={14} />
              </button>
            ))}
          </section>
        )}

        <WorkNotices
          key={`${scope.companyId}:${scope.agentId}`}
          scope={scope}
          notices={notices}
          onIssue={onIssue}
        />

        <section className="panel-section">
          <header className="section-head">
            <h3>当前任务</h3>
            <span className="count-pill">{issues.length}</span>
          </header>
          {issues.length ? (
            issues.map((issue) => (
              <button
                key={issue.id}
                className="task-row"
                onClick={() => onIssue(String(issue.id))}
              >
                <Hash size={13} />
                <span className="task-row-copy">
                  <strong>{issue.title}</strong>
                  <small>
                    #{issue.id} ·{" "}
                    {issue.progress || issue.summary || "尚未更新阶段进度"}
                  </small>
                </span>
                <Badge
                  value={statusLabel(issue.status)}
                  tone={statusTone(issue.status)}
                />
              </button>
            ))
          ) : (
            <EmptyState title="还没有关联任务">
              新建 Issue 后由部门部长接收、选择流程并分派。
            </EmptyState>
          )}
        </section>

        {activities.length > 0 && (
          <section className="panel-section">
            <header className="section-head">
              <h3>工具与异步活动</h3>
            </header>
            {activities.map((activity: any, index: number) => (
              <details className="tool-activity" key={activity.id || index}>
                <summary>
                  <Terminal size={13} />
                  {activity.name || activity.title || activity.type || "运行活动"}
                  <span>{activity.status || ""}</span>
                </summary>
                <pre>{JSON.stringify(activity, null, 2)}</pre>
              </details>
            ))}
          </section>
        )}

        {previews.length > 0 && (
          <section className="panel-section">
            <header className="section-head">
              <h3>关联联合预览</h3>
            </header>
            {previews.map((preview) => (
              <div className="preview-row" key={preview.id}>
                <GitBranch size={14} />
                <strong>{preview.name || preview.title || preview.id}</strong>
                <span>
                  {(preview.issue_ids || preview.issues || []).length} 个 Issue
                </span>
              </div>
            ))}
          </section>
        )}

        <section className="identity-card">
          <header>
            <span className="panel-kicker">固定身份</span>
            <strong>{agent.name}</strong>
          </header>
          <dl>
            <div>
              <dt>Agent</dt>
              <dd>{agent.agentId || agent.id}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>
                {runtime?.sessionId ||
                  agent.sessionId ||
                  agent.session_id ||
                  "正在读取…"}
              </dd>
            </div>
            <div>
              <dt>多任务</dt>
              <dd>由 Peri multitasks 执行</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
