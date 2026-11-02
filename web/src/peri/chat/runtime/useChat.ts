import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InteractionAnswer } from '@peri-code/sdk/view';
import {
  createChatApplication, failureMessageForCode, failureRecoveryForCode, type ChatController,
} from '../../remote';
import type { Runtime, RuntimePromptFailure } from '../../../lib/types';
import { createChatQueries, LIST_POLL_ACTIVITY_MS, LIST_POLL_IDLE_INTERVAL_MS, listRefetchInterval } from './queries';
import { chatPayloadReader } from './payloadReader';
import type { Chat, ChatRecovery, ChatSendOutcome, ChatSummary } from './types';

/** 错误文案单一出口：宿主字符串与 Error 用同一条清洗规则，避免控制字符进入视图。 */
function errorText(error: unknown): string {
  const text = typeof error === "string" ? error
    : error instanceof Error ? error.message : "本地宿主调用失败，请稍后重试。";
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").slice(0, 512);
}

/** 错误横幅的重试路由：列表错误刷新列表；只有读面失败才重新加载会话。 */
export type ChatRetryAction = 'refresh-list' | 'reload-chat' | 'rebuild-chat' | 'none';

export interface ChatErrorBanner {
  message: string;
  action: ChatRetryAction;
  /** 读面失败必须保留重试入口：关闭横幅后仍显示失败态。 */
  dismissible: boolean;
}

/** 异步 prompt 失败横幅：code/recovery 是事实，文案只来自固定中文表。 */
export interface ChatPromptFailureBanner extends ChatErrorBanner {
  key: string;
  code: string;
  recovery: ChatRecovery;
  /** 不含 code/恢复说明的固定中文正文，用于与同步错误去重。 */
  detail: string;
}

interface ChatErrorBanners {
  list?: ChatErrorBanner;
  chat?: ChatErrorBanner;
  promptFailure?: ChatPromptFailureBanner;
}

function retryActionFor(recovery: ChatRecovery | undefined): ChatRetryAction {
  if (recovery === 'reload') return 'reload-chat';
  if (recovery === 'rebuild') return 'rebuild-chat';
  return 'none';
}

/**
 * 横幅与重试动作的唯一映射：列表错误与会话错误分别展示，互不覆盖。
 * 有恢复入口的错误（未知执行结果、绑定过期、需重建 runtime）必须保留动作且不可 dismiss；
 * 普通执行拒绝不是读面事实，不能靠 reload 重读同一错误，因此不提供重试。
 */
export function errorBanners(input: {
  listError: string;
  chatError: string;
  loadState: 'idle' | 'loading' | 'ready' | 'failed' | 'unsupported';
  recovery?: ChatRecovery;
}): ChatErrorBanners {
  const banners: ChatErrorBanners = {};
  if (input.listError) {
    banners.list = { message: input.listError, action: 'refresh-list', dismissible: true };
  }
  if (input.loadState === 'failed') {
    banners.chat = {
      message: input.chatError || '会话加载失败，请重新加载。',
      action: 'reload-chat',
      dismissible: false,
    };
  } else if (input.chatError) {
    const action = retryActionFor(input.recovery);
    banners.chat = { message: input.chatError, action, dismissible: action === 'none' };
  }
  return banners;
}

/** 同一失败（requestId + code + 时间）只能展示一次；新失败必须重新可见。 */
export function promptFailureKey(failure: RuntimePromptFailure): string {
  return `${failure.requestId ?? ''}|${failure.code}|${failure.at}`;
}

const PROMPT_FAILURE_FALLBACK = '消息执行失败，执行状态尚未确认；请核对会话状态。';

/**
 * 异步 promptFailure 是否需要阻断 composer。
 *
 * 只有需要重建运行时的失败（rebuild）才阻断：reload 可以由用户手动重载，
 * 或直接发送新消息触发新 admission；none（含 execution_failed 等未知结果）
 * 只提示结果不确定、不自动重发，不能把用户永久锁在聊天气泡里。
 *
 * recovery 与横幅使用同一套 code→recovery 归一，避免「横幅显示重启、
 * 发送却未阻断」或反过来的错配。
 */
export function isPromptFailureBlocking(
  failure: RuntimePromptFailure | null | undefined,
): boolean {
  if (!failure) return false;
  return (failureRecoveryForCode(failure.code) ?? failure.recovery) === 'rebuild';
}

