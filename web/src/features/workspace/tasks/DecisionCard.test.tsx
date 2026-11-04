import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Decision, Issue } from "../../../lib/types";
import { DecisionCard } from "./DecisionCard";

const scope = { companyId: "c-1", agentId: "agent-1" };
const issue: Issue = {
  id: 1,
  title: "详情",
  status: "triage",
  agent_id: "agent-1",
  version: 1,
};

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`))?.[0] ?? "";

const buttonWith = (html: string, testId: string) =>
  html.match(
    new RegExp(`<button[^>]*data-testid="${testId}"[\\s\\S]*?</button>`),
  )?.[0] ?? "";

function render(decision: Decision): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <DecisionCard
        scope={scope}
        issue={issue}
        decision={decision}
        onSuccess={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("DecisionCard", () => {
  test("a decision with options renders quick-select chips and the answer form", () => {
    const html = render({
      id: "1-Q1",
      question: "选择登录方案",
      options: ["方案 A", "方案 B"],
      status: "pending",
      answer: null,
    });

    expect(html).toContain("选择登录方案");
    expect(html).toContain("待用户裁定");
    expect(html).toContain("等待你的裁定");
    expect(buttonWith(html, "decision-1-Q1-option-0")).toContain("方案 A");
    expect(buttonWith(html, "decision-1-Q1-option-1")).toContain("方案 B");
    expect(tag(html, "decision-1-Q1-custom")).toContain("<textarea");
    expect(tag(html, "decision-answer-1-Q1")).toContain('type="submit"');
  });

  test("a legacy decision without options keeps only the free-text form", () => {
    const html = render({
      id: "1-Q1",
      question: "说明原因",
      status: "pending",
      answer: null,
    });

    expect(html).not.toContain('class="decision-options"');
    expect(html).toContain("待用户裁定");
    expect(tag(html, "decision-1-Q1-option-0")).toBe("");
    expect(tag(html, "decision-1-Q1-custom")).toContain("<textarea");
    expect(tag(html, "decision-answer-1-Q1")).toContain('type="submit"');
  });

  test("an answered but unresolved decision is not waiting for the user", () => {
    const html = render({
      id: "1-Q1",
      question: "选择登录方案",
      options: ["方案 A", "方案 B"],
      status: "pending",
      answer: "方案 A",
    });

    expect(html).not.toContain("待用户裁定");
    expect(html).toContain("已答复，等待 Agent 处理");
    expect(html).not.toContain("等待你的裁定");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('type="submit"');
    expect(tag(html, "decision-1-Q1-custom")).toBe("");
    expect(tag(html, "decision-answer-1-Q1")).toBe("");
  });
});
