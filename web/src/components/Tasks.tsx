import { useState, useRef } from "react";
import {
  useMutation,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Plus,
  ArrowLeft,
  MessageSquare,
  ArrowUpRight,
  Pencil,
  Check,
  GitBranch,
  ExternalLink,
  CircleDot,
  FileText,
} from "lucide-react";
import type { Scope, Issue, Comment, Preview, Agent } from "../lib/types";
import { action, list, requestId } from "../lib/api";
import {
  Markdown,
  Badge,
  Empty,
  Modal,
  Field,
  ErrorBox,
  Loading,
  shortDate,
  statusLabel,
} from "./Common";
export function CreateIssue({
  companyId,
  onClose,
  onCreated,
}: {
  companyId: string;
  onClose: () => void;
  onCreated: (issue: Issue) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const m = useMutation({
    mutationFn: () =>
      action(companyId, "company_tasks", "createIssue", {
        title,
        body,
        summary: title,
        requestId: requestId(),
      }),
    onSuccess: (data) => onCreated(data.issue || data),
  });
  return (
    <Modal title="创建 Issue" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <p className="modal-intro">
          新 Issue
          进入待分类，由任务主管接收、选择流程并分派。聊天不会自动生成任务。
        </p>
        <Field label="标题">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="想要实现或解决什么？"
            required
          />
        </Field>
        <Field label="目标与验收要求 · Markdown">
          <textarea
            rows={7}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={"## 目标\n\n## 验收要求\n- "}
            required
          />
        </Field>
        <ErrorBox error={m.error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button
            data-testid="create-issue-submit"
            className="primary"
            disabled={m.isPending}
          >
            {m.isPending ? "正在创建…" : "创建 Issue"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function Tasks({
  scope,
  issues,
  previews,
  selected,
  onSelect,
  onCreate,
  onAgent,
  agents,
}: {
  scope: Scope;
  issues: Issue[];
  previews: Preview[];
  selected?: string;
  onSelect: (id?: string) => void;
  onCreate: () => void;
  onAgent: (id: string) => void;
  agents: Agent[];
}) {
  const issue = issues.find((i) => String(i.id) === selected);
  if (issue)
    return (
      <IssueDetail
        key={`${scope.companyId}:${issue.id}`}
        scope={scope}
        issue={issue}
        previews={previews}
        onBack={() => onSelect(undefined)}
        onAgent={onAgent}
        agents={agents}
      />
    );
  return (
    <div className="panel-content">
      <div className="section-heading">
        <div>
          <h2>任务</h2>
          <p>当前负责与明确协作的 Issue</p>
        </div>
        <button
          className="secondary"
          data-testid="create-issue"
          onClick={onCreate}
        >
          <Plus size={14} />
          创建
        </button>
      </div>
      {issues.length ? (
        <div className="issue-list">
          {issues.map((issue) => (
            <button
              data-testid={`issue-${issue.id}`}
              className="issue-card"
              key={issue.id}
              onClick={() => onSelect(String(issue.id))}
            >
              <div className="issue-card-top">
                <span className="issue-number">#{issue.id}</span>
                <Badge value={issue.status} />
                {issue.needs_user && (
                  <span className="needs-dot" title="有待用户裁定的问题" />
                )}
              </div>
              <h3>{issue.title}</h3>
              <p>{issue.summary || "尚未填写摘要"}</p>
              <div className="issue-card-bottom">
                <span>{issue.progress || "尚未更新进度"}</span>
                <ArrowUpRight size={14} />
              </div>
            </button>
          ))}
        </div>
      ) : (
        <Empty icon={<CircleDot size={28} />} title="这里还没有关联任务">
          可以创建 Issue 交给任务主管安排，或在左侧切换负责成员。
        </Empty>
      )}
      {previews.length > 0 && (
        <section className="preview-list">
          <h3>关联 Preview</h3>
          {previews.map((p) => (
            <PreviewCard key={p.id} preview={p} />
          ))}
        </section>
      )}
    </div>
  );
}
function IssueDetail({
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
  const [body, setBody] = useState(issue.body || issue.description || "");
  const [progress, setProgress] = useState(issue.progress || "");
  const [status, setStatus] = useState(issue.status);
  const [comment, setComment] = useState("");
  const [editComment, setEditComment] = useState<Comment | null>(null);
  const [editText, setEditText] = useState("");
  const [editVersion, setEditVersion] = useState(issue.version);
  const editRef = useRef({ body, progress, status });
  editRef.current = { body, progress, status };
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
        requestId: requestId(),
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
        requestId: requestId(),
      }),
    onSuccess: (_data, text) => {
      setComment((current) => (current === text ? "" : current));
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
        requestId: requestId(),
      }),
    onSuccess: () => {
      setEditComment(null);
      refresh();
    },
  });
  const allComments =
    comments.data?.pages.flatMap((page) => list<Comment>(page, "comments")) ??
    [];
  const preview = previews.find((p) => p.id === issue.preview_batch);
  const owner = agents.find((a) => (a.agentId || a.id) === issue.agent_id);
  return (
    <div className="panel-content issue-detail">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={14} />
        所有关联任务
      </button>
      <div className="issue-detail-meta">
        <span className="issue-number">#{issue.id}</span>
        <Badge value={issue.status} />
      </div>
      <h2>{issue.title}</h2>
      <div className="issue-owner">
        当前负责人{" "}
        <button onClick={() => onAgent(issue.agent_id)}>
          {owner?.name || issue.agent_id}
          <ArrowUpRight size={12} />
        </button>
      </div>
      {issue.progress && <p className="progress-note">{issue.progress}</p>}
      {issue.decisions?.map((d) => (
        <DecisionCard
          key={d.id}
          scope={scope}
          issue={issue}
          decision={d}
          onSuccess={refresh}
        />
      ))}
      <section className="issue-section">
        <div className="subheading">
          <h3>描述与交付记录</h3>
          <button
            className="quiet"
            onClick={() => {
              setEditing(!editing);
              setBody(issue.body || issue.description || "");
              setProgress(issue.progress || "");
              setStatus(issue.status);
              setEditVersion(issue.version);
            }}
          >
            <Pencil size={13} />
            {editing ? "取消编辑" : "编辑"}
          </button>
        </div>
        {editing ? (
          <div className="edit-issue">
            <Field label="描述 · Markdown">
              <textarea
                rows={10}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
            <div className="form-row">
              <Field label="业务状态">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  {[
                    "triage",
                    "plan",
                    "code",
                    "ready_preview",
                    "preview",
                    "accepted",
                    "verifying",
                    "ready_merge",
                  ].map((s) => (
                    <option key={s} value={s}>
                      {statusLabel(s)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="阶段进度">
                <input
                  value={progress}
                  onChange={(e) => setProgress(e.target.value)}
                />
              </Field>
            </div>
            {issue.version !== editVersion && (
              <div className="notice">
                Issue 已有新的修改。当前草稿保留，保存前请对照最新记录。
              </div>
            )}
            <ErrorBox error={update.error} />
            <button
              className="primary small"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  patch: { body, progress, status },
                  version: editVersion,
                })
              }
            >
              保存修改
            </button>
          </div>
        ) : (
          <Markdown>
            {issue.body || issue.description || "*尚未填写描述。*"}
          </Markdown>
        )}
      </section>
      {preview && (
        <PreviewCard
          preview={preview}
          scope={scope}
          issue={issue}
          onSuccess={refresh}
        />
      )}
      <section className="issue-section">
        <div className="subheading">
          <h3>评论时间线</h3>
          <span className="muted">{allComments.length} 条</span>
        </div>
        {comments.isLoading && <Loading />}
        <ErrorBox error={comments.error} />
        {allComments.map((c) => (
          <article key={c.id} className="comment">
            <div className="comment-meta">
              <span
                className={`avatar tiny ${c.author_type === "user" ? "user-avatar" : ""}`}
              >
                {c.author_type === "user"
                  ? "我"
                  : c.author_id?.slice(0, 1)?.toUpperCase()}
              </span>
              <strong>
                {c.author_type === "user"
                  ? "你"
                  : agents.find((a) => (a.agentId || a.id) === c.author_id)
                      ?.name || c.author_id}
              </strong>
              <time>{shortDate(c.created_at)}</time>
              {c.author_type === "user" && (
                <button
                  className="quiet"
                  aria-label="编辑我的评论"
                  onClick={() => {
                    setEditComment(c);
                    setEditText(c.body);
                  }}
                >
                  <Pencil size={12} />
                </button>
              )}
            </div>
            {editComment?.id === c.id ? (
              <div>
                <textarea
                  rows={4}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                />
                <ErrorBox error={edit.error} />
                <div className="inline-actions">
                  <button
                    className="quiet"
                    onClick={() => setEditComment(null)}
                  >
                    取消
                  </button>
                  <button
                    className="secondary small"
                    disabled={edit.isPending}
                    onClick={() => edit.mutate()}
                  >
                    保存评论
                  </button>
                </div>
              </div>
            ) : (
              <Markdown>{c.body}</Markdown>
            )}
            {c.updated_at && (
              <small className="muted">已编辑 {shortDate(c.updated_at)}</small>
            )}
          </article>
        ))}
        {comments.hasNextPage && (
          <button
            className="secondary small"
            disabled={comments.isFetchingNextPage}
            onClick={() => comments.fetchNextPage()}
          >
            {comments.isFetchingNextPage ? "正在加载…" : "加载更多评论"}
          </button>
        )}
        <form
          className="comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (comment.trim()) add.mutate(comment);
          }}
        >
          <textarea
            aria-label="评论内容"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="讨论、进展或验收意见… 支持 Markdown"
            rows={3}
          />
          <div className="comment-form-footer">
            <span>评论不自动改变状态</span>
            <button
              data-testid="comment-submit"
              className="primary small"
              disabled={!comment.trim() || add.isPending}
            >
              <MessageSquare size={13} />
              发表
            </button>
          </div>
          <ErrorBox error={add.error} />
        </form>
      </section>
    </div>
  );
}
function DecisionCard({
  scope,
  issue,
  decision: d,
  onSuccess,
}: {
  scope: Scope;
  issue: Issue;
  decision: NonNullable<Issue["decisions"]>[number];
  onSuccess: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const m = useMutation({
    mutationFn: (text: string) =>
      action(scope.companyId, "company_tasks", "answerDecision", {
        issueId: String(issue.id),
        questionId: d.id,
        answer: text,
        requestId: requestId(),
      }),
    onSuccess: (_data, text) => {
      setAnswer((current) => (current === text ? "" : current));
      onSuccess();
    },
  });
  return (
    <section className={`decision decision-${d.status}`}>
      <div className="decision-heading">
        <span>{d.id}</span>
        <Badge value={d.status} />
      </div>
      <h4>{d.question}</h4>
      {d.answer && <p className="decision-response">答复：{d.answer}</p>}
      {d.status === "pending" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate(answer);
          }}
        >
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={2}
            placeholder={`仅回答 ${d.id}，不会应用到其他问题`}
            aria-label={`回答 ${d.id}`}
          />
          <div className="inline-actions">
            <small>保存答复后由当前 Agent 处理</small>
            <button
              data-testid={`decision-answer-${d.id}`}
              className="secondary small"
              disabled={!answer.trim() || m.isPending}
            >
              提交此问题的答复
            </button>
          </div>
        </form>
      )}
      <ErrorBox error={m.error} />
    </section>
  );
}
function PreviewCard({
  preview: p,
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
    issue?.code_ref || p.code_refs?.[String(issue?.id)] || p.code_ref || "";
  const m = useMutation({
    mutationFn: () =>
      action(scope!.companyId, "company_tasks", "acceptPreview", {
        batchId: p.id,
        previewId: p.id,
        issueId: String(issue!.id),
        codeRef,
        evidence,
        passed: true,
        version: p.version,
        requestId: requestId(),
      }),
    onSuccess: () => {
      setEvidence("");
      onSuccess?.();
    },
  });
  const url = p.environment_url || p.url;
  return (
    <section className="preview-card">
      <div className="subheading">
        <h3>
          <GitBranch size={15} />
          {p.title || p.name || p.id}
        </h3>
        <span className="eyebrow">PREVIEW</span>
      </div>
      {p.branch && <div className="code-line">分支 · {p.branch}</div>}
      {url && /^https?:\/\//.test(url) && (
        <a className="preview-link" href={url} target="_blank" rel="noreferrer">
          打开联合预览
          <ExternalLink size={13} />
        </a>
      )}
      {p.body && <Markdown>{p.body}</Markdown>}
      {!!p.checklist && (
        <details>
          <summary>逐 Issue 验收清单</summary>
          <pre className="json-view">
            {typeof p.checklist === "string"
              ? p.checklist
              : JSON.stringify(p.checklist, null, 2)}
          </pre>
        </details>
      )}
      {scope && issue && issue.status === "preview" && (
        <div className="acceptance-form">
          <p>
            验收对象：#{issue.id} · <code>{codeRef || "尚未关联代码版本"}</code>
          </p>
          <textarea
            rows={2}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="记录你检查的验收项与结论"
          />
          <button
            className="primary small"
            disabled={!evidence.trim() || !codeRef || m.isPending}
            onClick={() => m.mutate()}
          >
            <Check size={14} />
            确认本 Issue 验收通过
          </button>
          <ErrorBox error={m.error} />
        </div>
      )}
      {!!p.acceptances && (
        <details>
          <summary>逐 Issue 验收记录与代码依据</summary>
          <pre className="json-view">
            {JSON.stringify(p.acceptances, null, 2)}
          </pre>
        </details>
      )}
      {!!(p.verification || p.verifications) && (
        <details>
          <summary>验证记录 · CI + Code Review</summary>
          <pre className="json-view">
            {JSON.stringify(p.verification || p.verifications, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
}
