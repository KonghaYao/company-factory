import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "../../lib/types";
import { AVATAR_COLOR_OPTIONS } from "../../lib/avatar";
import { AgentEditor, agentUpdateInput } from "./AgentSettings";

const agent: Agent = {
  agentId: "c-1-dev",
  name: "开发一号",
  role: "developer",
  responsibilities: "实现并验证功能。",
  systemPrompt: "先核对事实。",
  avatarColor: "rose",
  version: 3,
};

function render(current: Agent = agent): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AgentEditor
        companyId="c-1"
        agent={current}
        onClose={() => {}}
        onSaved={() => {}}
      />
    </QueryClientProvider>,
  );
}

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`))?.[0] ?? "";

describe("AgentEditor avatar color", () => {
  test("renders an accessible radiogroup with all 12 labeled options", () => {
    const html = render();

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-labelledby="agent-avatar-color-label"');
    expect(html).toContain('data-testid="agent-color-picker"');
    expect((html.match(/name="avatarColor"/g) ?? []).length).toBe(12);
    for (const option of AVATAR_COLOR_OPTIONS) {
      expect(html).toContain(`data-testid="agent-color-${option.id}"`);
      expect(html).toContain(option.label);
      expect(html).toContain(`data-avatar-color="${option.id}"`);
    }
  });

  test("keeps the current member color checked and previewed", () => {
    const html = render();
    const rose = tag(html, "agent-color-rose");
    const preview = html.slice(
      html.indexOf('data-testid="agent-avatar-preview"'),
      html.indexOf('data-testid="agent-color-picker"'),
    );

    expect(rose).toContain("checked");
    expect(tag(html, "agent-color-blue")).not.toContain("checked");
    expect(preview).toContain('data-avatar-color="rose"');
    expect(preview).toContain("avatar-md");
  });

  test("legacy members default the picker to the first palette id", () => {
    const html = render({ ...agent, avatarColor: undefined });
    const preview = html.slice(
      html.indexOf('data-testid="agent-avatar-preview"'),
      html.indexOf('data-testid="agent-color-picker"'),
    );

    expect(tag(html, "agent-color-blue")).toContain("checked");
    expect(preview).toContain('data-avatar-color="blue"');
  });

  test("keeps the save control available", () => {
    const html = render();

    expect(html).toContain('data-testid="agent-editor-save"');
    expect(html).toContain("保存员工定义");
  });

  test("submitted updateMember input carries avatarColor and version", () => {
    const draft = {
      name: "开发一号",
      responsibilities: "实现并验证功能。",
      systemPrompt: "先核对事实。",
      avatarColor: "rose",
    };
    const input = agentUpdateInput(agent, draft);
    const payload = JSON.stringify(input);

    expect(input).toEqual({
      agentId: "c-1-dev",
      name: "开发一号",
      responsibilities: "实现并验证功能。",
      systemPrompt: "先核对事实。",
      avatarColor: "rose",
      expectedVersion: 3,
    });
    expect(payload).toContain('"avatarColor":"rose"');
    expect(JSON.stringify(agentUpdateInput(agent, { ...draft }))).toBe(payload);
    expect(
      JSON.stringify(agentUpdateInput(agent, { ...draft, avatarColor: "blue" })),
    ).not.toBe(payload);
  });
});
