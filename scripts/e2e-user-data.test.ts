import { describe, expect, test } from "bun:test";
import {
  compareExpectedUserData,
  expectedPathRecord,
  type UserDataExpectedPath,
} from "./e2e-user-data";

const HOME = "/home/example";

function absent(name: ".company" | ".company-host"): UserDataExpectedPath {
  return {
    home: HOME,
    name,
    path: `${HOME}/${name}`,
    exists: false,
    kind: "absent",
  };
}

function present(
  name: ".company" | ".company-host",
  overrides: Partial<UserDataExpectedPath> = {},
): UserDataExpectedPath {
  return {
    home: HOME,
    name,
    path: `${HOME}/${name}`,
    exists: true,
    kind: "directory",
    canonical: `${HOME}/${name}`,
    size: 96,
    mtimeMs: 1_700_000_000_000,
    ino: 42,
    dev: 7,
    mode: 0o40700,
    nlink: 3,
    ...overrides,
  };
}

describe("expected user-data paths", () => {
  test("absent paths are part of the record instead of being dropped", () => {
    const record = expectedPathRecord(absent(".company"));
    expect(record).toContain("|absent");
    expect(record).toContain(".company");
    const presentRecord = expectedPathRecord(present(".company"));
    expect(presentRecord).not.toBe(record);
    expect(presentRecord).toContain("|directory|");
  });

  test("a directory created after the baseline is detected", () => {
    const result = compareExpectedUserData(
      [absent(".company"), absent(".company-host")],
      [present(".company"), absent(".company-host")],
    );
    expect(result.created).toEqual([`${HOME}/.company`]);
    expect(result.changed).toEqual([]);
  });

  test("inode, mtime, size and mode changes are detected", () => {
    const before = [present(".company"), present(".company-host")];
    const after = [
      present(".company", { ino: 43 }),
      present(".company-host", { size: 97 }),
    ];
    const result = compareExpectedUserData(before, after);
    expect(result.created).toEqual([]);
    expect(result.changed.sort()).toEqual([
      `${HOME}/.company`,
      `${HOME}/.company-host`,
    ]);
  });

  test("absent before and after stays unchanged", () => {
    const result = compareExpectedUserData(
      [absent(".company"), absent(".company-host")],
      [absent(".company"), absent(".company-host")],
    );
    expect(result.created).toEqual([]);
    expect(result.changed).toEqual([]);
  });
});
