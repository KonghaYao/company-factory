import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Issue, Scope, TodoItem } from "../../lib/types";
import { TasksView } from "./TasksView";

const scope: Scope = { companyId: "c-1", agentId: "agent-1" };
const agents: Agent[] = [
  { agentId: "agent-1", name: "开发一号", role: "developer" },
];

const todo = (
  id: string,
  text: string,
  status: TodoItem["status"],
): TodoItem => ({
  id,
  text,
  status,
  created_at: "2026-01-01T09:00:00Z",
  created_by_type: "agent",
  created_by_id: "agent-1",
  updated_at: "2026-01-01T09:00:00Z",
  updated_by_type: "agent",
  updated_by_id: "agent-1",
});

const issues: Issue[] = [
  {
    id: 7,
    title: "带待办的任务",
    status: "code",
    agent_id: "agent-1",
    version: 3,
    todos: [
      todo("7-T1", "梳理接口", "done"),
      todo("7-T2", "实现页面", "done"),
      todo("7-T3", "补充测试", "in_progress"),
      todo("7-T4", "验收", "pending"),
      todo("7-T5", "合入", "pending"),
    ],
  },
  {
    id: 8,
    title: "没有待办的任务",
    status: "triage",
    agent_id: "agent-1",
    version: 1,
    summary: "旧摘要",
  },
];

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`))?.[0] ?? "";

const render = () =>
  renderToStaticMarkup(
    <TasksView
      scope={scope}
      issues={issues}
      previews={[]}
      onSelect={() => {}}
      onCreate={() => {}}
      onAgent={() => {}}
      agents={agents}
    />,
  );

describe("TasksView todo progress", () => {
  test("card shows done/total and in-progress count", () => {
    const html = render();
    const progress = tag(html, "issue-7-todo-progress");

    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain('aria-valuenow="2"');
    expect(progress).toContain('aria-valuemax="5"');
    expect(html).toContain("2/5 · 1 进行中");
    expect(tag(html, "issue-7-latest-update")).toBe("");
    expect(html).not.toContain("阻塞");
    expect(html).not.toContain("外部 API 尚未就绪");
  });

  test("cards without todos render no 0/0 progress and keep the summary fallback", () => {
    const html = render();

    expect(tag(html, "issue-8-todo-progress")).toBe("");
    expect(html).not.toContain("0/0");
    expect(tag(html, "issue-8-latest-update")).toBe("");
    expect(html).toContain("旧摘要");
  });

  test("answered decisions are not counted as pending on task cards", () => {
    const html = renderToStaticMarkup(
      <TasksView
        scope={scope}
        issues={[
          {
            id: 9,
            title: "已答复的任务",
            status: "code",
            agent_id: "agent-1",
            decisions: [
              {
                id: "9-Q1",
                question: "可以上线吗？",
                status: "pending",
                answer: "可以",
              },
            ],
          },
        ]}
        previews={[]}
        onSelect={() => {}}
        onCreate={() => {}}
        onAgent={() => {}}
        agents={agents}
      />,
    );

    expect(html).not.toContain("待裁定");
  });
});
