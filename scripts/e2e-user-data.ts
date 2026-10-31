/**
 * Pure user-data metadata helpers for E19.
 *
 * The live E2E always records the two expected roots (`~/.company` and
 * `~/.company-host`) even when they do not exist. That makes a directory created
 * during the run visible to the before/after comparison instead of silently
 * outside the baseline.
 */

export type UserDataExpectedPath = {
  home: string;
  name: string;
  path: string;
  exists: boolean;
  kind: "absent" | "directory" | "symlink" | "file" | "other";
  canonical?: string;
  size?: number;
  mtimeMs?: number;
  ino?: number;
  dev?: number;
  mode?: number;
  nlink?: number;
};

export function expectedPathRecord(entry: UserDataExpectedPath): string {
  const label = `${entry.home}\0${entry.name}`;
  if (!entry.exists) return `expected\0${label}|absent`;
  return [
    "expected",
    label,
    entry.kind,
    entry.size ?? "",
    entry.mtimeMs ?? "",
    entry.ino ?? "",
    entry.dev ?? "",
    entry.mode ?? "",
    entry.nlink ?? "",
    entry.canonical ?? "",
  ].join("|");
}

export function compareExpectedUserData(
  before: UserDataExpectedPath[],
  after: UserDataExpectedPath[],
): { created: string[]; changed: string[] } {
  const key = (entry: UserDataExpectedPath) => `${entry.home}\0${entry.name}`;
  const previous = new Map(before.map((entry) => [key(entry), entry]));
  const created: string[] = [];
  const changed: string[] = [];
  for (const entry of after) {
    const old = previous.get(key(entry));
    if (!old) continue;
    if (!old.exists && entry.exists) created.push(entry.path);
    else if (old.exists !== entry.exists || expectedPathRecord(old) !== expectedPathRecord(entry))
      changed.push(entry.path);
  }
  return { created, changed };
}