/** 异步 promptFailure → 固定中文横幅；不依赖服务端 message 原文。 */
export function promptFailureBanner(
  failure: RuntimePromptFailure | null | undefined,
  dismissedKey?: string | null,
): ChatPromptFailureBanner | null {
  if (!failure) return null;
  const key = promptFailureKey(failure);
  const blocking = isPromptFailureBlocking(failure);
  // rebuild 横幅是常驻恢复入口：即使调用方残留了同 key 的 dismiss 记录也不能隐藏。
  if (!blocking && dismissedKey === key) return null;
  const detail = failureMessageForCode(failure.code) ?? PROMPT_FAILURE_FALLBACK;
  const recovery = failureRecoveryForCode(failure.code) ?? failure.recovery;
  const action = retryActionFor(recovery);
  const recoveryLabel = recovery === 'reload'
    ? '重新加载会话'
    : recovery === 'rebuild'
      ? '重启会话'
      : '无需自动恢复';
  // none + unknown 不再阻断发送，但必须让用户知道结果未确认且不会自动重发。
  const noAutoResend = recovery === 'none' && failure.disposition === 'unknown'
    ? '本轮结果不确定，不会自动重发。'
    : '';
  return {
    key,
    code: failure.code,
    recovery,
    detail,
    message: `[${failure.code}] ${detail}${noAutoResend ? ` ${noAutoResend}` : ''}（恢复：${recoveryLabel}）`,
    action,
    dismissible: !blocking && action === 'none',
  };
}

/** 实时同步中断的入口：已有内容时也保留重连，不让 Header 永远停在“同步中”。 */
export function syncRetryAction(input: {
  loadState: 'idle' | 'loading' | 'ready' | 'failed' | 'unsupported';
  liveSync: 'connecting' | 'synced' | 'failed';
}): ChatRetryAction {
  if (input.loadState === 'failed') return 'reload-chat';
  if (input.loadState === 'unsupported') return 'none';
  if (input.liveSync === 'failed') return 'reload-chat';
  return 'none';
}

