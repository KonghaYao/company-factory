import { describe, expect, test } from "bun:test";
import {
  MULTITASK_GUIDANCE,
  memoryManagedBlock,
  mergeManagedBlock,
} from "./templates";

describe("member managed profile", () => {
  test("injects multitasking guidance for every role", () => {
    for (const role of [
      "hr",
      "task-supervisor",
      "developer",
      "preview",
      "reviewer",
      "custom-role",
    ]) {
      const block = memoryManagedBlock({ role, responsibilities: "Work" });
      expect(block).toContain("## Multitasking");
      expect(block).toContain(MULTITASK_GUIDANCE);
      expect(block).toContain("multitasks");
    }
  });

  test("keeps agent-owned memory outside the managed block", () => {
    const merged = mergeManagedBlock(
      "my own notes",
      memoryManagedBlock({ role: "developer", responsibilities: "Work" }),
    );
    expect(merged).toContain("my own notes");
    expect(merged).toContain("## Multitasking");
  });
});
