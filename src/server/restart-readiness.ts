import type {
  CallerContext,
  InFlightDelivery,
  OrgMemberStatus,
} from "../domain";
import type { RuntimeWorkState } from "../runtime";
import { redactPublicMessage } from "../runtime/redaction";
import type { WorkNotice } from "./agent-work-notices";

export type RestartBusyReason =
  | "active_turn"
  | "prompt_in_flight"
  | "prompt_admission"
  | "agent_operation"
  | "queued_input"
  | "awaiting_input"
  | "running_task"
  | "im_delivery"
  | "work_notice";

export interface RestartBusyAgent {
  companyId: string;
  companyName: string;
  agentId: string;
  name: string;
  status: string;
  reasons: RestartBusyReason[];
  sessionId: string | null;
  turnId: string | null;
  threadId: string | null;
  archived: boolean;
}

export interface RestartReadinessCounts {
  companies: number;
  activeAgents: number;
  archivedAgents: number;
  busyAgents: number;
  idleAgents: number;
  offlineAgents: number;
}

export interface RestartReadinessErrorDetail {
  companyId?: string;
  agentId?: string;
  code: string;
  message: string;
}

export interface RestartReadinessResult {
  safeToRestart: boolean;
  verified: boolean;
  checkedAt: string;
  serverVersion: string;
  busy: RestartBusyAgent[];
  counts: RestartReadinessCounts;
  errors: RestartReadinessErrorDetail[];
}

export interface RestartReadinessService {
  check(input?: { companyId?: string }): Promise<RestartReadinessResult>;
}

/** HTTP 404 for an explicitly requested Company that does not exist. */
export class RestartReadinessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 404,
  ) {
    super(message);
    this.name = "RestartReadinessError";
  }
}

interface CompanyView {
  id: string;
  name: string;
  initialization_status?: string;
}
interface RosterAgentView {
  agentId: string;
  name: string;
  status: OrgMemberStatus;
  sessionId?: string | null;
}
interface OrganizationView {
  company?: { name?: string } | null;
  agents: RosterAgentView[];
}
export interface RestartReadinessDomain {
  listCompanies(): Promise<CompanyView[]>;
  organization(ctx: CallerContext): Promise<OrganizationView>;
  inFlightDeliveries(companyId: string): InFlightDelivery[];
}
export interface RestartReadinessRuntime {
  workState(input: {
    companyId: string;
    agentId: string;
    sessionId?: string;
  }): RuntimeWorkState;
  activeScopes(): Array<{ companyId: string; agentId: string }>;
}
export interface RestartReadinessNotices {
  inFlight(companyId: string): WorkNotice[];
}

export interface RestartReadinessOptions {
  domain: RestartReadinessDomain;
  runtime: RestartReadinessRuntime;
  notices: RestartReadinessNotices;
  version: string;
  now?: () => Date;
  timeoutMs?: number;
  redact?: (message: string) => string;
}

interface Accumulator {
  companyId: string;
  companyName: string;
  agentId: string;
  name: string;
  rosterStatus?: OrgMemberStatus;
  sessionId: string | null;
  work: RuntimeWorkState | null;
  threadId: string | null;
  reasons: Set<RestartBusyReason>;
}

const REASON_ORDER: RestartBusyReason[] = [
  "active_turn",
  "prompt_in_flight",
  "prompt_admission",
  "agent_operation",
  "queued_input",
  "awaiting_input",
  "running_task",
  "im_delivery",
  "work_notice",
];
const ACTIVE_TURN_STATUSES = ["accepting", "running", "cancelling"];
const RUNNING_TASK_STATUSES = ["running", "in_progress"];

