import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus } from "lucide-react";
import type {
  Agent,
  Company,
  FileReference,
  Group,
  Issue,
  Runtime,
  Scope,
  Workspace,
} from "./lib/types";
import { agentId, scopeKey } from "./lib/types";
import { api, ApiError, list, post, scoped } from "./lib/api";
import { emptyLocal, useLocal } from "./lib/state";
import { AppHeader } from "./layout/AppHeader";
import { SplitWorkspace } from "./layout/SplitWorkspace";
import { Button, ErrorBox, Spinner } from "./ui/primitives";
import { OrganizationPanel } from "./features/org/OrganizationPanel";
import { CreateCompany } from "./features/org/CreateCompany";
import { OrganizationSheet } from "./features/org/OrganizationSheet";
import { AgentConfiguration, AgentEditor } from "./features/org/AgentSettings";
import { WorkspacePanel } from "./features/workspace/WorkspacePanel";
import { CreateIssue } from "./features/workspace/CreateIssue";
import { ModelLibrarySheet } from "./features/models/ModelLibrarySheet";

/** Peri ChatShell 独立成 chunk：主工作台首屏不为 chat 运行时买单。 */
const CompanyChatShell = lazy(() =>
  import("./features/chat/CompanyChatShell").then((module) => ({
    default: module.CompanyChatShell,
  })),
);

