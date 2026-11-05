import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { softwarePipeline } from "../src/domain/templates";

const templateFile = join(
  import.meta.dir,
  "..",
  "templates",
  "software-delivery.md",
);

describe("software delivery pipeline template", () => {
  test("no longer assigns the terminal stage to a task supervisor", () => {
    expect(softwarePipeline).not.toContain("task-supervisor");
    expect(softwarePipeline).toContain(
      "ready_merge: { role: department-head,",
    );
  });

  test("describes coordination through the active node lead", () => {
    expect(softwarePipeline).toContain("leadPersonId");
    expect(softwarePipeline).toContain("角色标签本身不授予协调或改派权限");
  });

  test("keeps the existing stage sequence and terminal boundary", () => {
    for (const stage of [
      "plan:",
      "code:",
      "ready_preview:",
      "preview:",
      "accepted:",
      "verifying:",
      "ready_merge:",
    ])
      expect(softwarePipeline).toContain(stage);
    expect(softwarePipeline).toContain("ready_merge 只表示待合入，不是已合入");
  });

  test("the source file matches the pipeline imported by the domain", async () => {
    expect(await readFile(templateFile, "utf8")).toBe(softwarePipeline);
  });
});
