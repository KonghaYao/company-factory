import { mkdir, realpath, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CompanyStore, safeId, digest } from "../storage/company-store";
import { z } from "zod";
import { applyAgentMemory, prepareAgentMemory } from "./agent-memory";
import {
  AVATAR_COLORS,
  fallbackAvatarColor,
  fillMissingMemberColors,
  isAvatarColor,
  memberColorsChanged,
  nextAvatarColor,
  readMemberColors,
  resolveMemberColors,
  type AvatarColor,
} from "./avatar";
import { completeMutation } from "./mutation-completion";
import {
  applyTodoChanges,
  applyTodoOrder,
  cleanTodoNote,
  nextTodoSeq,
  normalizeIssueProgress,
  type TodoActor,
} from "./task-progress";
import {
  MEMORY_FILE,
  assertNoManagedMarkers,
  memoryTemplate,
  softwarePipeline,
} from "./templates";
import {
  MAX_ORG_DEPTH,
  childNodes,
  findNode,
  isOrgNodeKind,
  legacyOrganization,
  nextNodeOrder,
  nextPlacementOrder,
  nodeDepth,
  nodePath,
  normalizeOrganization,
  normalizeRoster,
  placementFor,
  rosterV2,
  runtimeScopeId,
  subtreeHeight,
  subtreeIds,
  toGroups,
} from "./org";
import {
  DomainError,
  requireValue,
  now,
  type CallerContext,
  type DomainOptions,
  type AgentRecord,
  type Company,
  type Group,
  type Issue,
  type Comment,
  type Preview,
  type Thread,
  type Message,
  type InFlightDelivery,
  type AgentConfig,
  type IssueStatus,
  type MoveMemberIntegrity,
  type OrgMemberStatus,
  type OrgMemberView,
  type OrgNode,
  type OrgNodeKind,
  type OrgPlacement,
  type Organization,
  type PendingDecisionView,
  type Roster,
  type TodoItem,
} from "./types";
export * from "./types";
export * from "./avatar";
export { CompanyStore } from "../storage/company-store";

type Input = Record<string, any>;
type InternalAgent = AgentRecord & { authToken: string };
const statuses: IssueStatus[] = [
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
const RETIRED_MODEL_CONFIG_KEYS = [
  "model",
  "models",
  "provider",
  "baseUrl",
  "apiKeyEnv",
] as const;
const configSchema = z
  .object({
    modelProfile: z
      .string()
      .max(96)
      .regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9_-]{0,95})?$/)
      .optional(),
    modelAlias: z.enum(["fable", "opus", "sonnet", "haiku"]).optional(),
    responsibilities: z.string().max(100000).optional(),
    instructions: z.string().max(100000).optional(),
    workspaceRoots: z.array(z.string().max(2000)).max(20).optional(),
    mcp: z.record(z.string(), z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of RETIRED_MODEL_CONFIG_KEYS)
      if (Object.hasOwn(value, key))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `config.${key} is retired; use config.modelProfile with the model library instead`,
        });
  });
function validatedConfig(input: unknown): AgentConfig {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    const retired = result.error.issues.some(
      (issue) =>
        issue.code === "custom" &&
        issue.path.length === 1 &&
        (RETIRED_MODEL_CONFIG_KEYS as readonly string[]).includes(
          String(issue.path[0]),
        ),
    );
    throw new DomainError(
      "invalid_input",
      retired
        ? "Agent configuration no longer accepts model/models/provider/baseUrl/apiKeyEnv; use config.modelProfile with the model library instead"
        : "Invalid Agent configuration",
      400,
      result.error.issues,
    );
  }
  const reserved = [
    "company_org",
    "company_tasks",
    "company_im",
    "agent_system",
    "company_files",
    "company_knowledge",
    "workspace",
  ];
  if (
    result.data.mcp &&
    Object.keys(result.data.mcp).some((k) => reserved.includes(k))
  )
    throw new DomainError(
      "forbidden",
      "Built-in Company identities and default Workspace cannot be replaced",
      403,
    );
  return result.data;
}
const cleanText = (v: unknown, label: string, max = 100000) => {
  requireValue(
    typeof v === "string" && v.trim().length > 0 && v.length <= max,
    "invalid_input",
    `${label} must be nonempty text (at most ${max} characters)`,
  );
  return v;
};
const clipText = (v: unknown, max: number) => String(v ?? "").slice(0, max);
const cleanDecisionOptions = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  requireValue(
    Array.isArray(value) && value.length >= 2 && value.length <= 6,
    "invalid_input",
    "options must contain 2–6 choices",
  );
  const options = value.map((item) => {
    requireValue(
      typeof item === "string",
      "invalid_input",
      "options must be strings",
    );
    const text = item.trim();
    requireValue(
      text.length > 0 && text.length <= 200 && !/[\r\n]/.test(item),
      "invalid_input",
      "each option must be one nonempty line of at most 200 characters",
    );
    return text;
  });
  requireValue(
    new Set(options).size === options.length,
    "invalid_input",
    "options must be unique",
  );
  return options;
};
const promptText = (v: unknown) => {
  requireValue(
    typeof v === "string" && v.length <= 100000,
    "invalid_input",
    "systemPrompt must be text (at most 100000 characters)",
  );
  return v;
};
const publicAgent = (a: InternalAgent): AgentRecord => {
  // Legacy `groupId` on disk is not a fact source and never leaves the domain.
  const { authToken, groupId: _legacyGroupId, ...rest } = a as InternalAgent & {
    groupId?: unknown;
  };
  return rest;
};
/**
 * File-backed application boundary. Public contexts MUST be constructed by a trusted
 * HTTP/MCP adapter. Mutations serialize per company; versions are checked before
 * changing selected fields; all unrelated YAML/Markdown content remains intact.
 * No method claims work is complete merely because a runtime accepted delivery.
 */