const ownerAccessTokenKey = "company.ownerAccessToken";
const POLL_INTERVAL = { organization: 4000, workspace: 2500, runtime: 1500 };

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
        // 继续使用 cookie 会话或手动登录。
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
              // 存储不可用时仍显示登录错误，允许手动重试。
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

  const [companyId, setCompanyId] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [companyModal, setCompanyModal] = useState(false);
  const [orgModal, setOrgModal] = useState(false);
  const [configModal, setConfigModal] = useState(false);
  const [libraryModal, setLibraryModal] = useState(false);
  const [editAgentId, setEditAgentId] = useState("");
  const [issueModal, setIssueModal] = useState(false);
  const [fileReference, setFileReference] = useState<FileReference>();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState("");
  /** 从工作区注入 Composer 的文本；由 ChatShell 消费后清空，避免重复追加。 */
  const [composerInsert, setComposerInsert] = useState<{
    agentId: string;
    text: string;
    revision: number;
  }>();

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
    refetchInterval: POLL_INTERVAL.organization,
  });
  const company: Company | undefined =
    organization.data?.company ||
    allCompanies.find((item) => item.id === companyId);
  const agents: Agent[] = organization.data?.agents || [];
  const groups: Group[] = organization.data?.groups || [];

  useEffect(() => {
    if (
      agents.length &&
      !agents.some((item) => agentId(item) === selectedAgent)
    )
      setSelectedAgent(agentId(agents[0]));
  }, [organization.data, selectedAgent]);

  const agent = agents.find((item) => agentId(item) === selectedAgent);
  const editingAgent = agents.find((item) => agentId(item) === editAgentId);
  const scope: Scope = { companyId, agentId: selectedAgent };
  const local = useLocal(
    (state) => state.scopes[scopeKey(scope)] || emptyLocal,
  );
  const ensure = useLocal((state) => state.ensure);
  const patch = useLocal((state) => state.patch);
  const insertComposerText = (targetAgentId: string, text: string) => {
    if (!targetAgentId) return;
    setComposerInsert((current) => ({
      agentId: targetAgentId,
      text,
      revision: (current?.revision ?? 0) + 1,
    }));
  };

  useEffect(() => {
    if (companyId && selectedAgent) ensure(scope);
  }, [companyId, selectedAgent, ensure]);

  const workspace = useQuery<Workspace>({
    queryKey: ["workspace", companyId, selectedAgent],
    queryFn: () => api(scoped(scope, "workspace")),
    enabled: !!companyId && !!selectedAgent,
    refetchInterval: POLL_INTERVAL.workspace,
  });
  const runtime = useQuery<Runtime>({
    queryKey: ["runtime", companyId, selectedAgent],
    queryFn: () => api(scoped(scope, "runtime")),
    enabled: !!companyId && !!selectedAgent,
    refetchInterval: POLL_INTERVAL.runtime,
  });
  const issues = workspace.data?.issues || [];
  const previews = workspace.data?.previews || [];
  const threads = workspace.data?.threads || [];
  const actualRuntime = runtime.data || workspace.data?.runtime;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
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
    insertComposerText(selectedAgent, text);
    setToast("指令已加入当前 Agent 的草稿，请检查后发送。");
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
    const hr = agents.find((item) => item.role === "hr");
    if (!hr) {
      setToast("未找到 HR，请检查公司初始化结果。");
      return;
    }
    const hrScope = { companyId, agentId: agentId(hr) };
    insertComposerText(hrScope.agentId, text);
    selectAgent(agentId(hr));
    setToast("成员定义已加入 HR 草稿，请检查后发送；尚未创建成员。");
  };

  if (!accessReady || companies.isLoading)
    return (
      <main className="boot-screen">
        <span className="boot-mark">
          <Boxes size={26} />
        </span>
        <span className="boot-label">
          <Spinner size={14} /> 正在打开本地工作台…
        </span>
      </main>
    );

  if (companies.error instanceof ApiError && companies.error.status === 401)
    return (
      <main className="gate-screen">
        <div className="gate-card">
          <span className="gate-mark">
            <Boxes size={30} />
          </span>
          <span className="panel-kicker">PRIVATE LOCAL WORKSPACE</span>
          <h1>打开你的工作台</h1>
          <p>
            从服务器终端复制私有访问链接，
            <br />
            或输入本机 owner-token 文件中的访问令牌。
          </p>
          <form
            className="gate-form"
            onSubmit={(event) => {
              event.preventDefault();
              login.mutate(accessToken);
            }}
          >
            <input
              type="password"
              autoComplete="off"
              aria-label="本地访问令牌"
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              placeholder="本地访问令牌"
              required
            />
            <Button
              variant="primary"
              disabled={!accessToken || login.isPending}
            >
              {login.isPending ? "正在验证…" : "进入工作台"}
            </Button>
          </form>
          <ErrorBox error={login.error || accessError || companies.error} />
          <small className="gate-note">
            令牌保存在本机浏览器中，用于下次恢复登录；失败时仍可手动输入。
          </small>
        </div>
      </main>
    );

  if (!allCompanies.length && !companyId)
    return (
      <main className="gate-screen">
        <div className="gate-card gate-card-wide">
          <span className="gate-mark">
            <Boxes size={30} />
          </span>
          <span className="panel-kicker">YOUR TEAM, ONE WORKSPACE</span>
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
          <Button
            variant="primary"
            data-testid="create-company"
            onClick={() => setCompanyModal(true)}
          >
            <Plus size={16} />
            创建第一家 Company
          </Button>
          <div className="gate-notes">
            <span>固定 Agent · 固定 Session</span>
            <span>YAML + Markdown + Git</span>
            <span>Peri 真实执行</span>
          </div>
          <ErrorBox error={companies.error} />
        </div>
        {companyModal && (
          <CreateCompany
            onClose={() => setCompanyModal(false)}
            onCreated={(created) => {
              setCompanyModal(false);
              chooseCompany(created.id);
              qc.invalidateQueries({ queryKey: ["companies"] });
              qc.invalidateQueries({ queryKey: ["company", created.id] });
            }}
          />
        )}
      </main>
    );

  return (
    <div className="app">
      <AppHeader
        companyName={company?.name}
        agentName={agent?.name}
        onOpenModels={() => setLibraryModal(true)}
      />
      <SplitWorkspace
        sidebar={
          <OrganizationPanel
            companies={allCompanies}
            companyId={companyId}
            groups={groups}
            agents={agents}
            selectedAgent={selectedAgent}
            collapsed={collapsed}
            loading={organization.isLoading}
            error={organization.error}
            onChooseCompany={chooseCompany}
            onSelectAgent={selectAgent}
            onEditAgent={(id) => {
              selectAgent(id);
              setEditAgentId(id);
            }}
            onToggleGroup={(groupId) => {
              const key = `${companyId}:${groupId}`;
              setCollapsed({ ...collapsed, [key]: !collapsed[key] });
            }}
            onCreateCompany={() => setCompanyModal(true)}
            onOpenSettings={() => setOrgModal(true)}
          />
        }
        chat={
          agent ? (
            <Suspense
              fallback={
                <div className="chat-placeholder">
                  <span className="panel-kicker">PERI CHAT</span>
                  <p>正在加载 ChatShell…</p>
                </div>
              }
            >
              <CompanyChatShell
                key={scopeKey(scope)}
                scope={scope}
                issues={issues}
                actualRuntime={actualRuntime}
                onOpenSettings={() => setConfigModal(true)}
                injectedDraft={
                  composerInsert?.agentId === scope.agentId
                    ? composerInsert
                    : undefined
                }
                onInjectedDraft={() => setComposerInsert(undefined)}
              />
            </Suspense>
          ) : (
            <div className="chat-placeholder">
              <span className="panel-kicker">选择一位 Agent</span>
              <h2>工作从一个具体的成员开始</h2>
              <p>每位成员拥有独立的固定会话、工作区与文件目录。</p>
            </div>
          )
        }
        workspace={
          <WorkspacePanel
            scope={scope}
            agent={agent}
            runtime={actualRuntime}
            issues={issues}
            previews={previews}
            threads={threads}
            notices={workspace.data?.notices || []}
            agents={agents}
            tab={local.tab}
            selectedIssue={local.issueId}
            openReference={fileReference}
            error={workspace.error}
            onTab={(tab) => patch(scope, { tab })}
            onSelectIssue={selectIssue}
            onOpenAgent={selectAgent}
            onCreateIssue={() => setIssueModal(true)}
            onOpenConfig={() => setConfigModal(true)}
            onOpenLibrary={() => setLibraryModal(true)}
            onDraft={draft}
            onReference={(reference) => {
              patch(scope, { references: [...local.references, reference] });
              setToast("代码选区已引用到当前 Chat 草稿。");
            }}
          />
        }
      />

      {companyModal && (
        <CreateCompany
          onClose={() => setCompanyModal(false)}
          onCreated={(created) => {
            setCompanyModal(false);
            chooseCompany(created.id);
            qc.invalidateQueries({ queryKey: ["companies"] });
            qc.invalidateQueries({ queryKey: ["company", created.id] });
          }}
        />
      )}
      {orgModal && company && (
        <OrganizationSheet
          company={company}
          groups={groups}
          onClose={() => setOrgModal(false)}
          onAskHR={onAskHR}
        />
      )}
      {configModal && agent && (
        <AgentConfiguration
          scope={scope}
          agent={agent}
          onClose={() => setConfigModal(false)}
        />
      )}
      <ModelLibrarySheet
        open={libraryModal}
        onClose={() => setLibraryModal(false)}
      />
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
      )}
      {issueModal && (
        <CreateIssue
          companyId={companyId}
          onClose={() => setIssueModal(false)}
          onCreated={createdIssue}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
