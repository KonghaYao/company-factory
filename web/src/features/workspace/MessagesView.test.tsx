import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "../../lib/types";
import { MessagesView } from "./MessagesView";

const scope = { companyId: "c-1", agentId: "self" };

function render(agents: Agent[]): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MessagesView
        scope={scope}
        threads={[]}
        agents={agents}
        onDraft={() => {}}
      />
    </QueryClientProvider>,
  );
}

function colleagueRow(html: string, name: string): string {
  const rows = html.match(/<button[^>]*class="colleague-row"[^>]*>[\s\S]*?<\/button>/g) ?? [];
  return rows.find((row) => row.includes(name)) ?? "";
}

describe("MessagesView", () => {
  test("colleague rows use the member color", () => {
    const html = render([
      { agentId: "self", name: "当前成员", role: "developer" },
      {
        agentId: "dev-2",
        name: "开发二号",
        role: "developer",
        avatarColor: "violet",
      },
    ]);
    const row = colleagueRow(html, "开发二号");

    expect(row).toContain('data-avatar-color="violet"');
    expect(row).toContain("avatar-sm");
    expect(row).not.toContain('data-avatar-color="blue"');
  });

  test("legacy colleagues without a color keep the default avatar", () => {
    const html = render([
      { agentId: "self", name: "当前成员", role: "developer" },
      { agentId: "dev-3", name: "旧同事", role: "developer" },
    ]);
    const row = colleagueRow(html, "旧同事");

    expect(row).toContain("avatar-agent avatar-sm");
    expect(row).not.toContain("data-avatar-color");
  });

  test("the signed-in agent is not listed as a colleague", () => {
    const html = render([
      { agentId: "self", name: "当前成员", role: "developer" },
    ]);

    expect(html).not.toContain("当前成员");
  });
});
