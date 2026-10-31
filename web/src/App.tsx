import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Plus,
  Building2,
  Settings2,
  Activity,
  CircleDot,
  Files as FilesIcon,
  MessageSquare,
  Command,
  ArrowUpRight,
  PanelLeftClose,
  LoaderCircle,
  Pencil,
} from "lucide-react";
import type {
  Company,
  Agent,
  Group,
  Scope,
  Workspace,
  Runtime,
  FileReference,
  Issue,
} from "./lib/types";
import { agentId, agentGroup, scopeKey } from "./lib/types";
import { api, list, scoped, post, ApiError } from "./lib/api";
import { useLocal, emptyLocal } from "./lib/state";
import {
  CreateCompany,
  OrganizationModal,
  Configuration,
} from "./components/Organization";
import { CreateIssue, Tasks } from "./components/Tasks";
import { Chat } from "./components/Chat";
import { Run } from "./components/Run";
import { AgentEditor } from "./components/AgentEditor";
const Files = lazy(() =>
  import("./components/Files").then((module) => ({ default: module.Files })),
);
import { Messages } from "./components/Messages";
import { ErrorBox, Loading, Empty } from "./components/Common";
const ownerAccessTokenKey = "company.ownerAccessToken";
function saveOwnerAccessToken(token: string) {
  try {
    localStorage.setItem(ownerAccessTokenKey, token);
  } catch {
    // 浏览器存储不可用时，仍可使用已建立的 cookie 会话。
  }
}
export default function App() {
  const qc = useQueryClient();
  const [accessReady, setAccessReady] = useState(false);
  const [accessError, setAccessError] = useState<unknown>(null);
  const [accessToken, setAccessToken] = useState("");
  const accessStarted = useRef(false);
  useEffect(() => {
    if (accessStarted.current) return;
    accessStarted.current = true;
    const params = new URLSearchParams(location.hash.slice(1));
    const hasHashToken = params.has("access");
    let token = params.get("access");
    if (hasHashToken) {
      history.replaceState(null, "", location.pathname + location.search);
    } else {
      try {
        token = localStorage.getItem(ownerAccessTokenKey);
      } catch {
        // 浏览器存储不可用时，继续使用现有 cookie 会话或手动登录。
      }
    }
    if (token) {
      const loginToken = token;
      post("/api/login", { token: loginToken })
        .then(() => {
          saveOwnerAccessToken(loginToken);
          setAccessError(null);
          qc.invalidateQueries({ queryKey: ["companies"] });
        })
        .catch((error: unknown) => {
          if (
            !hasHashToken &&
            error instanceof ApiError &&
            ["unauthorized", "401", "invalid_token"].includes(error.code)
          ) {
            try {
              localStorage.removeItem(ownerAccessTokenKey);
            } catch {
              // 浏览器存储不可用时，仍显示登录错误以便手动重试。
            }
          }
          setAccessError(error);
        })
        .finally(() => setAccessReady(true));
    } else setAccessReady(true);
  }, []);
  const login = useMutation({
    mutationFn: (token: string) => post("/api/login", { token }),
    onSuccess: (_, token) => {
      saveOwnerAccessToken(token);
      setAccessToken("");
      setAccessError(null);
      qc.invalidateQueries({ queryKey: ["companies"] });
    },
  });
  const [companyId, setCompanyId] = useState<string>("");
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [companyModal, setCompanyModal] = useState(false);
  const [orgModal, setOrgModal] = useState(false);
  const [configModal, setConfigModal] = useState(false);
  const [editAgentId, setEditAgentId] = useState("");
  const [issueModal, setIssueModal] = useState(false);
  const [fileReference, setFileReference] = useState<
    FileReference | undefined
  >();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState("");
  const [split, setSplit] = useState([17, 33, 50]);
  const layoutRef = useRef<HTMLDivElement>(null);
  const companies = useQuery({
    queryKey: ["companies"],
    queryFn: () => api("/api/companies"),
    enabled: accessReady,
    retry: false,
    refetchInterval: 10000,
  });
  const allCompanies = list<Company>(companies.data, "companies");
  useEffect(() => {
    if (!companyId && allCompanies.length) setCompanyId(allCompanies[0].id);
  }, [allCompanies, companyId]);
  const organization = useQuery({
    queryKey: ["company", companyId],
    queryFn: () => api(`/api/companies/${encodeURIComponent(companyId)}`),
    enabled: !!companyId,
    refetchInterval: 4000,
  });
  const company: Company | undefined =
    organization.data?.company || allCompanies.find((c) => c.id === companyId);
  const agents: Agent[] = organization.data?.agents || [];
  const groups: Group[] = organization.data?.groups || [];
  useEffect(() => {
    if (agents.length && !agents.some((a) => agentId(a) === selectedAgent))
      setSelectedAgent(agentId(agents[0]));
  }, [organization.data, selectedAgent]);
  const agent = agents.find((a) => agentId(a) === selectedAgent);
  const editingAgent = agents.find((a) => agentId(a) === editAgentId);
  const scope: Scope = { companyId, agentId: selectedAgent };
  const local = useLocal((s) => s.scopes[scopeKey(scope)] || emptyLocal);
  const ensure = useLocal((s) => s.ensure);
  const patch = useLocal((s) => s.patch);
  useEffect(() => {
    if (companyId && selectedAgent) ensure(scope);
  }, [companyId, selectedAgent, ensure]);
  const workspace = useQuery<Workspace>({
    queryKey: ["workspace", companyId, selectedAgent],
    queryFn: () => api(scoped(scope, "workspace")),
    enabled: !!companyId && !!selectedAgent,
    refetchInterval: 2500,
  });
  const runtime = useQuery<Runtime>({
    queryKey: ["runtime", companyId, selectedAgent],
    queryFn: () => api(scoped(scope, "runtime")),
    enabled: !!companyId && !!selectedAgent,
    refetchInterval: 1500,
  });
  const issues = workspace.data?.issues || [];
  const previews = workspace.data?.previews || [];
  const threads = workspace.data?.threads || [];
  const actualRuntime = runtime.data || workspace.data?.runtime;
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 5000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const selectAgent = (id: string) => {
    setSelectedAgent(id);
    setFileReference(undefined);
  };
  const chooseCompany = (id: string) => {
    setCompanyId(id);
    setSelectedAgent("");
    setFileReference(undefined);
  };
  const selectIssue = (id?: string) =>
    patch(scope, { tab: "tasks", issueId: id });
  const draft = (text: string) => {
    patch(scope, { draft: local.draft ? `${local.draft}\n\n${text}` : text });
    setToast("指令已加入当前 Agent 的草稿，请检查后发送。");
  };
  const openFile = (reference: FileReference) => {
    patch(scope, { tab: "files" });
    setFileReference({ ...reference });
  };
  const resize = (index: number, e: React.PointerEvent) => {
    const el = layoutRef.current;
    if (!el) return;
    const startX = e.clientX;
    const initial = [...split];
    const width = el.getBoundingClientRect().width;
    e.currentTarget.setPointerCapture(e.pointerId);
    const target = e.currentTarget;
    const move = (event: Event) => {
      const delta = (((event as PointerEvent).clientX - startX) / width) * 100;
      const next = [...initial];
      const minA = index === 0 ? 12 : 22;
      const minB = 22;
      next[index] = Math.min(
        initial[index] + initial[index + 1] - minB,
        Math.max(minA, initial[index] + delta),
      );
      next[index + 1] = initial[index] + initial[index + 1] - next[index];
      setSplit(next);
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  };
  const createdIssue = (issue: Issue) => {
    setIssueModal(false);
    qc.invalidateQueries();
    const target = issue.agent_id || selectedAgent;
    selectAgent(target);
    patch(
      { companyId, agentId: target },
      { tab: "tasks", issueId: String(issue.id) },
    );
    setToast(`Issue #${issue.id} 已创建，任务主管已成为当前负责人。`);
  };
  const onAskHR = (text: string) => {
    const hr = agents.find((a) => a.role === "hr");
    if (!hr) {
      setToast("未找到 HR，请检查公司初始化结果。");
      return;
    }
    const hrScope = { companyId, agentId: agentId(hr) };
    const old = useLocal.getState().scopes[scopeKey(hrScope)]?.draft || "";
    patch(hrScope, { draft: old ? `${old}\n\n${text}` : text });
    selectAgent(agentId(hr));
    setToast("成员定义已加入 HR 草稿，请检查后发送；尚未创建成员。");
  };
  return (
    <div className="app">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Company Factory 首页">
          <span className="brand-mark">
            <Boxes size={21} />
          </span>
          <strong>
            Company<span>Factory</span>
          </strong>
        </a>
        <div className="header-center">
          <span className="header-crumb">工作台</span>
          <span>/</span>
          <span>{company?.name || "开始建立公司"}</span>
        </div>
        <div className="header-right">
          <span className="local-label">
            <span />
            本地优先
          </span>
          <button className="user-circle" title="本地用户">
            我
          </button>
        </div>
      </header>
      {!accessReady || companies.isLoading ? (
        <Loading label="打开工作台…" />
      ) : (companies.error instanceof ApiError &&
          companies.error.code === "unauthorized") ||
        accessError ? (
        <main className="onboarding">
          <div className="onboarding-content login-content">
            <div className="onboarding-mark">
              <Boxes size={35} />
            </div>
            <span className="eyebrow">PRIVATE LOCAL WORKSPACE</span>
            <h1>打开你的工作台</h1>
            <p>
              从服务器终端复制私有访问链接，
              <br />
              或在这里输入本机 owner-token 文件中的访问令牌。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                login.mutate(accessToken);
              }}
            >
              <input
                type="password"
                aria-label="本地访问令牌"
                autoComplete="off"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="本地访问令牌"
                required
              />
              <button
                className="primary"
                disabled={!accessToken || login.isPending}
              >
                {login.isPending ? "正在验证…" : "进入工作台"}
              </button>
            </form>
            <ErrorBox error={login.error || accessError} />
            <small className="muted">
              登录成功后，owner 访问令牌会保存在本机浏览器的 localStorage 中，
              用于下次恢复登录；浏览器存储不可用时仍可登录。
            </small>
          </div>
        </main>
      ) : !allCompanies.length && !companyId ? (
        <main className="onboarding">
          <div className="onboarding-grid" />
          <div className="onboarding-content">
            <div className="onboarding-mark">
              <Boxes size={35} />
            </div>
            <span className="eyebrow">YOUR TEAM, ONE WORKSPACE</span>
            <h1>
              让每一位 Agent
              <br />
              都有自己的工作位置。
            </h1>
            <p>
              组织、对话、任务与交付，在同一个工作台中协作。
              <br />
              以本地文件为事实来源，从总部的两位成员开始。
            </p>
            <button
              className="primary large-button"
              data-testid="create-company"
              onClick={() => setCompanyModal(true)}
            >
              <Plus size={17} />
              创建第一家 Company
            </button>
            <div className="onboarding-notes">
              <span>固定 Agent · 固定 Session</span>
              <span>YAML + Markdown + Git</span>
              <span>Peri 真实执行</span>
            </div>
            <ErrorBox error={companies.error} />
          </div>
        </main>
      ) : (
        <div
          className="workbench"
          ref={layoutRef}
          style={{
            gridTemplateColumns: `minmax(150px,${split[0]}fr) 4px minmax(250px,${split[1]}fr) 4px minmax(340px,${split[2]}fr)`,
          }}
        >
          <aside className="organization-panel">
            <div className="org-title">
              <span className="eyebrow">ORGANIZATION</span>
              <button
                className="icon-button"
                title="新建组织"
                data-testid="create-company"
                onClick={() => setCompanyModal(true)}
              >
                <Plus size={15} />
              </button>
            </div>
            <label className="company-selector">
              <Building2 size={16} />
              <select
                aria-label="选择公司"
                value={companyId}
                onChange={(e) => chooseCompany(e.target.value)}
              >
                {allCompanies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <div className="org-tree">
              {organization.isLoading && <Loading />}
              <ErrorBox error={organization.error} />
              {groups.map((group) => (
                <section className="org-group" key={group.id}>
                  <button
                    className="group-heading"
                    onClick={() =>
                      setCollapsed({
                        ...collapsed,
                        [`${companyId}:${group.id}`]:
                          !collapsed[`${companyId}:${group.id}`],
                      })
                    }
                  >
                    {collapsed[`${companyId}:${group.id}`] ? (
                      <ChevronRight size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )}
                    <span>{group.name}</span>
                    <span className="group-count">
                      {agents.filter((a) => agentGroup(a) === group.id).length}
                    </span>
                  </button>
                  {!collapsed[`${companyId}:${group.id}`] &&
                    agents
                      .filter((a) => agentGroup(a) === group.id)
                      .map((a) => {
                        const id = agentId(a);
                        const isSelected = id === selectedAgent;
                        const needs =
                          a.needs_user ||
                          (isSelected && issues.some((i) => i.needs_user));
                        const busy =
                          a.busy || (isSelected && actualRuntime?.busy);
                        return (
                          <div
                            key={id}
                            className={`agent-row ${isSelected ? "selected" : ""} ${needs ? "needs-user" : ""}`}
                          >
                            <button
                              data-testid={`agent-${id}`}
                              className="agent-select"
                              onClick={() => selectAgent(id)}
                              title={`${a.name} · ${a.role}${needs ? " · 有待裁定问题" : ""}`}
                            >
                              <span className="agent-busy">
                                {busy && (
                                  <LoaderCircle size={12} className="spin" />
                                )}
                              </span>
                              <span className="agent-dot">
                                {a.name.slice(0, 1)}
                              </span>
                              <span className="agent-name">{a.name}</span>
                              {needs && <span className="needs-dot" />}
                            </button>
                            <button
                              data-testid={`agent-edit-${id}`}
                              className="agent-edit"
                              title={`编辑 ${a.name} 的职责与系统提示词`}
                              aria-label={`编辑 ${a.name}`}
                              onClick={() => {
                                selectAgent(id);
                                setEditAgentId(id);
                              }}
                            >
                              <Pencil size={12} />
                            </button>
                          </div>
                        );
                      })}
                </section>
              ))}
            </div>
            <div className="org-bottom">
              <button
                className="quiet org-create"
                data-testid="create-organization"
                onClick={() => setCompanyModal(true)}
              >
                <Plus size={14} />
                新建组织
              </button>
              <button className="quiet" onClick={() => setOrgModal(true)}>
                <Settings2 size={14} />
                组织设置
              </button>
              <div className="org-footnote">
                <span className="tiny-mark">◆</span> 一个成员，一个长期会话。
              </div>
            </div>
          </aside>
          <div
            role="separator"
            aria-label="调整组织栏宽度"
            aria-orientation="vertical"
            className="resize-handle"
            onPointerDown={(e) => resize(0, e)}
          />
          {agent ? (
            <Chat
              key={scopeKey(scope)}
              scope={scope}
              agent={agent}
              runtime={actualRuntime}
              issues={issues}
              onFile={openFile}
            />
          ) : (
            <Empty title="选择一位 Agent">工作从一个具体的成员开始。</Empty>
          )}
          <div
            role="separator"
            aria-label="调整工作区宽度"
            aria-orientation="vertical"
            className="resize-handle"
            onPointerDown={(e) => resize(1, e)}
          />
          <section className="data-shell">
            <header className="shell-heading">
              <div>
                <span className="eyebrow">DATA SHELL</span>
                <strong>{agent?.name || "Agent"} 的工作区</strong>
              </div>
              {agent && (
                <button
                  className="icon-button"
                  onClick={() => setConfigModal(true)}
                  title="Agent 配置"
                  aria-label="Agent 配置"
                >
                  <Settings2 size={16} />
                </button>
              )}
            </header>
            <nav className="data-tabs" aria-label="工作区页签">
              {(
                [
                  { id: "run", label: "运行", icon: Activity },
                  { id: "tasks", label: "任务", icon: CircleDot },
                  { id: "files", label: "文件", icon: FilesIcon },
                  { id: "messages", label: "消息", icon: MessageSquare },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  className={local.tab === t.id ? "active" : ""}
                  onClick={() => patch(scope, { tab: t.id })}
                >
                  <t.icon size={14} />
                  {t.label}
                  {t.id === "tasks" && issues.length > 0 && (
                    <span>{issues.length}</span>
                  )}
                </button>
              ))}
            </nav>
            <div
              className={`shell-body ${local.tab === "files" ? "files-body" : ""}`}
            >
              <ErrorBox error={workspace.error} />
              {agent ? (
                local.tab === "run" ? (
                  <Run
                    agent={agent}
                    runtime={actualRuntime}
                    issues={issues}
                    previews={previews}
                    onIssue={selectIssue}
                  />
                ) : local.tab === "tasks" ? (
                  <Tasks
                    scope={scope}
                    issues={issues}
                    previews={previews}
                    selected={local.issueId}
                    onSelect={selectIssue}
                    onCreate={() => setIssueModal(true)}
                    onAgent={selectAgent}
                    agents={agents}
                  />
                ) : local.tab === "files" ? (
                  <Suspense fallback={<Loading label="打开文件编辑器…" />}>
                    <Files
                      key={scopeKey(scope)}
                      scope={scope}
                      openReference={fileReference}
                      onReference={(ref) => {
                        patch(scope, {
                          references: [...local.references, ref],
                        });
                        setToast("代码选区已引用到当前 Chat 草稿。");
                      }}
                    />
                  </Suspense>
                ) : (
                  <Messages
                    key={scopeKey(scope)}
                    scope={scope}
                    threads={threads}
                    agents={agents}
                    onDraft={draft}
                  />
                )
              ) : (
                <Empty title="尚未选择成员" />
              )}
            </div>
            <footer className="shell-footer">
              <span className="connected-dot" />
              <span>文件为事实来源</span>
              <span className="footer-right">Company MCP × 3</span>
            </footer>
          </section>
        </div>
      )}
      {companyModal && (
        <CreateCompany
          onClose={() => setCompanyModal(false)}
          onCreated={(c) => {
            setCompanyModal(false);
            chooseCompany(c.id);
            qc.invalidateQueries({ queryKey: ["companies"] });
            qc.invalidateQueries({ queryKey: ["company", c.id] });
          }}
        />
      )}
      {orgModal && company && (
        <OrganizationModal
          company={company}
          groups={groups}
          onClose={() => setOrgModal(false)}
          onAskHR={onAskHR}
        />
      )}{" "}
      {configModal && agent && (
        <Configuration
          scope={scope}
          agent={agent}
          onClose={() => setConfigModal(false)}
        />
      )}{" "}
      {editingAgent && (
        <AgentEditor
          key={agentId(editingAgent)}
          companyId={companyId}
          agent={editingAgent}
          onClose={() => setEditAgentId("")}
          onSaved={() => {
            setEditAgentId("");
            setToast("员工定义已保存，将从下一条消息起生效。");
          }}
        />
      )}{" "}
      {issueModal && (
        <CreateIssue
          companyId={companyId}
          onClose={() => setIssueModal(false)}
          onCreated={createdIssue}
        />
      )}{" "}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
