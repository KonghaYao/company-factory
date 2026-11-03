import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { CompanyDomain, DomainError, type CallerContext } from "../domain";
import {
  PeriRuntime,
  WorkspaceViewAdapter,
  FileStoreProvider,
  ExplicitFirstStoreProvider,
  sharedSqldProviderFromEnv,
  toChatActionRuntimeError,
  type StoreProvider,
} from "../runtime";
import { AccessControl, AccessError } from "./security";
import { publicErrorDetails } from "./peri/errors";
import { redactPublicMessage, redactRuntimeMessage } from "../runtime/redaction";
import { createPeriChatApi } from "./peri/chat-api";
import { createDiagnosticsApi } from "./diagnostics-api";
import {
  disabledDiagnostics,
  openRuntimeDiagnostics,
  type DiagnosticsOptions,
  type DiagnosticsSink,
} from "../runtime/diagnostics";
import { AgentService } from "./agent-service";
import { AgentWorkNotices } from "./agent-work-notices";
import { AgentContextView } from "../domain/agent-context";
import { createCompanyMcp } from "./mcp";
import { MODULE_OPERATIONS, type CompanyModule } from "./operations";
import {
  RestartReadiness,
  RestartReadinessError,
  type RestartReadinessService,
} from "./restart-readiness";
import packageJson from "../../package.json";

