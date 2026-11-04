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
      onOpenIssue={() => {}}
    />,
  );
}

describe("PendingQuestions", () => {
  test("an empty inbox without an error renders nothing", () => {
    expect(render({ questions: [] })).toBe("");
  });

  test("questions show the count and one clickable summary row without answer forms", () => {
    const html = render();

    expect(html).toContain('data-testid="pending-questions-count">2</em>');
    expect(tag(html, "pending-questions-trigger")).toContain(
      'aria-expanded="true"',
    );

    const first = buttonWith(html, "pending-question-1-Q1");
    expect(first).toContain('type="button"');
    expect(first).toContain("#1");
    expect(first).toContain("采用哪个登录方案？");
    expect(first).toContain("开发一号");
    expect(first).toContain('title="打开 Issue #1：登录页改版：采用哪个登录方案？"');
    expect(first).toContain(
      'aria-label="开发一号 · #1 · 登录页改版：采用哪个登录方案？"',
    );
    expect(buttonWith(html, "pending-question-2-Q1")).toContain(
      "是否继续等待第三方回调？",
    );

    expect(html).not.toContain("<textarea");
    expect(tag(html, "pending-question-1-Q1-option-0")).toBe("");
    expect(tag(html, "pending-question-1-Q1-custom")).toBe("");
    expect(tag(html, "pending-question-1-Q1-submit")).toBe("");
    expect(tag(html, "pending-question-2-Q1-submit")).toBe("");
  });

  test("archived agents keep a single disabled-announced row with the full summary", () => {
    const html = render();
    const row = buttonWith(html, "pending-question-2-Q1");

    expect(row).toContain('aria-disabled="true"');
    expect(row).toContain("归档成员 · 已归档");
    expect(row).toContain(
      "该成员已归档，无法在工作区打开 Issue",
    );
    expect(html).not.toContain("<textarea");
  });

  test("an error renders inside the inbox even when there are no questions", () => {
    const html = render({ questions: [], error: new Error("读取失败") });

    expect(tag(html, "pending-questions")).not.toBe("");
    expect(html).toContain('role="alert"');
    expect(html).toContain("读取失败");
  });
});
