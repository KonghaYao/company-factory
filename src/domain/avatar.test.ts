import { describe, expect, test } from "bun:test";
import {
  AVATAR_COLORS,
  avatarColorSeed,
  fallbackAvatarColor,
  fillMissingMemberColors,
  isAvatarColor,
  memberColorsChanged,
  nextAvatarColor,
  readMemberColors,
  resolveMemberColors,
} from "./avatar";

describe("Avatar palette", () => {
  test("palette ids are unique, non-empty and in the documented order", () => {
    expect(AVATAR_COLORS).toEqual([
      "blue",
      "navy",
      "violet",
      "plum",
      "rose",
      "red",
      "orange",
      "amber",
      "olive",
      "green",
      "teal",
      "slate",
    ]);
    expect(new Set(AVATAR_COLORS).size).toBe(AVATAR_COLORS.length);
    for (const color of AVATAR_COLORS) expect(color.length).toBeGreaterThan(0);
  });

  test("isAvatarColor accepts every palette id and rejects arbitrary values", () => {
    for (const color of AVATAR_COLORS) expect(isAvatarColor(color)).toBe(true);
    for (const value of ["", "#fff", "#3b5bdb", "Blue", "chartreuse", null, undefined, 1, {}])
      expect(isAvatarColor(value)).toBe(false);
  });
});

describe("Deterministic fallback", () => {
  test("fallback hash snapshots stay stable for legacy ids", () => {
    expect(avatarColorSeed("legacy-hr")).toBe(3105557459);
    expect(avatarColorSeed("legacy-dev")).toBe(606215296);
    expect(avatarColorSeed("dev-1")).toBe(404524662);
    expect(fallbackAvatarColor("legacy-hr")).toBe("slate");
    expect(fallbackAvatarColor("legacy-dev")).toBe("rose");
    expect(fallbackAvatarColor("dev-1")).toBe("orange");
    expect(fallbackAvatarColor("legacy-hr")).toBe(
      fallbackAvatarColor("legacy-hr"),
    );
  });
});

describe("resolveMemberColors", () => {
  test("stored palette colors take priority over fallbacks", () => {
    const colors = resolveMemberColors([
      { agentId: "legacy-hr", color: "teal" },
      { agentId: "legacy-dev", color: "chartreuse" },
    ]);
    expect(colors.get("legacy-hr")).toBe("teal");
    expect(colors.get("legacy-dev")).toBe("rose");
  });

  test("missing members do not depend on input order", () => {
    const forward = resolveMemberColors([
      { agentId: "m-1" },
      { agentId: "m-2" },
      { agentId: "m-3" },
    ]);
    const backward = resolveMemberColors([
      { agentId: "m-3" },
      { agentId: "m-2" },
      { agentId: "m-1" },
    ]);
    expect([...forward]).toEqual([...backward]);
    expect([...forward]).toEqual([
      ["m-1", "orange"],
      ["m-2", "amber"],
      ["m-3", "olive"],
    ]);
  });

  test("up to twelve unresolved members receive distinct colors", () => {
    const members = Array.from({ length: AVATAR_COLORS.length }, (_, index) => ({
      agentId: `member-${index}`,
    }));
    const colors = [...resolveMemberColors(members).values()];
    expect(new Set(colors).size).toBe(AVATAR_COLORS.length);
  });

  test("more than twelve members stays stable and repeatable", () => {
    const members = Array.from({ length: 30 }, (_, index) => ({
      agentId: `member-${index}`,
    }));
    const first = resolveMemberColors(members);
    const second = resolveMemberColors([...members].reverse());
    expect([...first].sort()).toEqual([...second].sort());
    expect(first.size).toBe(30);
    for (const color of first.values()) expect(isAvatarColor(color)).toBe(true);
  });

  test("reserved historical colors are not reused by fallbacks", () => {
    const colors = resolveMemberColors(
      [{ agentId: "legacy-hr" }],
      ["slate", "chartreuse"],
    );
    expect(colors.get("legacy-hr")).not.toBe("slate");
    expect(colors.get("legacy-hr")).toBe("blue");
  });
});

describe("nextAvatarColor", () => {
  test("chooses only from unused colors while capacity remains", () => {
    expect(nextAvatarColor(["blue", "rose"], () => 0)).toBe("navy");
    expect(nextAvatarColor(["blue", "rose"], () => 0.999)).toBe("slate");
  });

  test("chooses among least-used colors when the palette is exhausted", () => {
    const allUsed = [...AVATAR_COLORS];
    expect(nextAvatarColor([...allUsed, "blue"], () => 0)).toBe("navy");
    expect(nextAvatarColor([...allUsed, "blue"], () => 0.999)).toBe("slate");
    expect(nextAvatarColor(allUsed, () => 0)).toBe("blue");
  });
});

describe("Stored member color map", () => {
  test("readMemberColors preserves unknown keys and ignores non-objects", () => {
    expect(readMemberColors({ "legacy-hr": "slate", retired: "chartreuse" })).toEqual({
      "legacy-hr": "slate",
      retired: "chartreuse",
    });
    expect(readMemberColors(null)).toEqual({});
    expect(readMemberColors(["blue"])).toEqual({});
    expect(readMemberColors("blue")).toEqual({});
  });

  test("memberColorsChanged compares key sets and values, not key order", () => {
    expect(
      memberColorsChanged({ a: "blue", b: "rose" }, { b: "rose", a: "blue" }),
    ).toBe(false);
    expect(memberColorsChanged({ a: "blue" }, { a: "rose" })).toBe(true);
    expect(memberColorsChanged({ a: "blue" }, {})).toBe(true);
    expect(memberColorsChanged({ a: "blue" }, { a: "blue", b: "teal" })).toBe(true);
  });

  test("fillMissingMemberColors freezes fallbacks without dropping entries", () => {
    const effective = resolveMemberColors([
      { agentId: "legacy-hr" },
      { agentId: "legacy-dev" },
    ]);
    const next = fillMissingMemberColors(
      { "legacy-dev": "green", retired: "chartreuse" },
      [{ agentId: "legacy-hr" }, { agentId: "legacy-dev" }],
      effective,
    );
    expect(next).toEqual({
      "legacy-dev": "green",
      retired: "chartreuse",
      "legacy-hr": "slate",
    });
    expect(
      fillMissingMemberColors(next, [{ agentId: "legacy-hr" }], effective),
    ).toEqual(next);
  });
});