function scopeKey(companyId: string, agentId: string) {
  return `${companyId}/${agentId}`;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isInitializationIncomplete(error: unknown): boolean {
  return (
    typeof (error as { code?: unknown } | null)?.code === "string" &&
    (error as { code: string }).code === "initialization_incomplete"
  );
}
function emptyCounts(): RestartReadinessCounts {
  return {
    companies: 0,
    activeAgents: 0,
    archivedAgents: 0,
    busyAgents: 0,
    idleAgents: 0,
    offlineAgents: 0,
  };
}

/**
 * Owner-only restart gate. It aggregates process-local execution facts only;
 * any unreadable source fails closed. It never wakes an Agent, writes files, or
 * reads chat/task content.
 */
export class RestartReadiness implements RestartReadinessService {
  private readonly timeoutMs: number;
  private readonly redact: (message: string) => string;
  constructor(private readonly options: RestartReadinessOptions) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.redact = options.redact ?? redactPublicMessage;
  }

  async check(
    input: { companyId?: string } = {},
  ): Promise<RestartReadinessResult> {
    const checkedAt = (this.options.now?.() ?? new Date()).toISOString();
    const work = this.collect(input, checkedAt).catch((error) => {
      if (error instanceof RestartReadinessError) throw error;
      return {
        safeToRestart: false,
        verified: false,
        checkedAt,
        serverVersion: this.options.version,
        busy: [],
        counts: emptyCounts(),
        errors: [
          {
            code: "readiness_failed",
            message: this.redact(messageOf(error)),
          },
        ],
      } satisfies RestartReadinessResult;
    });
    // The timeout path returns without waiting for slow sources; never leave an
    // unhandled rejection behind.
    work.catch(() => {});
    return this.withTimeout(work, checkedAt);
  }

  private async withTimeout(
    work: Promise<RestartReadinessResult>,
    checkedAt: string,
  ): Promise<RestartReadinessResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RestartReadinessResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            safeToRestart: false,
            verified: false,
            checkedAt,
            serverVersion: this.options.version,
            busy: [],
            counts: emptyCounts(),
            errors: [
              {
                code: "readiness_timeout",
                message: "重启检查超时，无法确认所有人员状态",
              },
            ],
          }),
        Math.max(0, this.timeoutMs),
      );
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async collect(
    input: { companyId?: string },
    checkedAt: string,
  ): Promise<RestartReadinessResult> {
    const errors: RestartReadinessErrorDetail[] = [];
    const record = (
      code: string,
      error: unknown,
      scope: { companyId?: string; agentId?: string } = {},
    ) => {
      errors.push({
        ...scope,
        code,
        message: this.redact(messageOf(error)),
      });
    };

    let companies: CompanyView[];
    try {
      companies = await this.options.domain.listCompanies();
    } catch (error) {
      record("companies_unavailable", error);
      return {
        safeToRestart: false,
        verified: false,
        checkedAt,
        serverVersion: this.options.version,
        busy: [],
        counts: emptyCounts(),
        errors,
      };
    }

    let scoped = companies;
    if (input.companyId) {
      scoped = companies.filter((company) => company.id === input.companyId);
      if (scoped.length === 0)
        throw new RestartReadinessError(
          "company_not_found",
          "Company not found",
          404,
        );
    }
    const companyById = new Map(scoped.map((company) => [company.id, company]));
    const companyNames = new Map<string, string>();
    const accumulators = new Map<string, Accumulator>();
    const accumulator = (
      companyId: string,
      agentId: string,
      companyName: string,
    ) => {
      const key = scopeKey(companyId, agentId);
      let current = accumulators.get(key);
      if (!current) {
        current = {
          companyId,
          companyName,
          agentId,
          name: agentId,
          sessionId: null,
          work: null,
          threadId: null,
          reasons: new Set(),
        };
        accumulators.set(key, current);
      }
      return current;
    };

    let activeAgents = 0;
    let archivedAgents = 0;

    for (const company of scoped) {
      const ctx: CallerContext = {
        type: "user",
        id: "owner",
        companyId: company.id,
      };
      let organization: OrganizationView | null = null;
      // A failed/partial initialization has no trustworthy roster. Its runtime
      // scopes are still checked below, so a live Provision cannot be missed.
      if ((company.initialization_status ?? "complete") === "complete") {
        try {
          organization = await this.options.domain.organization(ctx);
        } catch (error) {
          if (!isInitializationIncomplete(error))
            record("organization_unavailable", error, {
              companyId: company.id,
            });
        }
      }
      const companyName = organization?.company?.name ?? company.name;
      companyNames.set(company.id, companyName);
      for (const agent of organization?.agents ?? []) {
        const current = accumulator(company.id, agent.agentId, companyName);
        current.name = agent.name || agent.agentId;
        current.rosterStatus = agent.status;
        if (agent.sessionId) current.sessionId = agent.sessionId;
        if (agent.status === "archived") archivedAgents++;
        else activeAgents++;
      }
    }

    let scopes: Array<{ companyId: string; agentId: string }> = [];
    try {
      scopes = this.options.runtime.activeScopes();
    } catch (error) {
      record("runtime_scopes_unavailable", error);
    }
    for (const scope of scopes) {
      const company = companyById.get(scope.companyId);
      if (!company) continue;
      accumulator(scope.companyId, scope.agentId, company.name);
    }

    for (const current of accumulators.values()) {
      try {
        current.work = this.options.runtime.workState({
          companyId: current.companyId,
          agentId: current.agentId,
          sessionId: current.sessionId ?? undefined,
        });
        if (current.work.sessionId) current.sessionId = current.work.sessionId;
        this.applyWorkReasons(current);
      } catch (error) {
        record("work_state_unavailable", error, {
          companyId: current.companyId,
          agentId: current.agentId,
        });
      }
    }

    for (const company of scoped) {
      const companyName = companyNames.get(company.id) ?? company.name;
      let deliveries: InFlightDelivery[] = [];
      try {
        deliveries = this.options.domain.inFlightDeliveries(company.id);
      } catch (error) {
        record("in_flight_deliveries_unavailable", error, {
          companyId: company.id,
        });
      }
      for (const delivery of deliveries) {
        if (delivery.companyId !== company.id) continue;
        const current = accumulator(
          company.id,
          delivery.recipientId,
          companyName,
        );
        current.reasons.add("im_delivery");
        current.threadId = delivery.threadId;
      }
      let notices: WorkNotice[] = [];
      try {
        notices = this.options.notices.inFlight(company.id);
      } catch (error) {
        record("work_notices_unavailable", error, {
          companyId: company.id,
        });
      }
      for (const notice of notices) {
        const current = accumulator(company.id, notice.agentId, companyName);
        current.reasons.add("work_notice");
      }
    }

    let offlineAgents = 0;
    for (const current of accumulators.values())
      if (
        current.rosterStatus === "active" &&
        current.work?.bound === false
      )
        offlineAgents++;

    const busy = [...accumulators.values()]
      .filter((current) => current.reasons.size > 0)
      .map((current) => this.busyEntry(current))
      .sort(
        (a, b) =>
          a.companyId.localeCompare(b.companyId) ||
          a.agentId.localeCompare(b.agentId),
      );
    const busyActiveAgents = [...accumulators.values()].filter(
      (current) =>
        current.rosterStatus === "active" && current.reasons.size > 0,
    ).length;
    const verified = errors.length === 0;
    return {
      safeToRestart: verified && busy.length === 0,
      verified,
      checkedAt,
      serverVersion: this.options.version,
      busy,
      counts: {
        companies: scoped.length,
        activeAgents,
        archivedAgents,
        busyAgents: busy.length,
        idleAgents: Math.max(0, activeAgents - busyActiveAgents),
        offlineAgents,
      },
      errors,
    };
  }

  private applyWorkReasons(current: Accumulator) {
    const work = current.work;
    if (!work) return;
    if (
      ACTIVE_TURN_STATUSES.includes(work.status) ||
      work.running ||
      (work.activeTurn &&
        ACTIVE_TURN_STATUSES.includes(work.activeTurn.status))
    )
      current.reasons.add("active_turn");
    if (work.promptInFlight > 0) current.reasons.add("prompt_in_flight");
    if (work.pendingAdmissions > 0) current.reasons.add("prompt_admission");
    if (work.operation) current.reasons.add("agent_operation");
    if (work.queueCount > 0) current.reasons.add("queued_input");
    if (work.interactions.some((interaction) => interaction.status === "pending"))
      current.reasons.add("awaiting_input");
    if (
      work.tasks.some((task) => RUNNING_TASK_STATUSES.includes(task.status))
    )
      current.reasons.add("running_task");
  }

  private busyEntry(current: Accumulator): RestartBusyAgent {
    const reasons = [...current.reasons].sort(
      (a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b),
    );
    return {
      companyId: current.companyId,
      companyName: current.companyName,
      agentId: current.agentId,
      name: current.name,
      status: this.busyStatus(current, reasons),
      reasons,
      sessionId: current.work?.sessionId ?? current.sessionId,
      turnId: current.work?.activeTurn?.turnId ?? null,
      threadId: current.threadId,
      archived: current.rosterStatus === "archived",
    };
  }

  private busyStatus(
    current: Accumulator,
    reasons: RestartBusyReason[],
  ): string {
    const work = current.work;
    if (work && ACTIVE_TURN_STATUSES.includes(work.status)) return work.status;
    if (work?.activeTurn && ACTIVE_TURN_STATUSES.includes(work.activeTurn.status))
      return work.activeTurn.status;
    if (work?.running) return "running";
    if (reasons.includes("awaiting_input")) return "awaiting_input";
    if (reasons.every((reason) => reason === "agent_operation"))
      return "binding";
    if (
      reasons.every(
        (reason) => reason === "im_delivery" || reason === "work_notice",
      )
    )
      return "delivering";
    if (reasons.every((reason) => reason === "queued_input")) return "queued";
    if (reasons.every((reason) => reason === "running_task"))
      return "task_running";
    return "busy";
  }
}
