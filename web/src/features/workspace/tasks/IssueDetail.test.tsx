import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Comment, Issue, Preview } from "../../../lib/types";
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
  },
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
});
