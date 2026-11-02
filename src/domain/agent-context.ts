import type { CompanyDomain } from "./index";
import { digest, safeId } from "../storage/company-store";
import {
  DomainError,
  requireValue,
  type CallerContext,
  type Issue,
  type IssueStatus,
  type Preview,
  type Thread,
} from "./types";

/** Agent-facing reads: a small index of facts, with explicit routes to full data. */
export const CONTEXT_PAGE_BYTES = 32 * 1024;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const ALL_STATUSES: IssueStatus[] = [
  "triage",
  "plan",
  "code",
  "ready_preview",
  "preview",
  "accepted",
  "verifying",
  "ready_merge",
  "cancel",
];
type Input = Record<string, unknown>;
type Cursor = { scope: string; after: string };
export type IssueSummary = Pick<
  Issue,
  "id" | "status" | "agent_id" | "version" | "needs_user"
> & {
  title: string;
  summary: string;
  progress: string;
  detail: { operation: "getIssue"; issueId: string };
};
type ThreadSummary = Pick<
  Thread,
  "id" | "asker_id" | "recipient_id" | "status" | "version"
> & {
  subject: string;
  detail: { operation: "thread"; threadId: string };
};
type PreviewSummary = Pick<Preview, "id" | "owner_id" | "version"> & {
  branch: string;
  issue_count: number;
  detail: { operation: "getPreview"; batchId: string };
};
type Page<T> = { items: T[]; nextCursor: string | null };
const EMPTY_PAGE_BYTES = Buffer.byteLength(
  JSON.stringify({ items: [], nextCursor: null }),
);
const issueDetails =
  "Use getIssue(issueId) for the full current record. Summaries are clipped.";

function clipped(value: unknown, length: number): string {
  return Array.from(String(value ?? ""))
    .slice(0, length)
    .join("");
}
function options(input: Input) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  requireValue(
    Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= MAX_LIMIT,
    "invalid_input",
    "limit must be an integer between 1 and 50",
  );
  requireValue(
    input.includeHistory === undefined ||
      typeof input.includeHistory === "boolean",
    "invalid_input",
    "includeHistory must be boolean",
  );
  const status = input.status;
  requireValue(
    status === undefined ||
      (Array.isArray(status) &&
        status.length > 0 &&
        status.length <= ALL_STATUSES.length &&
        status.every((s) => ALL_STATUSES.includes(s as IssueStatus))),
    "invalid_input",
    "status must be a nonempty list of Issue statuses",
  );
  return {
    limit: Number(limit),
    includeHistory: input.includeHistory === true,
    status:
      status === undefined
        ? undefined
        : [...new Set(status as IssueStatus[])].sort(),
  };
}
function readCursor(value: unknown, scope: string): Cursor | null {
  if (value === undefined) return null;
  requireValue(
    typeof value === "string" && value.length > 0 && value.length <= 1024,
    "invalid_input",
    "Invalid context cursor",
  );
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    requireValue(
      decoded.scope === scope && typeof decoded.after === "string",
      "invalid_input",
      "Cursor does not belong to this scope and filter",
    );
    safeId(decoded.after, "cursor");
    return decoded;
  } catch {
    throw new DomainError(
      "invalid_input",
      "Cursor does not belong to this scope and filter",
    );
  }
}
function encodeCursor(scope: string, after: string) {
  return Buffer.from(JSON.stringify({ scope, after })).toString("base64url");
}
function compareIds(left: string, right: string) {
  // Preview IDs are caller-defined: P01 and P1 must not collapse at a cursor.
  return (
    left.localeCompare(right, undefined, { numeric: true }) ||
    (left < right ? -1 : left > right ? 1 : 0)
  );
}
function summary(issue: Issue): IssueSummary {
  return {
    id: issue.id,
    title: clipped(issue.title, 160),
    status: issue.status,
    agent_id: issue.agent_id,
    version: issue.version,
    needs_user: issue.needs_user,
    summary: clipped(issue.summary, 240),
    progress: clipped(issue.progress, 160),
    detail: { operation: "getIssue", issueId: issue.id },
  };
}

/** Each collection has its own scope and cursor; the budget includes its cursor. */
function page<T extends { id: string }, S>(
  rows: T[],
  scope: string,
  cursorValue: unknown,
  limit: number,
  growthBudget: number,
  summarize: (row: T) => S,
): Page<S> {
  const cursor = readCursor(cursorValue, scope);
  const remaining = rows
    .filter((row) => !cursor || compareIds(row.id, cursor.after) > 0)
    .sort((a, b) => compareIds(a.id, b.id));
  let result: Page<S> = { items: [], nextCursor: null };
  for (const [index, row] of remaining.entries()) {
    if (result.items.length >= limit) break;
    const candidate = {
      items: [...result.items, summarize(row)],
      nextCursor:
        index + 1 < remaining.length ? encodeCursor(scope, row.id) : null,
    };
    if (
      Buffer.byteLength(JSON.stringify(candidate)) - EMPTY_PAGE_BYTES >
      growthBudget
    )
      break;
    result = candidate;
  }
  requireValue(
    !remaining.length || result.items.length > 0,
    "invalid_state",
    "Context summary exceeds its page budget",
    500,
  );
  return result;
}
function issueScope(caller: CallerContext, filter: ReturnType<typeof options>) {
  // Preserve the existing Issue cursor scope for listIssues/workspace callers.
  return digest([
    caller.companyId,
    caller.id,
    filter.includeHistory,
    filter.status ?? null,
  ]);
}
function selectedIssues(
  issues: Issue[],
  caller: CallerContext,
  filter: ReturnType<typeof options>,
) {
  return issues.filter((issue) => {
    if (
      !filter.includeHistory &&
      issue.agent_id !== caller.id &&
      !issue.collaborators.includes(caller.id)
    )
      return false;
    if (filter.status) return filter.status.includes(issue.status);
    return (
      filter.includeHistory || !["cancel", "ready_merge"].includes(issue.status)
    );
  });
}

