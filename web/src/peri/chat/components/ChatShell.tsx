import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { syncRetryAction, useChat } from '../runtime';
import type { ChatSummary } from '../runtime';
import { Timeline } from '../timeline';
import { parseOpenUIAction, type OpenUIActionEvent } from '../openui';
import {
  ChatComposer, deriveHistoryPrompts, readAvailableCommands, readComposerMeta, readContextUsage,
} from '../composer';
import { ChatHeader } from './ChatHeader';
import { ChatRightPanel } from './ChatRightPanel';
import { PendingInteractions } from './PendingInteractions';
import { Sidebar } from './Sidebar';
import { Welcome } from './Welcome';
import { ChatBanners } from './shell/ChatBanners';
import { useComposerDrafts } from './shell/useComposerDrafts';
import { useChatNavigation } from './shell/useChatNavigation';

interface ChatShellProps {
  onOpenSettings: () => void;
}

/** `useChat` 的完整读面；DOM 测试可注入同形对象。 */
export type ChatShellChat = ReturnType<typeof useChat>;

interface ChatShellViewProps {
  chat: ChatShellChat;
  onOpenSettings: () => void;
  /** 宿主外壳开关：Company 已有 Agent 侧栏与 WorkspacePanel。 */
  chrome?: { sidebar?: boolean; details?: boolean };
  /** 时间线上方的宿主插槽（如“加载更早”）。 */
  beforeTimeline?: ReactNode;
  /** Composer 上方的宿主插槽（Issue/引用 chips、输入队列）。 */
  composerExtras?: ReactNode;
  /** 宿主从外部插入草稿（如“加入 HR 草稿”）；会话未就绪时等待。 */
  injectedDraft?: { text: string; revision: number };
  onInjectedDraft?: () => void;
}

const NAVIGATION_BLOCKED_PHASES = new Set(['cancelling', 'syncing']);

/**
 * 键入只改草稿槽：Timeline 的 props 全部保持引用稳定，避免整段会话列表跟着
 * 每次输入重渲染。Timeline 内部滚动实现不变。
 */
const MemoTimeline = memo(Timeline);

/** 三栏外壳：左侧线程列表、中间 Chat 列、右侧可收起的详情面板。 */
export function ChatShell({ onOpenSettings }: ChatShellProps) {
  const chat = useChat();
  return <ChatShellView chat={chat} onOpenSettings={onOpenSettings} />;
}

/**
 * 外壳视图：数据与命令全部经 `chat` 注入。
 * 窄屏 sidebar 变 drawer，右面板变 overlay；错误分列表/会话/实时同步三类展示。
 */
