import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  Agent,
  Company,
  Organization,
  PendingDecision,
} from "../../lib/types";
import { MembersMenu, OrganizationPanel } from "./OrganizationPanel";

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
    avatarColor: "navy",
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
    avatarColor: "rose",
    placement: null,
  },
  {
    agentId: "dev-2",
    name: "已归档开发",
    role: "developer",
    status: "archived",
    avatarColor: "teal",
    placement: null,
  },
];

function render(
  panelAgents: Agent[] = agents,
  pendingQuestions: PendingDecision[] = [],
): string {
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
      pendingQuestions={pendingQuestions}
      pendingQuestionsError={null}
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
      onAnswerQuestion={async () => {}}
      onOpenQuestion={noop}
    />,
  );
}

const agentRow = (html: string, id: string) =>
  html.match(
    new RegExp(
      `<button[^>]*data-testid="agent-${id}"[^>]*>[\\s\\S]*?</button>`,
    ),
  )?.[0] ?? "";

describe("OrganizationPanel", () => {
  test("node actions stay behind a more menu", () => {
    const html = render();

    expect(html).toContain('data-testid="org-node-more-headquarters"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('data-testid="org-node-add-headquarters"');
    expect(html).not.toContain('data-testid="org-node-edit-headquarters"');
  });

  test("unassigned active members are hidden from the sidebar", () => {
    const html = render();

    expect(html).not.toContain('data-testid="org-unassigned"');
    expect(html).not.toContain("未分配成员");
    expect(html).not.toContain('data-testid="agent-dev-1"');
    expect(html).not.toContain('data-testid="agent-more-dev-1"');
  });

  test("a placed member is not duplicated in the sidebar", () => {
    const html = render();
    const rows = html.match(/data-testid="agent-c-1-hr"/g) ?? [];

    expect(rows).toHaveLength(1);
  });

  test("the member menu is the only sidebar entry for archived members", () => {
    const html = render();

    expect(html).toContain('data-testid="org-members-trigger"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("成员");
    expect(html).not.toContain('data-testid="org-archived-trigger"');
    expect(html).not.toContain("已归档开发");
    expect(html).not.toContain('data-testid="agent-more-dev-2"');
  });

  test("the member menu stays available when nobody is archived", () => {
    const html = render(agents.filter((agent) => agent.status !== "archived"));

    expect(html).toContain('data-testid="org-members-trigger"');
  });

  test("member menu exposes all, unassigned and departed entries", () => {
    const html = renderToStaticMarkup(
      <MembersMenu
        counts={{ all: 3, unassigned: 1, archived: 1 }}
        onOpen={() => {}}
        defaultOpen
      />,
    );

    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("全部成员");
    expect(html).toContain("未分配成员");
    expect(html).toContain("离职人员");
  });

  test("the move-only note is removed without removing organization settings", () => {
    const html = render();

    expect(html).not.toContain("◆");
    expect(html).not.toContain("移动只改组织归属");
    expect(html).toContain("组织设置");
  });

  test("member avatars use the color from the organization projection", () => {
    const html = render();

    expect(agentRow(html, "c-1-hr")).toContain('data-avatar-color="navy"');
    expect(agentRow(html, "dev-1")).toBe("");
    expect(agentRow(html, "c-1-hr")).toContain("avatar-agent avatar-sm");
  });

  test("legacy members without a color keep the default avatar", () => {
    const html = render(
      agents.map(({ avatarColor: _avatarColor, ...legacy }) => legacy),
    );

    expect(agentRow(html, "c-1-hr")).toContain("avatar-agent avatar-sm");
    expect(agentRow(html, "c-1-hr")).not.toContain("data-avatar-color");
    expect(agentRow(html, "dev-1")).toBe("");
  });

  test("pending questions sit above the org tree, outside its scroll area", () => {
    const html = render(agents, [
      {
        issueId: "7",
        issueTitle: "上线检查",
        issueStatus: "code",
        agentId: "c-1-hr",
        decisionId: "7-Q1",
        question: "是否今天就上线？",
        options: ["今天上线", "明天上线"],
        updatedAt: "2026-01-02T10:00:00Z",
      },
    ]);
    const pendingIndex = html.indexOf('data-testid="pending-questions"');
    const scrollIndex = html.indexOf('class="org-scroll"');

    expect(pendingIndex).toBeGreaterThan(-1);
    expect(scrollIndex).toBeGreaterThan(-1);
    expect(pendingIndex).toBeLessThan(scrollIndex);
    expect(html).toContain("是否今天就上线？");
    expect(html).toContain("上线检查");
  });
});
