import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, PendingDecision } from "../../lib/types";
import { PendingQuestions } from "./PendingQuestions";

const agents: Agent[] = [
  { agentId: "agent-1", name: "开发一号", role: "developer", status: "active" },
  {
    agentId: "agent-2",
    name: "归档成员",
    role: "developer",
    status: "archived",
  },
];

const questions: PendingDecision[] = [
  {
    issueId: "1",
    issueTitle: "登录页改版",
    issueStatus: "code",
    agentId: "agent-1",
    decisionId: "1-Q1",
    question: "采用哪个登录方案？",
    options: ["方案 A", "方案 B"],
    updatedAt: "2026-01-02T10:00:00Z",
  },
  {
    issueId: "2",
    issueTitle: "支付接口",
    issueStatus: "triage",
    agentId: "agent-2",
    decisionId: "2-Q1",
    question: "是否继续等待第三方回调？",
    updatedAt: "2026-01-01T10:00:00Z",
  },
];

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`))?.[0] ?? "";

const buttonWith = (html: string, testId: string) =>
  html.match(
    new RegExp(`<button[^>]*data-testid="${testId}"[\\s\\S]*?</button>`),
  )?.[0] ?? "";

function render(
  options: {
    questions?: PendingDecision[];
    error?: unknown;
  } = {},
): string {
  return renderToStaticMarkup(
    <PendingQuestions
      questions={options.questions ?? questions}
      agents={agents}
      error={options.error ?? null}
      onAnswer={async () => {}}
      onOpenIssue={() => {}}
    />,
  );
}

describe("PendingQuestions", () => {
  test("an empty inbox without an error renders nothing", () => {
    expect(render({ questions: [] })).toBe("");
  });

  test("questions show the count, issue, agent, question and independent forms", () => {
    const html = render();

    expect(html).toContain('data-testid="pending-questions-count">2</em>');
    expect(tag(html, "pending-questions-trigger")).toContain(
      'aria-expanded="true"',
    );

    expect(html).toContain("#1");
    expect(html).toContain("登录页改版");
    expect(html).toContain("开发一号");
    expect(html).toContain("采用哪个登录方案？");
    expect(html).toContain("#2");
    expect(html).toContain("支付接口");
    expect(html).toContain("是否继续等待第三方回调？");

    expect(tag(html, "pending-question-1-Q1-option-0")).toContain('aria-pressed="false"');
    expect(tag(html, "pending-question-1-Q1-option-1")).not.toBe("");
    expect(tag(html, "pending-question-2-Q1-option-0")).toBe("");
    expect(tag(html, "pending-question-1-Q1-custom")).toContain("<textarea");
    expect(tag(html, "pending-question-2-Q1-custom")).toContain("<textarea");
    expect(tag(html, "pending-question-1-Q1-submit")).not.toBe("");
    expect(tag(html, "pending-question-2-Q1-submit")).not.toBe("");
  });

  test("archived agents are labeled and keep the issue link disabled, answers open", () => {
    const html = render();
    const issue = buttonWith(html, "pending-question-issue-2-Q1");

    expect(issue).toContain("disabled");
    expect(issue).toContain("已归档");
    expect(html).toContain("归档成员 · 已归档");
    expect(tag(html, "pending-question-2-Q1-custom")).toContain("<textarea");
    expect(tag(html, "pending-question-2-Q1-submit")).not.toBe("");
  });

  test("an error renders inside the inbox even when there are no questions", () => {
    const html = render({ questions: [], error: new Error("读取失败") });

    expect(tag(html, "pending-questions")).not.toBe("");
    expect(html).toContain('role="alert"');
    expect(html).toContain("读取失败");
  });
});
