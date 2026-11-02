import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { CompanyDomain, CallerContext, Issue } from "../domain";
import { requireValue } from "../domain/types";
import { digest, safeId } from "../storage/company-store";
import { redactRuntimeMessage } from "../runtime";
import type { AgentService } from "./agent-service";

type Operation = "createIssue" | "assignIssue" | "answerDecision";
type NoticeStatus = "saved" | "accepted" | "failed" | "unknown" | "skipped";
export interface WorkNotice {
  id: string;
  kind: Operation;
  issueId: string;
  issueVersion: number;
  agentId: string;
  questionId?: string;
  status: NoticeStatus;
  at: string;
  inputId?: string;
  error?: string;
}
/**
 * Fact notification, not a workflow engine. This service never selects a plan,
 * starts a pipeline stage, changes ownership or marks work completed.
 * Accepted means input admission only. Unknown admission is not auto-retried.
 */
export class AgentWorkNotices {
  private readonly active = new Map<
    string,
    { promise: Promise<void>; companyId: string; notice: WorkNotice }
  >();
  constructor(
    private readonly domain: CompanyDomain,
    private readonly agents: Pick<AgentService, "send">,
    private readonly changed: (event: Record<string, unknown>) => void,
  ) {}

  /** Notices this process is currently delivering for a Company; read-only. */
  inFlight(companyId: string): WorkNotice[] {
    return [...this.active.values()]
      .filter((entry) => entry.companyId === companyId)
      .map((entry) => ({ ...entry.notice }));
  }

  /** Owner inspection does not activate an Agent or change any work. */
  async list(caller: CallerContext, agentId: string): Promise<WorkNotice[]> {
    requireValue(
      caller.type === "user",
      "forbidden",
      "Owner access required",
      403,
    );
    await this.domain.getAgent(caller, { agentId });
    const directory = join(
      this.domain.store.company(caller.companyId),
      "events",
      "deliveries",
    );
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const recent: WorkNotice[] = [];
    for (const file of files) {
      if (!/^notice-[a-f0-9]{64}\.yaml$/.test(file)) continue;
      const notice = await this.domain.store.yaml<WorkNotice>(
        join(directory, file),
      );
      if (notice.agentId !== agentId) continue;
      recent.push(notice);
      recent.sort(
        (a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id),
      );
      if (recent.length > 20) recent.pop();
    }
    return recent;
  }

  async get(
    caller: CallerContext,
    agentId: string,
    id: string,
  ): Promise<WorkNotice> {
    requireValue(
      caller.type === "user",
      "forbidden",
      "Owner access required",
      403,
    );
    await this.domain.getAgent(caller, { agentId });
    const notice = await this.domain.store.yaml<WorkNotice>(
      this.path(caller.companyId, id),
    );
    requireValue(
      notice.agentId === agentId,
      "not_found",
      "Notification not found for this Agent",
      404,
    );
    return notice;
  }

  async afterOperation(
    caller: CallerContext,
    operation: string,
    input: Record<string, unknown>,
    result: unknown,
  ): Promise<WorkNotice | undefined> {
    if (!["createIssue", "assignIssue", "answerDecision"].includes(operation))
      return;
    const issue = result as Issue;
    if (!issue?.id || !issue.agent_id) return;
    if (
      operation === "answerDecision" &&
      !issue.decisions.some(
        (q) =>
          q.id === input.questionId &&
          q.status === "pending" &&
          q.answer !== null,
      )
    )
      return;
    // An Agent already sees the result of its own action. Do not echo it back
    // as a fresh user input and create a self-notification loop.
    if (caller.type === "agent" && caller.id === issue.agent_id) return;
    const id =
      "notice-" +
      digest([
        caller.companyId,
        caller.type,
        caller.id,
        operation,
        safeId(input.requestId),
      ]);
    const notice: WorkNotice = {
      id,
      kind: operation as Operation,
      issueId: issue.id,
      issueVersion: issue.version,
      agentId: issue.agent_id,
      status: "saved",
      at: new Date().toISOString(),
      ...(operation === "answerDecision"
        ? { questionId: String(input.questionId) }
        : {}),
    };
    try {
      return await this.enqueue(caller.companyId, notice);
    } catch (error) {
      // The domain mutation already committed. Preserve its success and expose
      // a receipt lookup failure without claiming an earlier attempt was unsent.
      return { ...notice, status: "unknown", error: this.error(error) };
    }
  }

  async retry(caller: CallerContext, agentId: string, id: string) {
    requireValue(
      caller.type === "user",
      "forbidden",
      "Only the user may retry a fact notification",
      403,
    );
    await this.domain.getAgent(caller, { agentId });
    const notice = await this.domain.store.yaml<WorkNotice>(
      this.path(caller.companyId, id),
    );
    requireValue(
      notice.agentId === agentId,
      "forbidden",
      "Notification belongs to another Agent",
      403,
    );
    return this.enqueue(caller.companyId, notice, true);
  }

