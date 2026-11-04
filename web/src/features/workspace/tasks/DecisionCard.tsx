import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { Issue, PendingDecision, Scope } from "../../../lib/types";
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
  const [justAnswered, setJustAnswered] = useState(false);
  const waiting = item.status === "pending" && !item.answer && !justAnswered;
  const answered = item.status === "pending" && Boolean(item.answer || justAnswered);
  const mutation = useMutation({
    mutationFn: (text: string) =>
      action(scope.companyId, "company_tasks", "answerDecision", {
        issueId: String(issue.id),
        questionId: item.id,
        answer: text,
        requestId: uuid(),
      }),
    onSuccess: async () => {
      // 先取消在途轮询，再乐观移除，避免旧响应把已答复的条目写回。
      await qc.cancelQueries({
        queryKey: ["pending-decisions", scope.companyId],
      });
      qc.setQueryData<{ items: PendingDecision[] }>(
        ["pending-decisions", scope.companyId],
        (current) =>
          current
            ? {
                items: current.items.filter(
                  (pending) => pending.decisionId !== item.id,
                ),
              }
            : current,
      );
      setJustAnswered(true);
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
        {/* 已答复但状态仍是 pending 时，不再展示“待用户裁定”状态。 */}
        {!answered && (
          <Badge
            value={statusLabel(item.status)}
            tone={statusTone(item.status)}
          />
        )}
        {waiting && <span className="pending-flag">等待你的裁定</span>}
        {answered && (
          <span className="answered-flag">已答复，等待 Agent 处理</span>
        )}
      </header>
      <h4>{item.question}</h4>
      {item.answer && (
        <p className="decision-answer">
          <Check size={12} />
          {item.answer}
        </p>
      )}
      {waiting && (
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
