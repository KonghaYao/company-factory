import {
  ChatUserAction,
  type InteractionAnswer,
  type ToolPayloadResponse,
} from "@peri-code/sdk";
import { logError } from "./logging";
import { type ActionTargetDTO, type Chat, type ChatSummary, type ProjectSummary } from "./contracts";
import { ChatProjection } from "./projection";
import {
  RemoteActionError, RemoteSendReceipt,
  type ActionReceipt, type RemoteActions,
} from "./actions";
import { ChatSyncProvider, type SyncConnectionStatus, type WebSocketLike } from "./sync";
import { DeliveryTracker, INPUT_WITHDRAWN_MESSAGE } from "./delivery";
import { ChatHandleTable, type ChatHandleRecord } from "./handles";
import {
  bindingTargetOf, deriveLiveSync, deriveLoadState, derivePhase, describeActionFailure,
  isCancelPending, messageOf, rawErrorOf,
  type ActionFailure, type ChatRecovery, type ChatSendOutcome, type ChatView,
} from "./view-state";

export type {
  ChatLoadState, ChatRecovery, ChatSendOutcome, ChatView, Phase, SyncStatus,
} from "./view-state";

interface ActiveChat extends ChatHandleRecord {
  projection: ChatProjection;
  sync: ChatSyncProvider;
  unsubscribe: () => void;
  everReady: boolean;
  initialResolve?: (ok: boolean) => void;
  delivery: DeliveryTracker;
}

export interface ChatControllerDeps {
  actions: RemoteActions;
  list(signal?: AbortSignal): Promise<ChatSummary[]>;
  listProjects(signal?: AbortSignal): Promise<ProjectSummary[]>;
  createProject(name: string, signal?: AbortSignal): Promise<ProjectSummary>;
  syncUrl(chatAddress: string): string;
  webSocketFactory?: (url: string) => WebSocketLike;
  /** 首次同步预算；超时只报告失败，不关闭服务端句柄。 */
  initialSyncTimeoutMs?: number;
  now?: () => Date;
}

const INITIAL_SYNC_TIMEOUT_MS = 30_000;
const DELIVERY_UNCONFIRMED = "消息尚未确认送达，请检查连接后重试。";

function sameChat(left: Chat | null, right: Chat | null): boolean {
  return left?.id === right?.id && left?.title === right?.title && left?.updatedAt === right?.updatedAt;
}

/** 打开历史会话只需要目录身份；`projectId` 等其余字段不参与绑定。 */
type OpenChatTarget = Pick<ChatSummary, "sessionId" | "title" | "updatedAt">;

/**
 * 页面级 Chat 控制器：句柄身份、两步打开历史、绑定代次、Action 与同步连接。
 *
 * 不持有服务端执行状态，也不伪造运行态：列表只来自目录；运行/交互/队列
 * 只来自 `ChatReplica`。切换会话只释放本地连接，不 cancel、不 closeChat。
 * 视图派生见 `view-state`，投递结算见 `delivery`，句柄表见 `handles`。
 */
export class ChatController {
  private view: ChatView = {
    selected: null, state: null, phase: "idle", historyReady: true,
    loadState: "idle", liveSync: "connecting", error: "", recovery: "none",
  };
  private readonly listeners = new Set<() => void>();
  private readonly handles = new ChatHandleTable();
  private active: ActiveChat | undefined;
  private disposed = false;
  private selection = 0;
  /** 下一次新建会话的目标项目；打开历史会话时清空。 */
  private newProjectId: string | undefined;
  private actionError = "";
  private connectionError = "";
  private dismissedError = "";
  private uncertain = false;
  private recovery: ChatRecovery = "none";
  private lastFailure: ActionFailure | null = null;
  private sending = false;
  private sendInFlight: Promise<unknown> | undefined;
  /** 最近一次已被 202 受理的原文；仅内存保存，供异步失败后手动恢复草稿。 */
  private lastSubmitted: { text: string; requestId: string; chatId: string } | null = null;
  /** 取消意图只对发起时的 running turn 有效；turn 结算或换代后自动失效。 */
  private cancelRequested = false;
  private cancelTurnId: string | null = null;

  constructor(private readonly deps: ChatControllerDeps) {}

  getState = (): ChatView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  listChats(signal?: AbortSignal): Promise<ChatSummary[]> {
    return this.deps.list(signal);
  }

  listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
    return this.deps.listProjects(signal);
  }

  createProject(name: string): Promise<ProjectSummary> {
    return this.deps.createProject(name);
  }

  currentChatId(): string | null {
    return this.view.selected?.id ?? null;
  }

  /**
   * 打开历史会话：先 POST /api/chats 取得句柄，再 change_session，收到 202 后才连 WS。
   * 同一客户端已绑定过的会话复用句柄，不重复换绑。
   *
   * `options.projectId` 只对新建会话生效；项目内的新会话共享项目 sandbox。
   */
  async openChat(
    target: OpenChatTarget | null,
    options: { projectId?: string } = {},
  ): Promise<boolean> {
    if (this.disposed) return false;
    this.newProjectId = target === null ? options.projectId : undefined;
    const selected = target === null ? null : toChat(target);
    const boundId = this.active?.projection.state().chat.id ?? null;
    if (target !== null && boundId === selected!.id
      && this.view.loadState !== "failed" && this.view.liveSync !== "failed") return true;

    const token = ++this.selection;
    this.releaseActive();
    this.actionError = "";
    this.connectionError = "";
    this.uncertain = false;
    this.lastFailure = null;
    this.recovery = "none";
    this.clearCancel();
    this.update({
      selected, state: null, phase: "loading", historyReady: false,
      loadState: "loading", liveSync: "connecting", error: "", recovery: "none",
    });

    try {
      if (target === null) return await this.openNew(token);
      return await this.openExisting(target, token);
    } catch (error) {
      if (token !== this.selection || this.disposed) return false;
      const failure = describeActionFailure(error);
      if (failure.uncertain) this.uncertain = true;
      this.lastFailure = { ...failure, recovery: "reload", blocked: true };
      this.actionError = failure.message;
      this.recovery = "reload";
      this.update({
        phase: "idle", loadState: "failed", historyReady: false,
        error: this.visibleError(), recovery: this.recovery,
      });
      return false;
    }
  }

  /**
   * 失败恢复：先释放本地连接，再真正重开当前会话；不 cancel、不关闭服务端句柄。
   * 新建失败（尚无 selected）时重试新会话创建，避免「重新加载」无请求可发。
   */
  async reloadChat(): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.view.selected) {
      return await this.openChat(
        null,
        this.newProjectId === undefined ? {} : { projectId: this.newProjectId },
      );
    }
    if (this.view.state?.running && !this.view.state.executionBlocked
      && this.view.loadState !== "failed" && this.view.liveSync !== "failed") return false;
    const selected = this.view.selected;
    this.handles.delete(selected.id);
    this.uncertain = false;
    this.lastFailure = null;
    this.recovery = "none";
    this.actionError = "";
    this.connectionError = "";
    this.clearCancel();
    // 先释放 active，`openChat` 也不会命中同 id 的「已打开」短路。
    this.releaseActive();
    return await this.openChat({
      sessionId: selected.id, title: selected.title, updatedAt: selected.updatedAt,
    });
  }

  /**
   * 关闭未确认时的逃生入口：显式关闭当前句柄（`actions.close`）后重开原会话。
   * `force=true` 对应 `DELETE ?force=1`，用于持久化/关闭状态未确认时放弃旧 runtime。
   * 关闭失败保留当前连接与错误，`close_incomplete` 原样上报，不假装已关闭。
   */
  async rebuildChat(force = false): Promise<boolean> {
    if (this.disposed) return false;
    const address = this.active?.address ?? this.view.selected?.id ?? null;
    if (address) {
      try {
        await this.deps.actions.close(address, force ? { force: true } : {});
      } catch (error) {
        this.failAction(error);
        return false;
      }
    }
    const selected = this.view.selected;
    if (selected) this.handles.delete(selected.id);
    this.releaseActive();
    this.selection += 1;
    this.uncertain = false;
    this.lastFailure = null;
    this.recovery = "none";
    this.actionError = "";
    this.connectionError = "";
    this.clearCancel();
    // Company DELETE 语义是“重启同一固定 Session”（不是新建）：关闭后重开原会话。
    return selected
      ? await this.openChat({
          sessionId: selected.id,
          title: selected.title,
          updatedAt: selected.updatedAt,
        })
      : await this.openChat(
          null,
          this.newProjectId === undefined ? {} : { projectId: this.newProjectId },
        );
  }

  /** 历史分页：只追加更早事实，不改变绑定。 */
  async loadEarlierHistory(limit = 50): Promise<boolean> {
    return this.control(ChatUserAction.loadEarlierHistory({ limit }));
  }

  /** 队列取回：从待投递队列撤回一条输入，不停止当前回复。 */
  async takeBackInput(inputId: string): Promise<boolean> {
    return this.control(ChatUserAction.takeBack(inputId));
  }

  /** 队列立即投递：把一条待投递输入提前交给运行侧。 */
  async forceSendInput(inputId: string): Promise<boolean> {
    return this.control(ChatUserAction.forceSend(inputId));
  }

  private async control(action: ChatUserAction): Promise<boolean> {
    const active = this.active;
    const target = active ? this.bindingTarget(active) : null;
    if (!active || !target) return false;
    try {
      await this.deps.actions.execute(active.address, action, target);
      if (!this.uncertain) {
        this.actionError = "";
        this.recovery = "none";
      }
      this.refresh();
      return true;
    } catch (error) {
      this.failAction(error);
      return false;
    }
  }

  /**
   * 发送输入：direct prompt 的 202 就是整轮 RPC 的受理回执，立即结算。
   * 旧 queue 回执仍等待副本投递事实；撤回/连接释放时返回未送达并保留可重试的可见错误。
   */
  async send(content: string): Promise<ChatSendOutcome> {
    const sent = await this.dispatchSend(content);
    if (!sent) {
      const failure = this.lastFailure;
      const disposition = failure?.disposition
        ?? (this.uncertain ? "unknown" : "not_sent");
      // 阻断只跟随可见恢复动作：没有 reload/rebuild 入口时，未知结果也不拦输入。
      const blocked = failure?.blocked ?? this.recovery !== "none";
      return {
        delivered: false,
        sessionId: null,
        message: this.actionError || DELIVERY_UNCONFIRMED,
        disposition,
        ...(blocked ? { blocked: true } : {}),
      };
    }
    if (sent.mode === "prompt") {
      // 202 只表示 admission 已受理；执行结果由 runtime.promptFailure 异步投影。
      this.actionError = "";
      this.uncertain = false;
      this.recovery = "none";
      this.lastFailure = null;
      this.refresh();
      return { delivered: true, sessionId: sent.sessionId };
    }
    try {
      await sent.receipt;
      this.actionError = "";
      this.uncertain = false;
      this.recovery = "none";
      this.lastFailure = null;
      this.refresh();
      return { delivered: true, sessionId: sent.sessionId };
    } catch (error) {
      const message = messageOf(error);
      // 只有撤回是明确未送达；连接释放等拒绝可能已入队或送达。
      const disposition = error instanceof Error && error.message === INPUT_WITHDRAWN_MESSAGE
        ? "rejected"
        : "unknown";
      this.failAction(new RemoteActionError("input_not_delivered", `消息未送达：${message}`, disposition));
      return {
        delivered: false,
        sessionId: sent.sessionId,
        message: this.actionError || message,
        disposition,
        ...(this.lastFailure?.blocked ? { blocked: true } : {}),
      };
    }
  }

  /**
   * 返回远程发送回执与目标会话。
   *
   * prompt 模式在 HTTP 202 后立即返回，不创建 DeliveryTracker；只有旧 queue
   * 回执才等待副本投递事实。因此用包装对象跨 async 边界，避免 `await` 摊平。
   */
  async dispatchSend(content: string): Promise<{
    receipt: RemoteSendReceipt;
    sessionId: string;
    mode: "prompt" | "queue";
  } | null> {
    const text = content.trim();
    // 只有可见恢复动作才阻断新输入；`uncertain` 本身不再拦截（否则用户会卡在
    // 没有恢复入口的错误上），失败也不会自动重发。
    if (this.disposed || !text || this.sending || this.recovery !== "none"
      || this.cancelPending()) return null;
    if (this.view.loadState !== "ready" && this.active) return null;
    if (!this.active) {
      if (!await this.openChat(null)) return null;
    }
    const active = this.active;
    const target = active ? this.bindingTarget(active) : null;
    if (!active || !target) {
      this.actionError = "会话尚未完成绑定，消息未发送。";
      this.refresh();
      return null;
    }
    this.sending = true;
    const issued = this.deps.actions.execute(active.address, ChatUserAction.send({ text }), target);
    this.sendInFlight = issued.catch(() => undefined);
    try {
      const receipt = await issued;
      // 服务端已总是返回 mode；缺失时按新的 prompt 主路径处理，不能静默回退到 legacy queue。
      const mode = receipt.mode ?? "prompt";
      if (mode === "prompt" && receipt.accepted === false)
        throw new RemoteActionError("prompt_not_admitted", "输入未被受理。", "not_sent");
      if (mode === "queue" && !receipt.inputId)
        throw new RemoteActionError("invalid_receipt", "发送回执缺少 inputId。", "unknown");
      // prompt 的新 admission 已清空服务端旧 failure；本地也记录本次原文，
      // 供异步 promptFailure 到达后由用户手动恢复草稿（绝不自动恢复/重发）。
      this.lastSubmitted = {
        text,
        requestId: receipt.requestId,
        chatId: receipt.sessionId || active.chat.id,
      };
      const delivery = mode === "prompt"
        ? Promise.resolve()
        : active.delivery.wait(receipt.inputId!);
      const remote = new RemoteSendReceipt(
        receipt.requestId,
        receipt.inputId ?? receipt.requestId,
        { chatId: receipt.chatId, sessionId: receipt.sessionId, bindingRevision: receipt.bindingRevision },
        Promise.resolve(),
        delivery,
        mode,
      );
      return { receipt: remote, sessionId: receipt.sessionId, mode };
    } catch (error) {
      this.failAction(error);
      return null;
    } finally {
      this.sending = false;
      this.refresh();
    }
  }

  /**
   * 异步 promptFailure 到达后的草稿恢复入口：只返回内存中的原文，不写入草稿、
   * 不触发发送。requestId 不匹配（例如旧失败）时不提供恢复。
   */
  recoverableDraft(requestId?: string): string | null {
    const submitted = this.lastSubmitted;
    if (!submitted) return null;
    if (this.currentChatId() !== submitted.chatId) return null;
    if (requestId && submitted.requestId && requestId !== submitted.requestId) return null;
    return submitted.text;
  }

  /**
   * 请求取消：`requested` 只表示通知已写出，不是停止确认。
   * 任务是否结束继续由副本的 `running` 决定。
   *
   * `promptInFlight` 来自运行时快照：direct prompt 受理后、副本尚未投影
   * `running` 的窗口内也必须允许发送 session/cancel。
   */
  async stop(options: { promptInFlight?: boolean } = {}): Promise<boolean> {
    if (this.disposed) return false;
    const active = this.active;
    const target = active ? this.bindingTarget(active) : null;
    if (!active || !target) return true;
    if (
      !options.promptInFlight
      && !this.view.state?.running
      && !this.view.state?.executionBlocked
    ) return true;
    if (this.cancelPending()) return true;
    this.cancelRequested = true;
    this.cancelTurnId = this.view.state?.activeTurn.turnId ?? null;
    this.refresh();
    // 保证取消不先于在途发送到达；不等待整轮执行。
    await this.sendInFlight;
    try {
      const receipt = await this.deps.actions.execute(active.address, ChatUserAction.cancel(), target);
      if (receipt.status === "idle") this.clearCancel();
      // 未知结果仍需要 reload 的说明，不能被一次成功的取消静默抹掉。
      if (!this.uncertain) {
        this.actionError = "";
        this.recovery = "none";
      }
      return true;
    } catch (error) {
      this.clearCancel();
      this.failAction(error);
      return false;
    } finally {
      this.refresh();
    }
  }

  async answerInteraction(interactionId: string, answer: InteractionAnswer): Promise<void> {
    const active = this.active;
    const target = active ? this.bindingTarget(active) : null;
    if (!active || !target) throw new Error("会话尚未就绪，回答未提交。");
    try {
      await this.deps.actions.execute(
        active.address,
        ChatUserAction.answer({ interactionId, answer }),
        target,
      );
      this.actionError = "";
      this.recovery = "none";
      this.refresh();
    } catch (error) {
      this.failAction(error);
      throw new Error(this.actionError || messageOf(error));
    }
  }

  /**
   * 写入会话配置（模型/模式/推理强度）。
   *
   * 成功只表示后端接受了请求；界面值仍由 `config_option_update` 投影接管。
   * 失败沿用 Action 的 disposition 规则，未知结果会阻断后续发送。
   */
  async setConfigOption(configId: string, value: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const active = this.active;
    const target = active ? this.bindingTarget(active) : null;
    if (!active || !target) return { ok: false, message: "会话尚未就绪，配置未提交。" };
    // SDK 0.3.0 的动作联合没有 set_config_option；缺该动作时只读，不伪造成功。
    const setConfigOption = (
      ChatUserAction as unknown as {
        setConfigOption?: (input: { configId: string; value: string }) => ChatUserAction;
      }
    ).setConfigOption;
    if (!setConfigOption)
      return { ok: false, message: "后端不支持会话内切换配置" };
    try {
      await this.deps.actions.execute(
        active.address,
        setConfigOption({ configId, value }),
        target,
      );
      // 成功写配置不能清掉未知结果留下的横幅；否则界面继续阻断却看不到原因。
      if (!this.uncertain) {
        this.actionError = "";
        this.recovery = "none";
      }
      this.refresh();
      return { ok: true };
    } catch (error) {
      // 明确拒绝只影响本次配置切换，由选择器就地回滚；未知结果才升级为全局阻断。
      const disposition = error instanceof RemoteActionError ? error.disposition : "unknown";
      if (disposition === "unknown") this.failAction(error);
      return {
        ok: false,
        message: disposition === "unknown"
          ? this.actionError || messageOf(error)
          : messageOf(error),
      };
    }
  }

  /**
   * 全文读取：只接受副本里仍被引用的载荷 ID，字节数取自引用事实。
   * 旧会话/丢失引用的 ID 明确 unavailable，不猜字节数。
   */
  readPayloadById(id: string, signal?: AbortSignal): Promise<ToolPayloadResponse> {
    const active = this.active;
    if (!active) {
      return Promise.reject(new Error("会话尚未就绪，无法读取全文。"));
    }
    return this.payloadRefBytes(id).then((bytes) => {
      if (bytes === undefined) throw new Error("全文引用已不在当前会话中。");
      return this.deps.actions.readPayload(active.address, { id, bytes }, { signal });
    });
  }

  private payloadRefBytes(id: string): Promise<number | undefined> {
    const state = this.active?.projection.state();
    for (const tool of state?.toolCalls ?? []) {
      if (tool.argumentsRef?.id === id) return Promise.resolve(tool.argumentsRef.bytes);
      if (tool.resultRef?.id === id) return Promise.resolve(tool.resultRef.bytes);
    }
    return Promise.resolve(undefined);
  }

  dismissError(): void {
    this.dismissedError = this.rawError();
    this.refresh();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.selection += 1;
    this.releaseActive();
    this.handles.clear();
    this.listeners.clear();
  }

  // ------------------------------------------------------------------
  // Open flows
  // ------------------------------------------------------------------

  private async openNew(token: number): Promise<boolean> {
    const handle = await this.deps.actions.createHandle(
      this.newProjectId === undefined ? {} : { projectId: this.newProjectId },
    );
    if (token !== this.selection || this.disposed) {
      await this.closeCandidate(handle.id);
      return false;
    }
    let receipt: ActionReceipt;
    try {
      receipt = await this.deps.actions.execute(
        handle.id,
        // 标题由 Store 在首次 append_history 时从首条用户消息补齐，前端不伪造。
        ChatUserAction.createNewSession(),
        { sessionId: null, bindingRevision: 0 },
      );
    } catch (error) {
      await this.closeCandidate(handle.id);
      throw error;
    }
    const chat: Chat = {
      id: receipt.sessionId,
      title: "新会话",
      updatedAt: this.deps.now?.().toISOString() ?? new Date().toISOString(),
    };
    const record: ChatHandleRecord = { address: handle.id, handleId: handle.id, chat };
    if (token !== this.selection || this.disposed) {
      await this.closeCandidate(handle.id);
      return false;
    }
    this.handles.set(chat.id, record);
    return await this.activate(record, token);
  }

  private async openExisting(target: OpenChatTarget, token: number): Promise<boolean> {
    let sessionId = target.sessionId;
    let record = this.handles.get(sessionId);
    if (!record) {
      const handle = await this.deps.actions.createHandle(sessionId);
      if (token !== this.selection || this.disposed) {
        await this.closeCandidate(handle.id);
        return false;
      }
      if (handle.sessionId !== null && handle.sessionId !== sessionId) {
        if (handle.replacesSessionId !== sessionId) {
          await this.closeCandidate(handle.id);
          throw new RemoteActionError("binding_conflict", "返回的会话与请求绑定不一致，未打开。", "rejected");
        }
        // Only an explicit, trusted replacement receipt can redirect an old
        // directory entry. It is a new Session, not recovered history.
        sessionId = handle.sessionId;
        target = { ...target, sessionId };
      }
      if (handle.replacesSessionId)
        this.actionError = "原固定会话已不在存储中；已打开替代会话，原历史未恢复。";
      let bound = false;
      try {
        await this.deps.actions.execute(
          handle.id,
          ChatUserAction.changeSessionTo(sessionId),
          { sessionId: handle.sessionId, bindingRevision: handle.bindingRevision },
        );
        bound = true;
        record = { address: handle.id, handleId: handle.id, chat: toChat(target) };
      } catch (error) {
        if (error instanceof RemoteActionError && error.code === "binding_conflict") {
          // 该 Session 已有控制者：以真实 Session ID 寻址既有句柄，不重复绑定。
          await this.closeCandidate(handle.id);
          record = { address: sessionId, handleId: null, chat: toChat(target) };
        } else {
          await this.closeCandidate(handle.id);
          throw error;
        }
      }
      if (token !== this.selection || this.disposed) {
        if (bound) await this.closeCandidate(handle.id);
        return false;
      }
      this.handles.set(sessionId, record);
    }
    if (token !== this.selection || this.disposed) return false;
    return await this.activate(record, token);
  }

  private async activate(record: ChatHandleRecord, token: number): Promise<boolean> {
    const projection = new ChatProjection(record.chat);
    let active: ActiveChat | undefined;
    const sync = new ChatSyncProvider({
      url: this.deps.syncUrl(record.address),
      projection,
      ...(this.deps.webSocketFactory ? { webSocketFactory: this.deps.webSocketFactory } : {}),
      onStatus: (status, error) => {
        if (active) this.onSyncStatus(active, status, error);
      },
    });
    active = {
      ...record, projection, sync, unsubscribe: () => {}, everReady: false,
      delivery: new DeliveryTracker(() => projection.state()),
    };
    this.active = active;
    active.unsubscribe = projection.subscribe(() => this.onProjection(active));
    // 先挂订阅再连接：首帧 SNAPSHOT 与后续 UPDATE 都不能落在订阅之前。
    sync.start();
    const ok = await this.waitInitial(active, token);
    if (token !== this.selection || this.disposed) {
      if (this.active === active) this.releaseActive();
      return false;
    }
    this.refresh();
    return ok;
  }

  private waitInitial(active: ActiveChat, token: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.initialResolve = undefined;
        resolve(ok);
      };
      const timer = setTimeout(() => {
        if (token !== this.selection) { finish(false); return; }
        this.connectionError = "会话同步超时，请重新连接。";
        finish(false);
      }, this.deps.initialSyncTimeoutMs ?? INITIAL_SYNC_TIMEOUT_MS);
      active.initialResolve = finish;
      // 已就绪的副本（理论上的复用）立即结算。
      if (active.projection.state().readiness !== "not-ready") finish(true);
    });
  }

  // ------------------------------------------------------------------
  // Projection / connection
  // ------------------------------------------------------------------

  private onProjection(active: ActiveChat): void {
    if (this.disposed || this.active !== active) return;
    const state = active.projection.state();
    if (state.readiness !== "not-ready") {
      active.everReady = true;
      active.initialResolve?.(true);
    }
    if (this.cancelRequested && !this.cancelPending()) this.clearCancel();
    active.delivery.settle(state);
    this.refresh();
  }

  private onSyncStatus(active: ActiveChat, status: SyncConnectionStatus, error?: Error): void {
    if (this.disposed || this.active !== active) return;
    if (status === "failed") {
      this.connectionError = error ? messageOf(error) : "实时同步连接失败。";
      active.initialResolve?.(false);
    } else if (status === "open") {
      this.connectionError = "";
    }
    this.refresh();
  }

  private bindingTarget(active: ActiveChat): ActionTargetDTO | null {
    return bindingTargetOf(active.projection.state());
  }

  // ------------------------------------------------------------------
  // View state
  // ------------------------------------------------------------------

  private refresh(): void {
    if (this.disposed) return;
    const active = this.active;
    const state = active?.projection.state() ?? null;
    const readiness = state?.readiness ?? "not-ready";
    if (state && readiness !== "not-ready") active!.everReady = true;
    if (this.cancelRequested && !this.cancelPending()) this.clearCancel();
    // 换绑后句柄记录也跟随绑定身份，避免复用旧 sessionId 快照。
    if (active && state?.sessionId && state.sessionId !== active.chat.id) {
      this.handles.followRebind({
        previousChatId: active.chat.id,
        address: active.address,
        handleId: active.handleId,
        chat: state.chat,
      });
      active.chat = state.chat;
    }
    const liveSync = deriveLiveSync({
      projectionStatus: active?.projection.status,
      syncStatus: active?.sync.status,
    });
    const loadState = deriveLoadState({
      hasActive: active !== undefined,
      hasSelection: this.view.selected !== null,
      readiness: state?.readiness ?? null,
      everReady: active?.everReady ?? false,
      previous: this.view.loadState,
      liveSync,
      connectionError: this.connectionError,
    });
    const historyReady = loadState === "ready";
    const phase = derivePhase({
      hasActive: active !== undefined,
      loadState,
      uncertain: this.uncertain,
      executionBlocked: state?.executionBlocked === true,
      recovery: this.recovery,
      running: state?.running === true,
      cancelPending: isCancelPending(
        { requested: this.cancelRequested, turnId: this.cancelTurnId },
        state,
      ),
      historyReady,
    });
    this.update({
      // 展示身份只跟随副本绑定；记录里的 Chat 只是尚未绑定时的占位。
      selected: state?.chat ?? active?.chat ?? this.view.selected,
      state,
      phase,
      historyReady,
      loadState,
      liveSync,
      error: this.visibleError(),
      recovery: this.recovery,
    });
  }

  /**
   * 取消意图只在发起时的 running 窗口内有效。
   * `running=false` 或 active turn 已换代即失效，避免停止后输入被永久拦住。
   */
  private cancelPending(): boolean {
    return isCancelPending(
      { requested: this.cancelRequested, turnId: this.cancelTurnId },
      this.active?.projection.state() ?? this.view.state,
    );
  }

  private clearCancel(): void {
    this.cancelRequested = false;
    this.cancelTurnId = null;
  }

  private rawError(): string {
    return rawErrorOf({
      actionError: this.actionError,
      connectionError: this.connectionError,
      loadState: this.view.loadState,
    });
  }

  private visibleError(): string {
    const candidate = this.rawError();
    if (!candidate) {
      this.dismissedError = "";
      return "";
    }
    return candidate === this.dismissedError ? "" : candidate;
  }

  private failAction(error: unknown): void {
    const failure = describeActionFailure(error);
    this.lastFailure = failure;
    if (failure.uncertain) this.uncertain = true;
    this.recovery = failure.recovery;
    this.actionError = failure.message;
    // 新的错误必须重新可见，不能沿用上一次 dismiss 的结果。
    this.dismissedError = "";
    this.refresh();
  }

  private update(patch: Partial<ChatView>): void {
    const next = { ...this.view, ...patch };
    if (sameChat(next.selected, this.view.selected)
      && next.state === this.view.state
      && next.phase === this.view.phase
      && next.historyReady === this.view.historyReady
      && next.loadState === this.view.loadState
      && next.liveSync === this.view.liveSync
      && next.error === this.view.error
      && next.recovery === this.view.recovery) return;
    this.view = next;
    for (const listener of [...this.listeners]) listener();
  }

  private releaseActive(): void {
    const active = this.active;
    this.active = undefined;
    this.clearCancel();
    if (!active) return;
    active.delivery.rejectAll();
    active.unsubscribe();
    void active.sync.close().catch((error) => logError("Chat sync close failed", error, { chatId: active.chat.id }));
    void active.projection.dispose().catch((error) => logError("Chat projection dispose failed", error, { chatId: active.chat.id }));
  }

  private async closeCandidate(handleId: string): Promise<void> {
    try {
      await this.deps.actions.close(handleId);
    } catch (error) {
      // 候选句柄清理失败必须可见；不覆盖主流程错误。
      logError("Chat candidate handle close failed", error, { handleId });
    }
  }
}

function toChat(summary: OpenChatTarget): Chat {
  return { id: summary.sessionId, title: summary.title ?? "新会话", updatedAt: summary.updatedAt };
}
