import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { upgradeWebSocket } from "@hono/bun";
import {
  ChatCloseIncompleteError,
  ChatUserAction,
  parseChatUserAction,
  type ChatBindingTarget,
  type ChatService,
  type ChatServiceContract,
  type ChatUserAction as ChatUserActionValue,
  type ReadPayloadOptions,
  type ToolPayloadResponse,
} from "@peri-code/sdk";
import type { AgentRecord, CallerContext } from "../../domain";
import { RuntimeError, type PeriRuntime, type RuntimeAgent } from "../../runtime";
import { chatNotFound, closeIncomplete, mapChatActionError, mapPayloadError } from "./errors";
import { logError } from "./logging";
import {
  SYNC_PATH,
  syncEvents,
  syncUpgradeGuard,
  type SyncEnv,
} from "./sync";

/** Company 语义：每个 Agent 一个固定 Session，HTTP/WS 都必须落在该 scope。 */
export interface ChatScope {
  caller: CallerContext;
  agent: AgentRecord;
  input: RuntimeAgent;
}

export interface PeriChatApiDeps {
  runtime: PeriRuntime;
  /** 解析 companyId+agentId 的调用者；鉴权失败必须抛错，不能降级为匿名。 */
  scope(c: Context): Promise<ChatScope>;
  /** DELETE = 重启同一 Session（运行中由路由前置拒绝）。 */
  restart(caller: CallerContext, agentId: string): Promise<unknown>;
}

interface ActionTarget {
  sessionId: string | null;
  bindingRevision: number;
}

const MAX_ACTION_BODY_BYTES = 256 * 1024;
const INVALID_ACTION = "Action body is not a valid ChatUserAction envelope";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 历史翻页到达最早一页时，SDK 用 `HistoryPageUnavailableError("exhausted")`
 * 终止分页；它会被包装成 ChatActionError("history_failed")。这是成功到达
 * 边界，不是存储/服务故障，HTTP 层应返回空页而不是 500。
 */
function isHistoryExhausted(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (
      current.name === "HistoryPageUnavailableError" &&
      (current as { reason?: unknown }).reason === "exhausted"
    )
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function invalidAction(c: Context, message: string, requestId?: string) {
  return c.json({
    ok: false as const,
    code: "invalid_action",
    message,
    disposition: "rejected" as const,
    ...(requestId ? { requestId } : {}),
  }, 400);
}

function companyError(
  error: unknown,
  context: { chatId?: string; requestId?: string },
): { status: ContentfulStatusCode; body: object } {
  if (error instanceof RuntimeError)
    return {
      status: error.status as ContentfulStatusCode,
      body: {
        ok: false as const,
        code: error.code,
        message: error.message,
        disposition: "rejected" as const,
        ...(context.requestId ? { requestId: context.requestId } : {}),
        ...(context.chatId ? { chatId: context.chatId } : {}),
      },
    };
  return mapChatActionError(error, context);
}
/** `target` 是连接所属绑定；空句柄用 `sessionId:null` + `bindingRevision:0`。 */
function parseTarget(value: unknown): ActionTarget | string {
  if (!isRecord(value)) return "target must be an object";
  const sessionId = value.sessionId;
  if (sessionId !== null && (typeof sessionId !== "string" || sessionId.length === 0))
    return "target.sessionId must be a non-empty string or null";
  const revision = value.bindingRevision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    return "target.bindingRevision must be a non-negative safe integer";
  return { sessionId, bindingRevision: revision };
}

async function readActionBody(
  c: Context,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_ACTION_BODY_BYTES)
    return { ok: false, response: invalidAction(c, "Action body exceeds 256 KiB") };
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_ACTION_BODY_BYTES)
    return { ok: false, response: invalidAction(c, "Action body exceeds 256 KiB") };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: invalidAction(c, INVALID_ACTION) };
  }
}

function bindingTarget(
  chat: ChatServiceContract,
  fallback: ActionTarget,
): ChatBindingTarget {
  const binding = chat.binding;
  if (binding) return binding;
  return {
    chatId: chat.id,
    sessionId: fallback.sessionId ?? "",
    bindingRevision: fallback.bindingRevision,
  };
}

