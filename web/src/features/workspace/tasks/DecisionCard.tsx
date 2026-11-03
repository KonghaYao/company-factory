import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { Issue, Scope } from "../../../lib/types";
import { action } from "../../../lib/api";
import { uuid } from "../../../lib/uuid";
import { statusLabel, statusTone } from "../../../lib/format";
import { Badge } from "../../../ui/primitives";
import { DecisionAnswerForm } from "../../../ui/DecisionAnswerForm";

/** 用户裁定卡片：一条问题一个请求，避免批量答复串味。 */
export function DecisionCard({
  scope,
  issue,
  decision: item,
  onSuccess,
}: {
  scope: Scope;
  issue: Issue;
  decision: NonNullable<Issue["decisions"]>[number];
  onSuccess: () => void;
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (text: string) =>
      action(scope.companyId, "company_tasks", "answerDecision", {
        issueId: String(issue.id),
        questionId: item.id,
        answer: text,
        requestId: uuid(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["pending-decisions", scope.companyId],
      });
      onSuccess();
    },
  });

  return (
    <section className={`decision-card decision-${item.status}`}>
      <header className="decision-row">
        <span className="decision-code">{item.id}</span>
        <Badge
          value={statusLabel(item.status)}
          tone={statusTone(item.status)}
        />
        {item.status === "pending" && (
          <span className="pending-flag">等待你的裁定</span>
        )}
      </header>
      <h4>{item.question}</h4>
      {item.answer && (
        <p className="decision-answer">
          <Check size={12} />
          {item.answer}
        </p>
      )}
      {item.status === "pending" && (
        <DecisionAnswerForm
          decisionId={item.id}
          options={item.options}
          testIdPrefix={`decision-${item.id}`}
          submitTestId={`decision-answer-${item.id}`}
          submitLabel="提交此问题的答复"
          hint="答复后由当前 Agent 继续处理"
          onAnswer={(text) => mutation.mutateAsync(text)}
        />
      )}
    </section>
  );
}
