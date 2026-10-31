import {
  Building2,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Settings2,
} from "lucide-react";
import type { Agent, Company, Group } from "../../lib/types";
import { agentGroup, agentId } from "../../lib/types";
import {
  Avatar,
  ErrorBox,
  IconButton,
  Loading,
  Spinner,
} from "../../ui/primitives";

/**
 * 左栏只解决「我是谁、在哪个团队、跟谁工作」。
 * 公司切换放在最上方，成员按部门分组；运行态与待裁定用最小信号表达。
 */
export function OrganizationPanel({
  companies,
  companyId,
  groups,
  agents,
  selectedAgent,
  collapsed,
  loading,
  error,
  onChooseCompany,
  onSelectAgent,
  onEditAgent,
  onToggleGroup,
  onCreateCompany,
  onOpenSettings,
}: {
  companies: Company[];
  companyId: string;
  groups: Group[];
  agents: Agent[];
  selectedAgent: string;
  collapsed: Record<string, boolean>;
  loading: boolean;
  error: unknown;
  onChooseCompany: (id: string) => void;
  onSelectAgent: (id: string) => void;
  onEditAgent: (id: string) => void;
  onToggleGroup: (groupId: string) => void;
  onCreateCompany: () => void;
  onOpenSettings: () => void;
}) {
  const company = companies.find((c) => c.id === companyId);

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
      </div>

      <div className="org-scroll">
        {loading && <Loading label="读取组织…" />}
        <ErrorBox error={error} />
        {groups.map((group) => {
          const key = `${companyId}:${group.id}`;
          const members = agents.filter((agent) => agentGroup(agent) === group.id);
          const isCollapsed = collapsed[key];
          return (
            <section className="org-group" key={group.id}>
              <button
                className="org-group-head"
                onClick={() => onToggleGroup(group.id)}
              >
                {isCollapsed ? (
                  <ChevronRight size={12} />
                ) : (
                  <ChevronDown size={12} />
                )}
                <span>{group.name}</span>
                <em>{members.length}</em>
              </button>
              {!isCollapsed &&
                members.map((agent) => {
                  const id = agentId(agent);
                  const selected = id === selectedAgent;
                  return (
                    <div
                      className={`agent-row ${selected ? "is-selected" : ""}`}
                      key={id}
                    >
                      <button
                        data-testid={`agent-${id}`}
                        className="agent-main"
                        onClick={() => onSelectAgent(id)}
                        title={`${agent.name} · ${agent.role}`}
                      >
                        <span className="agent-avatar-wrap">
                          <Avatar name={agent.name} size="sm" />
                          {agent.busy && (
                            <span className="agent-busy" title="正在运行">
                              <Spinner size={10} />
                            </span>
                          )}
                        </span>
                        <span className="agent-copy">
                          <span className="agent-name">{agent.name}</span>
                          <span className="agent-role">{agent.role}</span>
                        </span>
                        {agent.needs_user && (
                          <span className="needs-dot" title="有待用户裁定" />
                        )}
                      </button>
                      <button
                        data-testid={`agent-edit-${id}`}
                        className="agent-edit"
                        title={`编辑 ${agent.name}`}
                        aria-label={`编辑 ${agent.name}`}
                        onClick={() => onEditAgent(id)}
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                  );
                })}
              {!isCollapsed && members.length === 0 && (
                <p className="org-empty">这个部门还没有成员。</p>
              )}
            </section>
          );
        })}
      </div>

      <div className="org-bottom">
        <button className="org-action" onClick={onOpenSettings}>
          <Settings2 size={14} />
          组织设置
        </button>
        <p className="org-note">
          <span className="tiny-mark">◆</span> 一个成员，一个长期会话。
        </p>
      </div>
    </div>
  );
}