interface ExecutedAction {
  target: ChatBindingTarget;
  details: Record<string, unknown>;
}

/** 只在这里分支执行；send 只等待入队接受，不等待整轮投递。 */
async function executeAction(
  deps: PeriChatApiDeps,
  scope: ChatScope,
  chat: ChatServiceContract,
  action: ChatUserActionValue,
  fallback: ActionTarget,
): Promise<ExecutedAction> {
  switch (action.type) {
    case "send": {
      // 与 REST send 相同：只做模型配置前置，不向用户正文注入角色/配置。
      const text = deps.runtime.validateSendText(scope.input, action.payload.text);
      const receipt = chat.execute(
        ChatUserAction.send({
          text,
          requestId: action.requestId,
        }),
      );
      await receipt.accepted;
      // 与 REST send 相同的 stranded 修复；后台执行，不拖慢 202。
      void deps.runtime
        .recoverChatInput(scope.input, receipt.inputId)
        .catch(() => {});
      return {
        target: receipt.target,
        details: { inputId: receipt.inputId, accepted: true },
      };
    }
    case "change_session": {
      const result = await chat.execute(action);
      return {
        target: {
          chatId: result.chatId,
          sessionId: result.sessionId,
          bindingRevision: result.bindingRevision,
        },
        details: {},
      };
    }
    case "cancel": {
      const result = await chat.execute(action);
      return {
        target: bindingTarget(chat, fallback),
        details: { status: result.status },
      };
    }
    case "force_send":
    case "take_back":
    case "answer": {
      const result = await chat.execute(action);
      return {
        target: bindingTarget(chat, fallback),
        details: { status: result.status },
      };
    }
    case "load_earlier_history": {
      try {
        const result = await chat.execute(action);
        return {
          target: bindingTarget(chat, fallback),
          details: { applied: result.applied, nextCursor: result.nextCursor },
        };
      } catch (error) {
        if (!isHistoryExhausted(error)) throw error;
        return {
          target: bindingTarget(chat, fallback),
          details: { applied: 0, nextCursor: null, exhausted: true },
        };
      }
    }
    case "create_new_session":
      // 路由层已拒绝；这里兜底防御，避免未来分支误放行。
      throw new RuntimeError(
        "invalid_action",
        "每个 Agent 只有一个固定会话，不能新建 Session。",
        400,
      );
  }
}

/**
 * Company 版 Peri Chat HTTP/WS 面。
 *
 * 路由只做 scope 归属、边界校验、公司策略与错误映射；执行、绑定、同步语义都在 SDK。
 */