  private async enqueue(companyId: string, notice: WorkNotice, retry = false) {
    const { id } = notice;
    const path = this.path(companyId, id);
    return this.domain.store.locked("company:" + companyId, async () => {
      if (await this.domain.store.exists(path)) {
        const previous = await this.domain.store.yaml<WorkNotice>(path);
        requireValue(
          !retry || ["failed", "saved", "accepted"].includes(previous.status),
          "notice_not_retryable",
          "Only confirmed non-admission may be retried; inspect unknown admission first",
          409,
        );
        if (previous.status !== "failed") {
          // A prior process may have stopped after admission. Do not guess
          // and redeliver a saved record without its live admission promise.
          if (previous.status === "saved" && !this.active.has(id))
            return this.save(companyId, {
              ...previous,
              status: "unknown",
              error:
                "Previous notification admission is unconfirmed; inspect the fixed Session and queue.",
            });
          return previous;
        }
        notice = {
          ...previous,
          status: "saved",
          error: undefined,
          inputId: undefined,
        };
      } else {
        requireValue(!retry, "not_found", "Notification not found", 404);
      }
      try {
        await this.save(companyId, notice);
      } catch (error) {
        // No admission promise exists yet. Persist that known fact while still
        // holding the Company lock, even when Git or resource publication failed.
        const failed: WorkNotice = {
          ...notice,
          status: "failed",
          error: this.error(error),
        };
        try {
          await this.write(companyId, failed);
        } catch (persistenceError) {
          failed.error +=
            "; Notification was not sent, but its failure status could not be persisted: " +
            this.error(persistenceError);
        }
        try {
          this.publish(companyId, failed);
        } catch {
          // The returned failure and durable marker remain usable without SSE.
        }
        return failed;
      }
      // Register before releasing the lock so concurrent HTTP/MCP replays
      // cannot mistake a live delivery for an interrupted process.
      const work = Promise.resolve().then(() =>
        this.deliver(companyId, notice),
      );
      this.active.set(id, { promise: work, companyId, notice });
      void work
        .finally(() => {
          if (this.active.get(id)?.promise === work) this.active.delete(id);
        })
        .catch(() => {});
      return notice;
    });
  }

  private path(companyId: string, id: string) {
    return join(
      this.domain.store.company(companyId),
      "events",
      "deliveries",
      safeId(id) + ".yaml",
    );
  }
  private write(companyId: string, notice: WorkNotice) {
    return this.domain.store.putYaml(this.path(companyId, notice.id), {
      ...notice,
      error: notice.error ?? null,
      inputId: notice.inputId ?? null,
    });
  }
  private async save(companyId: string, notice: WorkNotice) {
    await this.write(companyId, notice);
    await this.domain.store.commit(
      this.domain.store.company(companyId),
      "Record Agent fact notification",
    );
    this.publish(companyId, notice);
    return notice;
  }
  private publish(companyId: string, notice: WorkNotice) {
    this.changed({
      companyId,
      agentId: notice.agentId,
      kind: "workNotice",
      id: notice.id,
      status: notice.status,
      inputId: notice.inputId ?? null,
      error: notice.error ?? null,
    });
  }
  private error(error: unknown) {
    return redactRuntimeMessage(
      error instanceof Error ? error.message : String(error),
    );
  }
  private async deliver(companyId: string, notice: WorkNotice) {
    let outcome: WorkNotice;
    let sendInvoked = false;
    try {
      const caller: CallerContext = {
        type: "user",
        id: "company-notice-host",
        companyId,
      };
      const current = await this.domain.getIssue(caller, {
        issueId: notice.issueId,
      });
      const questionPending =
        !notice.questionId ||
        current.decisions.some(
          (q) =>
            q.id === notice.questionId &&
            q.status === "pending" &&
            q.answer !== null,
        );
      if (
        current.status === "cancel" ||
        current.agent_id !== notice.agentId ||
        !questionPending
      ) {
        outcome = { ...notice, status: "skipped" };
      } else {
        const text = [
          "[Company fact notification]",
          JSON.stringify({
            noticeId: notice.id,
            reason: notice.kind,
            issueId: notice.issueId,
            observedVersion: notice.issueVersion,
            expectedOwner: notice.agentId,
            ...(notice.questionId ? { questionId: notice.questionId } : {}),
          }),
          "Read the current CLAUDE.md and getIssue(issueId). This is a fact-change notice, not an instruction to advance a workflow stage. Decide your own next action using current ownership, status and evidence. A repeated noticeId is the same notice.",
        ].join("\n");
        sendInvoked = true;
        const receipt = await this.agents.send(caller, notice.agentId, {
          text,
          issueId: notice.issueId,
          requestId: notice.id,
        });
        outcome = { ...notice, status: "accepted", inputId: receipt.inputId };
      }
    } catch (error) {
      const e = error as { code?: string; details?: { disposition?: string } };
      const disposition = e.details?.disposition;
      const notSent =
        !sendInvoked ||
        ["rejected", "not_sent"].includes(disposition ?? "") ||
        [
          "model_not_configured",
          "missing_session",
          "not_ready",
          "session_busy",
          "session_closing",
          "stale_session",
          "invalid_prompt",
          "prompt_superseded",
          "prompt_not_admitted",
          "wasm_store_not_configured",
          "wasm_store_unavailable",
          "wasm_session_cwd_mismatch",
          "peri_not_installed",
        ].includes(e.code ?? "");
      // `failed` is explicitly retryable through the owner-only notice retry
      // endpoint. session_busy is a definite non-admission: persist it as failed
      // rather than losing the notice; never auto-resend it here.
      outcome = {
        ...notice,
        status: notSent ? "failed" : "unknown",
        error: this.error(error),
      };
    }
    try {
      await this.domain.store.locked("company:" + companyId, () =>
        this.save(companyId, outcome),
      );
    } catch (error) {
      // Admission may already have happened. A saved record becomes unknown on
      // replay; no blind retry is triggered by a later Git or disk failure.
      this.changed({
        companyId,
        agentId: notice.agentId,
        kind: "workNotice",
        id: notice.id,
        status: "unknown",
        inputId: outcome.inputId ?? null,
        error: this.error(error),
      });
    }
  }
  async close() {
    await Promise.allSettled(
      [...this.active.values()].map((entry) => entry.promise),
    );
  }
}
