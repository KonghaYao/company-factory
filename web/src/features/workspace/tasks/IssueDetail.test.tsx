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
  test("both sections start collapsed but keep their content", () => {
    const html = render();

    expect(tag(html, "description-section-trigger")).toContain(
      'aria-expanded="false"',
    );
    expect(tag(html, "comments-section-trigger")).toContain(
      'aria-expanded="false"',
    );
    expect(tag(html, "description-section-body")).toContain("inert");
    expect(tag(html, "comments-section-body")).toContain("inert");
    expect(html).toContain("描述正文");
    expect(html).toContain("用户");
    expect(html).toContain("Agent 回复");
    expect(html).toContain("--collapsible-h:160px");
    expect(html).toContain("--collapsible-h:240px");
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

  test("renders edited marker and keeps composer outside the clipped body", () => {
    const html = render();

    expect(html).toContain("已编辑");
    expect(html).toContain('aria-label="评论内容"');
    expect(html).toContain('data-testid="comment-submit"');
    expect(
      html.indexOf('data-testid="comments-section-footer"'),
    ).toBeGreaterThan(html.indexOf('data-testid="comments-section-body"'));
    expect(tag(html, "comments-section-footer")).not.toContain("inert");
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