/** 可见性订阅：隐藏 tab 暂停低频轮询，回到页面时由 focus refetch 补一次。 */
function subscribeVisibility(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export function useChat(
  createApplication: () => ChatController = createChatApplication,
  options: { actualRuntime?: Runtime | null } = {},
) {
  const [dismissedListError, setDismissedListError] = useState(0);
  const [dismissedPromptFailure, setDismissedPromptFailure] = useState<string | null>(null);
  const [activityUntil, setActivityUntil] = useState(0);
  const controllerRef = useRef<ChatController | null>(null);
  const api = useMemo(() => ({
    list: (signal?: AbortSignal) => controllerRef.current?.listChats(signal) ?? Promise.resolve([]),
    projects: (signal?: AbortSignal) => controllerRef.current?.listProjects(signal) ?? Promise.resolve([]),
  }), []);
  const queries = useMemo(() => createChatQueries(api), [api]);
  const controller = useMemo(() => createApplication(), []);
  controllerRef.current = controller;
  const view = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
  const list = useQuery({
    ...queries.list,
    refetchInterval: query => listRefetchInterval(query.state.data, { activeUntil: activityUntil, visible }),
    // 隐藏 tab 不轮询；可见 tab 空闲时低频刷新目录事实。
    refetchIntervalInBackground: false,
    // 回到页面时立即补一次目录事实。
    refetchOnWindowFocus: true,
  }, queries.client);
  const projectList = useQuery({
    ...queries.projects,
    // 项目清单变化远低于会话目录：跟随可见性低频刷新即可。
    refetchInterval: visible ? LIST_POLL_IDLE_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  }, queries.client);
  const cleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bumpActivity = useCallback(() => {
    setActivityUntil(Date.now() + LIST_POLL_ACTIVITY_MS);
  }, []);

  useEffect(() => {
    // StrictMode 会连续执行 setup → cleanup → setup：把释放推迟到下一轮事件循环，
    // 重挂载时取消，真实卸载时才释放连接与查询缓存。
    if (cleanupTimer.current !== null) {
      clearTimeout(cleanupTimer.current);
      cleanupTimer.current = null;
    }
    queries.client.mount();
    return () => {
      cleanupTimer.current = setTimeout(() => {
        cleanupTimer.current = null;
        void controller.dispose();
        queries.client.unmount();
        void queries.dispose();
      }, 0);
    };
  }, [controller, queries]);

  // 全文读取按调用时刻取当前会话；切换会话不需要重建 reader。
  const payloadReader = useMemo(() => chatPayloadReader(() => controller), [controller]);
  const answerInteraction = useCallback(async (interactionId: string, answer: InteractionAnswer) => {
    await controller.answerInteraction(interactionId, answer);
  }, [controller]);

  const refreshList = useCallback(async () => {
    await Promise.all([
      list.refetch({ cancelRefetch: true }),
      projectList.refetch({ cancelRefetch: true }),
    ]);
  }, [list.refetch, projectList.refetch]);
  const selectChat = useCallback(async (
    chat: ChatSummary | null,
    options?: { projectId?: string },
  ) => {
    const opened = await controller.openChat(chat, options);
    // 切换会话时刷新目录：发现外部客户端新建/结算的后台会话。
    bumpActivity();
    void list.refetch({ cancelRefetch: true });
    return opened;
  }, [controller, bumpActivity, list.refetch]);
  const createProject = useCallback(async (name: string) => {
    const project = await controller.createProject(name);
    await projectList.refetch({ cancelRefetch: true });
    return project;
  }, [controller, projectList.refetch]);
  const reloadChat = useCallback(async () => {
    const opened = await controller.reloadChat();
    bumpActivity();
    void list.refetch({ cancelRefetch: true });
    return opened;
  }, [controller, bumpActivity, list.refetch]);
  const rebuildChat = useCallback(async (force = true) => {
    // 用户显式“重启会话”默认走 DELETE ?force=1：持久化/关闭未确认时也能放弃旧 runtime。
    const opened = await controller.rebuildChat(force);
    bumpActivity();
    void list.refetch({ cancelRefetch: true });
    return opened;
  }, [controller, bumpActivity, list.refetch]);
  const currentChatId = useCallback(() => controller.currentChatId(), [controller]);
  const send = useCallback(async (content: string): Promise<ChatSendOutcome> => {
    // 身份以控制器实际提交的会话为准：隐式创建期间即使视图已切走，也不会记错会话。
    const outcome = await controller.send(content);
    if (outcome.sessionId) bumpActivity();
    return outcome;
  }, [controller, bumpActivity]);
  const promptInFlight = (options.actualRuntime?.promptInFlight ?? 0) > 0;
  const stop = useCallback(
    () => controller.stop({ promptInFlight }),
    [controller, promptInFlight],
  );
  const loadEarlierHistory = useCallback(
    (limit?: number) => controller.loadEarlierHistory(limit),
    [controller],
  );
  const takeBackInput = useCallback(
    (inputId: string) => controller.takeBackInput(inputId),
    [controller],
  );
  const forceSendInput = useCallback(
    (inputId: string) => controller.forceSendInput(inputId),
    [controller],
  );
  const setConfigOption = useCallback(
    (configId: string, value: string) => controller.setConfigOption(configId, value),
    [controller],
  );
  const dismissChatError = useCallback(() => controller.dismissError(), [controller]);
  const dismissListError = useCallback(() => {
    setDismissedListError(list.errorUpdatedAt);
  }, [list.errorUpdatedAt]);

  const chatError = view.error;
  const listError = list.error && dismissedListError !== list.errorUpdatedAt ? errorText(list.error) : '';
  const runtimeFailure = options.actualRuntime?.promptFailure ?? null;
  const rawPromptFailure = promptFailureBanner(runtimeFailure, dismissedPromptFailure);
  // 同步 Action 已经展示同一失败时不再重复挂一条异步横幅；但 rebuild 横幅
  // 只在同步横幅同样提供重启入口时才让位，避免去重后只剩“关闭”按钮。
  const syncCoversPromptFailure = rawPromptFailure && chatError
    && chatError.includes(rawPromptFailure.detail)
    && (!isPromptFailureBlocking(runtimeFailure) || view.recovery === 'rebuild');
  const visiblePromptFailure = syncCoversPromptFailure ? null : rawPromptFailure;
  const banners = errorBanners({
    listError, chatError, loadState: view.loadState, recovery: view.recovery,
  });
  if (visiblePromptFailure) banners.promptFailure = visiblePromptFailure;
  const promptRecoveryDraft = runtimeFailure
    ? controller.recoverableDraft(runtimeFailure.requestId)
    : null;
  const dismissPromptFailure = useCallback(() => {
    setDismissedPromptFailure(rawPromptFailure?.key ?? null);
  }, [rawPromptFailure?.key]);

  return {
    ...view, chats: list.data ?? [], projects: projectList.data ?? [],
    listLoading: list.isFetching, projectsLoading: projectList.isFetching,
    chatError, listError, error: chatError || listError, banners,
    /** 运行侧事实来自 App 的 runtime 轮询，不新增端点。 */
    promptInFlight: options.actualRuntime?.promptInFlight ?? 0,
    promptFailure: visiblePromptFailure,
    /** 只有需要重启运行时的失败在恢复前不再发送；reload/none 可继续发送。 */
    promptFailureBlocked: isPromptFailureBlocking(runtimeFailure),
    promptRecoveryDraft,
    payloadReader, answerInteraction,
    refreshList, selectChat, createProject, reloadChat, rebuildChat, currentChatId, send, stop,
    loadEarlierHistory, takeBackInput, forceSendInput,
    setConfigOption,
    dismissChatError, dismissListError, dismissPromptFailure,
  };
}