export function createPeriChatApi(deps: PeriChatApiDeps): Hono<SyncEnv> {
  const api = new Hono<SyncEnv>();

  api.get("/api/chats", async (c) => {
    // 鉴权/Agent 归属错误必须原样返回，不能被折叠成“目录不可用”。
    const scope = await deps.scope(c);
    try {
      return c.json({
        chats: await deps.runtime.chatDirectory(scope.input),
        available: true,
      });
    } catch (error) {
      logError("[peri] Chat directory is unavailable", error);
      return c.json({
        chats: [],
        available: false,
        error: "Session directory is unavailable",
      }, 503);
    }
  });

  // 公司不暴露项目目录；返回空列表，避免 Peri 的目录轮询触发“项目不可用”横幅。
  api.get("/api/projects", (c) => c.json({ projects: [] }));
  api.post("/api/projects", (c) =>
    c.json({
      ok: false,
      code: "invalid_request",
      message: "Projects are not part of the Company workspace",
    }, 400),
  );

  /**
   * 只读 Session 投影（messages + view），供诊断与 live 验收读取。
   * 浏览器仍走 `/api/chats/:chatId/sync` 的 Peri 同步协议，不依赖此端点。
   */
  api.get("/api/chats/:chatId/projection", async (c) => {
    const scope = await deps.scope(c);
    const chatId = c.req.param("chatId");
    if (!deps.runtime.chatForScope(scope.input, chatId))
      return c.json(chatNotFound(chatId).body, 410);
    const projection = await deps.runtime.conversation(scope.input);
    return c.json({ ok: true, ...projection, chatId });
  });

  api.post("/api/chats", async (c) => {
    const body = await c.req.text();
    let parsed: unknown = {};
    if (body.trim().length > 0) {
      try {
        parsed = JSON.parse(body);
      } catch {
        return c.json({ ok: false, code: "invalid_request", message: "Body is not valid JSON" }, 400);
      }
    }
    if (!isRecord(parsed))
      return c.json({ ok: false, code: "invalid_request", message: "Body must be an object" }, 400);
    if (parsed.path !== undefined)
      return c.json({ ok: false, code: "invalid_request", message: "path is not supported" }, 400);
    if (parsed.projectId !== undefined)
      return c.json({ ok: false, code: "invalid_request", message: "projectId is not supported" }, 400);
    const sessionId = parsed.sessionId;
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length === 0))
      return c.json({ ok: false, code: "invalid_request", message: "sessionId must be a non-empty string" }, 400);

    // 鉴权失败必须原样返回，不能被 Action 错误映射折叠。
    const scope = await deps.scope(c);
    try {
      if (sessionId !== undefined) {
        const bound = await deps.runtime.boundSession(scope.input);
        if (bound && bound !== sessionId)
          return c.json({
            ok: false,
            code: "binding_conflict",
            message: "This Agent has one fixed Session; the requested Session is not it.",
            disposition: "rejected",
          }, 409);
      }
      const chat = await deps.runtime.wakeChat(scope.input);
      return c.json({
        chat: {
          id: chat.id,
          sessionId: chat.sessionId,
          bindingRevision: chat.bindingRevision,
        },
      }, 201);
    } catch (error) {
      const mapped = companyError(error, {});
      return c.json(mapped.body, mapped.status);
    }
  });

  api.post("/api/chats/:chatId/actions", async (c) => {
    const scope = await deps.scope(c);
    const chatId = c.req.param("chatId");
    const chat = deps.runtime.chatForScope(scope.input, chatId);
    if (!chat) return c.json(chatNotFound(chatId).body, 410);

    const body = await readActionBody(c);
    if (!body.ok) return body.response;
    if (!isRecord(body.value)) return invalidAction(c, INVALID_ACTION);

    const target = parseTarget(body.value.target);
    if (typeof target === "string") return invalidAction(c, target);

    let action: ChatUserActionValue;
    try {
      action = parseChatUserAction(body.value);
    } catch (error) {
      const mapped = mapChatActionError(error, { chatId: chat.id });
      return c.json(mapped.body, mapped.status);
    }

    if (action.type === "create_new_session")
      return invalidAction(
        c,
        "每个 Agent 只有一个固定会话，不能新建 Session。",
        action.requestId,
      );
    if (
      action.type === "change_session" &&
      action.payload.sessionId !== chat.sessionId
    )
      return c.json({
        ok: false,
        code: "binding_conflict",
        message: "change_session 只能切到该 Agent 的固定 Session。",
        disposition: "rejected",
        requestId: action.requestId,
        chatId: chat.id,
      }, 409);

    // Peri 客户端对“已绑定句柄”仍按空句柄目标发送 change_session；同 Session 的
    // 换绑是无操作，允许其复用句柄而不重复创建 Chat。
    const sameSessionChange =
      action.type === "change_session" &&
      action.payload.sessionId === chat.sessionId;
    const binding = chat.binding;
    const bindingMatches = binding
      ? binding.sessionId === target.sessionId &&
        binding.bindingRevision === target.bindingRevision
      : target.sessionId === null && target.bindingRevision === 0;
    if (!bindingMatches && !sameSessionChange)
      return c.json({
        ok: false,
        code: "binding_conflict",
        message: "Action target does not match the current binding",
        disposition: "rejected",
        requestId: action.requestId,
        chatId: chat.id,
      }, 409);

    try {
      const executed = await executeAction(deps, scope, chat, action, target);
      return c.json({
        ok: true,
        requestId: action.requestId,
        chatId: executed.target.chatId,
        sessionId: executed.target.sessionId,
        bindingRevision: executed.target.bindingRevision,
        ...executed.details,
      }, 202);
    } catch (error) {
      const mapped = companyError(error, {
        chatId: chat.id,
        requestId: action.requestId,
      });
      if (mapped.status >= 500)
        logError("[peri] Chat action failed", error, {
          chatId: chat.id,
          op: action.type,
          requestId: action.requestId,
        });
      return c.json(mapped.body, mapped.status);
    }
  });

  api.delete("/api/chats/:chatId", async (c) => {
    const scope = await deps.scope(c);
    const requestedId = c.req.param("chatId");
    const chat = deps.runtime.chatForScope(scope.input, requestedId);
    if (!chat) return c.json(chatNotFound(requestedId).body, 410);
    if (deps.runtime.chatRunning(scope.input))
      return c.json({
        ok: false,
        code: "busy",
        message: "会话正在运行，停止后才能重启。",
        disposition: "rejected",
        chatId: chat.id,
      }, 409);
    try {
      // 公司语义：DELETE = 重启同一 Session；持久绑定不变。
      await deps.restart(scope.caller, scope.agent.agentId);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof ChatCloseIncompleteError) {
        const mapped = closeIncomplete(error, chat.id);
        return c.json(mapped.body, mapped.status);
      }
      const mapped = companyError(error, { chatId: chat.id });
      logError("[peri] Chat restart failed", error, { chatId: chat.id });
      return c.json(mapped.body, mapped.status);
    }
  });

  api.get("/api/chats/:chatId/payload/:refId", async (c) => {
    const scope = await deps.scope(c);
    const chatId = c.req.param("chatId");
    const chat = deps.runtime.chatForScope(scope.input, chatId);
    if (!chat) return c.json(chatNotFound(chatId).body, 410);

    let refId: string;
    try {
      refId = decodeURIComponent(c.req.param("refId"));
    } catch {
      return c.json({ ok: false, code: "invalid_payload_ref", message: "Invalid payload id" }, 400);
    }
    const rawBytes = c.req.query("bytes");
    if (!rawBytes || !/^\d+$/.test(rawBytes))
      return c.json({
        ok: false,
        code: "invalid_payload_ref",
        message: "bytes must be a non-negative integer",
      }, 400);
    const bytes = Number(rawBytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      return c.json({
        ok: false,
        code: "invalid_payload_ref",
        message: "bytes must be a non-negative safe integer",
      }, 400);

    try {
      const options: ReadPayloadOptions = { signal: c.req.raw.signal };
      const payload: ToolPayloadResponse = await chat.readPayload(
        { id: refId, bytes },
        options,
      );
      return c.json({ ok: true, payload });
    } catch (error) {
      const mapped = mapPayloadError(error);
      if (mapped.status >= 500)
        logError("[peri] Payload read failed", error, { chatId: chat.id });
      return c.json(mapped.body, mapped.status);
    }
  });

  // 鉴权 → 归属 → attach 的顺序由这两层 middleware 固定；未授权请求不会创建 View。
  api.all(SYNC_PATH, async (c, next) => {
    const scope = await deps.scope(c);
    const chatId = c.req.param("chatId");
    const chat = deps.runtime.chatForScope(scope.input, chatId);
    if (!chat) {
      const mapped = chatNotFound(chatId);
      return c.json(mapped.body, 410);
    }
    return syncUpgradeGuard({
      chats: {
        getChat: (id) => deps.runtime.chatForScope(scope.input, id),
        findChatBySession: (id) => deps.runtime.chatForScope(scope.input, id),
      },
      views: {
        attach: (source) => deps.runtime.attachView(source as ChatService),
      },
    })(c, next);
  });
  api.get(
    SYNC_PATH,
    upgradeWebSocket((c) => {
      const connection = c.get("syncConnection");
      if (!connection) throw new Error("sync upgrade guard did not run");
      return syncEvents(connection);
    }),
    (c) => c.text("WebSocket upgrade rejected", 400),
  );

  return api;
}
