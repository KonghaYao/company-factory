import { lazy, Suspense } from "react";
import {
  Activity,
  CircleDot,
  Files as FilesIcon,
  MessageSquare,
  Settings2,
} from "lucide-react";
import type {
  Agent,
  FileReference,
  Issue,
  Preview,
  Runtime,
  Scope,
  Thread,
} from "../../lib/types";
import { ErrorBox, IconButton, Loading } from "../../ui/primitives";
import { RunView } from "./RunView";
import { TasksView } from "./TasksView";
import { MessagesView } from "./MessagesView";

// Monaco 体积较大，只在打开文件页签时加载。
const FilesView = lazy(() =>
  import("./FilesView").then((module) => ({ default: module.FilesView })),
);

export type WorkspaceTab = "run" | "tasks" | "files" | "messages";

const TABS: {
  id: WorkspaceTab;
  label: string;
  icon: typeof Activity;
}[] = [
  { id: "run", label: "运行", icon: Activity },
  { id: "tasks", label: "任务", icon: CircleDot },
  { id: "files", label: "文件", icon: FilesIcon },
  { id: "messages", label: "消息", icon: MessageSquare },
];

/**
 * 数据工作区是「业务事实」面板，与 Chat 的「对话事实」分开。
 * 页签状态保存在 per-Agent 的本地状态里，切换成员后各自恢复。
 */
export function WorkspacePanel({
  scope,
  agent,
  runtime,
  issues,
  previews,
  threads,
  agents,
  tab,
  selectedIssue,
  openReference,
  error,
  onTab,
  onSelectIssue,
  onOpenAgent,
  onCreateIssue,
  onOpenConfig,
  onDraft,
  onReference,
}: {
  scope: Scope;
  agent?: Agent;
  runtime?: Runtime;
  issues: Issue[];
  previews: Preview[];
  threads: Thread[];
  agents: Agent[];
  tab: WorkspaceTab;
  selectedIssue?: string;
  openReference?: FileReference;
  error?: unknown;
  onTab: (tab: WorkspaceTab) => void;
  onSelectIssue: (id?: string) => void;
  onOpenAgent: (id: string) => void;
  onCreateIssue: () => void;
  onOpenConfig: () => void;
  onDraft: (text: string) => void;
  onReference: (reference: FileReference) => void;
}) {
  return (
    <div className="workspace-panel">
      <header className="workspace-head">
        <div className="workspace-heading">
          <span className="panel-kicker">工作区</span>
          <div className="workspace-title">
            <h2>{agent?.name || "未选择成员"}</h2>
            {agent && <span>{agent.role}</span>}
          </div>
        </div>
        {agent && (
          <IconButton label="Agent 配置" onClick={onOpenConfig}>
            <Settings2 size={16} />
          </IconButton>
        )}
      </header>

      <nav className="workspace-tabs" aria-label="工作区页签" role="tablist">
        {TABS.map((item) => {
          const count =
            item.id === "tasks"
              ? issues.length
              : item.id === "messages"
                ? threads.length
                : 0;
          return (
            <button
              key={item.id}
              role="tab"
              aria-label={item.label}
              aria-selected={tab === item.id}
              className={tab === item.id ? "active" : ""}
              onClick={() => onTab(item.id)}
            >
              <item.icon size={14} />
              {item.label}
              {count > 0 && <span>{count}</span>}
            </button>
          );
        })}
      </nav>

      <div className={`workspace-body ${tab === "files" ? "is-files" : ""}`}>
        <ErrorBox error={error} />
        {!agent ? (
          <div className="workspace-empty">选择一位 Agent 开始工作。</div>
        ) : tab === "run" ? (
          <RunView
            agent={agent}
            runtime={runtime}
            issues={issues}
            previews={previews}
            onIssue={onSelectIssue}
          />
        ) : tab === "tasks" ? (
          <TasksView
            scope={scope}
            issues={issues}
            previews={previews}
            selected={selectedIssue}
            onSelect={onSelectIssue}
            onCreate={onCreateIssue}
            onAgent={onOpenAgent}
            agents={agents}
          />
        ) : tab === "files" ? (
          <Suspense fallback={<Loading label="打开文件编辑器…" />}>
            <FilesView
              key={`${scope.companyId}:${scope.agentId}`}
              scope={scope}
              openReference={openReference}
              onReference={onReference}
            />
          </Suspense>
        ) : (
          <MessagesView
            key={`${scope.companyId}:${scope.agentId}`}
            scope={scope}
            threads={threads}
            agents={agents}
            onDraft={onDraft}
          />
        )}
      </div>

      <footer className="workspace-foot">
        <span className="connected-dot" />
        <span>文件为事实来源</span>
        <span className="workspace-foot-right">Company MCP × 3</span>
      </footer>
    </div>
  );
}
