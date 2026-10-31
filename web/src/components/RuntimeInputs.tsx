import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, MessageSquare, X, Check } from "lucide-react";
import type { InteractionView } from "@peri-code/sdk/view";
import type { Scope } from "../lib/types";
import { errorCauseCode, post, scoped } from "../lib/api";
import { ErrorBox } from "./Common";
export function RuntimeInputs({
  scope,
  interactions,
  onInputError,
}: {
  scope: Scope;
  interactions: InteractionView[];
  /** 交由上层持久展示；卡片随交互消失后错误仍可见。 */
  onInputError?: (error: unknown) => void;
}) {
  return (
    <div className="runtime-inputs">
      {interactions
        .filter((i) => i.status === "pending")
        .map((i) => (
          <RuntimeInput
            key={`${scope.companyId}:${scope.agentId}:${i.id}`}
            scope={scope}
            interaction={i}
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
  const m = useMutation({
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
    if (submitting.current || m.isPending) return;
    submitting.current = true;
    m.mutate(answer, {
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
            i.questions.map((q) => [
              q.id,
              fields[q.id] ?? (q.multiSelect ? [] : ""),
            ]),
          )
        : i.fields?.length
          ? fields
          : JSON.parse(json);
      submit({
        kind: "elicitation",
        decision: { action: "accept", content },
      });
    } catch {
      setError("回答必须是有效的 JSON 对象。");
    }
  };
  return (
    <section className="runtime-input">
      <div className="runtime-input-title">
        {i.kind === "permission" ? (
          <ShieldCheck size={15} />
        ) : (
          <MessageSquare size={15} />
        )}
        <strong>{i.title || i.message || "Peri 等待运行时输入"}</strong>
        <span>运行时交互</span>
      </div>
      <p className="runtime-input-note">
        此操作只回答 Peri 当前请求，不会代替 Company Issue 的用户裁定或验收。
      </p>
      {i.title && i.message && <p>{i.message}</p>}
      {i.kind === "permission" ? (
        <div className="inline-actions">
          <button
            className="secondary small"
            disabled={m.isPending}
            onClick={() => submit({ kind: "permission", decision: "reject_once" })}
          >
            <X size={12} />
            本次拒绝
          </button>
          <button
            className="primary small"
            disabled={m.isPending}
            onClick={() => submit({ kind: "permission", decision: "allow_once" })}
          >
            <Check size={12} />
            仅允许本次
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            accept();
          }}
        >
          {i.formUnsupported && (
            <p className="notice">
              此表单包含尚未映射的字段：{i.formUnsupported}。可检查原始问题后以
              JSON 作答。
            </p>
          )}
          {i.questions?.length
            ? i.questions.map((q: any) => (
              <label className="field runtime-question" key={q.id}>
                <span>
                  {q.header || q.id} · {q.question}
                </span>
                {q.options?.length ? (
                  <select
                    required
                    multiple={q.multiSelect}
                    size={
                      q.multiSelect ? Math.min(q.options.length, 5) : undefined
                    }
                    value={(fields[q.id] ?? (q.multiSelect ? [] : "")) as any}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        [q.id]: q.multiSelect
                          ? Array.from(e.target.selectedOptions).map(
                              (o) => o.value,
                            )
                          : e.target.value,
                      })
                    }
                  >
                    {!q.multiSelect && <option value="">请选择</option>}
                    {q.options.map((o: any) => (
                      <option value={o.value} key={o.value}>
                        {o.label}
                        {o.description ? ` — ${o.description}` : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    required
                    value={String(fields[q.id] ?? "")}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        [q.id]: q.multiSelect
                          ? [e.target.value]
                          : e.target.value,
                      })
                    }
                  />
                )}
              </label>
            ))
            : null}
          {i.questions?.length ? null : i.fields?.length ? (
            i.fields.map((f: any) => (
              <label className="field" key={f.key}>
                <span>
                  {f.title || f.key}
                  {f.required ? " *" : ""}
                </span>
                {f.description && <small>{f.description}</small>}
                {f.enum ? (
                  <select
                    required={f.required}
                    value={String(fields[f.key] ?? "")}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        [f.key]: f.enum.find(
                          (v: any) => String(v) === e.target.value,
                        ),
                      })
                    }
                  >
                    <option value="">请选择</option>
                    {f.enum.map((v: any) => (
                      <option value={String(v)} key={String(v)}>
                        {String(v)}
                      </option>
                    ))}
                  </select>
                ) : f.type === "boolean" ? (
                  <select
                    required={f.required}
                    value={
                      fields[f.key] === undefined ? "" : String(fields[f.key])
                    }
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        [f.key]: e.target.value === "true",
                      })
                    }
                  >
                    <option value="">请选择</option>
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                ) : (
                  <input
                    required={f.required}
                    type={
                      f.type === "number" || f.type === "integer"
                        ? "number"
                        : "text"
                    }
                    step={f.type === "integer" ? 1 : "any"}
                    value={String(fields[f.key] ?? "")}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        [f.key]:
                          f.type === "number" || f.type === "integer"
                            ? Number(e.target.value)
                            : e.target.value,
                      })
                    }
                  />
                )}
              </label>
            ))
          ) : (
            <label className="field">
              <span>回答内容 · JSON（遵循请求字段）</span>
              <textarea
                className="code-input"
                rows={4}
                value={json}
                onChange={(e) => setJson(e.target.value)}
              />
            </label>
          )}
          <div className="inline-actions">
            <button
              type="button"
              className="quiet"
              disabled={m.isPending}
              onClick={() =>
                submit({
                  kind: "elicitation",
                  decision: { action: "cancel" },
                })
              }
            >
              取消
            </button>
            <button
              type="button"
              className="secondary small"
              disabled={m.isPending}
              onClick={() =>
                submit({
                  kind: "elicitation",
                  decision: { action: "decline" },
                })
              }
            >
              不提供
            </button>
            <button className="primary small" disabled={m.isPending}>
              提交运行时回答
            </button>
          </div>
        </form>
      )}
      {errorCauseCode(m.error) === "unknown_interaction" ? (
        <div className="notice" role="status">
          该交互已结束或已处理；请刷新后确认运行时状态。
        </div>
      ) : onInputError ? null : (
        <ErrorBox error={m.error} />
      )}
      <ErrorBox error={error} />
    </section>
  );
}
