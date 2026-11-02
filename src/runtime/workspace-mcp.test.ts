import { describe, expect, test } from "bun:test";
import { snapshotWorkspaceMcpServerOptions } from "./workspace-mcp";

describe("Workspace MCP server factory snapshot", () => {
  test("copies the launch options instead of aliasing them", () => {
    const env = { PATH: "/usr/bin", LANG: "C.UTF-8", HOME: "/home/dev" };
    const snapshot = snapshotWorkspaceMcpServerOptions({
      periBinary: "/opt/peri/peri",
      directory: "/tmp/company/agents/dev",
      env,
    });
    expect(snapshot.directory).toBe("/tmp/company/agents/dev");
    expect(snapshot.env).toEqual(env);
    expect(snapshot.env).not.toBe(env);

    env.PATH = "/changed";
    expect(snapshot.env?.PATH).toBe("/usr/bin");
  });

  test("keeps optional fields absent when they are not provided", () => {
    const snapshot = snapshotWorkspaceMcpServerOptions({
      periBinary: "/opt/peri/peri",
      directory: "/tmp/agent",
    });
    expect(snapshot.env).toBeUndefined();
  });
});
