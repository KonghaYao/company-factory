import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Agent, PendingDecision } from "../../lib/types";
import { agentId } from "../../lib/types";
import { ErrorBox } from "../../ui/primitives";
import { DecisionAnswerForm } from "../../ui/DecisionAnswerForm";

/**
 * 公司范围待裁定问题：固定在组织栏顶部，自带滚动区域。
 * 归档成员的问题仍可回答，但不能跳转到其工作区。
 */
export function PendingQuestions({
  questions,
  agents,
  error,
  onAnswer,
  onOpenIssue,
}: {
  questions: PendingDecision[];
  agents: Agent[];
  error: unknown;
  onAnswer: (item: PendingDecision, answer: string) => Promise<unknown>;
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
            return (
              <article
                className="pending-question"
                data-testid={`pending-question-${item.decisionId}`}
                key={item.decisionId}
              >
                <div className="pending-question-meta">
                  <button
                    type="button"
                    className="pending-question-issue"
                    data-testid={`pending-question-issue-${item.decisionId}`}
                    disabled={archived}
                    title={
                      archived
                        ? "该成员已归档，无法在工作区打开 Issue"
                        : "打开 Issue"
                    }
                    onClick={() => onOpenIssue(item.agentId, item.issueId)}
                  >
                    <span className="task-number">#{item.issueId}</span>
                    <span className="pending-question-title">
                      {item.issueTitle}
                    </span>
                  </button>
                  <span className="pending-question-agent">
                    {agent?.name || item.agentId}
                    {archived ? " · 已归档" : ""}
                  </span>
                </div>
                <p className="pending-question-text">{item.question}</p>
                <DecisionAnswerForm
                  decisionId={item.decisionId}
                  options={item.options}
                  testIdPrefix={`pending-question-${item.decisionId}`}
                  submitTestId={`pending-question-${item.decisionId}-submit`}
                  submitLabel="提交答复"
                  hint="提交后立即从待裁定列表隐藏"
                  onAnswer={(answer) => onAnswer(item, answer)}
                />
              </article>
            );
          })}
          {error ? <ErrorBox error={error} /> : null}
        </div>
      )}
    </section>
  );
}
