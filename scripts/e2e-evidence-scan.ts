/**
 * Secret scan for every file in the live-E2E evidence directory.
 *
 * The scan targets secret-shaped values, not bare variable names, so a cleanup
 * note that quotes a grep pattern (`PERI_MODEL_API_KEY|...`) is not a false
 * positive while an actual assignment is. Callers pass the run's real secret
 * values as well; a matching substring is a rejection.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const EVIDENCE_SECRET_PATTERNS = [
  /Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/i,
  /company_session=(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/i,
  /(?:PERI_MODEL_API_KEY|PERI_STORAGE_TOKEN|COMPANY_WEB_TOKEN|COMPANY_SQLD_TOKEN)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/,
  /authToken["']?\s*[:=]\s*["']?(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/,
  /apiKey["']?\s*[:=]\s*["']?(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/i,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function textHasSecret(content: string, secrets: string[]): boolean {
  return (
    EVIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(content)) ||
    secrets.some((secret) => secret.length >= 8 && content.includes(secret))
  );
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop()!;
    let info;
    try {
      info = lstatSync(current);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = readdirSync(current);
      } catch {}
      for (const entry of entries) stack.push(join(current, entry));
      continue;
    }
    files.push(current);
  }
  return files.sort();
}

export function scanEvidenceDirectory(input: {
  directory: string;
  secrets: string[];
  maxBytes: number;
  skipNames?: string[];
}): { scanned: number; rejected: string[] } {
  const skip = new Set(input.skipNames ?? []);
  const rejected: string[] = [];
  const files = listFiles(input.directory);
  for (const file of files) {
    if (skip.has(basename(file))) continue;
    let content: string;
    try {
      const info = lstatSync(file);
      if (info.size > input.maxBytes) {
        rejected.push(`${relative(input.directory, file)} (too large to scan)`);
        continue;
      }
      content = readFileSync(file, "utf8");
    } catch {
      rejected.push(`${relative(input.directory, file)} (unreadable)`);
      continue;
    }
    if (textHasSecret(content, input.secrets))
      rejected.push(relative(input.directory, file));
  }
  return { scanned: files.length, rejected };
}
