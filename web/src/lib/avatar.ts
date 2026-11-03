/**
 * 头像色板的展示元数据。
 *
 * id 的唯一权威是服务端 `src/domain/avatar.ts` 的 `AVATAR_COLORS`；这里只镜像
 * 顺序与中文标签，避免把 Node 侧模块带进浏览器构建。色值只存在于
 * `web/src/styles/tokens.css`，组件不发明颜色。
 */
export const AVATAR_COLOR_OPTIONS = [
  { id: "blue", label: "蓝色" },
  { id: "navy", label: "藏蓝" },
  { id: "violet", label: "紫罗兰" },
  { id: "plum", label: "梅紫" },
  { id: "rose", label: "玫红" },
  { id: "red", label: "红色" },
  { id: "orange", label: "橙色" },
  { id: "amber", label: "琥珀" },
  { id: "olive", label: "橄榄" },
  { id: "green", label: "绿色" },
  { id: "teal", label: "青色" },
  { id: "slate", label: "石板" },
] as const;

export type AvatarColorId = (typeof AVATAR_COLOR_OPTIONS)[number]["id"];

const AVATAR_COLOR_IDS = new Set<string>(
  AVATAR_COLOR_OPTIONS.map((option) => option.id),
);

export function isAvatarColorId(value: unknown): value is AvatarColorId {
  return typeof value === "string" && AVATAR_COLOR_IDS.has(value);
}

/** 只输出已知调色板 id；未知或非字符串值不会进入 DOM 属性。 */
export function avatarColorAttribute(
  value: unknown,
): AvatarColorId | undefined {
  return isAvatarColorId(value) ? value : undefined;
}
