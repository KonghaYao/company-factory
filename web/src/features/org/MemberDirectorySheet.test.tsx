import { describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "../../lib/types";
import {
  MemberDirectorySheet,
  groupMembers,
  type MemberFilter,
} from "./MemberDirectorySheet";

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
    placement: null,
  },
  {
    agentId: "dev-2",
    name: "离职开发",
    role: "developer",
    status: "archived",
    placement: null,
  },
];

type Props = ComponentProps<typeof MemberDirectorySheet>;

const render = (filter: MemberFilter, overrides: Partial<Props> = {}) =>
  renderToStaticMarkup(
    <MemberDirectorySheet
      open
      agents={agents}
      filter={filter}
      loading={false}
      error={null}
      onFilter={() => {}}
      onClose={() => {}}
      renderMember={(agent) => <p key={agent.agentId}>{agent.name}</p>}
      {...overrides}
    />,
  );

describe("groupMembers", () => {
  test("splits archived members out of the unassigned bucket", () => {
    const groups = groupMembers(agents);

    expect(groups.all).toHaveLength(3);
    expect(groups.active.map((agent) => agent.name)).toEqual([
      "人事",
      "未分配开发",
    ]);
    expect(groups.unassigned.map((agent) => agent.name)).toEqual([
      "未分配开发",
    ]);
    expect(groups.archived.map((agent) => agent.name)).toEqual(["离职开发"]);
  });
});

describe("MemberDirectorySheet", () => {
  test("the all tab lists every member", () => {
    const html = render("all");

    expect(html).toContain("成员列表");
    expect(html).toContain("人事");
    expect(html).toContain("未分配开发");
    expect(html).toContain("离职开发");
    expect(html).toContain("全部");
    expect(html).toContain("未分配");
    expect(html).toContain("离职人员");
  });

  test("the unassigned tab only lists active members without a placement", () => {
    const html = render("unassigned");

    expect(html).toContain("未分配开发");
    expect(html).not.toContain("人事");
    expect(html).not.toContain("离职开发");
  });

  test("the archived tab only lists departed members", () => {
    const html = render("archived");

    expect(html).toContain("离职开发");
    expect(html).not.toContain("人事");
    expect(html).not.toContain("未分配开发");
  });

  test("an empty roster shows the all-members empty state", () => {
    const html = render("all", { agents: [] });

    expect(html).toContain("当前公司还没有成员。");
  });

  test("loading state replaces the empty state and member rows", () => {
    const html = render("all", { loading: true });

    expect(html).toContain("读取成员…");
    expect(html).not.toContain("当前公司还没有成员。");
    expect(html).not.toContain("人事");
  });

  test("an error shows the message instead of member rows", () => {
    const html = render("all", { error: new Error("读取失败") });

    expect(html).toContain("读取失败");
    expect(html).not.toContain("当前公司还没有成员。");
    expect(html).not.toContain("人事");
  });

  test("a closed directory renders nothing", () => {
    const html = render("all", { open: false });

    expect(html).not.toContain('data-testid="member-directory"');
  });
});
