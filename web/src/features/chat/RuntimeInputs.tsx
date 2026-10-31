import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquare, ShieldCheck, X } from "lucide-react";
import type { InteractionView } from "@peri-code/sdk/view";
import type { Scope } from "../../lib/types";
import { errorCauseCode, post, scoped } from "../../lib/api";
import { Button, ErrorBox, Field } from "../../ui/primitives";

/**
 * Peri 的运行时交互（权限、elicitation）。
 * 它是会话级请求，不等同于 Company Issue 的用户裁定。
 */
export function RuntimeInputs({
  scope,
  interactions,
  onInputError,
}: {
  scope: Scope;
  interactions: InteractionView[];
  onInputError?: (error: unknown) => void;
}) {
  const pending = interactions.filter((item) => item.status === "pending");
  if (!pending.length) return null;
  return (
    <div className="runtime-inputs">
      {pending.map((item) => (
        <RuntimeInput
          key={`${scope.companyId}:${scope.agentId}:${item.id}`}
          scope={scope}
          interaction={item}
          onInputError={onInputError}
        />
      ))}
    </div>
  );
}

function RuntimeInput({
  scope,
  interaction: i,
  onInputError,
}: {
  scope: Scope;
  interaction: InteractionView;
  onInputError?: (error: unknown) => void;
}) {
  const qc = useQueryClient();
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [json, setJson] = useState("{}");
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const refresh = () => {
    qc.invalidateQueries({
      queryKey: ["runtime", scope.companyId, scope.agentId],
    });
    qc.invalidateQueries({
      queryKey: ["chat", scope.companyId, scope.agentId],
    });
  };
  const mutation = useMutation({
    mutationFn: (answer: unknown) =>
      post(scoped(scope, "answer"), {
        companyId: scope.companyId,
        interactionId: i.id,
        answer,
      }),
    onSuccess: () => {
      onInputError?.(null);
      refresh();
    },
    onError: (failure) => {
      onInputError?.(failure);
      refresh();
    },
  });
  const submit = (answer: unknown) => {
    if (submitting.current || mutation.isPending) return;
    submitting.current = true;
    mutation.mutate(answer, {
      onSettled: () => {
        submitting.current = false;
      },
    });
  };
  const accept = () => {
    try {
      setError("");
      const content = i.questions?.length
        ? Object.fromEntries(
            i.questions.map((q: any) => [
              q.id,
              fields[q.id] ?? (q.multiSelect ? [] : ""),
            ]),
          )
        : i.fields?.length
          ? fields
          : JSON.parse(json);
      submit({ kind: "elicitation", decision: { action: "accept", content } });
    } catch {
      setError("回答必须是有效的 JSON 对象。");
    }
  };

  return (
    <section className="runtime-card-request">
      <header>
        {i.kind === "permission" ? (
          <ShieldCheck size={15} />
        ) : (
          <MessageSquare size={15} />
        )}
        <strong>{i.title || i.message || "Peri 等待运行时输入"}</strong>
        <span>运行时交互</span>
      </header>
      <p className="runtime-note">
        只回答 Peri 当前请求，不代替 Issue 的用户裁定或验收。
      </p>
      {i.title && i.message && <p>{i.message}</p>}

      {i.kind === "permission" ? (
        <div className="inline-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={mutation.isPending}
            onClick={() =>
              submit({ kind: "permission", decision: "reject_once" })
            }
          >
            <X size={12} />
            本次拒绝
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={mutation.isPending}
            onClick={() =>
              submit({ kind: "permission", decision: "allow_once" })
            }
          >
            <Check size={12} />
            仅允许本次
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            accept();
          }}
        >
          {i.formUnsupported && (
            <div className="notice notice-warn">
              表单包含尚未映射的字段：{i.formUnsupported}。可检查原始问题后以
              JSON 作答。
            </div>
          )}
          {i.questions?.length
            ? i.questions.map((question: any) => (
                <Field
                  key={question.id}
                  label={`${question.header || question.id} · ${question.question}`}
                >
                  {question.options?.length ? (
                    <select
                      required
                      multiple={question.multiSelect}
                      size={
                        question.multiSelect
                          ? Math.min(question.options.length, 5)
                          : undefined
                      }
                      value={
                        (fields[question.id] ??
                          (question.multiSelect ? [] : "")) as any
                      }
                      onChange={(event) =>
                        setFields({
                          ...fields,
                          [question.id]: question.multiSelect
                            ? Array.from(event.target.selectedOptions).map(
                                (option) => option.value,
                              )
                            : event.target.value,
                        })
                      }
                    >
                      {!question.multiSelect && (
                        <option value="">请选择</option>
                      )}
                      {question.options.map((option: any) => (
                        <option value={option.value} key={option.value}>
                          {option.label}
                          {option.description ? ` — ${option.description}` : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      required
                      value={String(fields[question.id] ?? "")}
                      onChange={(event) =>
                        setFields({
                          ...fields,
                          [question.id]: question.multiSelect
                            ? [event.target.value]
                            : event.target.value,
                        })
                      }
                    />
                  )}
                </Field>
              ))
            : null}
          {i.questions?.length
            ? null
            : i.fields?.length
              ? i.fields.map((field: any) => (
                  <Field
                    key={field.key}
                    label={`${field.title || field.key}${field.required ? " *" : ""}`}
                    hint={field.description}
                  >
                    {field.enum ? (
                      <select
                        required={field.required}
                        value={String(fields[field.key] ?? "")}
                        onChange={(event) =>
                          setFields({
                            ...fields,
                            [field.key]: field.enum.find(
                              (value: any) => String(value) === event.target.value,
                            ),
                          })
                        }
                      >
                        <option value="">请选择</option>
                        {field.enum.map((value: any) => (
                          <option value={String(value)} key={String(value)}>
                            {String(value)}
                          </option>
                        ))}
                      </select>
                    ) : field.type === "boolean" ? (
                      <select
                        required={field.required}
                        value={
                          fields[field.key] === undefined
                            ? ""
                            : String(fields[field.key])
                        }
                        onChange={(event) =>
                          setFields({
                            ...fields,
                            [field.key]: event.target.value === "true",
                          })
                        }
                      >
                        <option value="">请选择</option>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : (
                      <input
                        required={field.required}
                        type={
                          field.type === "number" || field.type === "integer"
                            ? "number"
                            : "text"
                        }
                        step={field.type === "integer" ? 1 : "any"}
                        value={String(fields[field.key] ?? "")}
                        onChange={(event) =>
                          setFields({
                            ...fields,
                            [field.key]:
                              field.type === "number" ||
                              field.type === "integer"
                                ? Number(event.target.value)
                                : event.target.value,
                          })
                        }
                      />
                    )}
                  </Field>
                ))
              : (
                  <Field label="回答内容 · JSON">
                    <textarea
                      className="code-input"
                      rows={4}
                      value={json}
                      onChange={(event) => setJson(event.target.value)}
                    />
                  </Field>
                )}
          <div className="inline-actions">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={mutation.isPending}
              onClick={() =>
                submit({ kind: "elicitation", decision: { action: "cancel" } })
              }
            >
              取消
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={mutation.isPending}
              onClick={() =>
                submit({ kind: "elicitation", decision: { action: "decline" } })
              }
            >
              不提供
            </Button>
            <Button variant="primary" size="sm" disabled={mutation.isPending}>
              提交运行时回答
            </Button>
          </div>
        </form>
      )}

      {errorCauseCode(mutation.error) === "unknown_interaction" ? (
        <div className="notice">该交互已结束或已处理，请确认运行时状态。</div>
      ) : onInputError ? null : (
        <ErrorBox error={mutation.error} />
      )}
      <ErrorBox error={error} />
    </section>
  );
}
