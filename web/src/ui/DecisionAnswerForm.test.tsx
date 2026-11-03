import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionAnswerForm } from "./DecisionAnswerForm";

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`))?.[0] ?? "";

const buttonWith = (html: string, testId: string) =>
  html.match(
    new RegExp(`<button[^>]*data-testid="${testId}"[\\s\\S]*?</button>`),
  )?.[0] ?? "";

function render(options?: string[]): string {
  return renderToStaticMarkup(
    <DecisionAnswerForm
      decisionId="1-Q1"
      options={options}
      testIdPrefix="decision-1-Q1"
      submitTestId="decision-answer-1-Q1"
      submitLabel="提交此问题的答复"
      onAnswer={async () => {}}
    />,
  );
}

describe("DecisionAnswerForm", () => {
  test("legacy decisions keep the free-text textarea and submit testid", () => {
    const html = render();

    expect(html).toContain('class="decision-answer-form"');
    expect(html).not.toContain('class="decision-options"');
    expect(html).not.toContain('aria-label="可选答案"');
    expect(tag(html, "decision-1-Q1-custom")).toContain("<textarea");
    expect(tag(html, "decision-1-Q1-custom")).toContain(
      "仅回答 1-Q1，不会应用到其他问题",
    );
    expect(tag(html, "decision-answer-1-Q1")).toContain('type="submit"');
    expect(tag(html, "decision-answer-1-Q1")).toContain("disabled");
    expect(html).toContain("提交此问题的答复");
  });

  test("options render single-select chips plus the free-text fallback", () => {
    const html = render(["方案 A", "方案 B"]);

    expect(html).toContain('class="decision-options"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="可选答案"');
    expect(tag(html, "decision-1-Q1-option-0")).toContain('aria-pressed="false"');
    expect(buttonWith(html, "decision-1-Q1-option-0")).toContain("方案 A");
    expect(tag(html, "decision-1-Q1-option-1")).toContain('aria-pressed="false"');
    expect(buttonWith(html, "decision-1-Q1-option-1")).toContain("方案 B");
    expect(tag(html, "decision-1-Q1-custom")).toContain("<textarea");
    expect(tag(html, "decision-1-Q1-custom")).toContain("其他答案（可选）");
    expect(tag(html, "decision-answer-1-Q1")).toContain('type="submit"');
    expect(tag(html, "decision-answer-1-Q1")).toContain("disabled");
  });
});
