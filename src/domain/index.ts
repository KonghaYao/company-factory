import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CompanyStore, safeId, digest } from "../storage/company-store";
import { z } from "zod";
import {
  LEGACY_MEMORY_FILE,
  MEMORY_FILE,
  assertNoManagedMarkers,
  memoryManagedBlock,
  memoryTemplate,
  mergeManagedBlock,
  softwarePipeline,
} from "./templates";
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
  type AgentConfig,
  type IssueStatus,
} from "./types";
export * from "./types";
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
const promptText = (v: unknown) => {
  requireValue(
    typeof v === "string" && v.length <= 100000,
    "invalid_input",
    "systemPrompt must be text (at most 100000 characters)",
  );
  return v;
};
const publicAgent = (a: InternalAgent): AgentRecord => {
  const { authToken, ...rest } = a;
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
  private readonly pendingDeliveries = new Set<string>();
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
  private async roster(ctx: CallerContext): Promise<{
    version: number;
    members: { agentId: string; groupId: string; role: string }[];
  }> {
    return this.store.yaml(this.path(ctx, "roster.yaml"));
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
      )
        return { type: "agent", id: a.agentId, companyId: a.companyId };
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
        issue.history.some((h) => h.from === a.agentId || h.to === a.agentId),
      "forbidden",
      "Agent is not associated with this Issue",
      403,
    );
  }
  private version(record: { version: number }, input: Input) {
    requireValue(
      Number.isInteger(input.version),
      "invalid_input",
      "version is required",
    );
    requireValue(
      record.version === input.version,
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
      safeId(input.requestId, "requestId (required for mutations)");
      let requestPath: string | undefined;
      const requestHash = digest(input);
      if (input.requestId) {
        safeId(input.requestId, "requestId");
        requestPath = this.path(
          ctx,
          "events",
          "requests",
          `${digest(`${ctx.type}:${ctx.id}:${operation}:${input.requestId}`)}.yaml`,
        );
        if (await this.store.exists(requestPath)) {
          const saved = await this.store.yaml(requestPath);
          requireValue(
            saved.hash === requestHash,
            "idempotency_conflict",
            "Request ID was already used with different input",
            409,
          );
          return saved.result as T;
        }
      }
      const result = await fn();
      if (requestPath)
        await this.store.putYaml(requestPath, {
          operation,
          actor: ctx.id,
          request_id: input.requestId,
          hash: requestHash,
          at: now(),
          result,
        });
      await this.store.commit(
        this.store.company(ctx.companyId),
        `${operation} by ${ctx.type}:${ctx.id}`,
      );
      this.options.onChange?.({ companyId: ctx.companyId, kind: operation });
      return result;
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
            developer: { permissions: [] },
            preview: { permissions: [] },
            reviewer: { permissions: [] },
          },
          created_at: now(),
          version: 1,
        };
        await this.store.putYaml(join(root, "company.yaml"), company);
        await this.store.putYaml(join(root, "groups.yaml"), {
          version: 1,
          groups: [
            {
              id: "headquarters",
              name: "总部",
              responsibilities: "组织建设与任务协调",
            },
          ],
        });
        await this.store.putYaml(join(root, "roster.yaml"), {
          version: 1,
          members: [],
        });
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
        ];
        for (const definition of definitions) {
          const roster = await this.roster(cctx);
          if (!roster.members.some((a) => a.agentId === definition.agentId))
            await this.provision(cctx, definition);
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
    const { groups } = await this.store.yaml<{ groups: Group[] }>(
      this.path(ctx, "groups.yaml"),
    );
    const roster = await this.roster(ctx);
    const agents = await Promise.all(
      roster.members.map(async (m) =>
        publicAgent(await this.getAgentInternal(m.agentId)),
      ),
    );
    return {
      company,
      groups,
      agents:
        ctx.type === "user"
          ? agents
          : agents.map(
              ({
                agentId,
                companyId,
                groupId,
                name,
                role,
                responsibilities,
              }) => ({
                agentId,
                companyId,
                groupId,
                name,
                role,
                responsibilities,
              }),
            ),
    };
  }
  async createGroup(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "createGroup", input, async () => {
      await this.role(ctx, ["hr"]);
      const id = safeId(input.id, "groupId");
      const data = await this.store.yaml<{ version: number; groups: Group[] }>(
        this.path(ctx, "groups.yaml"),
      );
      requireValue(
        !data.groups.some((g) => g.id === id),
        "already_exists",
        "Group exists",
        409,
      );
      const group = {
        id,
        name: cleanText(input.name, "name", 200),
        responsibilities: String(input.responsibilities ?? ""),
      };
      data.groups.push(group);
      data.version++;
      await this.store.putYaml(this.path(ctx, "groups.yaml"), data);
      return group;
    });
  }
  private async provision(ctx: CallerContext, input: Input) {
    return this.store.locked(`agent:${safeId(input.agentId, "agentId")}`, () =>
      this.provisionLocked(ctx, input),
    );
  }
  private async provisionLocked(ctx: CallerContext, input: Input) {
    const agentId = safeId(input.agentId, "agentId");
    const dir = this.store.agent(agentId);
    requireValue(
      !(await this.store.exists(join(dir, "agent.yaml"))),
      "already_exists",
      "Agent ID already exists globally",
      409,
    );
    const groupId = safeId(input.groupId, "groupId");
    const role = safeId(input.role, "role");
    const groups = await this.store.yaml<{ groups: Group[] }>(
      this.path(ctx, "groups.yaml"),
    );
    requireValue(
      groups.groups.some((g) => g.id === groupId),
      "not_found",
      "Group does not exist",
      404,
    );
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
      groupId,
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
      groupId,
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
    const roster = await this.roster(ctx);
    roster.members.push({ agentId, groupId, role });
    roster.version++;
    await this.store.putYaml(this.path(ctx, "roster.yaml"), roster);
    // 显式降级只关闭宿主 Workspace，不为 Agent 仓库增加无沙箱 Git 路径。
    // 初始化提交不承载事件或幂等状态；其余内部/用户触发的 Git 仍按原边界 fail closed。
    if (process.env.COMPANY_WORKSPACE !== "disabled")
      await this.store.commit(dir, `Provision ${name} with fixed Session`);
    return publicAgent(agent);
  }
  async createMember(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "createMember", input, async () => {
      await this.role(ctx, ["hr"], false);
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
      a.version++;
      await this.store.putYaml(
        join(a.directory, "agent.yaml"),
        a,
        input.version,
      );
      const existing = await this.readAgentMemory(a.directory);
      const block = memoryManagedBlock({
        role: a.role,
        responsibilities: a.responsibilities,
        systemPrompt: a.systemPrompt,
        instructions:
          typeof a.config.instructions === "string" ? a.config.instructions : "",
      });
      const memory = existing
        ? mergeManagedBlock(existing.content, block)
        : memoryTemplate({
            name: a.name,
            role: a.role,
            responsibilities: a.responsibilities,
            systemPrompt: a.systemPrompt,
            instructions:
              typeof a.config.instructions === "string"
                ? a.config.instructions
                : "",
            knowledgeDirectory: this.path(ctx, "knowledgebase"),
          });
      await this.store.atomic(join(a.directory, MEMORY_FILE), memory);
      // Only migrate when the legacy file was the sole memory entry. If both
      // names already existed, leave the conflict untouched for the user.
      if (existing?.legacy) {
        const entries = await readdir(a.directory);
        if (entries.includes(LEGACY_MEMORY_FILE)) {
          if (entries.includes(MEMORY_FILE))
            await unlink(join(a.directory, LEGACY_MEMORY_FILE));
          else
            await rename(
              join(a.directory, LEGACY_MEMORY_FILE),
              join(a.directory, MEMORY_FILE),
            );
        }
      }
      await this.store.commit(a.directory, "Update member definition");
      return publicAgent(a);
    });
  }
  private async readAgentMemory(directory: string) {
    // Use exact directory entries rather than existsSync/readFile so a legacy
    // lowercase name is not mistaken for the canonical one on macOS.
    const entries = await readdir(directory);
    if (entries.includes(MEMORY_FILE))
      return {
        content: await readFile(join(directory, MEMORY_FILE), "utf8"),
        legacy: false,
      };
    if (entries.includes(LEGACY_MEMORY_FILE))
      return {
        content: await readFile(join(directory, LEGACY_MEMORY_FILE), "utf8"),
        legacy: true,
      };
    return null;
  }
  async setRolePermissions(ctx: CallerContext, input: Input) {
    return this.mutate(ctx, "setRolePermissions", input, async () => {
      await this.role(ctx, ["hr"]);
      const c = await this.company(ctx);
      this.version(c, input);
      const role = safeId(input.role, "role");
      requireValue(
        Array.isArray(input.permissions) &&
          input.permissions.every((p: unknown) => p === "issue.create"),
        "invalid_input",
        "Phase one supports issue.create only",
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
      a.effectiveConfig = structuredClone(a.config);
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
      all.push(await this.store.markdown(this.path(ctx, "tasks", file)));
    const agentId = input.agentId ?? (ctx.type === "agent" ? ctx.id : null);
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
          i.history.some((h) => h.from === agentId || h.to === agentId),
      );
    }
    return all;
  }
  async getIssue(ctx: CallerContext, input: Input): Promise<Issue> {
    const issue = await this.store.markdown<Issue>(
      this.issuePath(ctx, String(input.issueId)),
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
      const roster = await this.roster(ctx);
      const supervisor = roster.members.find(
        (a) => a.role === "task-supervisor",
      );
      requireValue(
        supervisor,
        "invalid_state",
        "Company has no task supervisor",
      );
      const files = await this.store.files(this.path(ctx, "tasks"));
      const id = String(
        Math.max(0, ...files.map((f) => Number.parseInt(f) || 0)) + 1,
      );
      const issue: Issue = {
        id,
        title: cleanText(input.title, "title", 500),
        type: null,
        pipeline: null,
        status: "triage",
        agent_id: supervisor.agentId,
        summary: String(input.summary ?? ""),
        progress: "",
        needs_user: false,
        decisions: [],
        preview_batch: null,
        collaborators: [],
        history: [],
        code_ref: null,
        plan_ref: null,
        worktree: null,
        created_at: now(),
        updated_at: now(),
        version: 1,
        body: String(
          input.body ?? "## 目标与验收要求\n\n## 工作记录\n\n## 交付物\n",
        ),
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
      await this.role(ctx, ["task-supervisor"]);
      const issue = await this.store.markdown<Issue>(
        this.issuePath(ctx, String(input.issueId)),
      );
      this.version(issue, input);
      requireValue(
        issue.status !== "cancel",
        "terminal_issue",
        "Canceled Issue cannot be reassigned",
        409,
      );
      const target = await this.getAgentInternal(
        safeId(input.agentId, "agentId"),
      );
      requireValue(
        target.companyId === ctx.companyId,
        "forbidden",
        "Cannot assign outside Company",
        403,
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
        for (const id of input.collaborators)
          requireValue(
            (await this.getAgentInternal(safeId(id))).companyId ===
              ctx.companyId,
            "forbidden",
            "Collaborator outside Company",
            403,
          );
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
      issue.decisions.push({
        id,
        question: cleanText(input.question, "question"),
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
      if (existing)
        for (const removedId of existing.issue_ids.filter(
          (i) => !ids.includes(i),
        )) {
          const issue = await this.store.markdown<Issue>(
            this.issuePath(ctx, removedId),
          );
          if (issue.preview_batch === id) {
            issue.preview_batch = null;
            if (issue.status === "preview") issue.status = "ready_preview";
            await this.writeIssue(ctx, issue);
          }
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
    const roster = await this.roster(ctx);
    const rows = await Promise.all(
      roster.members.map(async (m) => {
        const a = await this.getAgentInternal(m.agentId);
        return {
          agentId: a.agentId,
          companyId: a.companyId,
          groupId: a.groupId,
          name: a.name,
          role: a.role,
          responsibilities: a.responsibilities,
        };
      }),
    );
    const q = String(input.query ?? "").toLowerCase();
    return rows.filter(
      (a) =>
        !q ||
        `${a.agentId} ${a.name} ${a.role} ${a.responsibilities}`
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
  /** Delivery is a post-save side effect. Receipt is recorded separately from reply. */
  private queueDelivery(ctx: CallerContext, message: Message) {
    const key = `${ctx.companyId}/${message.id}`;
    if (!this.options.deliver || this.pendingDeliveries.has(key)) return;
    this.pendingDeliveries.add(key);
    void this.options
      .deliver({
        companyId: ctx.companyId,
        agentId: message.recipient_id,
        threadId: message.thread_id,
        messageId: message.id,
        text: `Company IM ${message.thread_id}/${message.id} from ${message.sender_id}\nRead the original via company_im.thread before replying.\n\n${message.body}`,
      })
      .then(async (result) => {
        await this.store.locked(`company:${ctx.companyId}`, async () => {
          const path = this.path(ctx, "im", "messages", `${message.id}.md`);
          const current = await this.store.markdown<Message>(path);
          current.delivery_status = result.status;
          current.version++;
          if (result.status === "delivered") current.delivered_at = now();
          if (result.error) current.delivery_error = result.error;
          if (result.receipt !== undefined) current.receipt = result.receipt;
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
          current.delivery_status = "failed";
          current.delivery_error = String(error?.message ?? error);
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
