import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Issue, TodoItem, TodoStatus } from "../../../lib/types";
import { TodoSection } from "./TodoSection";

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

const render = (items?: TodoItem[]) =>
  renderToStaticMarkup(
    <TodoSection issue={{ id: 1, title: "详情", status: "code", agent_id: "agent-1", todos: items }} />,
  );

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`))?.[0] ?? "";

const statusSpans = (html: string) =>
  html.match(/<span class="todo-status-text"[^>]*>.*?<\/span>/g) ?? [];

describe("TodoSection read-only", () => {
  test("shows progress and count without mutation controls", () => {
    const html = render(todos);
    const progress = tag(html, "todo-progress");
    const body = html.slice(
      html.indexOf('data-testid="todos-section-body"'),
    );

    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain('aria-valuenow="2"');
    expect(progress).toContain('aria-valuemax="4"');
    expect(html).toContain("已完成 2/4 · 1 进行中");
    expect(html).toContain("2/4 · 50%");
    expect((html.match(/data-testid="todo-item"/g) ?? []).length).toBe(4);

    // 唯一的按钮是分区自身的折叠开关，内容区没有任何变更控件。
    expect((html.match(/<button/g) ?? []).length).toBe(1);
    expect(html).toContain('class="collapsible-trigger"');
    expect(body).not.toContain("<button");
    expect(body).not.toContain("<select");
    expect(body).not.toContain("<input");
    expect(html).not.toContain("todo-add");
    expect(html).not.toContain("todo-toggle");
    expect(html).not.toContain('aria-label="状态：');
    expect(html).not.toContain('aria-label="上移：');
    expect(html).not.toContain('aria-label="下移：');
    expect(html).not.toContain('aria-label="删除待办：');
    expect(html).not.toContain('aria-label="新待办内容"');
  });

  test("renders each status as an aria-hidden icon plus a text label", () => {
    const html = render(todos);
    const spans = statusSpans(html);

    expect(spans).toHaveLength(4);
    expect(spans.filter((span) => span.includes('data-status="done"'))).toHaveLength(2);
    expect(spans.filter((span) => span.includes('data-status="in_progress"'))).toHaveLength(1);
    expect(spans.filter((span) => span.includes('data-status="pending"'))).toHaveLength(1);

    const done = spans.find((span) => span.includes('data-status="done"')) ?? "";
    const inProgress =
      spans.find((span) => span.includes('data-status="in_progress"')) ?? "";
    const pending =
      spans.find((span) => span.includes('data-status="pending"')) ?? "";

    expect(done).toContain("lucide-circle-check");
    expect(done).toContain("已完成");
    expect(inProgress).toContain("lucide-circle-dot");
    expect(inProgress).toContain("进行中");
    expect(pending).toContain("lucide-circle");
    expect(pending).not.toContain("lucide-circle-dot");
    expect(pending).not.toContain("lucide-circle-check");
    expect(pending).toContain("待开始");

    for (const span of spans) expect(span).toContain('aria-hidden="true"');
  });

  test("empty list shows the read-only empty state without 0/0", () => {
    const html = render();
    const body = html.slice(
      html.indexOf('data-testid="todos-section-body"'),
    );

    expect(tag(html, "todo-progress")).toBe("");
    expect(tag(html, "todo-empty")).not.toBe("");
    expect(html).toContain("还没有待办");
    expect(html).not.toContain("0/0");
    expect(body).not.toContain("<button");
    expect(body).not.toContain("<select");
    expect(body).not.toContain("<input");
  });
});