export class CompanyDomain {
  readonly store: CompanyStore;
  private readonly pendingDeliveries = new Map<string, InFlightDelivery>();
  constructor(readonly options: DomainOptions) {
    this.store = new CompanyStore(options.root);
  }
  private path(ctx: CallerContext, ...parts: string[]) {
    return join(this.store.company(ctx.companyId), ...parts);
  }
  private issuePath(ctx: CallerContext, id: string) {
    return this.path(ctx, "tasks", `${safeId(id, "issueId")}.md`);
  }
  private previewPath(ctx: CallerContext, id: string) {
    return this.path(ctx, "previews", `${safeId(id, "batchId")}.md`);
  }
  private async company(ctx: CallerContext) {
    return this.store.yaml<Company>(this.path(ctx, "company.yaml"));
  }
  private memberColorState(
    company: Company,
    members: readonly { agentId: string }[],
  ) {
    const stored = readMemberColors(company.memberColors);
    const effective = resolveMemberColors(
      members.map((member) => ({
        agentId: member.agentId,
        color: stored[member.agentId],
      })),
      Object.values(stored),
    );
    return { stored, effective };
  }
  private async putMemberColors(
    ctx: CallerContext,
    company: Company,
    stored: Record<string, unknown>,
    next: Record<string, unknown>,
  ) {
    if (!memberColorsChanged(stored, next)) return false;
    const previousVersion = Number.isInteger(company.version)
      ? company.version
      : 0;
    company.memberColors = next as Record<string, AvatarColor>;
    company.version = previousVersion + 1;
    await this.store.putYaml(
      this.path(ctx, "company.yaml"),
      company,
      previousVersion,
    );
    return true;
  }
  private async rosterDocument(
    ctx: CallerContext,
  ): Promise<{ roster: Roster; raw: string | null }> {
    const path = this.path(ctx, "roster.yaml");
    if (!(await this.store.exists(path)))
      return {
        roster: { schema: "company-people/v2", version: 0, members: [] },
        raw: null,
      };
    const raw = await this.store.raw(path);
    const company = await this.company(ctx);
    return { roster: normalizeRoster(await this.store.yaml(path), company.created_at), raw };
  }
  private async roster(ctx: CallerContext): Promise<Roster> {
    return (await this.rosterDocument(ctx)).roster;
  }
  /**
   * Prefer `organization.yaml`. Legacy companies are projected in memory from
   * `groups.yaml` + roster v1; reads never upgrade or write anything.
   */
  private async organizationState(ctx: CallerContext): Promise<{
    organization: Organization;
    legacy: boolean;
    raw: string | null;
    roster: Roster;
    rosterRaw: string | null;
  }> {
    const organizationPath = this.path(ctx, "organization.yaml");
    const roster = await this.rosterDocument(ctx);
    if (await this.store.exists(organizationPath)) {
      const raw = await this.store.raw(organizationPath);
      return {
        organization: normalizeOrganization(await this.store.yaml(organizationPath)),
        legacy: false,
        raw,
        roster: roster.roster,
        rosterRaw: roster.raw,
      };
    }
    const groupsPath = this.path(ctx, "groups.yaml");
    const groupDoc = (await this.store.exists(groupsPath))
      ? await this.store.yaml<{ groups: Group[] }>(groupsPath)
      : { groups: [] as Group[] };
    const company = await this.company(ctx);
    return {
      organization: legacyOrganization(
        groupDoc.groups ?? [],
        roster.roster,
        company.created_at,
      ),
      legacy: true,
      raw: null,
      roster: roster.roster,
      rosterRaw: roster.raw,
    };
  }
  private async putOrganization(
    ctx: CallerContext,
    organization: Organization,
    previousVersion: number | null,
  ) {
    await this.store.putYaml(
      this.path(ctx, "organization.yaml"),
      organization,
      previousVersion ?? 0,
    );
  }
  private async putRoster(
    ctx: CallerContext,
    roster: Roster,
    previousVersion: number | null,
    upgrade = false,
  ) {
    await this.store.putYaml(
      this.path(ctx, "roster.yaml"),
      upgrade ? rosterV2(roster) : roster,
      previousVersion ?? 0,
    );
  }
  private async memberStatus(
    companyId: string,
    agentId: string,
  ): Promise<OrgMemberStatus | null> {
    const path = join(this.store.company(companyId), "roster.yaml");
    if (!(await this.store.exists(path))) return null;
    const doc = await this.store.yaml<{
      members?: { agentId?: unknown; status?: unknown }[];
    }>(path);
    const member = doc.members?.find((item) => item.agentId === agentId);
    if (!member) return null;
    return member.status === "archived" ? "archived" : "active";
  }
  private requireNode(org: Organization, nodeId: string): OrgNode {
    const node = findNode(org, safeId(nodeId, "nodeId"));
    requireValue(node, "node_not_found", "Organization node does not exist", 404);
    return node;
  }
  private requireActiveNode(org: Organization, nodeId: string): OrgNode {
    const node = this.requireNode(org, nodeId);
    requireValue(
      node.status === "active",
      "node_archived",
      "Organization node is archived",
      409,
    );
    return node;
  }
  private requireActiveMember(roster: Roster, personId: string) {
    const member = roster.members.find((item) => item.agentId === personId);
    requireValue(
      member,
      "member_not_found",
      "Member does not exist in this Company",
      404,
    );
    requireValue(
      member.status === "active",
      "member_archived",
      "Member is archived",
      409,
    );
    return member;
  }
  private memberView(
    agent: InternalAgent,
    org: Organization,
    status: OrgMemberStatus,
    privateProjection: boolean,
    avatarColor: AvatarColor,
  ): OrgMemberView & Partial<AgentRecord> {
    const placement =
      status === "active" ? placementFor(org, agent.agentId) ?? null : null;
    const shared = {
      agentId: agent.agentId,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      responsibilities: agent.responsibilities,
      status,
      groupId: placement?.nodeId ?? null,
      orgPath: placement ? nodePath(org, placement.nodeId) : [],
      placement,
      avatarColor,
    };
    return privateProjection ? { ...publicAgent(agent), ...shared } : shared;
  }
  async getAgentInternal(agentId: string): Promise<InternalAgent> {
    const agent = await this.store.yaml<InternalAgent>(
      join(this.store.agent(agentId), "agent.yaml"),
    );
    // 兼容旧记录：没有独立提示词段时视为空，不因读取而改写文件。
    return {
      ...agent,
      systemPrompt:
        typeof agent.systemPrompt === "string" ? agent.systemPrompt : "",
    };
  }
  async authenticateAgent(token: string): Promise<CallerContext | null> {
    if (!token || token.length < 32) return null;
    for (const id of await this.store.ids(join(this.store.root, "agents"))) {
      const a = await this.getAgentInternal(id);
      if (
        timingSafeEqual(
          Buffer.from(digest(a.authToken)),
          Buffer.from(digest(token)),
        )
      ) {
        if ((await this.memberStatus(a.companyId, a.agentId)) === "archived")
          return null;
        return { type: "agent", id: a.agentId, companyId: a.companyId };
      }
    }
    return null;
  }
  private async access(ctx: CallerContext) {
    safeId(ctx.companyId, "companyId");
    await this.company(ctx);
    const initPath = this.path(ctx, "events", "initialization.yaml");
    requireValue(
      await this.store.exists(initPath),
      "initialization_incomplete",
      "Company initialization has not completed",
      409,
    );
    requireValue(
      (await this.store.yaml(initPath)).status === "complete",
      "initialization_incomplete",
      "Company initialization has not completed; retry the original createCompany request",
      409,
    );
    if (ctx.type === "agent") {
      const a = await this.getAgentInternal(ctx.id);
      requireValue(
        a.companyId === ctx.companyId,
        "forbidden",
        "Agent belongs to another Company",
        403,
      );
      requireValue(
        (await this.memberStatus(ctx.companyId, ctx.id)) !== "archived",
        "member_archived",
        "Agent is archived",
        403,
      );
      return a;
    }
    requireValue(
      ctx.type === "user" && !!ctx.id,
      "forbidden",
      "Untrusted caller",
      403,
    );
    return null;
  }
  private async role(ctx: CallerContext, roles: string[], allowUser = true) {
    const a = await this.access(ctx);
    requireValue(
      (!a && allowUser) || (!!a && roles.includes(a.role)),
      "forbidden",
      `Requires ${roles.join(" or ")} role`,
      403,
    );
    return a;
  }
  private async owner(ctx: CallerContext, issue: Issue, allowUser = true) {
    await this.access(ctx);
    requireValue(
      (ctx.type === "user" && allowUser) ||
        (ctx.type === "agent" && ctx.id === issue.agent_id),
      "not_current_owner",
      "Only the current responsible Agent may change this Issue",
      403,
    );
  }
  private async related(ctx: CallerContext, issue: Issue) {
    const a = await this.access(ctx);
    requireValue(
      !a ||
        a.agentId === issue.agent_id ||
        issue.collaborators.includes(a.agentId) ||
        (issue.created_by_type === "agent" &&
          issue.created_by_id === a.agentId) ||
        issue.history.some((h) => h.from === a.agentId || h.to === a.agentId),
      "forbidden",
      "Agent is not associated with this Issue",
      403,
    );
  }
  private version(record: { version: number }, input: Input) {
    const expected = input.version ?? input.expectedVersion;
    requireValue(
      Number.isInteger(expected),
      "invalid_input",
      "version is required",
    );
    requireValue(
      record.version === expected,
      "version_conflict",
      "Record has changed",
      409,
    );
  }
  private async mutate<T>(
    ctx: CallerContext,
    operation: string,
    input: Input,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.store.locked(`company:${ctx.companyId}`, async () => {
      await this.access(ctx);
      return completeMutation({
        store: this.store,
        caller: ctx,
        operation,
        input,
        run: fn,
        changed: () =>
          this.options.onChange?.({ companyId: ctx.companyId, kind: operation }),
      });
    });
  }
  private async writeIssue(ctx: CallerContext, issue: Issue) {
    const previous = issue.version;
    issue.version++;
    issue.updated_at = now();
    issue.needs_user = issue.decisions.some((q) => q.status === "pending");
    await this.store.putMarkdown(
      this.issuePath(ctx, issue.id),
      issue,
      previous,
    );
    return issue;
  }
  async listCompanies(): Promise<Company[]> {
    const result: Company[] = [];
    for (const id of await this.store.ids(join(this.store.root, "companys")))
      if (
        await this.store.exists(join(this.store.company(id), "company.yaml"))
      ) {
        const company = await this.store.yaml<Company>(
          join(this.store.company(id), "company.yaml"),
        );
        const initPath = join(
          this.store.company(id),
          "events",
          "initialization.yaml",
        );
        const initialization_status = (await this.store.exists(initPath))
          ? (await this.store.yaml(initPath)).status
          : "initializing";
        result.push({ ...company, initialization_status } as Company);
      }
    return result;
  }
  async createCompany(ctx: CallerContext, input: Input) {
    requireValue(
      ctx.type === "user" && !!ctx.id,
      "forbidden",
      "Only the user may create a Company",
      403,
    );
    const requestKey = safeId(
      input.requestId,
      "requestId (required for mutations)",
    );
    requireValue(
      !Object.hasOwn(input, "id"),
      "invalid_input",
      "公司 ID 由后端生成，请勿提交 id",
    );
    const id = safeId(
      `c-${digest({ callerType: ctx.type, callerId: ctx.id, requestId: requestKey }).slice(0, 32)}`,
      "companyId",
    );
    requireValue(
      id.length <= 85,
      "invalid_input",
      "Company ID must be at most 85 characters to reserve fixed Agent IDs",
    );
    const name = cleanText(input.name, "name", 200);
    const cctx = { ...ctx, companyId: id };
    const root = this.store.company(id);
    return this.store.locked("organization:create", async () => {
      const exists = await this.store.exists(join(root, "company.yaml"));
      const initPath = join(root, "events", "initialization.yaml");
      if (exists) {
        requireValue(
          await this.store.exists(initPath),
          "already_exists",
          "Company already exists",
          409,
        );
        const init = await this.store.yaml(initPath);
        requireValue(
          init.hash === digest(input),
          "idempotency_conflict",
          "同一创建请求不能用于不同的公司初始化内容",
          409,
        );
        if (init.status === "complete") return this.organization(cctx);
      } else {
        await mkdir(root, { recursive: true });
        for (const d of [
          "tasks",
          "comments",
          "pipelines",
          "previews",
          "knowledgebase",
          "im/threads",
          "im/messages",
          "events/requests",
        ])
          await mkdir(join(root, d), { recursive: true });
        const company: Company = {
          id,
          name,
          goal: String(input.goal ?? ""),
          roles: {
            hr: { permissions: [] },
            "task-supervisor": { permissions: ["issue.create"] },
            secretary: {
              permissions: ["issue.create", "issue.assign", "issue.search"],
            },
            developer: { permissions: [] },
            preview: { permissions: [] },
            reviewer: { permissions: [] },
          },
          created_at: now(),
          version: 1,
        };
        await this.store.putYaml(join(root, "company.yaml"), company);
        await this.store.putYaml(join(root, "organization.yaml"), {
          schema: "company-org/v1",
          version: 1,
          nodes: [
            {
              id: "headquarters",
              name: "总部",
              kind: "company",
              parentId: null,
              order: 0,
              responsibilities: "组织建设与任务协调",
              leadPersonId: null,
              status: "active",
              version: 1,
            },
          ],
          placements: [],
        } satisfies Organization);
        await this.store.putYaml(join(root, "roster.yaml"), {
          schema: "company-people/v2",
          version: 1,
          members: [],
        } satisfies Roster);
        await this.store.atomic(
          join(root, "pipelines", "software-delivery.md"),
          softwarePipeline,
        );
        await this.store.atomic(join(root, "knowledgebase", ".gitkeep"), "");
        await this.store.initGit(root);
      }
      await this.store.putYaml(initPath, {
        hash: digest(input),
        status: "initializing",
        updated_at: now(),
      });
      try {
        const definitions = [
          {
            agentId: `${id}-hr`,
            name: "HR",
            groupId: "headquarters",
            role: "hr",
            responsibilities: "讨论岗位职责、能力与交付要求，创建正式 Agent。",
            config: input.config ?? {},
          },
          {
            agentId: `${id}-supervisor`,
            name: "任务主管",
            groupId: "headquarters",
            role: "task-supervisor",
            responsibilities: "创建、分类、选择流程、指派 Issue，协调交接。",
            config: input.config ?? {},
          },
          {
            agentId: `${id}-secretary`,
            name: "秘书",
            groupId: "headquarters",
            role: "secretary",
            responsibilities:
              "用 interview 把用户需求转成 Issue 并派给组织领导；只跟进，不交付、不验收。",
            config: input.config ?? {},
          },
        ];
        for (const definition of definitions) {
          const roster = await this.roster(cctx);
          const member = roster.members.find((a) => a.agentId === definition.agentId);
          if (!member)
            await this.provision(cctx, definition, true);
          else {
            // A prior attempt may have saved the roster before Agent Git failed.
            // These fixed members are protected by the same initialization hash.
            const agent = await this.getAgentInternal(definition.agentId);
            this.matchInitializationAgent(cctx, definition, agent);
            requireValue(
              member.status === "active",
              "already_exists",
              "Existing roster member does not match this Company initialization",
              409,
            );
            const state = await this.organizationState(cctx);
            const placement = placementFor(state.organization, definition.agentId);
            requireValue(
              !placement || placement.nodeId === definition.groupId,
              "already_exists",
              "Existing organization placement does not match this Company initialization",
              409,
            );
            if (!placement) {
              const organization = state.organization;
              const previousVersion = organization.version;
              organization.placements.push({
                personId: definition.agentId,
                nodeId: definition.groupId,
                order: nextPlacementOrder(organization, definition.groupId),
                primary: true,
                reportsToPersonId: null,
                since: now(),
                movedAt: now(),
                movedBy: "initialization",
                previousNodeId: null,
                version: 1,
              });
              organization.version++;
              await this.putOrganization(
                cctx,
                organization,
                state.raw ? previousVersion : null,
              );
              if (state.legacy)
                await this.putRoster(
                  cctx,
                  roster,
                  state.rosterRaw ? roster.version : null,
                  true,
                );
            }
            await this.commitProvisionedAgent(agent);
          }
        }
        await this.store.putYaml(initPath, {
          hash: digest(input),
          status: "complete",
          updated_at: now(),
        });
        await this.store.commit(
          root,
          "Initialize Company, headquarters and permanent Agents",
        );
        this.options.onChange?.({ companyId: id, kind: "createCompany" });
        return this.organization(cctx);
      } catch (error) {
        await this.store.putYaml(initPath, {
          hash: digest(input),
          status: "failed",
          error: String(error instanceof Error ? error.message : error),
          updated_at: now(),
        });
        await this.store.commit(
          root,
          "Record incomplete initialization; retry identical createCompany input",
        );
        throw error;
      }
    });
  }
  async organization(ctx: CallerContext) {
    await this.access(ctx);
    const company = await this.company(ctx);
    const { organization, roster } = await this.organizationState(ctx);
    const { effective } = this.memberColorState(company, roster.members);
    const agents = await Promise.all(
      roster.members.map(async (member) => {
        const agent = await this.getAgentInternal(member.agentId);
        return this.memberView(
          agent,
          organization,
          member.status,
          ctx.type === "user",
          effective.get(member.agentId) ??
            fallbackAvatarColor(member.agentId),
        );
      }),
    );
    return {
      company,
      organization,
      groups: toGroups(organization.nodes),
      agents,
    };
  }
  private nodeKind(input: unknown, fallback: OrgNodeKind): OrgNodeKind {
    const value = input === undefined ? fallback : input;
    requireValue(
      isOrgNodeKind(value),
      "invalid_input",
      "kind must be company, division, department, team, squad or committee",
    );
    return value;
  }
  private nodeOrder(
    org: Organization,
    parentId: string | null,
    value: unknown,
    excludeId?: string,
  ): number {
    requireValue(
      Number.isInteger(value) && Number(value) >= 0,
      "invalid_input",
      "order must be a non-negative integer",
    );
    const order = Number(value);
    requireValue(
      !childNodes(org, parentId).some(
        (node) => node.id !== excludeId && node.order === order,
      ),
      "invalid_input",
      "Sibling organization order is already used",
    );
    return order;
  }
  private leadPerson(roster: Roster, value: unknown): string | null {
    if (value === null || value === "") return null;
    const personId = safeId(value, "leadPersonId");
    this.requireActiveMember(roster, personId);
    return personId;
  }
  /** Shared by createOrgNode and the createGroup compatibility alias. */
  private async createOrgNodeInMutation(
    ctx: CallerContext,
    input: Input,
    fallbackKind: OrgNodeKind,
  ): Promise<OrgNode> {
    const state = await this.organizationState(ctx);
    const organization = state.organization;
    const previousVersion = organization.version;
    const previousRosterVersion = state.roster.version;
    const id = safeId(input.id, "nodeId");
    requireValue(
      !findNode(organization, id),
      "already_exists",
      "Organization node exists",
      409,
    );
    const parentId =
      input.parentId === undefined || input.parentId === null || input.parentId === ""
        ? null
        : safeId(input.parentId, "parentId");
    if (parentId) {
      this.requireActiveNode(organization, parentId);
      requireValue(
        nodeDepth(organization, parentId) + 1 <= MAX_ORG_DEPTH,
        "invalid_input",
        `Organization depth cannot exceed ${MAX_ORG_DEPTH}`,
      );
    }
    const node: OrgNode = {
      id,
      name: cleanText(input.name, "name", 200),
      kind: this.nodeKind(input.kind, fallbackKind),
      parentId,
      order:
        input.order === undefined
          ? nextNodeOrder(organization, parentId)
          : this.nodeOrder(organization, parentId, input.order),
      responsibilities: String(input.responsibilities ?? ""),
      leadPersonId:
        input.leadPersonId === undefined
          ? null
          : this.leadPerson(state.roster, input.leadPersonId),
      status: "active",
      version: 1,
    };
    organization.nodes.push(node);
    organization.version++;
    await this.putOrganization(
      ctx,
      organization,
      state.raw ? previousVersion : null,
    );
    if (state.legacy)
      await this.putRoster(
        ctx,
        state.roster,
        state.rosterRaw ? previousRosterVersion : null,
        true,
      );
    return node;
  }
  async createGroup(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "createGroup", input, async () => {
      await this.role(ctx, ["hr"]);
      return this.createOrgNodeInMutation(ctx, input, "department");
    });
  }
  async createOrgNode(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "createOrgNode", input, async () => {
      await this.role(ctx, ["hr"]);
      return this.createOrgNodeInMutation(ctx, input, "department");
    });
  }
  async updateOrgNode(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "updateOrgNode", input, async () => {
      await this.role(ctx, ["hr"]);
      const state = await this.organizationState(ctx);
      const organization = state.organization;
      const previousVersion = organization.version;
      const previousRosterVersion = state.roster.version;
      this.version(organization, input);
      const node = this.requireNode(organization, safeId(input.id, "nodeId"));
      if (input.name !== undefined) node.name = cleanText(input.name, "name", 200);
      if (input.responsibilities !== undefined)
        node.responsibilities = String(input.responsibilities);
      if (input.kind !== undefined) node.kind = this.nodeKind(input.kind, node.kind);
      if (input.leadPersonId !== undefined)
        node.leadPersonId = this.leadPerson(state.roster, input.leadPersonId);
      const nextParentId =
        input.parentId === undefined
          ? node.parentId
          : input.parentId === null || input.parentId === ""
            ? null
            : safeId(input.parentId, "parentId");
      if (nextParentId !== node.parentId) {
        if (nextParentId) {
          this.requireActiveNode(organization, nextParentId);
          requireValue(
            !subtreeIds(organization, node.id).includes(nextParentId),
            "invalid_input",
            "Cannot move an organization node under its own subtree",
          );
          requireValue(
            nodeDepth(organization, nextParentId) + subtreeHeight(organization, node.id) <=
              MAX_ORG_DEPTH,
            "invalid_input",
            `Organization depth cannot exceed ${MAX_ORG_DEPTH}`,
          );
        }
        node.parentId = nextParentId;
        node.order =
          input.order === undefined
            ? nextNodeOrder(organization, nextParentId, node.id)
            : this.nodeOrder(organization, nextParentId, input.order, node.id);
      } else if (input.order !== undefined) {
        node.order = this.nodeOrder(
          organization,
          node.parentId,
          input.order,
          node.id,
        );
      }
      node.version++;
      organization.version++;
      await this.putOrganization(
        ctx,
        organization,
        state.raw ? previousVersion : null,
      );
      if (state.legacy)
        await this.putRoster(
          ctx,
          state.roster,
          state.rosterRaw ? previousRosterVersion : null,
          true,
        );
      return node;
    });
  }
  async archiveOrgNode(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "archiveOrgNode", input, async () => {
      await this.role(ctx, ["hr"]);
      const state = await this.organizationState(ctx);
      const organization = state.organization;
      const previousVersion = organization.version;
      const previousRosterVersion = state.roster.version;
      this.version(organization, input);
      const node = this.requireNode(organization, safeId(input.id, "nodeId"));
      if (node.status === "archived") return node;
      const subtree = subtreeIds(organization, node.id);
      const hasActiveChild = organization.nodes.some(
        (candidate) =>
          candidate.id !== node.id &&
          candidate.status === "active" &&
          subtree.includes(candidate.id),
      );
      const hasPlacement = organization.placements.some((placement) =>
        subtree.includes(placement.nodeId),
      );
      requireValue(
        !hasActiveChild && !hasPlacement,
        "org_node_not_empty",
        "Move members out and archive child nodes before archiving this organization node",
        409,
      );
      node.status = "archived";
      node.version++;
      organization.version++;
      await this.putOrganization(
        ctx,
        organization,
        state.raw ? previousVersion : null,
      );
      if (state.legacy)
        await this.putRoster(
          ctx,
          state.roster,
          state.rosterRaw ? previousRosterVersion : null,
          true,
        );
      return node;
    });
  }
  async deleteOrgNode(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "deleteOrgNode", input, async () => {
      await this.role(ctx, ["hr"]);
      const state = await this.organizationState(ctx);
      const organization = state.organization;
      const previousVersion = organization.version;
      const previousRosterVersion = state.roster.version;
      this.version(organization, input);
      const node = this.requireNode(organization, safeId(input.id, "nodeId"));
      const removedNodeIds = subtreeIds(organization, node.id);
      const affected = organization.placements.filter((placement) =>
        removedNodeIds.includes(placement.nodeId),
      );
      const reassignTo =
        input.reassignTo === undefined ||
        input.reassignTo === null ||
        input.reassignTo === ""
          ? null
          : safeId(input.reassignTo, "reassignTo");
      if (!reassignTo) {
        requireValue(
          removedNodeIds.length === 1 && affected.length === 0,
          "org_node_not_empty",
          "Organization node has child nodes or members; provide reassignTo",
          409,
        );
      } else {
        this.requireActiveNode(organization, reassignTo);
        requireValue(
          !removedNodeIds.includes(reassignTo),
          "invalid_input",
          "Cannot reassign members into the node being deleted",
        );
        let order = nextPlacementOrder(organization, reassignTo);
        for (const placement of affected) {
          placement.previousNodeId = placement.nodeId;
          placement.nodeId = reassignTo;
          placement.order = order++;
          placement.movedAt = now();
          placement.movedBy = ctx.id;
          placement.version++;
        }
      }
      organization.nodes = organization.nodes.filter(
        (item) => !removedNodeIds.includes(item.id),
      );
      organization.version++;
      await this.putOrganization(
        ctx,
        organization,
        state.raw ? previousVersion : null,
      );
      if (state.legacy)
        await this.putRoster(
          ctx,
          state.roster,
          state.rosterRaw ? previousRosterVersion : null,
          true,
        );
      return {
        id: node.id,
        removedNodeIds,
        movedPlacementCount: affected.length,
      };
    });
  }
  private async provision(
    ctx: CallerContext,
    input: Input,
    resumeInitialization = false,
  ) {
    return this.store.locked(`agent:${safeId(input.agentId, "agentId")}`, () =>
      this.provisionLocked(ctx, input, resumeInitialization),
    );
  }
  /** Only createCompany passes recovery permission after verifying its intent hash. */
  private matchInitializationAgent(
    ctx: CallerContext,
    input: Input,
    agent: InternalAgent,
  ) {
    requireValue(
      agent.agentId === input.agentId &&
        agent.companyId === ctx.companyId &&
        agent.directory === this.store.agent(input.agentId) &&
        agent.role === input.role &&
        agent.name === input.name &&
        agent.responsibilities === input.responsibilities &&
        agent.systemPrompt === (input.systemPrompt ?? "") &&
        digest(agent.config) === digest(input.config ?? {}) &&
        typeof agent.sessionId === "string" &&
        agent.sessionId.length > 0 &&
        typeof agent.authToken === "string" &&
        agent.authToken.length >= 32,
      "already_exists",
      "Existing Agent does not match this Company initialization",
      409,
    );
  }
  private async commitProvisionedAgent(agent: InternalAgent) {
    // Workspace runs locally and Agent Git is decoupled from the Workspace switch.
    await this.store.commit(
      agent.directory,
      `Provision ${agent.name} with fixed Session`,
    );
  }
  private async provisionLocked(
    ctx: CallerContext,
    input: Input,
    resumeInitialization = false,
  ) {
    const agentId = safeId(input.agentId, "agentId");
    const dir = this.store.agent(agentId);
    if (resumeInitialization && (await this.store.exists(join(dir, "agent.yaml")))) {
      const agent = await this.getAgentInternal(agentId);
      this.matchInitializationAgent(ctx, input, agent);
      // Reuse the confirmed identity and credential. The runtime validates the
      // fixed backend binding instead of creating another Session for recovery.
      const confirmed = await this.options.provisionAgent({
        ...agent,
        knowledgeDirectory: this.path(ctx, "knowledgebase"),
        baseUrl: this.options.baseUrl ?? "http://127.0.0.1:3000",
      });
      requireValue(
        confirmed.sessionId === agent.sessionId,
        "runtime_error",
        "Runtime did not confirm the original initialization Session",
        503,
      );
      const roster = await this.roster(ctx);
      const member = roster.members.find((m) => m.agentId === agentId);
      requireValue(
        !member || member.status === "active",
        "already_exists",
        "Existing roster member does not match this Company initialization",
        409,
      );
      const state = await this.organizationState(ctx);
      const nodeId =
        input.groupId === undefined || input.groupId === ""
          ? undefined
          : safeId(input.groupId, "groupId");
      const previousOrgVersion = state.organization.version;
      const previousRosterVersion = roster.version;
      let orgChanged = false;
      if (nodeId) {
        this.requireActiveNode(state.organization, nodeId);
        const placement = placementFor(state.organization, agentId);
        requireValue(
          !placement || placement.nodeId === nodeId,
          "already_exists",
          "Existing organization placement does not match this Company initialization",
          409,
        );
        if (!placement) {
          state.organization.placements.push({
            personId: agentId,
            nodeId,
            order: nextPlacementOrder(state.organization, nodeId),
            primary: true,
            reportsToPersonId: null,
            since: now(),
            movedAt: now(),
            movedBy: "initialization",
            previousNodeId: null,
            version: 1,
          });
          state.organization.version++;
          orgChanged = true;
        }
      }
      if (orgChanged || state.legacy)
        await this.putOrganization(
          ctx,
          state.organization,
          state.raw ? previousOrgVersion : null,
        );
      if (!member) {
        roster.members.push({ agentId, status: "active", joinedAt: now() });
        roster.version++;
        await this.putRoster(
          ctx,
          roster,
          state.rosterRaw ? previousRosterVersion : null,
          true,
        );
      } else if (state.legacy) {
        await this.putRoster(
          ctx,
          roster,
          state.rosterRaw ? previousRosterVersion : null,
          true,
        );
      }
      await this.commitProvisionedAgent(agent);
      return publicAgent(agent);
    }
    const groupId =
      input.groupId === undefined || input.groupId === ""
        ? undefined
        : safeId(input.groupId, "groupId");
    const role = safeId(input.role, "role");
    const state = await this.organizationState(ctx);
    if (groupId) this.requireActiveNode(state.organization, groupId);
    const previousOrgVersion = state.organization.version;
    const previousRosterVersion = state.roster.version;
    const company = await this.company(ctx);
    requireValue(
      Object.hasOwn(company.roles, role),
      "invalid_input",
      "Create role permissions before creating an Agent of that role",
    );
    const name = cleanText(input.name, "name", 200);
    const responsibilities = cleanText(
      input.responsibilities,
      "responsibilities",
    );
    const systemPrompt =
      input.systemPrompt === undefined ? "" : promptText(input.systemPrompt);
    assertNoManagedMarkers({
      name,
      responsibilities,
      systemPrompt,
      "config.instructions": input.config?.instructions,
    });
    const config: AgentConfig = validatedConfig(input.config ?? {});
    if (await this.store.exists(join(dir, "agent.yaml"))) {
      // A previous attempt may have written the person before the organization
      // index. Resume only when every requested person fact matches; otherwise
      // this is a genuine duplicate identity.
      const existing = await this.getAgentInternal(agentId);
      requireValue(
        existing.companyId === ctx.companyId &&
          existing.role === role &&
          existing.name === name &&
          existing.responsibilities === responsibilities &&
          existing.systemPrompt === systemPrompt &&
          digest(existing.config) === digest(config),
        "already_exists",
        "Existing Agent does not match this member request",
        409,
      );
      requireValue(
        !state.roster.members.some((member) => member.agentId === agentId),
        "already_exists",
        "Roster member already exists",
        409,
      );
      const placement = placementFor(state.organization, agentId);
      requireValue(
        !placement || placement.nodeId === groupId,
        "already_exists",
        "Existing organization placement does not match this member request",
        409,
      );
      let orgChanged = false;
      if (groupId && !placement) {
        state.organization.placements.push({
          personId: agentId,
          nodeId: groupId,
          order: nextPlacementOrder(state.organization, groupId),
          primary: true,
          reportsToPersonId: null,
          since: now(),
          movedAt: now(),
          movedBy: ctx.id,
          previousNodeId: null,
          version: 1,
        });
        state.organization.version++;
        orgChanged = true;
      }
      if (orgChanged || state.legacy)
        await this.putOrganization(
          ctx,
          state.organization,
          state.raw ? previousOrgVersion : null,
        );
      state.roster.members.push({
        agentId,
        status: "active",
        joinedAt: now(),
      });
      state.roster.version++;
      await this.putRoster(
        ctx,
        state.roster,
        state.rosterRaw ? previousRosterVersion : null,
        true,
      );
      await this.commitProvisionedAgent(existing);
      return publicAgent(existing);
    }
    // Freeze legacy fallbacks before choosing the new member's color so a
    // failed provision retry reuses the same reserved color for this agentId.
    const { stored: memberColors, effective } = this.memberColorState(
      company,
      state.roster.members,
    );
    const nextMemberColors = fillMissingMemberColors(
      memberColors,
      state.roster.members,
      effective,
    );
    const reservedColor = nextMemberColors[agentId];
    const avatarColor = isAvatarColor(reservedColor)
      ? reservedColor
      : nextAvatarColor(Object.values(nextMemberColors));
    nextMemberColors[agentId] = avatarColor;
    await this.putMemberColors(ctx, company, memberColors, nextMemberColors);
    const token = randomBytes(32).toString("hex");
    const knowledgeDirectory = this.path(ctx, "knowledgebase");
    const baseUrl = this.options.baseUrl ?? "http://127.0.0.1:3000";
    const mcpConfig = {
      mcpServers: Object.fromEntries(
        ["company_org", "company_tasks", "company_im"].map((module) => [
          module,
          {
            type: "http",
            url: `${baseUrl}/${module}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        ]),
      ),
    };
    await mkdir(join(dir, "tasks"), { recursive: true });
    await this.store.atomic(
      join(dir, MEMORY_FILE),
      memoryTemplate({
        name,
        role,
        responsibilities,
        systemPrompt,
        instructions:
          typeof config.instructions === "string" ? config.instructions : "",
        knowledgeDirectory,
      }),
    );
    await this.store.atomic(
      join(dir, ".mcp.json"),
      JSON.stringify(mcpConfig, null, 2) + "\n",
    );
    await this.store.atomic(
      join(dir, ".env"),
      "# This file is read-only for the Agent and is not used for model configuration.\n# Model provider, endpoint, API key and tier IDs come from the trusted host environment.\n",
    );
    await this.store.atomic(
      join(dir, ".gitignore"),
      "node_modules/\n.venv/\nvenv/\n",
    );
    const provisioned = await this.options.provisionAgent({
      agentId,
      companyId: ctx.companyId,
      ...(groupId ? { groupId } : {}),
      role,
      name,
      responsibilities,
      systemPrompt,
      directory: dir,
      knowledgeDirectory,
      config,
      authToken: token,
      baseUrl,
    });
    requireValue(
      typeof provisioned.sessionId === "string" &&
        provisioned.sessionId.length > 0,
      "runtime_error",
      "Runtime did not return a real Session binding",
      500,
    );
    const agent: InternalAgent = {
      agentId,
      companyId: ctx.companyId,
      role,
      name,
      responsibilities,
      systemPrompt,
      directory: dir,
      sessionId: provisioned.sessionId,
      config,
      effectiveConfig: structuredClone(config),
      configVersion: 1,
      appliedConfigVersion: 1,
      version: 1,
      authToken: token,
    };
    await this.store.putYaml(join(dir, "agent.yaml"), agent);
    if (groupId) {
      state.organization.placements.push({
        personId: agentId,
        nodeId: groupId,
        order: nextPlacementOrder(state.organization, groupId),
        primary: true,
        reportsToPersonId: null,
        since: now(),
        movedAt: now(),
        movedBy: ctx.id,
        previousNodeId: null,
        version: 1,
      });
      state.organization.version++;
    }
    if (groupId || state.legacy)
      await this.putOrganization(
        ctx,
        state.organization,
        state.raw ? previousOrgVersion : null,
      );
    const roster = state.roster;
    const existing = roster.members.find((member) => member.agentId === agentId);
    requireValue(
      !existing || existing.status === "active",
      "already_exists",
      "Roster member already exists",
      409,
    );
    if (!existing) {
      roster.members.push({ agentId, status: "active", joinedAt: now() });
      roster.version++;
    }
    if (!existing || state.legacy)
      await this.putRoster(
        ctx,
        roster,
        state.rosterRaw ? previousRosterVersion : null,
        true,
      );
    await this.commitProvisionedAgent(agent);
    return publicAgent(agent);
  }
  async createMember(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "createMember", input, async () => {
      await this.role(ctx, ["hr"], false);
      requireValue(
        input.avatarColor === undefined,
        "forbidden",
        "Only the user may set a member avatar color",
        403,
      );
      const rawConfig = input.config ?? {};
      const agentEditable = new Set([
        "modelProfile",
        "modelAlias",
        "responsibilities",
        "instructions",
      ]);
      const rawKeys =
        rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
          ? Object.keys(rawConfig)
          : [];
      requireValue(
        rawKeys.every((key) => agentEditable.has(key)),
        "forbidden",
        "HR may define a model profile/alias and role instructions only. Provider credentials, endpoints, MCPs and filesystem capabilities require user configuration.",
        403,
      );
      const config = validatedConfig(rawConfig);
      return this.provision(ctx, { ...input, config });
    });
  }
  private async fileDigest(path: string): Promise<string | null> {
    try {
      return digest(await this.store.raw(path));
    } catch (error) {
      if ((error as { code?: string }).code === "not_found") return null;
      throw error;
    }
  }
  private async pathIdentity(path: string): Promise<string | null> {
    try {
      const resolved = await realpath(path);
      const value = await stat(resolved);
      return `${resolved}:${value.dev}:${value.ino}`;
    } catch {
      return null;
    }
  }
  private async factSnapshot(agent: InternalAgent) {
    const scope = runtimeScopeId(agent.companyId, agent.agentId);
    return {
      agentYaml: await this.fileDigest(join(agent.directory, "agent.yaml")),
      memory: await this.fileDigest(join(agent.directory, MEMORY_FILE)),
      mcp: await this.fileDigest(join(agent.directory, ".mcp.json")),
      token: digest(agent.authToken),
      sessionId: agent.sessionId,
      directory: await this.pathIdentity(agent.directory),
      binding: await this.fileDigest(
        join(this.store.root, "runtime", "wasm-stores", `${scope}.json`),
      ),
      effectiveConfig: await this.fileDigest(
        join(this.store.root, "runtime", "effective-config", `${agent.agentId}.json`),
      ),
      workspace: await this.pathIdentity(
        join(this.store.root, "runtime", "workspace", scope, "home"),
      ),
      agentGit: await this.store.agentGitSnapshot(agent.directory),
    };
  }
  private integrityResult(
    before: Awaited<ReturnType<CompanyDomain["factSnapshot"]>>,
    after: Awaited<ReturnType<CompanyDomain["factSnapshot"]>>,
    rosterUnchanged: boolean,
  ): MoveMemberIntegrity {
    return {
      agentUnchanged: before.agentYaml === after.agentYaml,
      sessionUnchanged: before.sessionId === after.sessionId,
      tokenUnchanged: before.token === after.token,
      memoryUnchanged: before.memory === after.memory,
      mcpUnchanged: before.mcp === after.mcp,
      bindingUnchanged: before.binding === after.binding,
      effectiveConfigUnchanged: before.effectiveConfig === after.effectiveConfig,
      workspaceUnchanged: before.workspace === after.workspace,
      agentGitUnchanged:
        JSON.stringify(before.agentGit) === JSON.stringify(after.agentGit),
      rosterUnchanged,
    };
  }
  private immutableIntegrity(): MoveMemberIntegrity {
    return {
      agentUnchanged: true,
      sessionUnchanged: true,
      tokenUnchanged: true,
      memoryUnchanged: true,
      mcpUnchanged: true,
      bindingUnchanged: true,
      effectiveConfigUnchanged: true,
      workspaceUnchanged: true,
      agentGitUnchanged: true,
      rosterUnchanged: true,
    };
  }
  private async restoreFile(path: string, raw: string | null) {
    if (raw === null) {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
      return;
    }
    await this.store.atomic(path, raw);
  }
  async moveMember(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "moveMember", input, async () => {
      await this.role(ctx, ["hr"]);
      const agentId = safeId(input.agentId, "agentId");
      const nodeId = safeId(input.nodeId, "nodeId");
      let agent: InternalAgent;
      try {
        agent = await this.getAgentInternal(agentId);
      } catch (error) {
        if ((error as { code?: string }).code === "not_found")
          throw new DomainError(
            "member_not_found",
            "Member does not exist",
            404,
          );
        throw error;
      }
      requireValue(
        agent.companyId === ctx.companyId,
        "member_not_found",
        "Member does not exist in this Company",
        404,
      );
      const expectedVersion = input.expectedVersion ?? input.version;
      requireValue(
        Number.isInteger(expectedVersion),
        "invalid_input",
        "expectedVersion is required",
      );
      const state = await this.organizationState(ctx);
      this.requireActiveMember(state.roster, agentId);
      this.requireActiveNode(state.organization, nodeId);
      const current = placementFor(state.organization, agentId);
      const title =
        input.title === undefined ? undefined : String(input.title).slice(0, 200);
      const order =
        input.order === undefined
          ? undefined
          : (() => {
              requireValue(
                Number.isInteger(input.order) && Number(input.order) >= 0,
                "invalid_input",
                "order must be a non-negative integer",
              );
              return Number(input.order);
            })();
      const noop =
        !!current &&
        current.nodeId === nodeId &&
        (title === undefined || (current.title ?? "") === title) &&
        (order === undefined || current.order === order);
      if (noop && !state.legacy)
        return {
          placement: current,
          organization: state.organization,
          integrity: this.immutableIntegrity(),
        };
      if (state.organization.version !== expectedVersion)
        throw new DomainError(
          "version_conflict",
          "Organization has changed",
          409,
          { actualVersion: state.organization.version },
        );

      const before = await this.factSnapshot(agent);
      const rosterBefore = digest(
        state.roster.members.map((member) => ({
          agentId: member.agentId,
          status: member.status,
          joinedAt: member.joinedAt,
        })),
      );
      const rosterRawBefore = await this.fileDigest(this.path(ctx, "roster.yaml"));
      const previousOrgVersion = state.organization.version;
      const previousRosterVersion = state.roster.version;
      const at = now();
      let placement: OrgPlacement;
      if (noop) {
        placement = current!;
      } else if (current) {
        placement = current;
        const previousNodeId = placement.nodeId;
        placement.previousNodeId = previousNodeId;
        placement.nodeId = nodeId;
        if (title !== undefined) placement.title = title || undefined;
        placement.order =
          order ??
          (previousNodeId === nodeId
            ? placement.order
            : nextPlacementOrder(state.organization, nodeId));
        placement.movedAt = at;
        placement.movedBy = ctx.id;
        placement.version++;
      } else {
        placement = {
          personId: agentId,
          nodeId,
          title: title || undefined,
          order: order ?? nextPlacementOrder(state.organization, nodeId),
          primary: true,
          reportsToPersonId: null,
          since: at,
          movedAt: at,
          movedBy: ctx.id,
          previousNodeId: null,
          version: 1,
        };
        state.organization.placements.push(placement);
      }
      if (!noop) state.organization.version++;
      let orgWritten = false;
      let rosterWritten = false;
      try {
        await this.putOrganization(
          ctx,
          state.organization,
          state.raw ? previousOrgVersion : null,
        );
        orgWritten = true;
        if (state.legacy) {
          await this.putRoster(
            ctx,
            state.roster,
            state.rosterRaw ? previousRosterVersion : null,
            true,
          );
          rosterWritten = true;
        }
        const afterAgent = await this.getAgentInternal(agentId);
        const after = await this.factSnapshot(afterAgent);
        const afterRoster = state.legacy
          ? normalizeRoster(
              await this.store.yaml(this.path(ctx, "roster.yaml")),
              (await this.company(ctx)).created_at,
            )
          : state.roster;
        const rosterAfter = digest(
          afterRoster.members.map((member) => ({
            agentId: member.agentId,
            status: member.status,
            joinedAt: member.joinedAt,
          })),
        );
        const rosterUnchanged =
          rosterBefore === rosterAfter &&
          (state.legacy ||
            rosterRawBefore ===
              (await this.fileDigest(this.path(ctx, "roster.yaml"))));
        const integrity = this.integrityResult(before, after, rosterUnchanged);
        const failedChecks = Object.entries(integrity)
          .filter(([, value]) => !value)
          .map(([key]) => key);
        if (failedChecks.length)
          throw new DomainError(
            "integrity_violation",
            "Organization write violated Agent invariants; organization restored",
            409,
            { failedChecks: failedChecks.join(",") },
          );
        return { placement, organization: state.organization, integrity };
      } catch (error) {
        if (orgWritten)
          await this.restoreFile(this.path(ctx, "organization.yaml"), state.raw);
        if (rosterWritten)
          await this.restoreFile(
            this.path(ctx, "roster.yaml"),
            state.rosterRaw,
          );
        throw error;
      }
    });
  }
  async archiveMember(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "archiveMember", input, async () => {
      await this.role(ctx, ["hr"]);
      const agentId = safeId(input.agentId, "agentId");
      const state = await this.organizationState(ctx);
      const previousOrgVersion = state.organization.version;
      const previousRosterVersion = state.roster.version;
      this.version(state.organization, input);
      const member = state.roster.members.find(
        (item) => item.agentId === agentId,
      );
      requireValue(
        member,
        "member_not_found",
        "Member does not exist in this Company",
        404,
      );
      requireValue(
        await this.store.exists(join(this.store.agent(agentId), "agent.yaml")),
        "member_not_found",
        "Member does not exist",
        404,
      );
      const beforePlacements = state.organization.placements.length;
      state.organization.placements = state.organization.placements.filter(
        (placement) => placement.personId !== agentId,
      );
      let leadCleared = false;
      for (const node of state.organization.nodes)
        if (node.leadPersonId === agentId) {
          node.leadPersonId = null;
          node.version++;
          leadCleared = true;
        }
      const orgChanged =
        state.organization.placements.length !== beforePlacements || leadCleared;
      if (orgChanged) state.organization.version++;
      let rosterChanged = false;
      if (member.status !== "archived") {
        member.status = "archived";
        state.roster.version++;
        rosterChanged = true;
      }
      if (orgChanged || state.legacy)
        await this.putOrganization(
          ctx,
          state.organization,
          state.raw ? previousOrgVersion : null,
        );
      if (rosterChanged || state.legacy)
        await this.putRoster(
          ctx,
          state.roster,
          state.rosterRaw ? previousRosterVersion : null,
          true,
        );
      return {
        agentId,
        status: "archived" as const,
        organization: state.organization,
      };
    });
  }
  async restoreMember(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "restoreMember", input, async () => {
      await this.role(ctx, ["hr"]);
      const agentId = safeId(input.agentId, "agentId");
      const state = await this.organizationState(ctx);
      const previousOrgVersion = state.organization.version;
      const previousRosterVersion = state.roster.version;
      this.version(state.organization, input);
      const member = state.roster.members.find(
        (item) => item.agentId === agentId,
      );
      requireValue(
        member,
        "member_not_found",
        "Member does not exist in this Company",
        404,
      );
      requireValue(
        await this.store.exists(join(this.store.agent(agentId), "agent.yaml")),
        "member_not_found",
        "Member does not exist",
        404,
      );
      requireValue(
        member.status === "archived",
        "member_not_archived",
        "Member is already active; use moveMember to change its organization node",
        409,
      );
      const nodeId =
        input.nodeId === undefined || input.nodeId === null || input.nodeId === ""
          ? undefined
          : safeId(input.nodeId, "nodeId");
      let orgChanged = false;
      if (nodeId) {
        this.requireActiveNode(state.organization, nodeId);
        const current = placementFor(state.organization, agentId);
        if (!current) {
          state.organization.placements.push({
            personId: agentId,
            nodeId,
            order: nextPlacementOrder(state.organization, nodeId),
            primary: true,
            reportsToPersonId: null,
            since: now(),
            movedAt: now(),
            movedBy: ctx.id,
            previousNodeId: null,
            version: 1,
          });
          orgChanged = true;
        } else if (current.nodeId !== nodeId) {
          current.previousNodeId = current.nodeId;
          current.nodeId = nodeId;
          current.order = nextPlacementOrder(state.organization, nodeId);
          current.movedAt = now();
          current.movedBy = ctx.id;
          current.version++;
          orgChanged = true;
        }
      }
      if (orgChanged) state.organization.version++;
      member.status = "active";
      state.roster.version++;
      if (orgChanged || state.legacy)
        await this.putOrganization(
          ctx,
          state.organization,
          state.raw ? previousOrgVersion : null,
        );
      await this.putRoster(
        ctx,
        state.roster,
        state.rosterRaw ? previousRosterVersion : null,
        true,
      );
      return {
        agentId,
        status: "active" as const,
        organization: state.organization,
      };
    });
  }
  async updateMember(ctx: CallerContext, input: Input) {
    requireValue(
      ctx.type === "user",
      "forbidden",
      "Only the user may edit member definitions",
      403,
    );
    return this.mutate(ctx, "updateMember", input, async () => {
      const a = await this.getAgentInternal(safeId(input.agentId, "agentId"));
      requireValue(
        a.companyId === ctx.companyId,
        "forbidden",
        "Wrong Company",
        403,
      );
      this.version(a, input);
      assertNoManagedMarkers({
        name: input.name,
        responsibilities: input.responsibilities,
        systemPrompt: input.systemPrompt,
      });
      if (input.name !== undefined) a.name = cleanText(input.name, "name", 200);
      if (input.responsibilities !== undefined)
        a.responsibilities = cleanText(
          input.responsibilities,
          "responsibilities",
        );
      if (input.systemPrompt !== undefined)
        a.systemPrompt = promptText(input.systemPrompt);
      let avatarColor: AvatarColor | undefined;
      if (input.avatarColor !== undefined) {
        requireValue(
          isAvatarColor(input.avatarColor),
          "invalid_input",
          `avatarColor must be one of ${AVATAR_COLORS.join(", ")}`,
        );
        avatarColor = input.avatarColor;
      }
      const profile = this.memoryProfile(ctx, a, a.effectiveConfig);
      // Validation and memory application precede member writes: a malformed or
      // unsafe memory file cannot leave a rejected member edit half-applied.
      await applyAgentMemory(this.store, profile);
      if (avatarColor !== undefined) {
        // Freeze every legacy fallback before applying the owner's choice, so
        // later member changes cannot recolor an unrelated member.
        const company = await this.company(ctx);
        const { roster } = await this.organizationState(ctx);
        const { stored, effective } = this.memberColorState(
          company,
          roster.members,
        );
        const next = fillMissingMemberColors(
          stored,
          roster.members,
          effective,
        );
        next[a.agentId] = avatarColor;
        await this.putMemberColors(ctx, company, stored, next);
      }
      a.version++;
      await this.store.putYaml(
        join(a.directory, "agent.yaml"),
        a,
        input.version,
      );
      await this.store.commit(a.directory, "Update member definition");
      return publicAgent(a);
    });
  }
  private memoryProfile(ctx: CallerContext, agent: AgentRecord, config: AgentConfig) {
    return {
      directory: agent.directory,
      knowledgeDirectory: this.path(ctx, "knowledgebase"),
      name: agent.name,
      role: agent.role,
      responsibilities: agent.responsibilities,
      systemPrompt: agent.systemPrompt,
      instructions: typeof config.instructions === "string" ? config.instructions : "",
    };
  }
  /** Internal restart preflight; does not publish saved instructions early. */
  async validateAgentConfigurationApply(ctx: CallerContext, input: Input) {
    requireValue(ctx.type === "user", "forbidden", "Only the user may restart an Agent", 403);
    const agent = await this.getAgent(ctx, { agentId: input.agentId });
    requireValue(
      agent.configVersion === input.configVersion,
      "version_conflict",
      "Configuration changed before restarting",
      409,
    );
    await prepareAgentMemory(this.memoryProfile(ctx, agent, agent.config));
  }
  async setRolePermissions(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "setRolePermissions", input, async () => {
      await this.role(ctx, ["hr"]);
      const c = await this.company(ctx);
      this.version(c, input);
      const role = safeId(input.role, "role");
      requireValue(
        Array.isArray(input.permissions) &&
          input.permissions.every((p: unknown) =>
            ["issue.create", "issue.assign", "issue.search"].includes(
              String(p),
            ),
          ),
        "invalid_input",
        "Supported role permissions: issue.create, issue.assign, issue.search",
      );
      c.roles[role] = {
        permissions: [...new Set(input.permissions)] as string[],
      };
      c.version++;
      await this.store.putYaml(
        this.path(ctx, "company.yaml"),
        c,
        input.version,
      );
      return c;
    });
  }
  async getAgent(ctx: CallerContext, input: Input) {
    await this.access(ctx);
    const a = await this.getAgentInternal(safeId(input.agentId, "agentId"));
    requireValue(
      a.companyId === ctx.companyId,
      "forbidden",
      "Agent belongs to another Company",
      403,
    );
    requireValue(
      ctx.type === "user" || ctx.id === a.agentId,
      "forbidden",
      "Private Agent record",
      403,
    );
    return publicAgent(a);
  }
  async saveAgentConfiguration(ctx: CallerContext, input: Input) {
    requireValue(
      ctx.type === "user",
      "forbidden",
      "Only the user may save Agent configuration",
      403,
    );
    return this.mutate(ctx, "saveAgentConfiguration", input, async () => {
      const a = await this.getAgentInternal(safeId(input.agentId, "agentId"));
      requireValue(
        a.companyId === ctx.companyId,
        "forbidden",
        "Wrong Company",
        403,
      );
      this.version(a, input);
      requireValue(
        input.config &&
          typeof input.config === "object" &&
          !Array.isArray(input.config),
        "invalid_input",
        "config must be an object",
      );
      a.config = validatedConfig({ ...a.config, ...input.config });
      a.configVersion++;
      a.version++;
      await this.store.putYaml(
        join(a.directory, "agent.yaml"),
        a,
        input.version,
      );
      await this.store.commit(
        a.directory,
        "Save configuration; restart required",
      );
      return {
        ...publicAgent(a),
        restartRequired: a.configVersion !== a.appliedConfigVersion,
      };
    });
  }
  async markAgentConfigurationApplied(ctx: CallerContext, input: Input) {
    requireValue(
      ctx.type === "user",
      "forbidden",
      "Only user restart may apply configuration",
      403,
    );
    return this.mutate(ctx, "applyAgentConfiguration", input, async () => {
      const a = await this.getAgentInternal(safeId(input.agentId, "agentId"));
      requireValue(
        a.companyId === ctx.companyId,
        "forbidden",
        "Wrong Company",
        403,
      );
      if (input.configVersion !== undefined)
        requireValue(
          a.configVersion === input.configVersion,
          "version_conflict",
          "Configuration changed while restarting",
          409,
        );
      // The service supplies the exact snapshot used to start this activation.
      // Direct internal callers may omit it only while the checked version is
      // still current. Never substitute a later saved configuration.
      const applied = input.configuration === undefined
        ? structuredClone(a.config)
        : validatedConfig(input.configuration);
      requireValue(
        digest(applied) === digest(a.config),
        "version_conflict",
        "Applied runtime configuration differs from the saved revision",
        409,
      );
      // Re-read after runtime restart so Agent-authored free memory and current
      // member responsibilities are preserved. Failure leaves applied unchanged.
      await applyAgentMemory(this.store, this.memoryProfile(ctx, a, applied));
      a.effectiveConfig = structuredClone(applied);
      a.appliedConfigVersion = a.configVersion;
      a.version++;
      await this.store.putYaml(join(a.directory, "agent.yaml"), a);
      await this.store.commit(
        a.directory,
        "Apply saved configuration on explicit restart",
      );
      return publicAgent(a);
    });
  }
  async listIssues(ctx: CallerContext, input: Input = {}) {
    await this.access(ctx);
    const all: Issue[] = [];
    for (const file of await this.store.files(this.path(ctx, "tasks")))
      all.push(
        normalizeIssueProgress(
          await this.store.markdown(this.path(ctx, "tasks", file)),
        ),
      );
    // Agent scope comes from its credential, never from the truthiness of input.
    if (ctx.type === "agent" && input.agentId !== undefined)
      requireValue(
        safeId(input.agentId, "agentId") === ctx.id,
        "forbidden",
        "Cannot query another Agent workspace",
        403,
      );
    const agentId = ctx.type === "agent" ? ctx.id : input.agentId ?? null;
    if (agentId) {
      const a = await this.getAgentInternal(safeId(agentId, "agentId"));
      requireValue(
        a.companyId === ctx.companyId,
        "forbidden",
        "Wrong Company",
        403,
      );
      if (ctx.type === "agent")
        requireValue(
          agentId === ctx.id,
          "forbidden",
          "Cannot query another Agent workspace",
          403,
        );
      return all.filter(
        (i) =>
          i.agent_id === agentId ||
          i.collaborators.includes(agentId) ||
          (i.created_by_type === "agent" && i.created_by_id === agentId) ||
          i.history.some((h) => h.from === agentId || h.to === agentId),
      );
    }
    return all;
  }
  async searchIssues(ctx: CallerContext, input: Input = {}) {
    await this.access(ctx);
    const company = await this.company(ctx);
    if (ctx.type === "agent") {
      const a = await this.getAgentInternal(ctx.id);
      requireValue(
        company.roles[a.role]?.permissions.includes("issue.search"),
        "forbidden",
        "Role does not have issue.search",
        403,
      );
    }
    requireValue(
      typeof input.query === "string",
      "invalid_input",
      "query must be text",
    );
    const query = input.query.trim().toLowerCase();
    requireValue(
      query.length >= 1 && query.length <= 200,
      "invalid_input",
      "query must be 1-200 characters",
    );
    if (input.status !== undefined)
      requireValue(
        Array.isArray(input.status) &&
          input.status.every((status) =>
            statuses.includes(status as IssueStatus),
          ),
        "invalid_input",
        "Unknown Issue status",
      );
    const rows: Issue[] = [];
    for (const file of await this.store.files(this.path(ctx, "tasks")))
      rows.push(
        normalizeIssueProgress(
          await this.store.markdown<Issue>(this.path(ctx, "tasks", file)),
        ),
      );
    const matches = rows
      .filter((issue) => {
        if (
          input.status &&
          !(input.status as string[]).includes(issue.status)
        )
          return false;
        return [
          issue.id,
          issue.title,
          issue.summary,
          issue.type ?? "",
          issue.pipeline ?? "",
        ].some((value) => String(value).toLowerCase().includes(query));
      })
      .sort(
        (left, right) =>
          right.updated_at.localeCompare(left.updated_at) ||
          left.id.localeCompare(right.id, undefined, { numeric: true }),
      );
    const limit = Math.min(50, Math.max(1, Number(input.limit) || 20));
    return {
      items: matches.slice(0, limit).map((issue) => ({
        id: issue.id,
        title: clipText(issue.title, 240),
        status: issue.status,
        agent_id: issue.agent_id,
        type: issue.type,
        pipeline: issue.pipeline,
        needs_user: issue.needs_user,
        summary: clipText(issue.summary, 500),
        created_by_type: issue.created_by_type ?? null,
        created_by_id: issue.created_by_id ?? null,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
      })),
      total: matches.length,
      truncated: matches.length > limit,
    };
  }
  /**
   * Owner-only, company-wide inbox projection of unanswered decisions. Excludes
   * canceled Issues and never returns Issue bodies/comments; archived Agents'
   * questions remain because the user still has to answer them.
   */
  async listPendingDecisions(
    ctx: CallerContext,
  ): Promise<PendingDecisionView[]> {
    requireValue(
      ctx.type === "user",
      "forbidden",
      "Only the user may read pending Company decisions",
      403,
    );
    const issues = await this.listIssues(ctx);
    return issues
      .filter((issue) => issue.status !== "cancel")
      .flatMap((issue) =>
        issue.decisions
          .filter(
            (decision) =>
              decision.status === "pending" && decision.answer === null,
          )
          .map((decision) => ({
            issueId: issue.id,
            issueTitle: issue.title,
            issueStatus: issue.status,
            agentId: issue.agent_id,
            decisionId: decision.id,
            question: decision.question,
            ...(decision.options ? { options: [...decision.options] } : {}),
            updatedAt: issue.updated_at,
          })),
      )
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.issueId.localeCompare(b.issueId, undefined, { numeric: true }) ||
          a.decisionId.localeCompare(b.decisionId),
      );
  }
  async getIssue(ctx: CallerContext, input: Input): Promise<Issue> {
    const issue = normalizeIssueProgress(
      await this.store.markdown<Issue>(
        this.issuePath(ctx, String(input.issueId)),
      ),
    );
    await this.related(ctx, issue);
    return issue;
  }
  async createIssue(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "createIssue", input, async () => {
      const a = await this.access(ctx);
      const company = await this.company(ctx);
      requireValue(
        !a || company.roles[a.role]?.permissions.includes("issue.create"),
        "forbidden",
        "Role does not have issue.create",
        403,
      );
      const canDispatch =
        !a ||
        a.role === "task-supervisor" ||
        !!company.roles[a.role]?.permissions.includes("issue.assign");
      const dispatches =
        input.assigneeAgentId !== undefined ||
        input.type !== undefined ||
        input.pipeline !== undefined;
      requireValue(
        !dispatches || canDispatch,
        "forbidden",
        "Role does not have issue.assign",
        403,
      );
      const roster = await this.roster(ctx);
      let supervisor: InternalAgent | undefined;
      for (const member of roster.members) {
        if (member.status !== "active") continue;
        const candidate = await this.getAgentInternal(member.agentId);
        if (
          candidate.companyId === ctx.companyId &&
          candidate.role === "task-supervisor"
        ) {
          supervisor = candidate;
          break;
        }
      }
      requireValue(
        supervisor,
        "invalid_state",
        "Company has no task supervisor",
      );
      let assignee: InternalAgent | undefined;
      if (input.assigneeAgentId !== undefined) {
        const assigneeId = safeId(input.assigneeAgentId, "assigneeAgentId");
        assignee = await this.getAgentInternal(assigneeId);
        requireValue(
          assignee.companyId === ctx.companyId,
          "forbidden",
          "Cannot assign outside Company",
          403,
        );
        requireValue(
          (await this.memberStatus(ctx.companyId, assignee.agentId)) !==
            "archived",
          "member_archived",
          "Cannot assign an archived member",
          409,
        );
        requireValue(
          !a || a.role === "task-supervisor" || assignee.agentId !== a.agentId,
          "forbidden",
          "An Agent cannot assign an Issue to itself",
          403,
        );
      }
      let type: string | null = null;
      if (input.type !== undefined)
        type = input.type === null ? null : cleanText(input.type, "type", 100);
      let pipeline: string | null = null;
      if (input.pipeline !== undefined) {
        if (input.pipeline !== null) {
          const pipelineId = safeId(input.pipeline, "pipeline");
          requireValue(
            await this.store.exists(
              this.path(ctx, "pipelines", `${pipelineId}.md`),
            ),
            "not_found",
            "Pipeline not found",
            404,
          );
          pipeline = pipelineId;
        }
      }
      const files = await this.store.files(this.path(ctx, "tasks"));
      const id = String(
        Math.max(0, ...files.map((f) => Number.parseInt(f) || 0)) + 1,
      );
      const ownerAgentId = assignee?.agentId ?? supervisor.agentId;
      const issue: Issue = {
        id,
        title: cleanText(input.title, "title", 500),
        type,
        pipeline,
        status: "triage",
        agent_id: ownerAgentId,
        summary: String(input.summary ?? ""),
        progress: "",
        needs_user: false,
        decisions: [],
        preview_batch: null,
        collaborators: [],
        created_by_type: ctx.type,
        created_by_id: ctx.id,
        history:
          ownerAgentId === supervisor.agentId
            ? []
            : [
                {
                  at: now(),
                  from: supervisor.agentId,
                  to: ownerAgentId,
                  by: ctx.id,
                  reason: cleanText(input.reason, "reason"),
                },
              ],
        code_ref: null,
        plan_ref: null,
        worktree: null,
        created_at: now(),
        updated_at: now(),
        version: 1,
        body: String(
          input.body ?? "## 目标与验收要求\n\n## 工作记录\n\n## 交付物\n",
        ),
        todos: [],
      };
      await this.store.putMarkdown(this.issuePath(ctx, id), issue, 0);
      return issue;
    });
  }
  async updateIssue(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "updateIssue", input, async () => {
      const issue = await this.getIssue(ctx, input);
      await this.owner(ctx, issue);
      this.version(issue, input);
      requireValue(
        issue.status !== "cancel",
        "terminal_issue",
        "Canceled Issue cannot be revived",
        409,
      );
      const patch = input.patch;
      requireValue(
        patch && typeof patch === "object" && !Array.isArray(patch),
        "invalid_input",
        "patch must be an object",
      );
      const allowed = [
        "title",
        "summary",
        "progress",
        "body",
        "status",
        "code_ref",
        "plan_ref",
        "worktree",
      ];
      requireValue(
        Object.keys(patch).every((k) => allowed.includes(k)),
        "forbidden",
        "Field requires its dedicated business operation",
        403,
      );
      if (patch.title !== undefined) cleanText(patch.title, "title", 500);
      for (const k of ["summary", "progress", "body"])
        if (patch[k] !== undefined)
          requireValue(
            typeof patch[k] === "string",
            "invalid_input",
            `${k} must be text`,
          );
      if (patch.status !== undefined) {
        requireValue(
          statuses.includes(patch.status),
          "invalid_input",
          "Unknown Issue status",
        );
        requireValue(
          patch.status !== "cancel",
          "invalid_input",
          "Use cancelIssue with a reason",
        );
        if (["accepted", "verifying", "ready_merge"].includes(patch.status))
          await this.assertDeliveryGate(ctx, issue, patch.status);
      }
      if (
        patch.code_ref !== undefined &&
        patch.code_ref !== issue.code_ref &&
        ["accepted", "verifying", "ready_merge"].includes(
          patch.status ?? issue.status,
        )
      )
        requireValue(
          false,
          "stale_evidence",
          "Changed code requires Preview Agent to update code-linked acceptance before verification",
          409,
        );
      for (const key of ["code_ref", "plan_ref", "worktree"])
        if (patch[key] !== undefined && patch[key] !== null)
          cleanText(patch[key], key, 2000);
      if (patch.plan_ref || patch.worktree)
        for (const file of await this.store.files(this.path(ctx, "tasks"))) {
          const other = await this.store.markdown<Issue>(
            this.path(ctx, "tasks", file),
          );
          if (other.id !== issue.id)
            for (const key of ["plan_ref", "worktree"] as const)
              if (patch[key] && other[key] === patch[key])
                throw new DomainError(
                  "shared_issue_artifact",
                  `${key} must be independent per Issue`,
                  409,
                );
        }
      Object.assign(issue, patch);
      return this.writeIssue(ctx, issue);
    });
  }
  async assignIssue(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "assignIssue", input, async () => {
      const a = await this.access(ctx);
      const supervised = a?.role === "task-supervisor";
      if (a && !supervised) {
        const company = await this.company(ctx);
        requireValue(
          company.roles[a.role]?.permissions.includes("issue.assign"),
          "forbidden",
          "Requires task-supervisor or issue.assign",
          403,
        );
      }
      const issue = await this.store.markdown<Issue>(
        this.issuePath(ctx, String(input.issueId)),
      );
      const targetId = safeId(input.agentId, "agentId");
      if (a && !supervised) {
        requireValue(
          issue.created_by_type === "agent" &&
            issue.created_by_id === a.agentId,
          "forbidden",
          "issue.assign may only reassign Issues you created",
          403,
        );
        requireValue(
          targetId !== a.agentId,
          "forbidden",
          "An Agent cannot assign an Issue to itself",
          403,
        );
      }
      this.version(issue, input);
      requireValue(
        issue.status !== "cancel",
        "terminal_issue",
        "Canceled Issue cannot be reassigned",
        409,
      );
      const target = await this.getAgentInternal(targetId);
      requireValue(
        target.companyId === ctx.companyId,
        "forbidden",
        "Cannot assign outside Company",
        403,
      );
      requireValue(
        (await this.memberStatus(ctx.companyId, target.agentId)) !== "archived",
        "member_archived",
        "Cannot assign an archived member",
        409,
      );
      const previous = issue.agent_id;
      if (previous !== target.agentId)
        issue.history.push({
          at: now(),
          from: previous,
          to: target.agentId,
          by: ctx.id,
          reason: cleanText(input.reason, "reason"),
        });
      issue.agent_id = target.agentId;
      if (input.type !== undefined)
        issue.type =
          input.type === null ? null : cleanText(input.type, "type", 100);
      if (input.pipeline !== undefined) {
        if (input.pipeline !== null) {
          safeId(input.pipeline, "pipeline");
          requireValue(
            await this.store.exists(
              this.path(ctx, "pipelines", `${input.pipeline}.md`),
            ),
            "not_found",
            "Pipeline not found",
            404,
          );
        }
        issue.pipeline = input.pipeline;
      }
      if (input.collaborators !== undefined) {
        requireValue(
          Array.isArray(input.collaborators),
          "invalid_input",
          "collaborators must be an array",
        );
        for (const id of input.collaborators) {
          const collaborator = await this.getAgentInternal(safeId(id));
          requireValue(
            collaborator.companyId === ctx.companyId,
            "forbidden",
            "Collaborator outside Company",
            403,
          );
          requireValue(
            (await this.memberStatus(ctx.companyId, collaborator.agentId)) !==
              "archived",
            "member_archived",
            "Cannot add an archived member as a collaborator",
            409,
          );
        }
        issue.collaborators = [...new Set(input.collaborators)] as string[];
      }
      return this.writeIssue(ctx, issue);
    });
  }
  async cancelIssue(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "cancelIssue", input, async () => {
      const issue = await this.getIssue(ctx, input);
      await this.owner(ctx, issue);
      this.version(issue, input);
      requireValue(
        issue.status !== "cancel",
        "terminal_issue",
        "Issue already canceled",
        409,
      );
      issue.cancel_reason = cleanText(input.reason, "reason");
      issue.status = "cancel";
      return this.writeIssue(ctx, issue);
    });
  }
  async pipelines(ctx: CallerContext) {
    await this.access(ctx);
    return Promise.all(
      (await this.store.files(this.path(ctx, "pipelines"))).map((f) =>
        this.store.markdown(this.path(ctx, "pipelines", f)),
      ),
    );
  }
  async comments(ctx: CallerContext, input: Input) {
    await this.getIssue(ctx, input);
    const rows: Comment[] = [];
    for (const f of await this.store.files(
      this.path(ctx, "comments", safeId(String(input.issueId))),
    ))
      rows.push(
        await this.store.markdown(
          this.path(ctx, "comments", String(input.issueId), f),
        ),
      );
    const offset = Math.max(0, Number(input.cursor) || 0);
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 30));
    return {
      items: rows.slice(offset, offset + limit),
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
    };
  }
  private async comment(
    ctx: CallerContext,
    issueId: string,
    body: string,
    todoSnapshot?: Comment["todo_snapshot"],
  ): Promise<Comment> {
    const dir = this.path(ctx, "comments", safeId(issueId));
    const rows = await this.store.files(dir);
    const id = `${issueId}-C${Math.max(0, ...rows.map((f) => Number(/-C(\d+)/.exec(f)?.[1]) || 0)) + 1}`;
    const item: Comment = {
      id,
      issue_id: issueId,
      author_type: ctx.type,
      author_id: ctx.id,
      created_at: now(),
      version: 1,
      body: cleanText(body, "body"),
    };
    if (todoSnapshot !== undefined) item.todo_snapshot = todoSnapshot;
    await this.store.putMarkdown(join(dir, `${id}.md`), item, 0);
    return item;
  }
  async addComment(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "addComment", input, async () => {
      const issue = await this.getIssue(ctx, input);
      return this.comment(ctx, issue.id, input.body);
    });
  }
  async updateComment(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "updateComment", input, async () => {
      await this.getIssue(ctx, input);
      const p = this.path(
        ctx,
        "comments",
        safeId(String(input.issueId)),
        `${safeId(input.commentId, "commentId")}.md`,
      );
      const comment = await this.store.markdown<Comment>(p);
      requireValue(
        comment.author_type === ctx.type && comment.author_id === ctx.id,
        "forbidden",
        "Only the author may edit a comment",
        403,
      );
      this.version(comment, input);
      comment.body = cleanText(input.body, "body");
      comment.updated_at = now();
      comment.version++;
      await this.store.putMarkdown(p, comment, input.version);
      return comment;
    });
  }
  async updateTodos(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "updateTodos", input, async () => {
      requireValue(
        ctx.type === "agent",
        "forbidden",
        "The todo list is managed only by the responsible Agent",
        403,
      );
      const issue = await this.getIssue(ctx, input);
      await this.owner(ctx, issue);
      this.version(issue, input);
      requireValue(
        issue.status !== "cancel",
        "terminal_issue",
        "Canceled Issue cannot change todos",
        409,
      );
      const changes = input.changes;
      const order = input.order;
      requireValue(
        (changes !== undefined &&
          Array.isArray(changes) &&
          changes.length > 0) ||
          (order !== undefined && Array.isArray(order) && order.length > 0),
        "invalid_input",
        "changes or order is required",
      );
      const note = cleanTodoNote(input.note);
      const actor: TodoActor = { type: ctx.type, id: ctx.id };
      const at = now();
      let todos: TodoItem[] = issue.todos ?? [];
      let sequence = nextTodoSeq(todos, issue.todo_seq);
      if (changes !== undefined) {
        const applied = applyTodoChanges({
          issueId: issue.id,
          todos,
          changes,
          actor,
          at,
          sequence,
        });
        todos = applied.todos;
        sequence = applied.sequence;
      }
      if (order !== undefined) todos = applyTodoOrder(todos, order);
      issue.todos = todos;
      if (sequence > (issue.todo_seq ?? 0)) issue.todo_seq = sequence;
      const written = await this.writeIssue(ctx, issue);
      const todo_snapshot = (written.todos ?? []).map(({ id, text, status }) => ({
        id,
        text,
        status,
      }));
      const comment = await this.comment(ctx, written.id, note, todo_snapshot);
      return { issue: written, comment };
    });
  }
  async askDecision(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "askDecision", input, async () => {
      const issue = await this.getIssue(ctx, input);
      await this.owner(ctx, issue);
      this.version(issue, input);
      requireValue(
        issue.status !== "cancel",
        "terminal_issue",
        "Canceled Issue cannot ask new questions",
        409,
      );
      const id = `${issue.id}-Q${Math.max(0, ...issue.decisions.map((q) => Number(q.id.split("-Q")[1]) || 0)) + 1}`;
      const options = cleanDecisionOptions(input.options);
      issue.decisions.push({
        id,
        question: cleanText(input.question, "question"),
        ...(options ? { options } : {}),
        status: "pending",
        answer: null,
        answers: [],
      });
      return this.writeIssue(ctx, issue);
    });
  }
  async answerDecision(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "answerDecision", input, async () => {
      requireValue(
        ctx.type === "user",
        "forbidden",
        "Only the user may answer a Company decision",
        403,
      );
      const issue = await this.getIssue(ctx, input);
      const q = issue.decisions.find((q) => q.id === input.questionId);
      requireValue(
        q,
        "not_found",
        "Exact questionId was not found on this Issue",
        404,
      );
      const answer = cleanText(input.answer, "answer");
      q.answers.push({
        text: answer,
        author_id: ctx.id,
        at: now(),
        late: q.status !== "pending",
      });
      if (q.status === "pending") q.answer = answer;
      await this.comment(
        ctx,
        issue.id,
        `用户答复 ${q.id}${q.status !== "pending" ? "（晚到，仅保留历史）" : ""}\n\n${answer}`,
      );
      return this.writeIssue(ctx, issue);
    });
  }
  async resolveDecision(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "resolveDecision", input, async () => {
      const issue = await this.getIssue(ctx, input);
      await this.owner(ctx, issue, false);
      this.version(issue, input);
      const q = issue.decisions.find((q) => q.id === input.questionId);
      requireValue(q, "not_found", "Question not found", 404);
      requireValue(
        q.status === "pending" && q.answer !== null,
        "invalid_state",
        "A pending question with a user answer is required",
      );
      q.status = "answered";
      q.processed_at = now();
      return this.writeIssue(ctx, issue);
    });
  }
  async withdrawDecision(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "withdrawDecision", input, async () => {
      const issue = await this.getIssue(ctx, input);
      await this.owner(ctx, issue);
      this.version(issue, input);
      const q = issue.decisions.find((q) => q.id === input.questionId);
      requireValue(q, "not_found", "Question not found", 404);
      requireValue(
        q.status === "pending",
        "invalid_state",
        "Only a pending question may be withdrawn",
      );
      q.status = "withdrawn";
      q.withdrawn_at = now();
      return this.writeIssue(ctx, issue);
    });
  }
  async savePreview(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "savePreview", input, async () => {
      const caller = await this.access(ctx);
      const id = safeId(input.id ?? input.batchId, "batchId");
      const path = this.previewPath(ctx, id);
      const existing = (await this.store.exists(path))
        ? await this.store.markdown<Preview>(path)
        : null;
      requireValue(
        !caller ||
          caller.role === "preview" ||
          existing?.owner_id === caller.agentId,
        "forbidden",
        "Preview owner or Preview role required",
        403,
      );
      if (existing) this.version(existing, input);
      else
        requireValue(
          input.version === undefined || input.version === 0,
          "version_conflict",
          "Batch does not exist",
          409,
        );
      const ids: string[] = [
        ...new Set((input.issue_ids ?? input.issueIds ?? []).map(String)),
      ] as string[];
      requireValue(
        ids.length > 0,
        "invalid_input",
        "Preview requires at least one Issue",
      );
      const ownerId =
        input.owner_id ??
        input.ownerId ??
        caller?.agentId ??
        existing?.owner_id;
      requireValue(
        ownerId,
        "invalid_input",
        "ownerId required for a user-created Preview",
      );
      const owner = await this.getAgentInternal(safeId(ownerId, "ownerId"));
      requireValue(
        owner.companyId === ctx.companyId,
        "forbidden",
        "Owner outside Company",
        403,
      );
      if (existing && caller)
        requireValue(
          ownerId === existing.owner_id,
          "forbidden",
          "Cross-person handoff belongs to the task supervisor",
          403,
        );
      const branch = cleanText(input.branch ?? existing?.branch, "branch", 500);
      const url = cleanText(
        input.environment_url ??
          input.environmentUrl ??
          existing?.environment_url,
        "environmentUrl",
        2000,
      );
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new DomainError(
          "invalid_input",
          "Environment URL must be an absolute http(s) URL",
        );
      }
      requireValue(
        ["http:", "https:"].includes(parsed.protocol),
        "invalid_input",
        "Environment URL must use http(s)",
      );
      const codeRefs =
        input.code_refs ?? input.codeRefs ?? existing?.code_refs ?? {};
      const checklist = input.checklist ?? existing?.checklist ?? {};
      requireValue(
        codeRefs && typeof codeRefs === "object" && !Array.isArray(codeRefs),
        "invalid_input",
        "codeRefs must map Issue IDs to current code references",
      );
      requireValue(
        checklist && typeof checklist === "object" && !Array.isArray(checklist),
        "invalid_input",
        "checklist must map Issue IDs to acceptance items",
      );
      const issues: Issue[] = [];
      for (const issueId of ids) {
        const issue = await this.store.markdown<Issue>(
          this.issuePath(ctx, issueId),
        );
        requireValue(
          issue.status !== "cancel",
          "terminal_issue",
          "Canceled Issue cannot enter Preview",
          409,
        );
        requireValue(
          !caller || issue.agent_id === caller.agentId,
          "not_current_owner",
          "Supervisor must hand each Issue to its Preview owner before changing its state",
          403,
        );
        cleanText(codeRefs[issueId], `code_ref for ${issueId}`, 1000);
        requireValue(
          Array.isArray(checklist[issueId]) &&
            checklist[issueId].length > 0 &&
            checklist[issueId].every(
              (s: unknown) => typeof s === "string" && s.trim(),
            ),
          "invalid_input",
          `Nonempty acceptance checklist required for Issue ${issueId}`,
        );
        requireValue(
          issue.plan_ref && issue.worktree,
          "missing_deliverables",
          "Independent plan_ref and worktree references are required before Preview",
        );
        issues.push(issue);
      }
      // Removing a batch member changes that Issue too. Validate the full write
      // set before touching any file; batch ownership cannot override Issue ownership.
      const removed: Issue[] = [];
      for (const removedId of
        existing?.issue_ids.filter((i) => !ids.includes(i)) ?? []) {
        const issue = await this.store.markdown<Issue>(
          this.issuePath(ctx, removedId),
        );
        if (issue.preview_batch !== id) continue;
        await this.owner(ctx, issue);
        requireValue(
          !["accepted", "verifying", "ready_merge"].includes(issue.status),
          "preview_evidence_in_use",
          "Current acceptance or verification still uses this Preview; explicitly revise the Issue before removing it",
          409,
        );
        removed.push(issue);
      }
      const batch: Preview = {
        id,
        owner_id: ownerId,
        issue_ids: ids,
        collaborators: existing?.collaborators ?? [],
        branch,
        code_refs: codeRefs,
        environment_url: url,
        checklist,
        acceptances: existing?.acceptances ?? [],
        verifications: existing?.verifications ?? [],
        body: String(input.body ?? existing?.body ?? ""),
        version: (existing?.version ?? 0) + 1,
        updated_at: now(),
      };
      for (const issue of removed) {
        issue.preview_batch = null;
        if (issue.status === "preview") issue.status = "ready_preview";
        await this.writeIssue(ctx, issue);
      }
      for (const issue of issues) {
        const changed =
          issue.code_ref !== codeRefs[issue.id] || issue.preview_batch !== id;
        issue.code_ref = codeRefs[issue.id];
        issue.preview_batch = id;
        if (changed || ["ready_preview", "code", "plan"].includes(issue.status))
          issue.status = "preview";
        await this.writeIssue(ctx, issue);
      }
      await this.store.putMarkdown(path, batch, existing?.version ?? 0);
      return batch;
    });
  }
  async getPreview(ctx: CallerContext, input: Input) {
    await this.access(ctx);
    const b = await this.store.markdown<Preview>(
      this.previewPath(ctx, input.batchId ?? input.id),
    );
    if (ctx.type === "agent") {
      const related = b.owner_id === ctx.id || b.collaborators.includes(ctx.id);
      const issues = await this.listIssues(ctx);
      requireValue(
        related || issues.some((i) => i.preview_batch === b.id),
        "forbidden",
        "Preview is not associated with Agent",
        403,
      );
    }
    return b;
  }
  private acceptedFor(batch: Preview, issue: Issue) {
    const row = [...batch.acceptances]
      .reverse()
      .find((a) => a.issue_id === issue.id && a.code_ref === issue.code_ref);
    return row?.passed === true;
  }
  private verifiedFor(batch: Preview, issue: Issue, kind: "ci" | "review") {
    const row = [...batch.verifications]
      .reverse()
      .find(
        (a) =>
          a.issue_id === issue.id &&
          a.code_ref === issue.code_ref &&
          a.kind === kind,
      );
    return row?.passed === true;
  }
  private async assertDeliveryGate(
    ctx: CallerContext,
    issue: Issue,
    target: string,
  ) {
    requireValue(
      issue.preview_batch && issue.code_ref,
      "missing_evidence",
      "Preview and current code reference required",
      409,
    );
    const batch = await this.store.markdown<Preview>(
      this.previewPath(ctx, issue.preview_batch),
    );
    requireValue(
      this.acceptedFor(batch, issue),
      "missing_acceptance",
      "User acceptance for current code is required",
      409,
    );
    if (target === "ready_merge")
      requireValue(
        this.verifiedFor(batch, issue, "ci") &&
          this.verifiedFor(batch, issue, "review"),
        "missing_verification",
        "Both CI and Code Review must pass for current code",
        409,
      );
  }
  async acceptPreview(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "acceptPreview", input, async () => {
      requireValue(
        ctx.type === "user",
        "forbidden",
        "Only explicit user acceptance may accept Preview",
        403,
      );
      const batch = await this.getPreview(ctx, input);
      this.version(batch, input);
      const id = String(input.issueId);
      requireValue(
        batch.issue_ids.includes(id),
        "invalid_input",
        "Issue is not in this batch",
      );
      const issue = await this.store.markdown<Issue>(this.issuePath(ctx, id));
      requireValue(
        issue.preview_batch === batch.id,
        "stale_preview",
        "This batch is historical; the Issue is associated with another current batch",
        409,
      );
      requireValue(
        issue.status !== "cancel",
        "terminal_issue",
        "Canceled Issue cannot be accepted",
        409,
      );
      const codeRef = cleanText(
        input.codeRef ?? input.code_ref,
        "codeRef",
        1000,
      );
      requireValue(
        codeRef === issue.code_ref && codeRef === batch.code_refs[id],
        "stale_evidence",
        "Acceptance must identify the current code",
        409,
      );
      requireValue(
        typeof input.passed === "boolean",
        "invalid_input",
        "passed must be true or false",
      );
      const checklist = input.checklist ?? batch.checklist[id];
      requireValue(
        Array.isArray(checklist) && checklist.length > 0,
        "invalid_input",
        "Acceptance checklist required",
      );
      const evidence = cleanText(input.evidence, "evidence");
      batch.acceptances.push({
        issue_id: id,
        code_ref: codeRef,
        passed: input.passed,
        checklist,
        evidence,
        by: ctx.id,
        at: now(),
      });
      batch.version++;
      batch.updated_at = now();
      await this.store.putMarkdown(
        this.previewPath(ctx, batch.id),
        batch,
        input.version,
      );
      issue.status = input.passed
        ? "accepted"
        : input.rework === "plan"
          ? "plan"
          : "code";
      await this.writeIssue(ctx, issue);
      await this.comment(
        ctx,
        id,
        `用户逐 Issue 验收：${input.passed ? "通过" : "返工"}\n\n代码：\`${codeRef}\`\n\n${evidence}\n\n${checklist.map((s: string) => `- ${s}`).join("\n")}`,
      );
      return { preview: batch, issue };
    });
  }
  async recordVerification(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "recordVerification", input, async () => {
      const batch = await this.getPreview(ctx, input);
      this.version(batch, input);
      const id = String(input.issueId);
      requireValue(
        batch.issue_ids.includes(id),
        "invalid_input",
        "Issue not in batch",
      );
      const issue = await this.store.markdown<Issue>(this.issuePath(ctx, id));
      requireValue(
        issue.preview_batch === batch.id,
        "stale_preview",
        "This batch is historical; the Issue is associated with another current batch",
        409,
      );
      await this.owner(ctx, issue);
      requireValue(
        issue.status !== "cancel",
        "terminal_issue",
        "Canceled Issue cannot be verified",
        409,
      );
      requireValue(
        ["accepted", "verifying", "ready_merge"].includes(issue.status),
        "invalid_state",
        "Formal verification happens after acceptance",
        409,
      );
      await this.assertDeliveryGate(ctx, issue, "verifying");
      const codeRef = cleanText(
        input.codeRef ?? input.code_ref,
        "codeRef",
        1000,
      );
      requireValue(
        codeRef === issue.code_ref && codeRef === batch.code_refs[id],
        "stale_evidence",
        "Verification must identify current code",
        409,
      );
      requireValue(
        input.kind === "ci" || input.kind === "review",
        "invalid_input",
        "kind must be ci or review",
      );
      requireValue(
        typeof input.passed === "boolean",
        "invalid_input",
        "passed must be true or false",
      );
      const evidence = cleanText(input.evidence, "evidence");
      batch.verifications.push({
        issue_id: id,
        code_ref: codeRef,
        kind: input.kind,
        passed: input.passed,
        evidence,
        by: ctx.id,
        at: now(),
      });
      batch.version++;
      batch.updated_at = now();
      await this.store.putMarkdown(
        this.previewPath(ctx, batch.id),
        batch,
        input.version,
      );
      issue.status = input.passed ? "verifying" : "code";
      await this.writeIssue(ctx, issue);
      await this.comment(
        ctx,
        id,
        `${input.kind === "ci" ? "CI" : "Code Review"}：${input.passed ? "通过" : "失败"}\n\n代码：\`${codeRef}\`\n\n${evidence}`,
      );
      return { preview: batch, issue };
    });
  }
  async members(ctx: CallerContext, input: Input = {}) {
    await this.access(ctx);
    const company = await this.company(ctx);
    const { roster, organization } = await this.organizationState(ctx);
    const { effective } = this.memberColorState(company, roster.members);
    const rows = await Promise.all(
      roster.members.map(async (member) => {
        const a = await this.getAgentInternal(member.agentId);
        const placement =
          member.status === "active"
            ? placementFor(organization, a.agentId) ?? null
            : null;
        return {
          agentId: a.agentId,
          companyId: a.companyId,
          groupId: placement?.nodeId ?? null,
          orgPath: placement ? nodePath(organization, placement.nodeId) : [],
          status: member.status,
          name: a.name,
          role: a.role,
          responsibilities: a.responsibilities,
          avatarColor:
            effective.get(member.agentId) ??
            fallbackAvatarColor(member.agentId),
        };
      }),
    );
    const q = String(input.query ?? "").toLowerCase();
    return rows.filter(
      (a) =>
        !q ||
        `${a.agentId} ${a.name} ${a.role} ${a.responsibilities} ${a.orgPath
          .map((node) => node.name)
          .join(" ")}`
          .toLowerCase()
          .includes(q),
    );
  }
  private async getThread(ctx: CallerContext, id: string) {
    await this.access(ctx);
    const thread = await this.store.markdown<Thread>(
      this.path(ctx, "im", "threads", `${safeId(id, "threadId")}.md`),
    );
    requireValue(
      ctx.type === "user" ||
        [thread.asker_id, thread.recipient_id].includes(ctx.id),
      "forbidden",
      "Not a participant in this thread",
      403,
    );
    return thread;
  }
  private async persistMessage(
    ctx: CallerContext,
    thread: Thread,
    recipientId: string,
    body: string,
    replyTo: string | null,
  ) {
    const files = await this.store.files(this.path(ctx, "im", "messages"));
    const n =
      Math.max(0, ...files.map((f) => Number(/^M(\d+)/.exec(f)?.[1]) || 0)) + 1;
    const message: Message = {
      id: `M${n}`,
      thread_id: thread.id,
      sender_id: ctx.id,
      recipient_id: recipientId,
      reply_to: replyTo,
      created_at: now(),
      delivery_status: "saved",
      late: thread.status !== "open",
      version: 1,
      body: cleanText(body, "body"),
    };
    await this.store.putMarkdown(
      this.path(ctx, "im", "messages", `${message.id}.md`),
      message,
      0,
    );
    return message;
  }
  /** Read-only view of IM messages this process is delivering for a Company. */
  inFlightDeliveries(companyId: string): InFlightDelivery[] {
    return [...this.pendingDeliveries.values()]
      .filter((delivery) => delivery.companyId === companyId)
      .map((delivery) => ({ ...delivery }));
  }
  /** Delivery is a post-save side effect. Receipt is recorded separately from reply. */
  private queueDelivery(ctx: CallerContext, message: Message) {
    const key = `${ctx.companyId}/${message.id}`;
    if (!this.options.deliver || this.pendingDeliveries.has(key)) return;
    this.pendingDeliveries.set(key, {
      companyId: ctx.companyId,
      messageId: message.id,
      threadId: message.thread_id,
      recipientId: message.recipient_id,
      startedAt: now(),
    });
    const attempt = (message.delivery_attempts ?? 0) + 1;
    void this.options
      .deliver({
        companyId: ctx.companyId,
        agentId: message.recipient_id,
        threadId: message.thread_id,
        messageId: message.id,
        requestId: message.id,
        attempt,
        text: `Company IM ${message.thread_id}/${message.id} from ${message.sender_id}\nRead the original via company_im.thread before replying.\n\n${message.body}`,
      })
      .then(async (result) => {
        await this.store.locked(`company:${ctx.companyId}`, async () => {
          const path = this.path(ctx, "im", "messages", `${message.id}.md`);
          const current = await this.store.markdown<Message>(path);
          current.delivery_status = result.status;
          current.delivery_attempts = attempt;
          current.last_attempt_at = now();
          current.version++;
          // delivered 仅表示已送入会话（admission）；unknown 绝不能写 delivered_at。
          if (result.status === "delivered") {
            current.delivered_at = now();
            delete current.delivery_error;
            delete current.delivery_error_code;
            delete current.delivery_disposition;
          } else {
            if (result.error) current.delivery_error = result.error;
            if (result.code) current.delivery_error_code = result.code;
            const disposition =
              result.disposition ??
              (result.status === "unknown" ? "unknown" : undefined);
            if (disposition) current.delivery_disposition = disposition;
          }
          // A receipt is proof of admission; only delivered may persist it.
          if (result.status === "delivered" && result.receipt !== undefined)
            current.receipt = result.receipt;
          await this.store.putMarkdown(path, current);
          await this.store.commit(
            this.store.company(ctx.companyId),
            `Record IM ${message.id} delivery ${result.status}`,
          );
          this.options.onChange?.({
            companyId: ctx.companyId,
            kind: "imDelivery",
            id: message.id,
            agentIds: [message.sender_id, message.recipient_id],
          });
        });
      })
      .catch(async (error) => {
        await this.store.locked(`company:${ctx.companyId}`, async () => {
          const path = this.path(ctx, "im", "messages", `${message.id}.md`);
          const current = await this.store.markdown<Message>(path);
          // A thrown deliver call proves neither success nor non-delivery.
          current.delivery_status = "unknown";
          current.delivery_error = String(
            (error as { message?: unknown } | null)?.message ?? error,
          );
          const code = (error as { code?: unknown } | null)?.code;
          if (typeof code === "string") current.delivery_error_code = code;
          current.delivery_disposition = "unknown";
          current.delivery_attempts = attempt;
          current.last_attempt_at = now();
          current.version++;
          await this.store.putMarkdown(path, current);
          await this.store.commit(
            this.store.company(ctx.companyId),
            `Record IM ${message.id} delivery failure`,
          );
          this.options.onChange?.({
            companyId: ctx.companyId,
            kind: "imDelivery",
            id: message.id,
          });
        });
      })
      .finally(() => this.pendingDeliveries.delete(key));
  }
  async ask(ctx: CallerContext, input: Input) {
    const result = await this.mutate(ctx, "ask", input, async () => {
      requireValue(
        ctx.type === "agent",
        "forbidden",
        "Agent identity required; user inputs belong in Chat",
        403,
      );
      const recipient = await this.getAgentInternal(
        safeId(input.agentId ?? input.recipientId, "recipientId"),
      );
      requireValue(
        recipient.companyId === ctx.companyId && recipient.agentId !== ctx.id,
        "forbidden",
        "Recipient must be another member of this Company",
        403,
      );
      requireValue(
        (await this.memberStatus(ctx.companyId, recipient.agentId)) !==
          "archived",
        "member_archived",
        "Cannot send a new message to an archived member",
        409,
      );
      let thread: Thread;
      if (input.threadId) {
        thread = await this.getThread(ctx, input.threadId);
        requireValue(
          thread.asker_id === ctx.id &&
            thread.recipient_id === recipient.agentId,
          "forbidden",
          "Thread participants do not match",
          403,
        );
        requireValue(
          thread.status === "open",
          "thread_closed",
          "A closed thread cannot be reopened",
          409,
        );
      } else {
        const files = await this.store.files(this.path(ctx, "im", "threads"));
        const n =
          Math.max(
            0,
            ...files.map((f) => Number(/^T(\d+)/.exec(f)?.[1]) || 0),
          ) + 1;
        thread = {
          id: `T${n}`,
          asker_id: ctx.id,
          recipient_id: recipient.agentId,
          status: "open",
          subject: cleanText(input.subject ?? input.body, "subject", 500),
          created_at: now(),
          version: 1,
          body: "",
        };
        await this.store.putMarkdown(
          this.path(ctx, "im", "threads", `${thread.id}.md`),
          thread,
          0,
        );
      }
      const message = await this.persistMessage(
        ctx,
        thread,
        recipient.agentId,
        input.body,
        null,
      );
      return { threadId: thread.id, messageId: message.id, thread, message };
    });
    const current = await this.store.markdown<Message>(
      this.path(ctx, "im", "messages", `${result.messageId}.md`),
    );
    if (current.delivery_status === "saved") this.queueDelivery(ctx, current);
    return { ...result, message: current };
  }
  async reply(ctx: CallerContext, input: Input) {
    const result = await this.mutate(ctx, "reply", input, async () => {
      requireValue(
        ctx.type === "agent",
        "forbidden",
        "Agent identity required",
        403,
      );
      const thread = await this.getThread(ctx, input.threadId);
      const replyTo = safeId(input.messageId ?? input.replyTo, "messageId");
      const original = await this.store.markdown<Message>(
        this.path(ctx, "im", "messages", `${replyTo}.md`),
      );
      requireValue(
        original.thread_id === thread.id,
        "invalid_input",
        "Reply target is not in this thread",
      );
      const recipientId =
        thread.asker_id === ctx.id ? thread.recipient_id : thread.asker_id;
      const message = await this.persistMessage(
        ctx,
        thread,
        recipientId,
        input.body,
        replyTo,
      );
      return { threadId: thread.id, messageId: message.id, thread, message };
    });
    const current = await this.store.markdown<Message>(
      this.path(ctx, "im", "messages", `${result.messageId}.md`),
    );
    if (current.delivery_status === "saved") this.queueDelivery(ctx, current);
    return { ...result, message: current };
  }
  async inbox(ctx: CallerContext, input: Input = {}) {
    await this.access(ctx);
    if (ctx.type === "agent")
      requireValue(
        input.agentId === undefined || input.agentId === ctx.id,
        "forbidden",
        "Agents can only read their own inbox; use thread(threadId) for a thread you participate in",
        403,
      );
    const agentId =
      ctx.type === "agent" ? ctx.id : safeId(input.agentId, "agentId");
    requireValue(
      (await this.getAgentInternal(agentId)).companyId === ctx.companyId,
      "forbidden",
      "Wrong Company",
      403,
    );
    const items: Message[] = [];
    for (const f of await this.store.files(this.path(ctx, "im", "messages"))) {
      const row = await this.store.markdown<Message>(
        this.path(ctx, "im", "messages", f),
      );
      if (row.recipient_id === agentId) items.push(row);
    }
    const offset = Math.max(0, Number(input.cursor) || 0);
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 30));
    return {
      items: items.slice(offset, offset + limit),
      nextCursor: offset + limit < items.length ? String(offset + limit) : null,
    };
  }
  async thread(ctx: CallerContext, input: Input) {
    const thread = await this.getThread(ctx, input.threadId);
    const messages: Message[] = [];
    for (const f of await this.store.files(this.path(ctx, "im", "messages"))) {
      const row = await this.store.markdown<Message>(
        this.path(ctx, "im", "messages", f),
      );
      if (row.thread_id === thread.id) messages.push(row);
    }
    const offset = Math.max(0, Number(input.cursor) || 0);
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 30));
    return {
      thread,
      items: messages.slice(offset, offset + limit),
      nextCursor:
        offset + limit < messages.length ? String(offset + limit) : null,
    };
  }
  async closeThread(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "closeThread", input, async () => {
      const thread = await this.getThread(ctx, input.threadId);
      requireValue(
        ctx.type === "agent" && thread.asker_id === ctx.id,
        "forbidden",
        "Only the asking Agent may close this thread",
        403,
      );
      this.version(thread, input);
      requireValue(
        input.status === "resolved" || input.status === "withdrawn",
        "invalid_input",
        "status must be resolved or withdrawn",
      );
      thread.status = input.status;
      thread.version++;
      await this.store.putMarkdown(
        this.path(ctx, "im", "threads", `${thread.id}.md`),
        thread,
        input.version,
      );
      return thread;
    });
  }
  async workspace(ctx: CallerContext, input: Input) {
    const agent = await this.getAgent(ctx, input);
    const issues = await this.listIssues(ctx, { agentId: agent.agentId });
    const previews: Preview[] = [];
    for (const f of await this.store.files(this.path(ctx, "previews"))) {
      const p = await this.store.markdown<Preview>(
        this.path(ctx, "previews", f),
      );
      if (
        p.owner_id === agent.agentId ||
        p.collaborators.includes(agent.agentId) ||
        issues.some((i) => i.preview_batch === p.id)
      )
        previews.push(p);
    }
    const threads: Thread[] = [];
    for (const f of await this.store.files(this.path(ctx, "im", "threads"))) {
      const t = await this.store.markdown<Thread>(
        this.path(ctx, "im", "threads", f),
      );
      if ([t.asker_id, t.recipient_id].includes(agent.agentId)) threads.push(t);
    }
    return {
      companyId: ctx.companyId,
      agentId: agent.agentId,
      agent,
      issues,
      previews,
      threads,
    };
  }
}