export type ApplicationOptions = {
  root?: string;
  baseUrl?: string;
  periBinary?: string;
  storeProvider?: StoreProvider;
  storesFile?: string;
  webToken?: string;
  staticRoot?: string;
  /** Enabled explicitly by the server entrypoint; omitted in tests that do not exercise diagnostics. */
  diagnostics?: DiagnosticsOptions | false;
  /** Narrow injection point for restart-gate tests; production constructs the default. */
  readiness?: RestartReadinessService;
};
export async function createApplication(options: ApplicationOptions = {}) {
  const root = resolve(
    options.root ?? process.env.COMPANY_HOME ?? join(homedir(), ".company"),
  );
  const baseUrl =
    options.baseUrl ?? process.env.COMPANY_BASE_URL ?? "http://127.0.0.1:3000";
  const storesFile = options.storesFile ?? process.env.COMPANY_WASM_STORES_FILE;
  // 显式 stores 优先；显式 scope 缺配时才回退到宿主自动供给的单一共享 sqld。
  const sharedStores = options.storeProvider
    ? undefined
    : sharedSqldProviderFromEnv();
  const storeProvider =
    options.storeProvider ??
    (sharedStores
      ? new ExplicitFirstStoreProvider(
          new FileStoreProvider({ root, file: storesFile }),
          sharedStores,
        )
      : undefined);
  await mkdir(root, { recursive: true });
  const ownerTokenFile = join(root, "owner-token");
  let ownerToken = options.webToken ?? process.env.COMPANY_WEB_TOKEN;
  if (!ownerToken) {
    try {
      ownerToken = (await readFile(ownerTokenFile, "utf8")).trim();
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      ownerToken = randomBytes(32).toString("hex");
      await writeFile(ownerTokenFile, ownerToken + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    }
  }
  const access = new AccessControl(root, baseUrl, ownerToken);
  const diagnostics: DiagnosticsSink =
    options.diagnostics === false || options.diagnostics === undefined
      ? disabledDiagnostics
      : await openRuntimeDiagnostics(options.diagnostics);
  const pendingTokens = new Map<string, CallerContext>();
  const authenticate = access.agent.bind(access);
  access.agent = async (request) => {
    access.allowed(request);
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (token && pendingTokens.has(token)) return pendingTokens.get(token)!;
    return authenticate(request);
  };
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  let mcp: ReturnType<typeof createCompanyMcp> | undefined;
  const emit = (event: Record<string, unknown>) => {
    mcp?.changed();
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        listeners.delete(fn);
      }
    }
  };
  const runtime = new PeriRuntime({
    root,
    periBinary: options.periBinary ?? process.env.PERI_BINARY,
    storeProvider,
    storesFile,
    diagnostics,
    onChange: (scope) => emit({ ...scope, kind: "runtime" }),
  });
  const files = new WorkspaceViewAdapter({
    periBinary: runtime.binary,
    home: join(root, "runtime", "home"),
    companyHome: root,
  });
  let agents: AgentService;
  const domain = new CompanyDomain({
    root,
    baseUrl,
    provisionAgent: async (input) => {
      const token = (input as any).authToken;
      if (token)
        pendingTokens.set(token, {
          type: "agent",
          id: input.agentId,
          companyId: input.companyId,
        });
      try {
        return await runtime.provision(input);
      } catch (error) {
        if (token) pendingTokens.delete(token);
        throw error;
      }
    },
    deliver: async (input) => {
      const recordFailure = (failure: {
        error?: string;
        code?: string;
        disposition?: "rejected" | "not_sent" | "unknown";
        uncertain?: boolean;
      }) => {
        diagnostics.record({
          event: "im_delivery_failed",
          companyId: input.companyId,
          agentId: input.agentId,
          messageId: input.messageId,
          threadId: input.threadId,
          attempt: input.attempt,
          code: failure.code,
          disposition: failure.disposition,
          uncertain: failure.uncertain,
          message: failure.error
            ? redactRuntimeMessage(failure.error, 500)
            : undefined,
        });
      };
      try {
        const receipt = await agents.deliver(input);
        if (receipt.status === "delivered")
          return { status: "delivered" as const, receipt };
        recordFailure({
          error: receipt.error,
          code: receipt.code,
          disposition: receipt.disposition,
          uncertain: receipt.uncertain,
        });
        return {
          status: receipt.status,
          error: receipt.error,
          code: receipt.code,
          disposition: receipt.disposition,
          uncertain: receipt.uncertain,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown } | null)?.code;
        recordFailure({
          error: message,
          code: typeof code === "string" ? code : undefined,
          disposition: "unknown",
          uncertain: true,
        });
        return {
          status: "unknown" as const,
          error: message,
          disposition: "unknown" as const,
          uncertain: true,
        };
      }
    },
    onChange: (event) => emit(event),
  });
  agents = new AgentService(domain, runtime);
  const notices = new AgentWorkNotices(domain, agents, emit);
  const readiness: RestartReadinessService =
    options.readiness ??
    new RestartReadiness({
      domain,
      runtime,
      notices,
      version: packageJson.version,
    });
  const agentContext = new AgentContextView(domain);
  const dispatch = async (
    module: CompanyModule,
    operation: string,
    caller: CallerContext,
    input: Record<string, unknown>,
  ) => {
    if (
      !(MODULE_OPERATIONS[module] as readonly string[] | undefined)?.includes(
        operation,
      )
    )
      throw new DomainError("not_found", "Unknown Company operation", 404);
    const normalized = { ...input };
    if (normalized.expectedVersion !== undefined) {
      normalized.version = normalized.expectedVersion;
      delete normalized.expectedVersion;
    }
    if (["ask", "reply"].includes(operation) && normalized.text !== undefined) {
      normalized.body = normalized.text;
      delete normalized.text;
    }
    if (operation === "ask" && normalized.toAgentId !== undefined) {
      normalized.recipientId = normalized.toAgentId;
      delete normalized.toAgentId;
    }
    if (caller.type === "agent" && module === "company_tasks") {
      if (operation === "listIssues")
        return agentContext.issues(caller, normalized);
      if (operation === "workspace")
        return agentContext.workspace(caller, normalized);
    }
    const method = operation === "listPipelines" ? "pipelines" : operation;
    const handler = (domain as any)[method];
    if (typeof handler !== "function")
      throw new DomainError(
        "unsupported_operation",
        "Operation is not available",
        404,
      );
    const result = await handler.call(domain, caller, normalized);
    const notification = await notices.afterOperation(
      caller,
      operation,
      normalized,
      result,
    );
    return notification
      ? {
          ...result,
          notification,
          ...(operation === "answerDecision" ? { delivery: notification } : {}),
        }
      : result;
  };
  mcp = createCompanyMcp(access, dispatch);
  const app = new Hono();
  app.onError((error, c) => {
    // bind/restart 阶段的 SDK chat 动作错误不经 executeControl，也按同一契约映射。
    const e = toChatActionRuntimeError(error) ?? (error as any);
    const status = typeof e.status === "number" ? e.status : 500;
    const message = redactPublicMessage(
      String(e.message ?? "请求失败；诊断已记录"),
    );
    console.error(`[${e.code ?? "internal_error"}] ${message}`);
    // 全局兜底只回传脱敏后的标量诊断，不把任意 details 对象/凭据带给客户端。
    const details = publicErrorDetails(e.details);
    return c.json(
      {
        error: {
          code: e.code ?? "internal_error",
          message,
          ...(details ? { details } : {}),
        },
      },
      status,
    );
  });
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "company-factory",
      version: packageJson.version,
      mcpModules: Object.keys(MODULE_OPERATIONS),
      runtime:
        "@peri-code/sdk@0.4.0 WASM + local sqld (explicit or host-provisioned shared)",
      storage: {
        sharedSqld: sharedStores ? "enabled" : "disabled",
      },
      workspace:
        process.env.COMPANY_WORKSPACE === "disabled"
          ? "disabled (COMPANY_WORKSPACE=disabled)"
          : "official Peri 4.4.1 Workspace MCP (local, no OS sandbox)",
    }),
  );
  app.post("/api/login", async (c) => {
    const body = await c.req.json();
    c.header("Set-Cookie", access.login(c.req.raw, String(body.token ?? "")));
    return c.json({ ok: true });
  });
  app.get("/api/companies", async (c) => {
    access.user(c.req.raw, "");
    return c.json({ companies: await domain.listCompanies() });
  });
  // Owner-only, read-only model library projection. Never returns endpoint or
  // credential values; the UI compares `revision` with the applied snapshot.
  app.get("/api/model-library", async (c) => {
    access.user(c.req.raw, "");
    return c.json(runtime.modelLibrary());
  });
  app.get("/api/companies/:companyId", async (c) => {
    const ctx = access.user(c.req.raw, c.req.param("companyId"));
    const org = await domain.organization(ctx);
    const issues = await domain.listIssues(ctx);
    return c.json({
      ...org,
      agents: await Promise.all(
        org.agents.map(async (a) => ({
          ...a,
          ...(await agents.snapshot(ctx, a.agentId)),
          needs_user: issues.some(
            (i) => i.agent_id === a.agentId && i.needs_user,
          ),
        })),
      ),
    });
  });
  // Owner-only pending-decision inbox. Minimal projection; never exposes Issue bodies.
  app.get("/api/decisions/pending", async (c) => {
    const companyId = c.req.query("companyId")?.trim();
    if (!companyId)
      throw new AccessError("company_required", "companyId is required", 400);
    const caller = access.user(c.req.raw, companyId);
    return c.json({ items: await domain.listPendingDecisions(caller) });
  });
  // Owner-only restart gate. Agent bearer credentials are not owner sessions, so
  // they receive 401 here. This endpoint is not exposed through Company MCP.
  app.get("/api/restart-readiness", async (c) => {
    access.user(c.req.raw, "");
    const companyId = c.req.query("companyId")?.trim() || undefined;
    try {
      const result = await readiness.check(companyId ? { companyId } : {});
      const status = !result.verified
        ? 503
        : result.safeToRestart
          ? 200
          : 409;
      return c.json(result, status);
    } catch (error) {
      if (error instanceof RestartReadinessError)
        return c.json(
          {
            error: {
              code: error.code,
              message: redactPublicMessage(error.message),
            },
          },
          error.status as 404,
        );
      throw error;
    }
  });
  app.post("/api/action", async (c) => {
    const body = await c.req.json();
    const module = body.module as CompanyModule;
    const caller = access.user(c.req.raw, String(body.companyId ?? ""));
    return c.json(
      await dispatch(module, String(body.operation), caller, body.input ?? {}),
    );
  });
  app.all("/:module/mcp", async (c) => {
    if (!Object.keys(MODULE_OPERATIONS).includes(c.req.param("module")))
      return c.json({ error: { code: "not_found" } }, 404);
    return mcp!.fetch(c.req.raw);
  });
  const scope = (c: any, body?: any) => ({
    caller: access.user(
      c.req.raw,
      String(body?.companyId ?? c.req.query("companyId") ?? ""),
    ),
    agentId: c.req.param("agentId") as string,
  });
  /**
   * Peri Chat 官方协议面：/api/chats、actions、payload、projects 与 /sync WS。
   * 鉴权 → Agent 归属 → runtime 归属都在路由内部完成；必须先于 SPA 回退挂载。
   */
  const chatScope = async (c: Context) => {
    const companyId = String(c.req.query("companyId") ?? "");
    if (!companyId)
      throw new AccessError("company_required", "companyId is required", 400);
    const agentId = String(c.req.query("agentId") ?? "");
    if (!agentId)
      throw new AccessError("agent_required", "agentId is required", 400);
    const caller = access.user(c.req.raw, companyId);
    const agent = await agents.binding(caller, agentId);
    return { caller, agent, input: agents.input(agent) };
  };
  app.route(
    "/",
    createDiagnosticsApi({ diagnostics, access }),
  );
  app.route(
    "/",
    createPeriChatApi({
      runtime,
      scope: chatScope,
      restart: (caller, agentId, options) =>
        agents.restart(caller, agentId, options),
      diagnostics,
    }),
  );
  app.get("/api/agents/:agentId/workspace", async (c) => {
    const { caller, agentId } = scope(c);
    const workspace = await domain.workspace(caller, { agentId });
    return c.json({
      ...workspace,
      notices: await notices.list(caller, agentId),
      runtime: await agents.snapshot(caller, agentId),
    });
  });
  app.get("/api/agents/:agentId/notices", async (c) => {
    const { caller, agentId } = scope(c);
    return c.json(await notices.list(caller, agentId));
  });
  app.get("/api/agents/:agentId/notices/:noticeId", async (c) => {
    const { caller, agentId } = scope(c);
    return c.json(await notices.get(caller, agentId, c.req.param("noticeId")));
  });
  app.post("/api/agents/:agentId/notices/:noticeId/retry", async (c) => {
    const { caller, agentId } = scope(c, await c.req.json());
    return c.json(
      await notices.retry(caller, agentId, c.req.param("noticeId")),
    );
  });
  app.get("/api/agents/:agentId/runtime", async (c) => {
    const { caller, agentId } = scope(c);
    return c.json(await agents.snapshot(caller, agentId));
  });
  app.get("/api/agents/:agentId/configuration", async (c) => {
    const { caller, agentId } = scope(c);
    return c.json(await agents.configuration(caller, agentId));
  });
  app.post("/api/agents/:agentId/configuration", async (c) => {
    const body = await c.req.json();
    const { caller, agentId } = scope(c, body);
    return c.json(await agents.save(caller, agentId, body));
  });
  app.post("/api/agents/:agentId/restart", async (c) => {
    const body = await c.req.json();
    const { caller, agentId } = scope(c, body);
    return c.json(await agents.restart(caller, agentId));
  });
  // 旧聊天 HTTP 面已退役：chat 只经 /api/chats/* 与 /api/chats/:id/sync 驱动。
  // AgentService 的 send/stop/queue/answer 仍保留给 IM/MCP 内部调用。
  app.get("/api/events", async (c) => {
    const caller = access.user(
      c.req.raw,
      String(c.req.query("companyId") ?? ""),
    );
    await domain.organization(caller);
    const agentId = c.req.query("agentId");
    if (agentId) await agents.binding(caller, agentId);
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const fn = (event: Record<string, unknown>) => {
          if (
            event.companyId === caller.companyId &&
            (!event.agentId || !agentId || event.agentId === agentId)
          )
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
        };
        listeners.add(fn);
        const interval = setInterval(
          () => controller.enqueue(encoder.encode(": heartbeat\n\n")),
          15000,
        );
        cleanup = () => {
          listeners.delete(fn);
          clearInterval(interval);
        };
        controller.enqueue(encoder.encode(": ready\n\n"));
        c.req.raw.signal.addEventListener("abort", () => {
          cleanup();
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });
  const fileInput = async (c: any, body?: any) => {
    const { caller, agentId } = scope(c, body);
    const a = await agents.binding(caller, agentId);
    return agents.input(a);
  };
  app.get("/api/agents/:agentId/files", async (c) =>
    c.json(await files.list(await fileInput(c), c.req.query("path"))),
  );
  app.get("/api/agents/:agentId/files/read", async (c) =>
    c.json(
      await files.read(await fileInput(c), String(c.req.query("path") ?? "")),
    ),
  );
  app.post("/api/agents/:agentId/files/save", async (c) => {
    const body = await c.req.json();
    return c.json(
      await files.save(
        await fileInput(c, body),
        String(body.path ?? ""),
        String(body.content ?? ""),
        String(body.expectedVersion ?? ""),
      ),
    );
  });
  app.get("/api/agents/:agentId/files/search", async (c) =>
    c.json(
      await files.search(
        await fileInput(c),
        String(c.req.query("q") ?? ""),
        c.req.query("path"),
      ),
    ),
  );
  app.get("/api/agents/:agentId/files/diff", async (c) =>
    c.json(
      await files.diff(await fileInput(c), String(c.req.query("path") ?? "")),
    ),
  );
  app.get("/api/agents/:agentId/files/changes", async (c) =>
    c.json(await files.changes(await fileInput(c))),
  );
  app.get("/api/agents/:agentId/files/capabilities", async (c) =>
    c.json(await files.capabilities(await fileInput(c))),
  );
  app.post("/api/agents/:agentId/files/commit", async (c) => {
    const body = await c.req.json();
    return c.json(
      await files.commit(await fileInput(c, body), String(body.message ?? "")),
    );
  });
  const staticRoot = options.staticRoot ?? resolve("dist/web");
  app.use("/assets/*", serveStatic({ root: staticRoot }));
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/"))
      return c.json(
        { error: { code: "not_found", message: "Unknown API route" } },
        404,
      );
    access.allowed(c.req.raw);
    const index = Bun.file(join(staticRoot, "index.html"));
    if (!(await index.exists()))
      return c.text("Build the workbench first: npm run build", 503);
    return c.html(await index.text());
  });
  return {
    app,
    domain,
    runtime,
    agents,
    files,
    access,
    mcp,
    notices,
    readiness,
    diagnostics,
    root,
    baseUrl,
    ownerToken,
    dispatch,
    async close() {
      await notices.close();
      const results = await Promise.allSettled([
        mcp!.close(),
        files.shutdown(),
        runtime.shutdown(),
      ]);
      if (sharedStores)
        results.push(...(await Promise.allSettled([sharedStores.close()])));
      // Diagnostics shutdown must never change the application close result.
      await diagnostics.close().catch(() => {});
      if (results.some((result) => result.status === "rejected"))
        throw new Error(
          "应用关闭未确认；Workspace/WASM/共享 sqld handle 已保留，请重试关闭。",
        );
    },
  };
}
