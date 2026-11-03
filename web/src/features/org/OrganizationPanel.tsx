import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  Building2,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  Undo2,
  Users,
} from "lucide-react";
import type {
  Agent,
  Company,
  Organization,
  OrgNode,
  PendingDecision,
} from "../../lib/types";
import { agentId } from "../../lib/types";
import {
  Avatar,
  ErrorBox,
  IconButton,
  Loading,
  Spinner,
} from "../../ui/primitives";
import {
  MemberDirectorySheet,
  groupMembers,
  type MemberFilter,
} from "./MemberDirectorySheet";
import { PendingQuestions } from "./PendingQuestions";

type RunAction = (action: () => void) => () => void;

/** One trigger per row; outside click, Escape or selection closes the menu. */
function RowActionsMenu({
  label,
  testId,
  menuTestId,
  className,
  children,
}: {
  label: string;
  testId: string;
  menuTestId: string;
  className: string;
  children: (run: RunAction) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const run: RunAction = (action) => () => {
    setOpen(false);
    action();
  };

  return (
    <span className={`${className} ${open ? "is-open" : ""}`.trim()} ref={root}>
      <IconButton
        label={label}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={14} />
      </IconButton>
      {open && (
        <div
          className="row-actions-menu"
          role="menu"
          aria-label={label}
          data-testid={menuTestId}
        >
          {children(run)}
        </div>
      )}
    </span>
  );
}

/** One sidebar entry opens the unified member directory at a given filter. */
export function MembersMenu({
  counts,
  onOpen,
  defaultOpen = false,
}: {
  counts: { all: number; unassigned: number; archived: number };
  onOpen: (filter: MemberFilter) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const choose = (filter: MemberFilter) => {
    setOpen(false);
    onOpen(filter);
  };

  return (
    <div className={`org-members ${open ? "is-open" : ""}`.trim()} ref={root}>
      <button
        type="button"
        className="org-members-trigger"
        data-testid="org-members-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Users size={13} />
        <span>成员</span>
        <em>{counts.all}</em>
        <ChevronDown size={12} className="org-members-chevron" />
      </button>
      {open && (
        <div
          className="row-actions-menu org-members-menu"
          role="menu"
          aria-label="成员"
          data-testid="org-members-menu"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="org-members-all"
            onClick={() => choose("all")}
          >
            <Users size={12} /> 全部成员 <em>{counts.all}</em>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="org-members-unassigned"
            onClick={() => choose("unassigned")}
          >
            <MoveRight size={12} /> 未分配成员 <em>{counts.unassigned}</em>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="org-members-archived"
            onClick={() => choose("archived")}
          >
            <Archive size={12} /> 离职人员 <em>{counts.archived}</em>
          </button>
        </div>
      )}
    </div>
  );
}

/** Keep node actions behind one trigger so the tree header stays quiet. */
function NodeActionsMenu({
  node,
  onCreate,
  onEdit,
  onArchive,
  onDelete,
}: {
  node: OrgNode;
  onCreate: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const archived = node.status === "archived";

  return (
    <RowActionsMenu
      label={`${node.name} 的更多操作`}
      testId={`org-node-more-${node.id}`}
      menuTestId={`org-node-menu-${node.id}`}
      className="org-node-actions"
    >
      {(run) =>
        archived ? (
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            data-testid={`org-node-delete-${node.id}`}
            onClick={run(onDelete)}
          >
            <Trash2 size={12} />
            删除已归档节点
          </button>
        ) : (
          <>
            <button
              type="button"
              role="menuitem"
              data-testid={`org-node-add-${node.id}`}
              onClick={run(onCreate)}
            >
              <Plus size={12} />
              新建子节点
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid={`org-node-edit-${node.id}`}
              onClick={run(onEdit)}
            >
              <Pencil size={12} />
              编辑节点
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid={`org-node-archive-${node.id}`}
              onClick={run(onArchive)}
            >
              <Archive size={12} />
              归档节点
            </button>
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              data-testid={`org-node-delete-${node.id}`}
              onClick={run(onDelete)}
            >
              <Trash2 size={12} />
              删除节点
            </button>
          </>
        )
      }
    </RowActionsMenu>
  );
}

/** Person rows use the same menu so identity actions stay out of the way. */
function AgentActionsMenu({
  agent,
  onMove,
  onArchive,
  onEdit,
  onRestore,
}: {
  agent: Agent;
  onMove: () => void;
  onArchive: () => void;
  onEdit: () => void;
  onRestore: () => void;
}) {
  const id = agentId(agent);
  const archived = agent.status === "archived";

  return (
    <RowActionsMenu
      label={`${agent.name} 的更多操作`}
      testId={`agent-more-${id}`}
      menuTestId={`agent-menu-${id}`}
      className="agent-actions"
    >
      {(run) =>
        archived ? (
          <button
            type="button"
            role="menuitem"
            data-testid={`agent-restore-${id}`}
            onClick={run(onRestore)}
          >
            <Undo2 size={12} />
            恢复成员
          </button>
        ) : (
          <>
            <button
              type="button"
              role="menuitem"
              data-testid={`agent-move-${id}`}
              onClick={run(onMove)}
            >
              <MoveRight size={12} />
              移动到其他节点
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid={`agent-archive-${id}`}
              onClick={run(onArchive)}
            >
              <Archive size={12} />
              归档成员
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid={`agent-edit-${id}`}
              onClick={run(onEdit)}
            >
              <Pencil size={12} />
              编辑成员
            </button>
          </>
        )
      }
    </RowActionsMenu>
  );
}

/**
 * 组织树是独立于人员实体的投影：节点只引用成员，移动成员不改变身份、
 * 固定 Session、权限或 Issue/IM 归属。
 */
export function OrganizationPanel({
  companies,
  companyId,
  organization,
  agents,
  selectedAgent,
  collapsed,
  loading,
  error,
  pendingQuestions,
  pendingQuestionsError,
  onChooseCompany,
  onSelectAgent,
  onEditAgent,
  onToggleNode,
  onCreateCompany,
  onOpenSettings,
  onCreateNode,
  onEditNode,
  onArchiveNode,
  onDeleteNode,
  onMoveAgent,
  onArchiveAgent,
  onRestoreAgent,
  onAnswerQuestion,
  onOpenQuestion,
}: {
  companies: Company[];
  companyId: string;
  organization: Organization | null;
  agents: Agent[];
  selectedAgent: string;
  collapsed: Record<string, boolean>;
  loading: boolean;
  error: unknown;
  pendingQuestions: PendingDecision[];
  pendingQuestionsError: unknown;
  onChooseCompany: (id: string) => void;
  onSelectAgent: (id: string) => void;
  onEditAgent: (id: string) => void;
  onToggleNode: (nodeId: string) => void;
  onCreateCompany: () => void;
  onOpenSettings: () => void;
  onCreateNode: (parentId?: string) => void;
  onEditNode: (nodeId: string) => void;
  onArchiveNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onMoveAgent: (agentId: string) => void;
  onArchiveAgent: (agentId: string) => void;
  onRestoreAgent: (agentId: string) => void;
  onAnswerQuestion: (item: PendingDecision, answer: string) => Promise<unknown>;
  onOpenQuestion: (agentId: string, issueId: string) => void;
}) {
  const company = companies.find((c) => c.id === companyId);
  const [membersOpen, setMembersOpen] = useState(false);
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("all");

  const nodes = organization?.nodes ?? [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const roots = nodes
    .filter((node) => !node.parentId || !nodeIds.has(node.parentId))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const childrenOf = (parentId: string | null) =>
    nodes
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const memberGroups = groupMembers(agents);
  const renderActiveAgent = (agent: Agent, closeDirectory = false) => {
    const id = agentId(agent);
    const selected = id === selectedAgent;
    const act = (action: () => void) => () => {
      if (closeDirectory) setMembersOpen(false);
      action();
    };
    return (
      <div className={`agent-row ${selected ? "is-selected" : ""}`} key={id}>
        <button
          data-testid={`agent-${id}`}
          className="agent-main"
          onClick={act(() => onSelectAgent(id))}
          title={`${agent.name} · ${agent.role}`}
        >
          <span className="agent-avatar-wrap">
            <Avatar name={agent.name} color={agent.avatarColor} size="sm" />
            {agent.busy && (
              <span className="agent-busy" title="正在运行">
                <Spinner size={10} />
              </span>
            )}
          </span>
          <span className="agent-copy">
            <span className="agent-name">{agent.name}</span>
            <span className="agent-role">
              {agent.placement?.title || agent.role}
            </span>
          </span>
          {agent.needs_user && (
            <span className="needs-dot" title="有待用户裁定" />
          )}
        </button>
        <AgentActionsMenu
          agent={agent}
          onMove={act(() => onMoveAgent(id))}
          onArchive={act(() => onArchiveAgent(id))}
          onEdit={act(() => onEditAgent(id))}
          onRestore={act(() => onRestoreAgent(id))}
        />
      </div>
    );
  };
  const renderArchivedAgent = (agent: Agent, closeDirectory = false) => {
    const id = agentId(agent);
    const act = (action: () => void) => () => {
      if (closeDirectory) setMembersOpen(false);
      action();
    };
    return (
      <div className="agent-row" key={id}>
        <span className="agent-main agent-archived-copy">
          <Avatar name={agent.name} color={agent.avatarColor} size="sm" />
          <span className="agent-copy">
            <span className="agent-name">{agent.name}</span>
            <span className="agent-role">离职 · 权限已拒绝</span>
          </span>
        </span>
        <AgentActionsMenu
          agent={agent}
          onMove={act(() => onMoveAgent(id))}
          onArchive={act(() => onArchiveAgent(id))}
          onEdit={act(() => onEditAgent(id))}
          onRestore={act(() => onRestoreAgent(id))}
        />
      </div>
    );
  };
  const renderDirectoryMember = (agent: Agent) =>
    agent.status === "archived"
      ? renderArchivedAgent(agent, true)
      : renderActiveAgent(agent, true);
  const renderNode = (node: OrgNode, depth: number) => {
    const key = `${companyId}:${node.id}`;
    const isCollapsed = collapsed[key];
    const archived = node.status === "archived";
    const members = agents.filter(
      (agent) =>
        agent.status !== "archived" && agent.placement?.nodeId === node.id,
    );
    const children = childrenOf(node.id);
    return (
      <section
        className={`org-group ${archived ? "org-node-archived" : ""}`}
        key={node.id}
      >
        <div className="org-node-head" style={{ paddingLeft: depth * 8 }}>
          <button
            className="org-group-head"
            data-testid={`org-node-${node.id}`}
            onClick={() => onToggleNode(node.id)}
          >
            {isCollapsed ? (
              <ChevronRight size={12} />
            ) : (
              <ChevronDown size={12} />
            )}
            <span>
              {node.name}
              {archived ? "（已归档）" : ""}
            </span>
            <em>{members.length}</em>
          </button>
          <NodeActionsMenu
            node={node}
            onCreate={() => onCreateNode(node.id)}
            onEdit={() => onEditNode(node.id)}
            onArchive={() => onArchiveNode(node.id)}
            onDelete={() => onDeleteNode(node.id)}
          />
        </div>
        {!isCollapsed && (
          <>
            {members.map((agent) => renderActiveAgent(agent))}
            {members.length === 0 && children.length === 0 && (
              <p className="org-empty">这个节点还没有成员或子节点。</p>
            )}
            <div className="org-tree-children">
              {children.map((child) => renderNode(child, depth + 1))}
            </div>
          </>
        )}
      </section>
    );
  };

  return (
    <div className="org-panel">
      <div className="org-head">
        <div className="panel-kicker">
          <span>组织</span>
          <IconButton
            label="新建组织"
            data-testid="create-company"
            onClick={onCreateCompany}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        <label className="company-switch">
          <span className="company-mark">
            <Building2 size={16} />
          </span>
          <span className="company-copy">
            <select
              aria-label="选择公司"
              value={companyId}
              onChange={(event) => onChooseCompany(event.target.value)}
            >
              {companies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <small>{company?.goal || "本地组织 · Git 为事实来源"}</small>
          </span>
          <ChevronDown size={13} className="company-chevron" />
        </label>
        <MembersMenu
          counts={{
            all: memberGroups.all.length,
            unassigned: memberGroups.unassigned.length,
            archived: memberGroups.archived.length,
          }}
          onOpen={(filter) => {
            setMemberFilter(filter);
            setMembersOpen(true);
          }}
        />
      </div>

      <PendingQuestions
        questions={pendingQuestions}
        agents={agents}
        error={pendingQuestionsError}
        onAnswer={onAnswerQuestion}
        onOpenIssue={onOpenQuestion}
      />

      <div className="org-scroll">
        {loading && <Loading label="读取组织…" />}
        <ErrorBox error={error} />
        {!loading &&
          !error &&
          roots.map((node) => renderNode(node, 0))}
        {!loading && !error && nodes.length === 0 && (
          <p className="org-empty">还没有组织节点。</p>
        )}
      </div>

      <div className="org-bottom">
        <button className="org-action" onClick={onOpenSettings}>
          <Settings2 size={14} />
          组织设置
        </button>
      </div>

      <MemberDirectorySheet
        open={membersOpen}
        agents={agents}
        filter={memberFilter}
        loading={loading}
        error={error}
        onFilter={setMemberFilter}
        onClose={() => setMembersOpen(false)}
        renderMember={renderDirectoryMember}
      />
    </div>
  );
}
