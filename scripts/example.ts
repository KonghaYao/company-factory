/** Reproducible example: real Peri Sessions, two real worktrees/merge/Preview/CI.
 * This runs the integration fixture, not an LLM-generated delivery and not human
 * acceptance. The suite prints a temporary artifact directory for inspection.
 */
const child = Bun.spawn(
  [process.execPath, "test", "tests/integration.test.ts"],
  {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);

export {};
