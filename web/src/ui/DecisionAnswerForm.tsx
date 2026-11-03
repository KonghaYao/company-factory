import { useState, type FormEvent, type ReactNode } from "react";
import { Button, ErrorBox } from "./primitives";

/**
 * 裁定答复表单：有 options 时提供单选 chip，始终保留自由文本。
 * 每个实例独立维护 busy/error，侧栏与详情互不影响。
 */
export function DecisionAnswerForm({
  decisionId,
  options,
  onAnswer,
  submitLabel = "提交答复",
  submitTestId,
  testIdPrefix,
  hint,
}: {
  decisionId: string;
  options?: string[];
  onAnswer: (answer: string) => Promise<unknown>;
  submitLabel?: string;
  submitTestId: string;
  testIdPrefix: string;
  hint?: ReactNode;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const hasOptions = !!options?.length;
  const answer = custom.trim() ? custom : (options?.[selected ?? -1] ?? "");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!answer || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAnswer(answer);
      setSelected(null);
      setCustom("");
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="decision-answer-form" onSubmit={submit}>
      {options && options.length > 0 && (
        <div className="decision-options" role="group" aria-label="可选答案">
          {options.map((option, index) => (
            <button
              key={`${index}-${option}`}
              type="button"
              className="decision-option"
              aria-pressed={selected === index}
              data-testid={`${testIdPrefix}-option-${index}`}
              onClick={() => {
                setSelected((current) => (current === index ? null : index));
                setCustom("");
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <textarea
        rows={2}
        value={custom}
        aria-label={
          hasOptions ? `其他答案（可选）· ${decisionId}` : `回答 ${decisionId}`
        }
        placeholder={
          hasOptions
            ? "其他答案（可选）"
            : `仅回答 ${decisionId}，不会应用到其他问题`
        }
        data-testid={`${testIdPrefix}-custom`}
        onChange={(event) => {
          setCustom(event.target.value);
          setSelected(null);
        }}
      />
      <div className="inline-actions">
        <small>{hint}</small>
        <Button
          type="submit"
          size="sm"
          data-testid={submitTestId}
          disabled={!answer || busy}
        >
          {busy ? "提交中…" : submitLabel}
        </Button>
      </div>
      <ErrorBox error={error} />
    </form>
  );
}
