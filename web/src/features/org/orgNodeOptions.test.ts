import { describe, expect, test } from "bun:test";
import type { Organization, OrgNode } from "../../lib/types";
import {
  activeNodeOptions,
  defaultParentId,
  parentNodeOptions,
} from "./orgNodeOptions";

function node(partial: Partial<OrgNode> & Pick<OrgNode, "id">): OrgNode {
  return {
    name: partial.id,
    kind: "department",
    parentId: null,
    order: 0,
    status: "active",
    version: 1,
    ...partial,
  };
}

const organization: Organization = {
  schema: "company-org/v1",
  version: 3,
  nodes: [
    node({ id: "headquarters", name: "总部", kind: "company", order: 0 }),
    node({
      id: "software-development",
      name: "软件研发",
      kind: "division",
      order: 1,
    }),
    node({
      id: "backend",
      name: "后端组",
      kind: "team",
      parentId: "software-development",
      order: 0,
    }),
    node({
      id: "old-team",
      name: "旧团队",
      status: "archived",
      order: 2,
    }),
  ],
  placements: [],
};

describe("organization node options", () => {
  test("editing a root keeps the empty parent instead of taking the first node", () => {
    const root = organization.nodes.find((item) => item.id === "headquarters")!;
    const options = activeNodeOptions(organization);

    expect(root.parentId).toBeNull();
    expect(defaultParentId(root, undefined, options)).toBe("");
    expect(defaultParentId(root, "software-development", options)).toBe("");
  });

  test("editing keeps the stored parent and creation keeps the requested parent", () => {
    const options = activeNodeOptions(organization);
    const backend = organization.nodes.find((item) => item.id === "backend")!;

    expect(defaultParentId(backend, undefined, options)).toBe(
      "software-development",
    );
    expect(defaultParentId(undefined, "software-development", options)).toBe(
      "software-development",
    );
    expect(defaultParentId(undefined, undefined, options)).toBe(
      "software-development",
    );
  });

  test("only active nodes are offered, sorted by their display path", () => {
    const options = activeNodeOptions(organization);

    expect(options.map((item) => item.node.id)).toEqual([
      "software-development",
      "backend",
      "headquarters",
    ]);
    expect(options.find((item) => item.node.id === "backend")?.path).toBe(
      "软件研发 / 后端组",
    );
  });

  test("editing excludes the node itself and every descendant from parents", () => {
    const division = parentNodeOptions(organization, "software-development");
    const root = parentNodeOptions(organization, "headquarters");

    expect(division.map((item) => item.node.id)).toEqual(["headquarters"]);
    expect(root.map((item) => item.node.id)).toEqual([
      "software-development",
      "backend",
    ]);
    expect(
      parentNodeOptions(organization).map((item) => item.node.id),
    ).toContain("software-development");
  });
});
