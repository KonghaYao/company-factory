import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AVATAR_COLOR_OPTIONS,
  avatarColorAttribute,
  isAvatarColorId,
} from "./avatar";

const tokensCss = readFileSync(
  fileURLToPath(new URL("../styles/tokens.css", import.meta.url)),
  "utf8",
);
const baseCss = readFileSync(
  fileURLToPath(new URL("../styles/base.css", import.meta.url)),
  "utf8",
);
const domainAvatarPath = fileURLToPath(
  new URL("../../../src/domain/avatar.ts", import.meta.url),
);

/** 服务端调色板是 id 的唯一权威；Web 只镜像顺序。 */
function readDomainPalette(): string[] | null {
  if (!existsSync(domainAvatarPath)) return null;
  const source = readFileSync(domainAvatarPath, "utf8");
  const literal = source.match(
    /export const AVATAR_COLORS\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  if (!literal) throw new Error("AVATAR_COLORS not found in src/domain/avatar.ts");
  return [...literal[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function linearChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex).map(linearChannel);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function token(name: string): string {
  const match = tokensCss.match(
    new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`),
  );
  if (!match) throw new Error(`missing token --${name}`);
  return match[1];
}

const paletteIds = AVATAR_COLOR_OPTIONS.map((option) => option.id);
const domainPalette = readDomainPalette();

describe("web avatar palette", () => {
  test.skipIf(domainPalette === null)(
    "ids match src/domain/avatar.ts in order",
    () => {
      expect(domainPalette).toEqual(paletteIds);
    },
  );

  test("every option has a unique id and a visible Chinese label", () => {
    expect(new Set(paletteIds).size).toBe(paletteIds.length);
    for (const option of AVATAR_COLOR_OPTIONS) {
      expect(option.id).not.toBe("");
      expect(option.label.trim()).not.toBe("");
      expect(option.label).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  test("every palette id has bg/fg tokens with white-text contrast >= 4.5", () => {
    for (const id of paletteIds) {
      const background = token(`avatar-${id}-bg`);
      const foreground = token(`avatar-${id}-fg`);

      expect(foreground.toLowerCase()).toBe("#ffffff");
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(
      tokensCss.match(/--avatar-[a-z]+-(?:bg|fg):/g) ?? [],
    ).toHaveLength(24);
  });

  test("base.css styles every palette id and the picker swatch", () => {
    expect(baseCss).toContain(".avatar[data-avatar-color]");
    expect(baseCss).toContain(".avatar-swatch");
    for (const id of paletteIds) {
      expect(baseCss).toContain(`[data-avatar-color="${id}"]`);
    }
  });

  test("only known palette ids are accepted", () => {
    for (const id of paletteIds) {
      expect(isAvatarColorId(id)).toBe(true);
      expect(avatarColorAttribute(id)).toBe(id);
    }
    for (const invalid of [
      "",
      "#fff",
      "chartreuse",
      "Rose",
      " rose ",
      null,
      undefined,
      42,
      {},
      [],
    ]) {
      expect(isAvatarColorId(invalid)).toBe(false);
      expect(avatarColorAttribute(invalid)).toBeUndefined();
    }
  });
});