export class AgentContextView {
  constructor(private readonly domain: CompanyDomain) {}
  async issues(caller: CallerContext, input: Input = {}) {
    requireValue(
      caller.type === "agent",
      "forbidden",
      "Agent context requires an Agent identity",
      403,
    );
    // listIssues validates any supplied agentId, including an empty string.
    const all = await this.domain.listIssues(caller, input);
    const filter = options(input);
    const metadata = {
      includeHistory: filter.includeHistory,
      details: issueDetails,
    };
    const budget =
      CONTEXT_PAGE_BYTES -
      Buffer.byteLength(
        JSON.stringify({ items: [], nextCursor: null, ...metadata }),
      );
    return {
      ...page(
        selectedIssues(all, caller, filter),
        issueScope(caller, filter),
        input.cursor,
        filter.limit,
        budget,
        summary,
      ),
      ...metadata,
    };
  }
  async workspace(caller: CallerContext, input: Input) {
    requireValue(
      caller.type === "agent",
      "forbidden",
      "Agent context requires an Agent identity",
      403,
    );
    const agentId = safeId(input.agentId ?? caller.id, "agentId");
    requireValue(
      agentId === caller.id,
      "forbidden",
      "Cannot query another Agent workspace",
      403,
    );
    // Reuse the domain's participant/Preview visibility rules, then project only
    // summaries. Outgoing unanswered threads and superseded Previews still need
    // discoverable IDs after the fixed Session's history has been compacted.
    const workspace = await this.domain.workspace(caller, { agentId });
    const { agent } = workspace;
    const filter = options(input);
    const result = {
      companyId: caller.companyId,
      agentId,
      profile: {
        name: clipped(agent.name, 200),
        role: clipped(agent.role, 96),
        configVersion: agent.configVersion,
        appliedConfigVersion: agent.appliedConfigVersion,
        memory: "CLAUDE.md",
      },
      issues: [] as IssueSummary[],
      nextCursor: null as string | null,
      includeHistory: filter.includeHistory,
      threads: [] as ThreadSummary[],
      nextThreadCursor: null as string | null,
      previews: [] as PreviewSummary[],
      nextPreviewCursor: null as string | null,
      read: {
        issue:
          "getIssue(issueId): full issue, worktree, plan, code and preview references",
        preview:
          "getPreview(batchId): full preview and acceptance/verification evidence; previews includes accessible historical batches",
        messages:
          "thread(threadId, cursor): messages in any participating thread, including unanswered outgoing requests; inbox(cursor): your own received messages (agentId is owner-only)",
        pagination:
          "Continue each index independently: cursor/nextCursor for Issues, threadCursor/nextThreadCursor for threads, previewCursor/nextPreviewCursor for previews. limit applies to each index; includeHistory/status filter Issues only. Summaries are clipped.",
        profile:
          "Read CLAUDE.md for the current applied profile and your own memory",
      },
    };
    // Account for the complete envelope first. Each index can grow by one third
    // of the remaining bytes, including its cursor; none can starve another.
    const budget = Math.floor(
      (CONTEXT_PAGE_BYTES - Buffer.byteLength(JSON.stringify(result))) / 3,
    );
    const issues = page(
      selectedIssues(workspace.issues, caller, filter),
      issueScope(caller, filter),
      input.cursor,
      filter.limit,
      budget,
      summary,
    );
    const threads = page(
      workspace.threads,
      digest([caller.companyId, caller.id, "threads"]),
      input.threadCursor,
      filter.limit,
      budget,
      (thread): ThreadSummary => ({
        id: thread.id,
        asker_id: thread.asker_id,
        recipient_id: thread.recipient_id,
        status: thread.status,
        version: thread.version,
        subject: clipped(thread.subject, 160),
        detail: { operation: "thread", threadId: thread.id },
      }),
    );
    const previews = page(
      workspace.previews,
      digest([caller.companyId, caller.id, "previews"]),
      input.previewCursor,
      filter.limit,
      budget,
      (preview): PreviewSummary => ({
        id: preview.id,
        owner_id: preview.owner_id,
        version: preview.version,
        branch: clipped(preview.branch, 160),
        issue_count: preview.issue_ids.length,
        detail: { operation: "getPreview", batchId: preview.id },
      }),
    );
    return {
      ...result,
      issues: issues.items,
      nextCursor: issues.nextCursor,
      threads: threads.items,
      nextThreadCursor: threads.nextCursor,
      previews: previews.items,
      nextPreviewCursor: previews.nextCursor,
    };
  }
}
