import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Agent, PendingDecision } from "../../lib/types";
import { agentId } from "../../lib/types";
import { ErrorBox } from "../../ui/primitives";

/**
 * 公司范围待裁定问题：固定在组织栏顶部，自带滚动区域。
 * 每条只显示一行摘要，点击整行打开对应 Issue；答复入口只保留在 Issue 详情。
 * 归档成员的问题仍可见，但点击只提示无法打开工作区。
 */
export function PendingQuestions({
  questions,
  agents,
  error,
  onOpenIssue,
}: {
  questions: PendingDecision[];
  agents: Agent[];
  error: unknown;
  onOpenIssue: (agentId: string, issueId: string) => void;
}) {
  const [open, setOpen] = useState(true);

  if (questions.length === 0 && !error) return null;

  return (
    <section className="pending-questions" data-testid="pending-questions">
      <button
        type="button"
        className="pending-questions-head"
        aria-expanded={open}
        data-testid="pending-questions-trigger"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>待你裁定</span>
        <em
          className="pending-questions-count"
          data-testid="pending-questions-count"
        >
          {questions.length}
        </em>
      </button>
      {open && (
        <div className="pending-questions-body" data-testid="pending-questions-body">
          {questions.map((item) => {
            const agent = agents.find((candidate) => agentId(candidate) === item.agentId);
            const archived = agent?.status === "archived";
            const agentName = agent?.name || item.agentId;
            const summary = `${item.issueTitle}：${item.question}`;
            return (
              <button
                type="button"
                className="pending-question"
                data-testid={`pending-question-${item.decisionId}`}
                key={item.decisionId}
                aria-label={`${agentName} · #${item.issueId} · ${summary}${
                  archived ? "（已归档，无法在工作区打开）" : ""
                }`}
                aria-disabled={archived || undefined}
                title={
                  archived
                    ? `${summary}（该成员已归档，无法在工作区打开 Issue）`
                    : `打开 Issue #${item.issueId}：${summary}`
                }
                onClick={() => onOpenIssue(item.agentId, item.issueId)}
              >
                <span className="task-number">#{item.issueId}</span>
                <span className="pending-question-summary">{item.question}</span>
                <span className="pending-question-agent">
                  {agentName}
                  {archived ? " · 已归档" : ""}
                </span>
              </button>
            );
          })}
          {error ? <ErrorBox error={error} /> : null}
        </div>
      )}
    </section>
  );
}
