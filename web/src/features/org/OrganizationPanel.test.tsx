import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Company, Organization } from "../../lib/types";
import { OrganizationPanel } from "./OrganizationPanel";

const company: Company = { id: "c-1", name: "测试公司" };
const organization: Organization = {
  schema: "company-org/v1",
  version: 2,
  nodes: [
    {
      id: "headquarters",
      name: "总部",
      kind: "company",
      parentId: null,
      order: 0,
      status: "active",
      version: 1,
    },
    {
      id: "team",
      name: "团队",
      kind: "team",
      parentId: "headquarters",
      order: 0,
      status: "active",
      version: 1,
    },
  ],
  placements: [],
};
const agents: Agent[] = [
  {
    agentId: "c-1-hr",
    name: "人事",
    role: "hr",
    status: "active",
    placement: {
      personId: "c-1-hr",
      nodeId: "headquarters",
      order: 0,
      primary: true,
      since: "2026-01-01",
      movedAt: "2026-01-01",
      movedBy: "test",
      version: 1,
    },
  },
  {
    agentId: "dev-1",
    name: "未分配开发",
    role: "developer",
    status: "active",
    placement: null,
  },
  {
    agentId: "dev-2",
    name: "已归档开发",
    role: "developer",
    status: "archived",
    placement: null,
  },
];

function render(panelAgents: Agent[] = agents): string {
  const noop = () => {};
  return renderToStaticMarkup(
    <OrganizationPanel
      companies={[company]}
      companyId={company.id}
      organization={organization}
      agents={panelAgents}
      selectedAgent=""
      collapsed={{}}
      loading={false}
      error={null}
      onChooseCompany={noop}
      onSelectAgent={noop}
      onEditAgent={noop}
      onToggleNode={noop}
      onCreateCompany={noop}
      onOpenSettings={noop}
      onCreateNode={noop}
      onEditNode={noop}
      onArchiveNode={noop}
      onDeleteNode={noop}
      onMoveAgent={noop}
      onArchiveAgent={noop}
      onRestoreAgent={noop}
    />,
  );
}

describe("OrganizationPanel", () => {
  test("node actions stay behind a more menu", () => {
    const html = render();

    expect(html).toContain('data-testid="org-node-more-headquarters"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('data-testid="org-node-add-headquarters"');
    expect(html).not.toContain('data-testid="org-node-edit-headquarters"');
  });

  test("active members without a placement stay visible in the unassigned section", () => {
    const html = render();

    expect(html).toContain('data-testid="org-unassigned"');
    expect(html).toContain("未分配成员");
    expect(html).toContain("未分配开发");
    expect(html).toContain('data-testid="agent-more-dev-1"');
    expect(html).not.toContain('data-testid="agent-move-dev-1"');
    expect(html).not.toContain('data-testid="agent-archive-dev-1"');
    expect(html).not.toContain('data-testid="agent-edit-dev-1"');
  });

  test("a placed member is not duplicated in the unassigned section", () => {
    const html = render();
    const rows = html.match(/data-testid="agent-c-1-hr"/g) ?? [];

    expect(rows).toHaveLength(1);
  });

  test("archived members stay behind a header trigger and out of unassigned", () => {
    const html = render();
    const trigger =
      html.match(
        /<button[^>]*data-testid="org-archived-trigger"[\s\S]*?<\/button>/,
      )?.[0] ?? "";
    const unassigned = html.slice(html.indexOf('data-testid="org-unassigned"'));

    expect(trigger).toContain("已归档成员");
    expect(trigger).toContain("<em>1</em>");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(unassigned).not.toContain("已归档开发");
    expect(unassigned).not.toContain('data-testid="agent-dev-2"');
    expect(html).not.toContain("已归档开发");
    expect(html).not.toContain('data-testid="agent-more-dev-2"');
    expect(html).not.toContain('data-testid="agent-restore-dev-2"');
    expect(html).not.toContain('data-testid="org-archived-list"');
  });

  test("the archived trigger is hidden when nobody is archived", () => {
    const html = render(agents.filter((agent) => agent.status !== "archived"));

    expect(html).not.toContain('data-testid="org-archived-trigger"');
  });
});
