import { useEffect, type ReactNode } from "react";
import type { Agent } from "../../lib/types";
import {
  ErrorBox,
  Loading,
  Segmented,
  Sheet,
} from "../../ui/primitives";

export type MemberFilter = "all" | "unassigned" | "archived";

/** Archived members are excluded from the unassigned bucket. */
export function groupMembers(agents: Agent[]) {
  const archived = agents.filter((agent) => agent.status === "archived");
  const active = agents.filter((agent) => agent.status !== "archived");
  const unassigned = active.filter(
    (agent) => !agent.placement?.nodeId && !agent.groupId,
  );
  return { all: agents, active, unassigned, archived };
}

function emptyLabel(filter: MemberFilter) {
  if (filter === "unassigned") return "当前没有未分配的成员。";
  if (filter === "archived") return "当前没有离职人员。";
  return "当前公司还没有成员。";
}

export function MemberDirectorySheet({
  open,
  agents,
  filter,
  loading,
  error,
  onFilter,
  onClose,
  renderMember,
}: {
  open: boolean;
  agents: Agent[];
  filter: MemberFilter;
  loading: boolean;
  error: unknown;
  onFilter: (filter: MemberFilter) => void;
  onClose: () => void;
  renderMember: (agent: Agent) => ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);

  const groups = groupMembers(agents);
  const visible =
    filter === "all"
      ? groups.all
      : filter === "unassigned"
        ? groups.unassigned
        : groups.archived;

  return (
    <Sheet
      open={open}
      title="成员列表"
      subtitle="当前公司的全部成员；离职成员保留目录、Session、IM 与 Issue，恢复后可重新分配节点。"
      onClose={onClose}
      wide
    >
      <div className="org-member-directory" data-testid="member-directory">
        <Segmented
          value={filter}
          options={[
            { id: "all", label: "全部", count: groups.all.length },
            {
              id: "unassigned",
              label: "未分配",
              count: groups.unassigned.length,
            },
            { id: "archived", label: "离职人员", count: groups.archived.length },
          ]}
          onChange={onFilter}
        />
        <div className="org-member-list" data-testid="member-directory-list">
          {loading && <Loading label="读取成员…" />}
          <ErrorBox error={error} />
          {!loading && !error && visible.length === 0 && (
            <p className="org-empty">{emptyLabel(filter)}</p>
          )}
          {!loading &&
            !error &&
            visible.map((agent) => renderMember(agent))}
        </div>
      </div>
    </Sheet>
  );
}