export function ChatShellView({
  chat,
  onOpenSettings,
  chrome,
  beforeTimeline,
  composerExtras,
  injectedDraft,
  onInjectedDraft,
}: ChatShellViewProps) {
  const showSidebar = chrome?.sidebar !== false;
  const showDetails = chrome?.details !== false;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const detailsTrigger = useRef<HTMLButtonElement>(null);

  const drafts = useComposerDrafts(chat.selected?.id ?? null, chat.currentChatId);
  const navigation = useChatNavigation(chat, drafts);
  const { draftKey, draft, changeDraft, selectPrompt: setPromptDraft } = drafts;
  const { select, runAction, send, focusComposer, focusSignal, scrollSignal } = navigation;

  // 宿主注入草稿：会话就绪后按 revision 只应用一次，追加而不是覆盖用户输入。
  const injectedRevision = useRef(0);
  useEffect(() => {
    if (!injectedDraft || !chat.selected) return;
    if (injectedDraft.revision === injectedRevision.current) return;
    injectedRevision.current = injectedDraft.revision;
    changeDraft(draft ? `${draft}\n\n${injectedDraft.text}` : injectedDraft.text);
    focusComposer();
    onInjectedDraft?.();
  }, [
    injectedDraft,
    chat.selected,
    draft,
    changeDraft,
    focusComposer,
    onInjectedDraft,
  ]);

  const running = chat.state?.running === true || chat.phase === 'cancelling';
  const promptInFlight = (chat.promptInFlight ?? 0) > 0;
  // prompt 是整轮 RPC：受理后到投影出 running 之前也必须挡住第二次发送。
  const canSend = chat.historyReady && chat.phase === 'idle'
    && !promptInFlight && !chat.promptFailureBlocked;
  const navigationDisabled = NAVIGATION_BLOCKED_PHASES.has(chat.phase);
  const pendingInteractions = chat.state?.pendingInteractions ?? [];
  const chatBanner = chat.banners.chat;
  const promptFailureBanner = chat.banners.promptFailure;
  const listBanner = chat.banners.list;
  const syncRetry = syncRetryAction({ loadState: chat.loadState, liveSync: chat.liveSync });
  // 阻断态必须给出原因与可执行入口；错误横幅在这时让位给专用提示，避免重复。
  const blocked = chat.phase === 'blocked';
  const blockedMessage = chat.chatError
    || (chat.recovery === 'rebuild'
      ? '会话需要重启后才能继续。'
      : chat.state?.executionBlocked
        ? '宿主执行被阻断，当前会话暂时不能发送消息。'
        : '会话被阻断，需要重新加载后才能继续。');
  const composerDisabledReason = chat.phase === 'blocked'
    ? (chat.recovery === 'rebuild'
      ? '会话需要重启后才能继续发送。'
      : chat.state?.executionBlocked
        ? '会话执行被阻断，请先重新加载。'
        : '操作状态未确认，请先重新加载。')
    : chat.promptFailureBlocked
      ? '会话需要重启后才能继续发送。'
      : promptInFlight
        ? '上一条消息仍在执行，请稍候。'
        : undefined;
  // 实时同步中断：已有内容时也保留重连；首次同步提示只在没有其他横幅时出现。
  const syncError = syncRetry === 'reload-chat' && chat.loadState !== 'failed';
  const syncPending = !blocked && !chatBanner && syncRetry === 'none' && chat.selected !== null
    && !chat.historyReady && chat.phase !== 'loading' && chat.loadState !== 'unsupported';
  // 目录是线程标题的服务端事实：Store 的自动标题不经过副本会话信息，
  // 页头跟随目录轮询，而不是停在创建时的占位标题。
  const selectedTitle = chat.chats.find((item) => item.sessionId === chat.selected?.id)?.title
    || chat.selected?.title
    || '新会话';

  // Composer 只消费派生事实：状态栏、用量、历史与命令都来自当前展示态。
  const composerMeta = useMemo(() => readComposerMeta(chat.state), [chat.state]);
  const composerUsage = useMemo(() => readContextUsage(chat.state), [chat.state]);
  const composerHistory = useMemo(() => deriveHistoryPrompts(chat.state), [chat.state]);
  const composerCommands = useMemo(() => readAvailableCommands(chat.state), [chat.state]);
  const setConfigOption = useCallback(async (configId: string, value: string) => {
    const result = await chat.setConfigOption(configId, value);
    if (!result.ok) throw new Error(result.message);
  }, [chat.setConfigOption]);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    sidebarTrigger.current?.focus();
  }, []);

  const closeDetails = useCallback(() => {
    setDetailsOpen(false);
    detailsTrigger.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (sidebarOpen) closeSidebar();
      if (detailsOpen) closeDetails();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen, detailsOpen, closeSidebar, closeDetails]);

  const selectFromSidebar = useCallback((target: ChatSummary | null) => {
    setSidebarOpen(false);
    void select(target);
  }, [select]);

  const newChat = useCallback(() => selectFromSidebar(null), [selectFromSidebar]);

  const newChatInProject = useCallback((projectId: string) => {
    setSidebarOpen(false);
    void select(null, { projectId });
  }, [select]);

  const createProject = useCallback(async (name: string) => {
    await chat.createProject(name);
  }, [chat.createProject]);

  const refreshList = useCallback(() => {
    void chat.refreshList();
  }, [chat.refreshList]);

  /** 断开连接的恢复入口：重开当前会话；成功后才迁移草稿由导航 hook 负责。 */
  const onRetry = useMemo(
    () => (syncRetry === 'reload-chat' ? () => runAction('reload-chat') : undefined),
    [runAction, syncRetry],
  );

  const selectPrompt = useCallback((prompt: string) => {
    setPromptDraft(prompt);
    focusComposer();
  }, [focusComposer, setPromptDraft]);

  // 异步 prompt 失败只提供手动恢复入口：不自动写草稿，更不自动重发。
  const recoveryDraft = chat.promptRecoveryDraft
    && draft.trim() !== chat.promptRecoveryDraft.trim()
    ? chat.promptRecoveryDraft
    : null;
  const restoreRecoveryDraft = useCallback(() => {
    const text = chat.promptRecoveryDraft;
    if (!text) return;
    changeDraft(draft ? `${draft}\n\n${text}` : text);
    focusComposer();
  }, [changeDraft, chat.promptRecoveryDraft, draft, focusComposer]);

  /** Renderer action 路由：复用 send 的草稿迁移语义；外链只接受已白名单的 http(s)。 */
  const onOpenUIAction = useCallback((event: OpenUIActionEvent) => {
    const action = parseOpenUIAction(event);
    if (action.kind === 'send') {
      void send(action.text);
    } else if (action.kind === 'open_url' && typeof window !== 'undefined') {
      window.open(action.url, '_blank', 'noopener,noreferrer');
    }
  }, [send]);

  const stop = useCallback(() => chat.stop(), [chat.stop]);

  const emptyContent = useMemo(
    () => <Welcome disabled={!canSend} onSelectPrompt={selectPrompt} />,
    [canSend, selectPrompt],
  );

  return (
    <div className="bg-background text-foreground flex h-full min-h-[320px] overflow-hidden">
      {showSidebar && (
        <Sidebar
          chats={chat.chats}
          projects={chat.projects}
          selectedId={chat.selected?.id}
          selectedRunning={chat.state?.running === true}
          loading={chat.listLoading}
          projectsLoading={chat.projectsLoading}
          disabled={navigationDisabled}
          open={sidebarOpen}
          onClose={closeSidebar}
          onNew={newChat}
          onNewInProject={newChatInProject}
          onCreateProject={createProject}
          onRefresh={refreshList}
          onSelect={selectFromSidebar}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          title={selectedTitle}
          detailsOpen={detailsOpen}
          sidebarOpen={sidebarOpen}
          showSidebar={showSidebar}
          showDetails={showDetails}
          sidebarTrigger={sidebarTrigger}
          detailsTrigger={detailsTrigger}
          syncLabel={
            chat.loadState === 'unsupported'
              ? '版本不支持'
              : chat.loadState === 'failed' || chat.liveSync === 'failed'
                ? '同步失败'
                : chat.selected && !chat.historyReady ? '同步中…' : undefined
          }
          onOpenSidebar={() => setSidebarOpen(true)}
          onToggleDetails={() => setDetailsOpen((value) => !value)}
          onOpenSettings={onOpenSettings}
        />

        <ChatBanners
          listBanner={listBanner}
          blocked={blocked}
          blockedMessage={blockedMessage}
          blockedRecovery={chat.recovery}
          chatBanner={chatBanner}
          promptFailureBanner={promptFailureBanner}
          syncError={syncError}
          syncPending={syncPending}
          onAction={runAction}
          onDismissList={chat.dismissListError}
          onDismissChat={chat.dismissChatError}
          onDismissPromptFailure={chat.dismissPromptFailure}
        />

        {beforeTimeline}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <MemoTimeline
            state={chat.state}
            loadState={chat.loadState}
            error={chat.chatError}
            onRetry={onRetry}
            emptyContent={emptyContent}
            bottomInset={composerHeight}
            scrollSignal={scrollSignal}
            payloadReader={chat.payloadReader}
            onOpenUIAction={onOpenUIAction}
            actionsEnabled={canSend}
          />

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-background via-background/90 to-transparent pt-8">
            <div className="pointer-events-auto mx-auto w-full max-w-[46rem] px-4 pb-4">
              <ChatComposer
                key={draftKey}
                draft={draft}
                onDraftChange={changeDraft}
                canSend={canSend}
                canStop={running || promptInFlight}
                stopping={chat.phase === 'cancelling'}
                disabledReason={composerDisabledReason}
                errorBanner={chat.chatError}
                recoveryDraft={recoveryDraft}
                onRestoreRecoveryDraft={restoreRecoveryDraft}
                pendingContent={
                  <>
                    {composerExtras}
                    <PendingInteractions
                      interactions={pendingInteractions}
                      onAnswer={chat.historyReady ? chat.answerInteraction : undefined}
                    />
                  </>
                }
                onSend={send}
                onStop={stop}
                onHeightChange={setComposerHeight}
                focusSignal={focusSignal}
                meta={composerMeta}
                usage={composerUsage}
                historyPrompts={composerHistory}
                commands={composerCommands}
                onConfigOption={setConfigOption}
              />
            </div>
          </div>
        </div>
      </main>

      {showDetails && (
        <ChatRightPanel open={detailsOpen} state={chat.state} onClose={closeDetails} />
      )}
    </div>
  );
}
