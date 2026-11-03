/**
 * Fixed avatar palette ids owned by the Company. Color values live in the web
 * token layer; domain facts stay palette ids so they can be validated and
 * rendered without inline styles.
 */
export const AVATAR_COLORS = [
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
] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function isAvatarColor(value: unknown): value is AvatarColor {
  return (
    typeof value === "string" &&
    (AVATAR_COLORS as readonly string[]).includes(value)
  );
}

/** FNV-1a 32-bit over UTF-8 bytes. Only seeds deterministic fallbacks. */
export function avatarColorSeed(agentId: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(agentId)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Deterministic color for legacy members without a stored palette id. */
export function fallbackAvatarColor(agentId: string): AvatarColor {
  return AVATAR_COLORS[avatarColorSeed(agentId) % AVATAR_COLORS.length]!;
}

/**
 * Reads `company.yaml.memberColors` without judging ids. Unknown and legacy
 * keys are preserved so a later Company write never drops another member's
 * entry. Non-object values are treated as an empty map.
 */
export function readMemberColors(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>));
}

/** Key-set and value comparison that ignores object insertion order. */
export function memberColorsChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (beforeKeys.length !== afterKeys.length) return true;
  return beforeKeys.some(
    (key) => !Object.hasOwn(after, key) || !Object.is(before[key], after[key]),
  );
}

/**
 * Stored colors win. Missing members are filled in agentId order by probing
 * linearly from their seed, so the result does not depend on roster order.
 * Reserved historical colors (for example deleted members) are not reused
 * until the palette is exhausted; an exhausted palette reuses the seed color.
 */
export function resolveMemberColors(
  members: readonly { agentId: string; color?: unknown }[],
  reserved: Iterable<unknown> = [],
): Map<string, AvatarColor> {
  const result = new Map<string, AvatarColor>();
  const used = new Set<AvatarColor>();
  for (const member of members) {
    if (isAvatarColor(member.color)) {
      result.set(member.agentId, member.color);
      used.add(member.color);
    }
  }
  for (const color of reserved) if (isAvatarColor(color)) used.add(color);
  const missing = [
    ...new Set(
      members
        .filter((member) => !isAvatarColor(member.color))
        .map((member) => member.agentId),
    ),
  ].sort();
  for (const agentId of missing) {
    const start = avatarColorSeed(agentId) % AVATAR_COLORS.length;
    let selected: AvatarColor | undefined;
    for (let offset = 0; offset < AVATAR_COLORS.length; offset++) {
      const candidate = AVATAR_COLORS[(start + offset) % AVATAR_COLORS.length]!;
      if (!used.has(candidate)) {
        selected = candidate;
        break;
      }
    }
    selected ??= AVATAR_COLORS[start]!;
    result.set(agentId, selected);
    used.add(selected);
  }
  return result;
}

/**
 * Default assignment: random among the least-used colors, which is the unused
 * set while fewer than 12 people have colors. `random` is injectable for tests.
 */
export function nextAvatarColor(
  used: Iterable<unknown>,
  random: () => number = Math.random,
): AvatarColor {
  const counts = new Map<AvatarColor, number>(
    AVATAR_COLORS.map((color) => [color, 0] as const),
  );
  for (const value of used)
    if (isAvatarColor(value))
      counts.set(value, (counts.get(value) ?? 0) + 1);
  const least = Math.min(...counts.values());
  const candidates = AVATAR_COLORS.filter(
    (color) => counts.get(color) === least,
  );
  const sample = random();
  const index = Number.isFinite(sample)
    ? Math.min(
        candidates.length - 1,
        Math.max(0, Math.floor(sample * candidates.length)),
      )
    : 0;
  return candidates[index]!;
}

/**
 * Freezes the current effective fallback for every roster member lacking a
 * valid stored color. Existing keys, including unknown ones, are preserved.
 */
export function fillMissingMemberColors(
  stored: Record<string, unknown>,
  members: readonly { agentId: string }[],
  effective: ReadonlyMap<string, AvatarColor>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...stored };
  for (const member of members) {
    if (isAvatarColor(next[member.agentId])) continue;
    const color = effective.get(member.agentId);
    if (color) next[member.agentId] = color;
  }
  return next;
}
