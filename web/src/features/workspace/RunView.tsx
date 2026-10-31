import { Activity, ArrowUpRight, GitBranch, Hash, Terminal } from "lucide-react";
import type { Agent, Issue, Preview, Runtime } from "../../lib/types";
import { statusLabel, statusTone } from "../../lib/format";
import { Badge, EmptyState, ErrorBox } from "../../ui/primitives";

/** 概览回答「现在发生了什么」：运行态、待裁定、任务与交付物。 */
export function RunView({
  agent,
  runtime,
  issues,
  previews,
  onIssue,
}: {
  agent: Agent;
  runtime?: Runtime;
  issues: Issue[];
  previews: Preview[];
  onIssue: (id: string) => void;
}) {
  const pending = issues.flatMap((issue) =>
    (issue.decisions || [])
      .filter((decision) => decision.status === "pending")
      .map((decision) => ({ issue, decision })),
  );
  const busy = Boolean(
    runtime?.busy ||
      runtime?.running ||
      runtime?.activeTurn?.status === "running",
  );
  const activities = runtime?.activities || [];

  return (
    <div className="panel-scroll">
      <section className={`runtime-hero ${busy ? "is-running" : ""}`}>
        <div className="runtime-hero-main">
          <span className="runtime-orb">
            <Activity size={20} />
          </span>
          <div>
            <h2>{busy ? "正在执行工作" : "等待新的输入"}</h2>
            <p>
              {busy
                ? "运行状态来自 Peri，不代表业务验收通过。"
                : "未完成 Issue 或等待裁定不会被显示为忙碌。"}
            </p>
          </div>
          {busy && <span className="live-pill">LIVE</span>}
        </div>
        <dl className="runtime-facts">
          <div>
            <dt>模型</dt>
            <dd>{runtime?.model || "未配置"}</dd>
          </div>
          <div>
            <dt>当前回合</dt>
            <dd>{runtime?.activeTurn?.status || "—"}</dd>
          </div>
          <div>
            <dt>待投递</dt>
            <dd>{runtime?.queueState?.count ?? runtime?.queue?.length ?? 0}</dd>
          </div>
        </dl>
      </section>

      <ErrorBox error={runtime?.error} />
      {runtime?.configured === false && (
        <div className="notice notice-warn">
          模型尚未配置。组织、任务和文件功能仍可使用；开始推理前请按 README
          配置模型服务。
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
              <Badge value={statusLabel(issue.status)} tone={statusTone(issue.status)} />
            </button>
          ))
        ) : (
          <EmptyState title="还没有关联任务">
            新建 Issue 后由任务主管接收、选择流程并分派。
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
  );
}
