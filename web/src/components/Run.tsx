import {
  Activity,
  Hash,
  GitBranch,
  Info,
  Terminal,
  ArrowUpRight,
} from "lucide-react";
import type { Agent, Runtime, Issue, Preview } from "../lib/types";
import { Badge, Empty, ErrorBox } from "./Common";
export function Run({
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
  const pending = issues.flatMap((i) =>
    (i.decisions || [])
      .filter((d) => d.status === "pending")
      .map((d) => ({ issue: i, decision: d })),
  );
  return (
    <div className="panel-content run-view">
      <div className="section-heading">
        <div>
          <span className="eyebrow">AGENT WORKSPACE</span>
          <h2>正在发生</h2>
          <p>只展示当前成员的真实工作与运行记录</p>
        </div>
        <Activity size={19} className="muted" />
      </div>
      <div className={`runtime-card ${runtime?.busy ? "is-running" : ""}`}>
        <span className={`runtime-orb ${runtime?.busy ? "spin" : ""}`}>
          <Activity size={22} />
        </span>
        <div>
          <h3>{runtime?.busy ? "正在执行工作" : "等待新的输入"}</h3>
          <p>
            {runtime?.busy
              ? "运行状态来自 Peri，不代表业务验收通过。"
              : "未完成 Issue 或等待裁定不会被显示为忙碌。"}
          </p>
        </div>
        {runtime?.busy && <span className="live-pill">LIVE</span>}
      </div>
      <ErrorBox error={runtime?.error} />
      {runtime?.configured === false && (
        <div className="notice">
          <Info size={15} />
          <div>
            模型尚未配置。组织、任务和文件功能仍可使用；开始推理前请按 README
            配置模型服务。
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <section className="run-section">
          <div className="subheading">
            <h3>需要你的裁定</h3>
            <span className="count yellow">{pending.length}</span>
          </div>
          {pending.map(({ issue, decision }) => (
            <button
              className="decision-summary"
              key={decision.id}
              onClick={() => onIssue(String(issue.id))}
            >
              <span>{decision.id}</span>
              <strong>{decision.question}</strong>
              <ArrowUpRight size={14} />
            </button>
          ))}
        </section>
      )}
      <section className="run-section">
        <div className="subheading">
          <h3>当前任务</h3>
          <span className="count">{issues.length}</span>
        </div>
        {issues.length ? (
          issues.map((i) => (
            <button
              key={i.id}
              className="run-task-row"
              onClick={() => onIssue(String(i.id))}
            >
              <Hash size={14} />
              <div>
                <strong>{i.title}</strong>
                <p>
                  #{i.id} · {i.progress || i.summary || "尚未更新阶段进度"}
                </p>
              </div>
              <Badge value={i.status} />
            </button>
          ))
        ) : (
          <div className="inline-empty">还没有负责或协作的 Issue。</div>
        )}
      </section>
      {runtime?.activities?.length ? (
        <section className="run-section">
          <h3>工具与异步活动</h3>
          {runtime.activities.map((a, i) => (
            <details className="tool-activity" key={a.id || i}>
              <summary>
                <Terminal size={14} />
                {a.name || a.title || a.type || "运行活动"}
                <span>{a.status || ""}</span>
              </summary>
              <pre>{JSON.stringify(a, null, 2)}</pre>
            </details>
          ))}
        </section>
      ) : null}
      {previews.length > 0 && (
        <section className="run-section">
          <h3>关联联合预览</h3>
          {previews.map((p) => (
            <div key={p.id} className="run-preview">
              <GitBranch size={15} />
              <strong>{p.name || p.title || p.id}</strong>
              <span>{(p.issue_ids || p.issues || []).length} 个 Issue</span>
            </div>
          ))}
        </section>
      )}
      <section className="session-card">
        <div>
          <span className="eyebrow">固定身份</span>
          <strong>{agent.name}</strong>
        </div>
        <dl>
          <dt>Agent</dt>
          <dd>{agent.agentId || agent.id}</dd>
          <dt>Session</dt>
          <dd>
            {runtime?.sessionId ||
              agent.sessionId ||
              agent.session_id ||
              "正在读取…"}
          </dd>
          <dt>多任务</dt>
          <dd>由 Peri multitasks 执行</dd>
        </dl>
      </section>
    </div>
  );
}
