import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WorkspaceViewAdapter } from "./workspace";

describe("Workspace roots", () => {
  test("exposes the company knowledgebase as the company asset root", () => {
    const root = "/tmp/company";
    const knowledgeDirectory = join(root, "companys", "acme", "knowledgebase");
    const workspace = new WorkspaceViewAdapter({
      periBinary: "/bin/false",
      companyHome: root,
    });
    const roots = workspace.roots({
      agentId: "dev",
      companyId: "acme",
      directory: join(root, "agents", "dev"),
      knowledgeDirectory,
    });
    expect(roots).toContainEqual({
      name: "公司资产（公共知识）",
      path: knowledgeDirectory,
      kind: "knowledge",
    });
    expect(roots.some((entry) => entry.name === "公司知识")).toBe(false);
    expect(
      roots.find((entry) => entry.kind === "company"),
    ).toMatchObject({
      name: "公司数据",
      path: join(root, "companys", "acme"),
    });
  });

  test("omits the knowledge root when no directory is configured", () => {
    const workspace = new WorkspaceViewAdapter({ periBinary: "/bin/false" });
    const roots = workspace.roots({
      agentId: "dev",
      companyId: "acme",
      directory: "/tmp/agent",
    });
    expect(roots.some((entry) => entry.kind === "knowledge")).toBe(false);
  });
});
