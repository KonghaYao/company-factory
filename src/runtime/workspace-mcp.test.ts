import { describe, expect, test } from "bun:test";
import { snapshotWorkspaceMcpServerOptions } from "./workspace-mcp";

describe("Workspace MCP server factory isolation snapshot", () => {
  test("copies privatePaths and projectRoots instead of aliasing them", () => {
    const privatePaths = ["/var/lib/company/stores.db"];
    const projectRoots = ["/tmp/company-project"];
    const snapshot = snapshotWorkspaceMcpServerOptions({
      periBinary: "/opt/peri/peri",
      scope: {
        directory: "/tmp/company/agents/dev",
        companyHome: "/tmp/company",
        privatePaths,
        projectRoots,
      },
    });
    expect(snapshot.scope.privatePaths).toEqual(["/var/lib/company/stores.db"]);
    expect(snapshot.scope.projectRoots).toEqual(["/tmp/company-project"]);
    expect(snapshot.scope.privatePaths).not.toBe(privatePaths);
    expect(snapshot.scope.projectRoots).not.toBe(projectRoots);

    privatePaths.push("/tmp/other-store");
    projectRoots.push("/tmp/other-project");
    expect(snapshot.scope.privatePaths).toEqual(["/var/lib/company/stores.db"]);
    expect(snapshot.scope.projectRoots).toEqual(["/tmp/company-project"]);
  });

  test("keeps the optional fields absent when they are not provided", () => {
    const snapshot = snapshotWorkspaceMcpServerOptions({
      periBinary: "/opt/peri/peri",
      scope: { directory: "/tmp/agent" },
    });
    expect(snapshot.scope.privatePaths).toBeUndefined();
    expect(snapshot.scope.projectRoots).toBeUndefined();
    expect(snapshot.scope.companyHome).toBeUndefined();
    expect(snapshot.env).toBeUndefined();
  });
});
