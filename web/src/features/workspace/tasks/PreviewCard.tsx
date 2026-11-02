import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, ExternalLink, GitBranch } from "lucide-react";
import type { Issue, Preview, Scope } from "../../../lib/types";
import { action } from "../../../lib/api";
import { uuid } from "../../../lib/uuid";
import { Button, ErrorBox } from "../../../ui/primitives";
import { Markdown } from "../../../ui/Markdown";

/** Preview 卡同时承载「看结果」和「按 Issue 验收」两件事。 */
export function PreviewCard({
  preview,
  scope,
  issue,
  onSuccess,
}: {
  preview: Preview;
  scope?: Scope;
  issue?: Issue;
  onSuccess?: () => void;
}) {
  const [evidence, setEvidence] = useState("");
  const codeRef =
    issue?.code_ref ||
    preview.code_refs?.[String(issue?.id)] ||
    preview.code_ref ||
    "";
  const mutation = useMutation({
    mutationFn: () =>
      action(scope!.companyId, "company_tasks", "acceptPreview", {
        batchId: preview.id,
        previewId: preview.id,
        issueId: String(issue!.id),
        codeRef,
        evidence,
        passed: true,
        version: preview.version,
        requestId: uuid(),
      }),
    onSuccess: () => {
      setEvidence("");
      onSuccess?.();
    },
  });
  const url = preview.environment_url || preview.url;

  return (
    <section className="preview-card">
      <header className="section-head">
        <div>
          <h3>
            <GitBranch size={15} />
            {preview.title || preview.name || preview.id}
          </h3>
          {preview.branch && (
            <p className="code-line">分支 · {preview.branch}</p>
          )}
        </div>
        <span className="panel-kicker">PREVIEW</span>
      </header>
      {url && /^https?:\/\//.test(url) && (
        <a className="preview-link" href={url} target="_blank" rel="noreferrer">
          打开联合预览
          <ExternalLink size={13} />
        </a>
      )}
      {preview.body && <Markdown>{preview.body}</Markdown>}
      {!!preview.checklist && (
        <details>
          <summary>逐 Issue 验收清单</summary>
          <pre className="json-view">
            {typeof preview.checklist === "string"
              ? preview.checklist
              : JSON.stringify(preview.checklist, null, 2)}
          </pre>
        </details>
      )}
      {scope && issue && issue.status === "preview" && (
        <div className="acceptance-form">
          <p>
            验收对象：#{issue.id} ·{" "}
            <code>{codeRef || "尚未关联代码版本"}</code>
          </p>
          <textarea
            rows={2}
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            placeholder="记录你检查的验收项与结论"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={!evidence.trim() || !codeRef || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <Check size={14} />
            确认本 Issue 验收通过
          </Button>
          <ErrorBox error={mutation.error} />
        </div>
      )}
      {!!preview.acceptances && (
        <details>
          <summary>逐 Issue 验收记录与代码依据</summary>
          <pre className="json-view">
            {JSON.stringify(preview.acceptances, null, 2)}
          </pre>
        </details>
      )}
      {!!(preview.verification || preview.verifications) && (
        <details>
          <summary>验证记录 · CI + Code Review</summary>
          <pre className="json-view">
            {JSON.stringify(
              preview.verification || preview.verifications,
              null,
              2,
            )}
          </pre>
        </details>
      )}
    </section>
  );
}
