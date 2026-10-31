import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { Issue, Scope } from "../../../lib/types";
import { action, requestId } from "../../../lib/api";
import { statusLabel, statusTone } from "../../../lib/format";
import { Badge, Button, ErrorBox } from "../../../ui/primitives";

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
  const [answer, setAnswer] = useState("");
  const mutation = useMutation({
    mutationFn: (text: string) =>
      action(scope.companyId, "company_tasks", "answerDecision", {
        issueId: String(issue.id),
        questionId: item.id,
        answer: text,
        requestId: requestId(),
      }),
    onSuccess: (_result, text) => {
      setAnswer((current) => (current === text ? "" : current));
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(answer);
          }}
        >
          <textarea
            rows={2}
            value={answer}
            aria-label={`回答 ${item.id}`}
            placeholder={`仅回答 ${item.id}，不会应用到其他问题`}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <div className="inline-actions">
            <small>答复后由当前 Agent 继续处理</small>
            <Button
              type="submit"
              size="sm"
              data-testid={`decision-answer-${item.id}`}
              disabled={!answer.trim() || mutation.isPending}
            >
              提交此问题的答复
            </Button>
          </div>
        </form>
      )}
      <ErrorBox error={mutation.error} />
    </section>
  );
}
