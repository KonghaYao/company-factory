import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  Agent,
  Comment,
  Issue,
  Preview,
  TodoItem,
  TodoStatus,
} from "../../../lib/types";
import { IssueDetail } from "./IssueDetail";

const scope = { companyId: "c-1", agentId: "agent-1" };
const issue: Issue = {
  id: 1,
  title: "详情",
  status: "triage",
  agent_id: "agent-1",
  body: "**描述正文**",
  version: 1,
};
const agents: Agent[] = [
  { agentId: "agent-1", name: "开发一号", role: "developer" },
];
const comments: Comment[] = [
  {
    id: "comment-1",
    body: "用户 **评论**",
    author_type: "user",
    author_id: "user-1",
    created_at: "2026-01-01T10:00:00Z",
    updated_at: "2026-01-02T10:00:00Z",
  },
  {
    id: "comment-2",
    body: "Agent 回复",
    author_type: "agent",
    author_id: "agent-1",
    created_at: "2026-01-01T11:00:00Z",
    todo_snapshot: [
      { id: "1-T1", text: "梳理接口", status: "done" },
      { id: "1-T3", text: "补充测试", status: "in_progress" },
    ],
  },
];
const todo = (id: string, text: string, status: TodoStatus): TodoItem => ({
  id,
  text,
  status,
  created_at: "2026-01-01T09:00:00Z",
  created_by_type: "agent",
  created_by_id: "agent-1",
  updated_at: "2026-01-01T09:00:00Z",
  updated_by_type: "agent",
  updated_by_id: "agent-1",
  ...(status === "done" ? { done_at: "2026-01-01T12:00:00Z" } : {}),
});
const todos: TodoItem[] = [
  todo("1-T1", "梳理接口", "done"),
  todo("1-T2", "实现页面", "done"),
  todo("1-T3", "补充测试", "in_progress"),
  todo("1-T4", "验收", "pending"),
];

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`))?.[0] ?? "";

function render(
  options: {
    comments?: Comment[];
    nextCursor?: string | null;
    issue?: Issue;
    previews?: Preview[];
  } = {},
): string {
  const currentIssue = options.issue ?? issue;
  const qc = new QueryClient();
  qc.setQueryData(
    ["comments", scope.companyId, scope.agentId, currentIssue.id],
    {
      pages: [
        {
          items: options.comments ?? comments,
          nextCursor: options.nextCursor ?? null,
        },
      ],
      pageParams: [undefined],
    },
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IssueDetail
        scope={scope}
        issue={currentIssue}
        previews={options.previews ?? []}
        agents={agents}
        onBack={() => {}}
        onAgent={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("IssueDetail", () => {
  test("description collapses but the comment section never does", () => {
    const html = render();
    const commentsSection = tag(html, "comments-section");

    expect(tag(html, "description-section-trigger")).toContain(
      'aria-expanded="false"',
    );
    expect(tag(html, "description-section-body")).toContain("inert");

    expect(commentsSection).not.toBe("");
    expect(commentsSection).not.toContain("collapsible-section");
    expect(tag(html, "comments-section-trigger")).toBe("");
    expect(tag(html, "comments-section-body")).toBe("");
    expect(tag(html, "comments-section-footer")).toBe("");
    expect(html).toContain('data-testid="comment-timeline"');
    expect(html).toContain("用户");
    expect(html).toContain("Agent 回复");
    expect(html).toContain("--collapsible-h:160px");
    expect(html).not.toContain("--collapsible-h:240px");
  });

  test("todo section renders before description and comments, without updates", () => {
    const html = render();

    expect(tag(html, "todos-section-trigger")).toContain('aria-expanded="true"');
    expect(tag(html, "todos-section-body")).not.toContain("inert");
    expect(tag(html, "updates-section")).toBe("");
    expect(tag(html, "updates-section-trigger")).toBe("");

    const order = [
      html.indexOf('data-testid="todos-section"'),
      html.indexOf('data-testid="description-section"'),
      html.indexOf('data-testid="comments-section"'),
    ];
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("todo progress, per-item status and empty state are read-only", () => {
    const html = render({ issue: { ...issue, todos } });
    const progress = tag(html, "todo-progress");
    const todoBody = html.slice(
      html.indexOf('data-testid="todos-section-body"'),
      html.indexOf('data-testid="description-section"'),
    );

    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain('aria-valuenow="2"');
    expect(progress).toContain('aria-valuemax="4"');
    expect(html).toContain("已完成 2/4 · 1 进行中");
    expect(html).toContain("2/4 · 50%");
    expect((html.match(/data-testid="todo-item"/g) ?? []).length).toBe(4);
    expect((html.match(/todo-item is-done/g) ?? []).length).toBe(2);
    expect((todoBody.match(/data-testid="todo-status"/g) ?? []).length).toBe(4);
    expect(todoBody).toContain("已完成");
    expect(todoBody).toContain("进行中");
    expect(todoBody).toContain("待开始");
    expect(todoBody).toContain("lucide-circle-check");
    expect(todoBody).toContain("lucide-circle-dot");
    expect(todoBody).toContain("lucide-circle");
    expect(todoBody).not.toContain("<select");
    expect(todoBody).not.toContain("<input");
    expect(todoBody).not.toContain("<button");
    expect(html).not.toContain('aria-label="状态：补充测试"');
    expect(html).not.toContain('aria-label="上移：实现页面"');
    expect(html).not.toContain('aria-label="下移：梳理接口"');
    expect(html).not.toContain('aria-label="删除待办：验收"');
    expect(html).not.toContain('aria-label="新待办内容"');
    expect(tag(html, "todo-empty")).toBe("");

    const empty = render();
    expect(tag(empty, "todo-progress")).toBe("");
    expect(tag(empty, "todo-empty")).not.toBe("");
    expect(empty).toContain("还没有待办");
    expect(empty).not.toContain("0/0");
  });

  test("comment todo snapshot renders after the body as a read-only list", () => {
    const html = render();
    const snapshotIndex = html.indexOf(
      'data-testid="comment-todo-snapshot"',
    );
    const agentBodyIndex = html.indexOf(
      'data-testid="comment-comment-2-body"',
    );
    const userStart = html.indexOf('data-comment-id="comment-1"');
    const agentStart = html.indexOf('data-comment-id="comment-2"');
    const snapshotMarkup = html.slice(snapshotIndex, html.indexOf("</ul>", snapshotIndex));

    expect(snapshotIndex).toBeGreaterThan(agentBodyIndex);
    expect((html.match(/data-testid="comment-todo-snapshot"/g) ?? []).length).toBe(1);
    expect(html.slice(userStart, agentStart)).not.toContain(
      'data-testid="comment-todo-snapshot"',
    );
    expect((html.match(/data-testid="comment-todo-item"/g) ?? []).length).toBe(2);
    expect(snapshotMarkup).toContain('data-status="done"');
    expect(snapshotMarkup).toContain('data-status="in_progress"');
    expect(snapshotMarkup).toContain("lucide-circle-check");
    expect(snapshotMarkup).toContain("lucide-circle-dot");
    expect(snapshotMarkup).toContain("已完成");
    expect(snapshotMarkup).toContain("进行中");
    expect(snapshotMarkup).toContain("梳理接口");
    expect(snapshotMarkup).toContain("补充测试");
    expect(snapshotMarkup).not.toContain("<button");
  });

  test("comments without a snapshot render no snapshot container", () => {
    const html = render({ comments: [comments[0]] });

    expect(tag(html, "comment-todo-snapshot")).toBe("");
  });

  test("each comment gets its own collapsed body and keeps its content", () => {
    const html = render();
    const userBody = tag(html, "comment-comment-1-body");
    const agentBody = tag(html, "comment-comment-2-body");

    expect((html.match(/class="collapsible-text"/g) ?? []).length).toBe(2);
    expect((html.match(/--collapsible-text-h:136px/g) ?? []).length).toBe(2);
    expect(tag(html, "comment-comment-1")).toContain('data-open="false"');
    expect(tag(html, "comment-comment-2")).toContain('data-open="false"');
    expect(userBody).toContain('data-state="collapsed"');
    expect(agentBody).toContain('data-state="collapsed"');
    // SSR 尚未测量：不裁剪标记、不显示按钮，但正文保留在 DOM。
    expect(userBody).not.toContain("inert");
    expect(agentBody).not.toContain("inert");
    expect(tag(html, "comment-comment-1-toggle")).toBe("");
    expect(tag(html, "comment-comment-2-toggle")).toBe("");
    expect(html).toContain("评论");
    expect(html).toContain("Agent 回复");
  });

  test("comment meta, edit button and edited marker stay outside the collapsed body", () => {
    const html = render();
    const userBodyIndex = html.indexOf(
      'data-testid="comment-comment-1-body"',
    );
    const editedIndex = html.indexOf("已编辑");

    expect(html).toContain('class="comment-author"');
    expect((html.match(/aria-label="编辑我的评论"/g) ?? []).length).toBe(1);
    expect(editedIndex).toBeGreaterThan(userBodyIndex);
    expect(html.match(/inert/g) ?? []).toHaveLength(1);
  });

  test("markdown bodies are rendered by Streamdown", () => {
    const html = render();

    expect((html.match(/data-slot="peri-markdown"/g) ?? []).length).toBe(3);
    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain("issue-markdown");
    expect(html).not.toContain('class="markdown');
  });

  test("user and agent comments have distinct structure", () => {
    const html = render();

    expect((html.match(/data-author="user"/g) ?? []).length).toBe(1);
    expect((html.match(/data-author="agent"/g) ?? []).length).toBe(1);
    expect(html).toContain("comment is-user");
    expect(html).toContain("comment is-agent");
    expect(html).toContain("avatar-user");
    expect(html).toContain("avatar-agent");
    expect(html).toContain("开发一号");
    expect((html.match(/aria-label="编辑我的评论"/g) ?? []).length).toBe(1);
  });

  test("timeline, load more and composer keep their order", () => {
    const html = render({ nextCursor: "30" });
    const timelineIndex = html.indexOf('data-testid="comment-timeline"');
    const loadMoreIndex = html.indexOf("加载更多评论");
    const composerIndex = html.indexOf('aria-label="评论内容"');

    expect(timelineIndex).toBeGreaterThan(-1);
    expect(loadMoreIndex).toBeGreaterThan(timelineIndex);
    expect(composerIndex).toBeGreaterThan(loadMoreIndex);
    expect(html).toContain('data-testid="comment-submit"');
    expect(tag(html, "comments-section")).not.toContain("inert");
  });

  test("load more only appears when there is a next page", () => {
    expect(render()).not.toContain("加载更多评论");
    expect(render({ nextCursor: "30" })).toContain("加载更多评论");
  });

  test("preview body also uses Streamdown", () => {
    const html = render({
      issue: { ...issue, preview_batch: "p-1" },
      previews: [{ id: "p-1", title: "联合预览", body: "**预览正文**" }],
    });

    expect(html).toContain("预览正文");
    expect((html.match(/data-slot="peri-markdown"/g) ?? []).length).toBe(4);
  });

  test("a pending decision with options exposes chips in the detail card", () => {
    const html = render({
      issue: {
        ...issue,
        decisions: [
          {
            id: "1-Q1",
            question: "选择",
            options: ["A", "B"],
            status: "pending",
            answer: null,
          },
        ],
      },
    });

    expect(tag(html, "decision-1-Q1-option-0")).not.toBe("");
    expect(tag(html, "decision-1-Q1-option-1")).not.toBe("");
    expect(tag(html, "decision-answer-1-Q1")).not.toBe("");
    expect(html).toContain("选择");
  });
});
