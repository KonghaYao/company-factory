import { describe, test, expect, beforeEach } from "bun:test";
import { useLocal } from "./state";
import { scopeKey } from "./types";
const one = { companyId: "one", agentId: "dev" };
const two = { companyId: "two", agentId: "dev" };
beforeEach(() => useLocal.setState({ scopes: {} }));
describe("Agent-scoped workbench buffers (unit tests, not SDK evidence)", () => {
  test("same agentId in different company keys cannot cross drafts or tabs", () => {
    useLocal
      .getState()
      .patch(one, { draft: "first", tab: "files", issueId: "42" });
    useLocal.getState().patch(two, { draft: "second", tab: "messages" });
    expect(useLocal.getState().scopes[scopeKey(one)].draft).toBe("first");
    expect(useLocal.getState().scopes[scopeKey(two)].draft).toBe("second");
    expect(useLocal.getState().scopes[scopeKey(one)].tab).toBe("files");
  });
  test("late accepted receipt clears only captured draft and references", () => {
    const refs = [{ path: "claude.md" }];
    useLocal.getState().patch(one, { draft: "submitted", references: refs });
    useLocal.getState().patch(one, { draft: "newer unsent" });
    useLocal.getState().clearSent(one, "submitted", refs);
    expect(useLocal.getState().scopes[scopeKey(one)].draft).toBe(
      "newer unsent",
    );
    expect(useLocal.getState().scopes[scopeKey(one)].references).toEqual([]);
  });
  test("new references added while send waits are retained", () => {
    const old = [{ path: "old.md" }];
    useLocal.getState().patch(one, { draft: "submitted", references: old });
    const newer = [...old, { path: "new.md" }];
    useLocal.getState().patch(one, { references: newer });
    useLocal.getState().clearSent(one, "submitted", old);
    expect(useLocal.getState().scopes[scopeKey(one)].draft).toBe("");
    expect(useLocal.getState().scopes[scopeKey(one)].references).toEqual(newer);
  });
  test("file conflicts preserve original, unsaved and disk evidence independently", () => {
    useLocal
      .getState()
      .file(one, "memory.md", {
        original: "v1",
        content: "mine",
        dirty: true,
        version: "v1",
      });
    useLocal
      .getState()
      .file(one, "memory.md", {
        diskConflict: "theirs",
        conflictVersion: "v2",
      });
    useLocal
      .getState()
      .file(two, "memory.md", {
        original: "other-company",
        content: "other-company",
      });
    const file = useLocal.getState().scopes[scopeKey(one)].files["memory.md"];
    expect(file.original).toBe("v1");
    expect(file.content).toBe("mine");
    expect(file.diskConflict).toBe("theirs");
    expect(file.dirty).toBe(true);
    expect(
      useLocal.getState().scopes[scopeKey(two)].files["memory.md"].content,
    ).toBe("other-company");
  });
});
