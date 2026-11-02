import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Scope, WorkNotice } from "../../lib/types";
import { post, scoped } from "../../lib/api";
import { shortDate } from "../../lib/format";
import { Button, ErrorBox } from "../../ui/primitives";

const labels: Record<WorkNotice["status"], string> = {
  saved: "正在投递",
  accepted: "会话已接收",
  failed: "未送达，可重试",
  unknown: "是否送达待核对",
  skipped: "任务情况已变化，已跳过",
};

/** Admission facts only; the Agent still chooses whether and how to act. */
export function WorkNotices({
  scope,
  notices,
  onIssue,
}: {
  scope: Scope;
  notices: WorkNotice[];
  onIssue: (id: string) => void;
}) {
  const client = useQueryClient();
  const retry = useMutation({
    mutationFn: (id: string) =>
      post(scoped(scope, `notices/${encodeURIComponent(id)}/retry`), {}),
    onSettled: () =>
      client.invalidateQueries({
        queryKey: ["workspace", scope.companyId, scope.agentId],
      }),
  });
  if (!notices.length) return null;
  return (
    <section className="panel-section">
      <header className="section-head">
        <h3>最近的任务通知</h3>
      </header>
      <p>接收通知不代表任务开始或完成，由 Agent 决定下一步。</p>
      <ErrorBox error={retry.error} />
      {notices.map((notice) => (
        <article className="notice" key={notice.id}>
          <button className="back-link" onClick={() => onIssue(notice.issueId)}>
            Issue #{notice.issueId}
          </button>
          <strong>{labels[notice.status]}</strong>
          {" · "}
          <time>{shortDate(notice.at)}</time>
          {notice.error && <p>{notice.error}</p>}
          {notice.status === "unknown" && (
            <p>请先查看该 Agent 的会话和输入队列，确认后再决定是否补充消息。</p>
          )}
          {notice.status === "failed" && (
            <Button
              disabled={retry.isPending}
              onClick={() => retry.mutate(notice.id)}
            >
              重试通知
            </Button>
          )}
        </article>
      ))}
    </section>
  );
}
