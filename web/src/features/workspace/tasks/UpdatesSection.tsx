import { useState } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type {
  Agent,
  Issue,
  Scope,
  TaskUpdate,
  TaskUpdateKind,
} from "../../../lib/types";
import { addTaskUpdate, fetchTaskUpdates, list } from "../../../lib/api";
import { uuid } from "../../../lib/uuid";
import { shortDate, statusLabel } from "../../../lib/format";
import {
  isVersionConflict,
  issueExpectedVersion,
  taskUpdateKindLabels,
  taskUpdateKindTone,
} from "../../../lib/taskProgress";
import {
  Avatar,
  Badge,
  Button,
  ErrorBox,
  Loading,
} from "../../../ui/primitives";
import { CollapsibleSection } from "../../../ui/CollapsibleSection";
import { StreamdownText } from "../../../peri/chat/timeline/StreamdownText";

/**
 * Issue 进展分区：只追加的 progress/blocker/decision 记录。
 *
 * 与评论不同：这里没有编辑/删除，也不复用评论的折叠语义；权威记录是
 * 服务端追加文件，最新在前并支持「加载更早」。
 */
export function UpdatesSection({
  scope,
  issue,
  agents,
  onIssue,
  onRefresh,
}: {
  scope: Scope;
  issue: Issue;
  agents: Agent[];
  onIssue: (issue: Issue) => void;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<TaskUpdateKind>("progress");
  const updates = useInfiniteQuery({
    queryKey: ["updates", scope.companyId, scope.agentId, issue.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchTaskUpdates(scope.companyId, {
        issueId: String(issue.id),
        cursor: pageParam,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: 3500,
  });
  const mutation = useMutation({
    mutationFn: (payload: { body: string; kind: TaskUpdateKind }) => {
      const expectedVersion = issueExpectedVersion(issue);
      if (expectedVersion === undefined)
        throw new Error("任务版本缺失，请刷新后重试。");
      return addTaskUpdate(scope.companyId, {
        issueId: String(issue.id),
        expectedVersion,
        requestId: uuid(),
        kind: payload.kind,
        body: payload.body,
      });
    },
    onSuccess: (result) => {
      onIssue(result.issue);
      onRefresh();
    },
    onError: (error) => {
      // 冲突时刷新到最新 issue，正文保留在 composer 中供用户重试。
      if (isVersionConflict(error)) onRefresh();
    },
  });

  const allUpdates =
    updates.data?.pages.flatMap((page) => list<TaskUpdate>(page, "items")) ??
    [];
  const pending = mutation.isPending;
  const conflict = isVersionConflict(mutation.error);

  const submit = () => {
    const body = draft.trim();
    if (!body || pending) return;
    mutation.mutate(
      { body, kind },
      {
        onSuccess: () =>
          setDraft((current) => (current.trim() === body ? "" : current)),
      },
    );
  };

  return (
    <CollapsibleSection
      className="panel-section updates-section"
      testId="updates-section"
      title="进展记录"
      description={
        updates.isLoading
          ? "正在读取进展…"
          : `${updates.hasNextPage ? "已加载 " : ""}${allUpdates.length} 条 · 只追加`
      }
      defaultOpen
      collapsedHeight={260}
      footer={
        <form
          className="update-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            aria-label="进展记录"
            rows={3}
            value={draft}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="记录进展、阻塞或决定… 支持 Markdown；只追加，不改变状态"
          />
          <div className="update-form-foot">
            <label className="update-kind">
              <span>类型</span>
              <select
                aria-label="进展类型"
                value={kind}
                disabled={pending}
                onChange={(event) =>
                  setKind(event.target.value as TaskUpdateKind)
                }
              >
                <option value="progress">进展</option>
                <option value="blocker">阻塞</option>
                <option value="decision">决定</option>
              </select>
            </label>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              data-testid="update-submit"
              disabled={!draft.trim() || pending}
            >
              <Plus size={13} />
              追加进展
            </Button>
          </div>
          <small className="update-hint">
            只追加，不会改变任务状态；评论请用下方评论区。
          </small>
          <ErrorBox error={mutation.error} />
          {conflict && (
            <p className="todo-hint">
              任务版本已变化，已请求最新数据；请确认后重试，正文会保留。
            </p>
          )}
        </form>
      }
    >
      {updates.isLoading && <Loading label="正在读取进展…" />}

      <ol
        className="update-timeline"
        data-testid="update-timeline"
        role="list"
      >
        {allUpdates.map((item) => {
          const author =
            item.author_type === "user"
              ? "你"
              : agents.find(
                  (agent) =>
                    (agent.agentId || agent.id) === item.author_id,
                )?.name ||
                item.author_id ||
                "未知成员";
          return (
            <li
              key={item.id}
              className="update-item"
              data-testid="update-item"
              data-kind={item.kind}
              data-update-id={item.id}
            >
              <span className="update-avatar">
                <Avatar
                  name={author}
                  size="xs"
                  tone={item.author_type === "user" ? "user" : "agent"}
                />
              </span>
              <article className="update-card">
                <header className="update-meta">
                  <strong className="update-author">{author}</strong>
                  <Badge
                    value={taskUpdateKindLabels[item.kind]}
                    tone={taskUpdateKindTone[item.kind]}
                  />
                  <time dateTime={item.created_at}>
                    {shortDate(item.created_at)}
                  </time>
                </header>
                <StreamdownText
                  className="issue-markdown update-markdown"
                  text={item.body}
                />
                <p className="update-snapshot">
                  状态 {statusLabel(item.status)}
                  {item.todo_counts.total > 0 &&
                    ` · 待办 ${item.todo_counts.done}/${item.todo_counts.total}`}
                  {item.todo_counts.in_progress > 0 &&
                    ` · ${item.todo_counts.in_progress} 进行中`}
                </p>
              </article>
            </li>
          );
        })}
      </ol>

      {!updates.isLoading && allUpdates.length === 0 && (
        <p className="section-empty" data-testid="update-empty">
          还没有进展记录。Agent 会在关键节点追加进展、阻塞或决定。
        </p>
      )}

      {updates.hasNextPage && (
        <div className="update-more">
          <Button
            size="sm"
            data-testid="update-more"
            disabled={updates.isFetchingNextPage}
            onClick={() => updates.fetchNextPage()}
          >
            {updates.isFetchingNextPage ? "正在加载…" : "加载更早的进展"}
          </Button>
        </div>
      )}
      <ErrorBox error={updates.error} />
    </CollapsibleSection>
  );
}
