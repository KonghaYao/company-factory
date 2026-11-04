import { useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  MessageSquare,
  Pencil,
} from "lucide-react";
import type {
  Agent,
  Comment,
  Issue,
  Preview,
  Scope,
} from "../../../lib/types";
import { action, list } from "../../../lib/api";
import { uuid } from "../../../lib/uuid";
import { shortDate, statusLabel, statusTone } from "../../../lib/format";
import {
  Avatar,
  Badge,
  Button,
  ErrorBox,
  Field,
  Loading,
} from "../../../ui/primitives";
import { CollapsibleSection } from "../../../ui/CollapsibleSection";
import { CollapsibleText } from "../../../ui/CollapsibleText";
import { StreamdownText } from "../../../peri/chat/timeline/StreamdownText";
import { DecisionCard } from "./DecisionCard";
import { PreviewCard } from "./PreviewCard";
import { TodoSection } from "./TodoSection";
import { TodoStatusText } from "./TodoStatusText";

const STATUS_OPTIONS = [
  "triage",
  "plan",
  "code",
  "ready_preview",
  "preview",
  "accepted",
  "verifying",
  "ready_merge",
];

/** Issue 详情：待办、编辑、裁定、Preview 验收与评论时间线。 */
export function IssueDetail({
  scope,
  issue,
  previews,
  onBack,
  onAgent,
  agents,
}: {
  scope: Scope;
  issue: Issue;
  previews: Preview[];
  onBack: () => void;
  onAgent: (id: string) => void;
  agents: Agent[];
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [expandedComments, setExpandedComments] = useState<Set<string>>(
    () => new Set(),
  );
  const [body, setBody] = useState(issue.body || issue.description || "");
  const [progress, setProgress] = useState(issue.progress || "");
  const [status, setStatus] = useState(issue.status);
  const [comment, setComment] = useState("");
  const [editComment, setEditComment] = useState<Comment | null>(null);
  const [editText, setEditText] = useState("");
  const [editVersion, setEditVersion] = useState(issue.version);
  const editRef = useRef({ body, progress, status });
  editRef.current = { body, progress, status };

  const setCommentExpanded = (id: string, open: boolean) =>
    setExpandedComments((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const comments = useInfiniteQuery({
    queryKey: ["comments", scope.companyId, scope.agentId, issue.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      action(scope.companyId, "company_tasks", "comments", {
        issueId: String(issue.id),
        cursor: pageParam,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: 3500,
  });
  const refresh = () => {
    qc.invalidateQueries({
      queryKey: ["workspace", scope.companyId, scope.agentId],
    });
    qc.invalidateQueries({
      queryKey: ["comments", scope.companyId, scope.agentId, issue.id],
    });
    qc.invalidateQueries({ queryKey: ["company", scope.companyId] });
  };
  const update = useMutation({
    mutationFn: (capture: {
      patch: { body: string; progress: string; status: string };
      version?: string | number;
    }) =>
      action(scope.companyId, "company_tasks", "updateIssue", {
        issueId: String(issue.id),
        version: capture.version,
        patch: capture.patch,
        requestId: uuid(),
      }),
    onSuccess: (result, capture) => {
      if (JSON.stringify(editRef.current) === JSON.stringify(capture.patch))
        setEditing(false);
      else setEditVersion(result.version);
      refresh();
    },
  });
  const add = useMutation({
    mutationFn: (text: string) =>
      action(scope.companyId, "company_tasks", "addComment", {
        issueId: String(issue.id),
        body: text,
        requestId: uuid(),
      }),
    onSuccess: (created: Comment | undefined, text) => {
      setComment((current) => (current === text ? "" : current));
      if (created?.id) setCommentExpanded(created.id, true);
      refresh();
    },
  });
  const edit = useMutation({
    mutationFn: () =>
      action(scope.companyId, "company_tasks", "updateComment", {
        issueId: String(issue.id),
        commentId: editComment?.id,
        version: editComment?.version,
        body: editText,
        requestId: uuid(),
      }),
    onSuccess: () => {
      setEditComment(null);
      refresh();
    },
  });

  const allComments =
    comments.data?.pages.flatMap((page) => list<Comment>(page, "comments")) ??
    [];
  const preview = previews.find((item) => item.id === issue.preview_batch);
  const owner = agents.find(
    (agent) => (agent.agentId || agent.id) === issue.agent_id,
  );
  const pending =
    issue.decisions?.filter(
      (decision) => decision.status === "pending" && !decision.answer,
    ).length || 0;

  return (
    <div className="panel-scroll issue-detail">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={14} />
        所有关联任务
      </button>

      <header className="issue-meta">
        <span className="task-number">#{issue.id}</span>
        <Badge value={statusLabel(status)} tone={statusTone(status)} />
        {pending > 0 && <span className="pending-flag">{pending} 待裁定</span>}
      </header>
      <h2 className="issue-title">{issue.title}</h2>
      <div className="issue-owner">
        <span>当前负责人</span>
        <button onClick={() => onAgent(issue.agent_id)}>
          {owner?.name || issue.agent_id}
          <ArrowUpRight size={12} />
        </button>
      </div>
      {issue.progress && <p className="progress-note">{issue.progress}</p>}

      {issue.decisions?.map((decision) => (
        <DecisionCard
          key={decision.id}
          scope={scope}
          issue={issue}
          decision={decision}
          onSuccess={refresh}
        />
      ))}

      <TodoSection issue={issue} />

      <CollapsibleSection
        className="panel-section"
        testId="description-section"
        title="描述与交付记录"
        description="Agent 通过 Company MCP 维护，保存不等于验收。"
        collapsedHeight={160}
        open={descriptionOpen}
        onOpenChange={setDescriptionOpen}
        lockOpen={editing}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!editing) setDescriptionOpen(true);
              setEditing(!editing);
              setBody(issue.body || issue.description || "");
              setProgress(issue.progress || "");
              setStatus(issue.status);
              setEditVersion(issue.version);
            }}
          >
            <Pencil size={13} />
            {editing ? "取消编辑" : "编辑"}
          </Button>
        }
      >
        {editing ? (
          <div className="edit-issue">
            <Field label="描述 · Markdown">
              <textarea
                rows={10}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </Field>
            <div className="form-row">
              <Field label="业务状态">
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {statusLabel(option)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="阶段进度">
                <input
                  value={progress}
                  onChange={(event) => setProgress(event.target.value)}
                  placeholder="例如：等待 Preview 验收"
                />
              </Field>
            </div>
            {issue.version !== editVersion && (
              <div className="notice">
                Issue 已有新的修改。当前草稿保留，保存前请对照最新记录。
              </div>
            )}
            <ErrorBox error={update.error} />
            <Button
              variant="primary"
              size="sm"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  patch: { body, progress, status },
                  version: editVersion,
                })
              }
            >
              保存修改
            </Button>
          </div>
        ) : (
          <StreamdownText
            className="issue-markdown"
            text={issue.body || issue.description || "*尚未填写描述。*"}
          />
        )}
      </CollapsibleSection>

      {preview && (
        <PreviewCard
          preview={preview}
          scope={scope}
          issue={issue}
          onSuccess={refresh}
        />
      )}

      <section className="panel-section" data-testid="comments-section">
        <header className="section-head">
          <div>
            <h3>评论时间线</h3>
            <p>
              {comments.isLoading
                ? "正在读取讨论…"
                : `${allComments.length} 条讨论 · 评论不会自动改变状态`}
            </p>
          </div>
        </header>

        {comments.isLoading && <Loading />}
        <ol
          className="comment-timeline"
          role="list"
          data-testid="comment-timeline"
        >
          {allComments.map((item) => {
            const member =
              item.author_type === "user"
                ? undefined
                : agents.find(
                    (agent) => (agent.agentId || agent.id) === item.author_id,
                  );
            const author =
              item.author_type === "user"
                ? "你"
                : member?.name || item.author_id || "未知成员";
            const isUser = item.author_type === "user";
            const isEditingComment = editComment?.id === item.id;
            return (
              <li
                key={item.id}
                className="comment-item"
                data-author={isUser ? "user" : "agent"}
                data-comment-id={item.id}
              >
                <span className="comment-avatar" aria-hidden="true">
                  <Avatar
                    name={author}
                    size="xs"
                    tone={isUser ? "user" : "agent"}
                    color={member?.avatarColor}
                  />
                </span>
                <article
                  className={`comment ${isUser ? "is-user" : "is-agent"}`}
                >
                  <header className="comment-meta">
                    <strong className="comment-author">{author}</strong>
                    <time dateTime={item.created_at}>
                      {shortDate(item.created_at)}
                    </time>
                    {isUser && !isEditingComment && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="编辑我的评论"
                        onClick={() => {
                          setCommentExpanded(item.id, true);
                          setEditComment(item);
                          setEditText(item.body);
                        }}
                      >
                        <Pencil size={12} />
                      </Button>
                    )}
                  </header>
                  <CollapsibleText
                    testId={`comment-${item.id}`}
                    open={isEditingComment || expandedComments.has(item.id)}
                    onOpenChange={(open) =>
                      setCommentExpanded(item.id, open)
                    }
                    locked={isEditingComment}
                    collapsedHeight={136}
                    contextLabel={author}
                  >
                    {isEditingComment ? (
                      <div className="comment-edit">
                        <textarea
                          rows={4}
                          autoFocus
                          value={editText}
                          onChange={(event) => setEditText(event.target.value)}
                        />
                        <ErrorBox error={edit.error} />
                        <div className="inline-actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditComment(null)}
                          >
                            取消
                          </Button>
                          <Button
                            size="sm"
                            disabled={edit.isPending}
                            onClick={() => edit.mutate()}
                          >
                            保存评论
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <StreamdownText
                        className="issue-markdown"
                        text={item.body}
                      />
                    )}
                  </CollapsibleText>
                  {item.todo_snapshot !== undefined && (
                    <ul
                      className="comment-todo-snapshot"
                      data-testid="comment-todo-snapshot"
                      role="list"
                    >
                      {item.todo_snapshot.length > 0 ? (
                        item.todo_snapshot.map((todo) => (
                          <li
                            key={todo.id}
                            data-testid="comment-todo-item"
                            data-status={todo.status}
                          >
                            <TodoStatusText status={todo.status} />
                            <span
                              className="comment-todo-snapshot-text"
                              title={todo.text}
                            >
                              {todo.text}
                            </span>
                          </li>
                        ))
                      ) : (
                        <li className="comment-todo-empty">无待办</li>
                      )}
                    </ul>
                  )}
                  {item.updated_at && (
                    <small className="comment-edited">
                      已编辑 {shortDate(item.updated_at)}
                    </small>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
        {comments.hasNextPage && (
          <div className="comment-more">
            <Button
              size="sm"
              disabled={comments.isFetchingNextPage}
              onClick={() => comments.fetchNextPage()}
            >
              {comments.isFetchingNextPage ? "正在加载…" : "加载更多评论"}
            </Button>
          </div>
        )}
        <ErrorBox error={comments.error} />
        <form
          className="comment-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (comment.trim()) add.mutate(comment);
          }}
        >
          <textarea
            aria-label="评论内容"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="讨论、进展或验收意见… 支持 Markdown"
            rows={3}
          />
          <div className="comment-form-foot">
            <span>评论不自动改变状态</span>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              data-testid="comment-submit"
              disabled={!comment.trim() || add.isPending}
            >
              <MessageSquare size={13} />
              发表
            </Button>
          </div>
          <ErrorBox error={add.error} />
        </form>
      </section>
    </div>
  );
}
