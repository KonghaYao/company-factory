import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Save } from "lucide-react";
import type { Agent, Runtime, Scope } from "../../lib/types";
import { agentId } from "../../lib/types";
import { action, api, post, scoped } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import {
  appliedTierRows,
  libraryProfile,
  libraryTierRows,
  modelErrorLabel,
  modelReason,
  modelRevisionMismatch,
  shortRevision,
} from "../../lib/model";
import {
  Button,
  ErrorBox,
  Field,
  Loading,
  Sheet,
} from "../../ui/primitives";
import { ModelChain } from "../models/ModelChain";
import { ModelProfilePicker } from "../models/ModelProfilePicker";
import { ModelTierTable } from "../models/ModelTierTable";
import { useModelLibrary } from "../models/useModelLibrary";

/** 配置保存与重启是两步：保存不打断工作，重启才应用。 */
export function AgentConfiguration({
  scope,
  agent,
  onClose,
}: {
  scope: Scope;
  agent: Agent;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["configuration", scope.companyId, scope.agentId],
    queryFn: () => api(scoped(scope, "configuration")),
  });
  const runtime = useQuery<Runtime>({
    queryKey: ["runtime", scope.companyId, scope.agentId],
    queryFn: () => api(scoped(scope, "runtime")),
  });
  const library = useModelLibrary(true);
  const [value, setValue] = useState<string | null>(null);
  const [editVersion, setEditVersion] = useState<string | number | undefined>();
  const [success, setSuccess] = useState("");
  const [parseError, setParseError] = useState("");
  const valueRef = useRef(value);
  valueRef.current = value;
  const save = useMutation({
    mutationFn: (capture: {
      configuration: unknown;
      text: string;
      version?: string | number;
    }) =>
      post(scoped(scope, "configuration"), {
        companyId: scope.companyId,
        configuration: capture.configuration,
        expectedVersion: capture.version,
      }),
    onSuccess: (result, capture) => {
      if (valueRef.current === capture.text || valueRef.current === null) {
        setValue(null);
        setEditVersion(undefined);
      } else setEditVersion(result.version);
      setSuccess("配置已保存，重启后生效。后来输入的内容仍保留在编辑器中。");
      qc.invalidateQueries({
        queryKey: ["configuration", scope.companyId, scope.agentId],
      });
    },
  });
  const restart = useMutation({
    mutationFn: () =>
      post(scoped(scope, "restart"), { companyId: scope.companyId }),
    onSuccess: () => {
      setSuccess("已应用保存的配置。Agent 身份、目录与 Session 保持不变。");
      qc.invalidateQueries();
    },
  });
  const serialized =
    value ??
    JSON.stringify(q.data?.saved || q.data?.configuration || {}, null, 2);
  const savedConfig =
    q.data?.saved && typeof q.data.saved === "object" ? q.data.saved : {};
  let draftConfig: Record<string, unknown> = savedConfig;
  try {
    const parsed = JSON.parse(serialized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      draftConfig = parsed;
  } catch {
    // JSON 草稿暂时无效时，选择器回落到已保存的配置。
  }
  const draftProfile =
    typeof draftConfig.modelProfile === "string" ? draftConfig.modelProfile : "";
  const draftAlias =
    typeof draftConfig.modelAlias === "string" ? draftConfig.modelAlias : "";
  /** 选择器只改 JSON 草稿；不会写库、保存或重启。 */
  const applyModelDraft = (patch: {
    modelProfile?: string;
    modelAlias?: string;
  }) => {
    let parsed: Record<string, unknown>;
    try {
      const candidate = JSON.parse(serialized);
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
        throw new Error("configuration must be an object");
      parsed = { ...candidate };
    } catch {
      setParseError(
        "JSON 草稿格式有误，无法使用模型选择器更新；请先修正 JSON。",
      );
      return;
    }
    for (const [key, next] of Object.entries(patch)) {
      if (!next) delete parsed[key];
      else parsed[key] = next;
    }
    if (value === null) setEditVersion(q.data?.version);
    setValue(JSON.stringify(parsed, null, 2));
    setParseError("");
    setSuccess("");
  };

  return (
    <Sheet
      open
      wide
      title={`${agent.name} · 配置`}
      subtitle="保存不会热加载或打断工作；只有手动重启才会应用新配置。模型密钥在服务器环境中配置。"
      onClose={onClose}
    >
      {q.isLoading ? (
        <Loading />
      ) : (
        <div className="sheet-form">
          {(() => {
            const savedProfile =
              typeof savedConfig.modelProfile === "string"
                ? savedConfig.modelProfile
                : "";
            const savedAlias =
              typeof savedConfig.modelAlias === "string"
                ? savedConfig.modelAlias
                : "";
            const applied = runtime.data;
            const currentRevision = library.data?.revision ?? null;
            const appliedRevision = applied?.modelLibraryRevision ?? null;
            const revisionMismatch = modelRevisionMismatch(
              currentRevision,
              appliedRevision,
            );
            const appliedRows = appliedTierRows(applied);
            const selectedProfile =
              draftProfile || savedProfile || library.data?.activeProfile || "";
            const selectedLibraryProfile = libraryProfile(
              library.data,
              selectedProfile,
            );
            return (
              <section className="model-profile-summary">
                <div className="identity-strip">
                  <span>
                    已保存 profile ·{" "}
                    {savedProfile ||
                      `继承模型库默认${
                        library.data?.activeProfile
                          ? `（${library.data.activeProfile}）`
                          : ""
                      }`}
                  </span>
                  <span>已保存 alias · {savedAlias || "继承 profile"}</span>
                  <span>已应用 revision · {appliedRevision ? shortRevision(appliedRevision) : "—"}</span>
                  <span>source · {applied?.modelSource ?? "—"}</span>
                </div>
                <div className="model-applied-chain">
                  <span className="panel-kicker">已应用链路</span>
                  <ModelChain
                    profile={applied?.modelProfile}
                    provider={applied?.modelProvider}
                    model={applied?.model}
                    alias={applied?.modelAlias}
                    empty={applied?.configured === false ? "模型尚未配置" : "未配置"}
                  />
                </div>
                {applied?.configured === false && (
                  <div className="notice notice-warn">
                    模型尚未配置：
                    {modelReason(applied.modelError, applied.modelMissing)}。
                    修改模型库后需重启 Agent。
                  </div>
                )}
                {revisionMismatch && (
                  <div className="notice notice-warn">
                    模型库已更新（{shortRevision(currentRevision!)} ≠ 已应用{" "}
                    {shortRevision(appliedRevision!)}）；重启 Agent 后生效。
                  </div>
                )}
                {applied?.modelTierNotice && (
                  <div className="notice notice-warn">
                    {applied.modelTierNotice}。
                  </div>
                )}
                {library.data && library.data.status !== "ok" && (
                  <div className="notice notice-warn">
                    模型库当前不可用：{modelErrorLabel(library.data.error)}
                    {library.data.issues.length
                      ? `（${library.data.issues.join("；")}）`
                      : ""}
                  </div>
                )}
                <ErrorBox error={library.error} />
                <ModelProfilePicker
                  profile={draftProfile}
                  alias={draftAlias}
                  library={library.data}
                  onChange={applyModelDraft}
                />
                {(draftProfile !== savedProfile ||
                  draftAlias !== savedAlias) && (
                  <div className="notice">
                    模型配置草稿已修改；保存并重启 Agent 后才会应用。
                  </div>
                )}
                <div className="model-tier-blocks">
                  {appliedRows ? (
                    <div className="model-tier-block">
                      <span className="model-tier-caption">已应用快照</span>
                      <ModelTierTable rows={appliedRows} origin="applied" />
                    </div>
                  ) : (
                    <p className="model-muted">
                      当前快照没有四档明细；重启该 Agent 后显示。
                    </p>
                  )}
                  {selectedLibraryProfile ? (
                    <div className="model-tier-block">
                      <span className="model-tier-caption">
                        模型库文件 · profile {selectedLibraryProfile.id}
                      </span>
                      <ModelTierTable
                        rows={libraryTierRows(selectedLibraryProfile)}
                        origin="library"
                        label={`profile ${selectedLibraryProfile.id} 四档`}
                      />
                    </div>
                  ) : (
                    <p className="model-muted">
                      模型库中没有可显示的 profile 档位。
                    </p>
                  )}
                </div>
              </section>
            );
          })()}
          <Field label="保存的配置 · JSON">
            <textarea
              className="code-input"
              rows={16}
              spellCheck={false}
              value={serialized}
              onChange={(event) => {
                if (value === null) setEditVersion(q.data?.version);
                setValue(event.target.value);
                setSuccess("");
              }}
            />
          </Field>
          {value !== null &&
            editVersion !== undefined &&
            q.data?.version !== editVersion && (
              <div className="notice notice-warn">
                保存的配置已在另一处变化。当前草稿保留；直接保存会触发版本冲突。
              </div>
            )}
          {q.data?.pendingRestart && (
            <div className="notice notice-warn">有尚未应用的配置，重启后生效。</div>
          )}
          <ErrorBox error={q.error || save.error || restart.error || parseError} />
          {success && <p className="success-line">{success}</p>}
          <footer className="sheet-actions">
            <Button
              variant="secondary"
              data-testid="config-restart"
              disabled={restart.isPending}
              onClick={() => restart.mutate()}
            >
              <RotateCcw size={14} />
              {restart.isPending ? "正在重启…" : "重启 Agent"}
            </Button>
            <Button
              variant="primary"
              data-testid="config-save"
              disabled={save.isPending}
              onClick={() => {
                try {
                  setParseError("");
                  save.mutate({
                    configuration: JSON.parse(serialized),
                    text: serialized,
                    version: editVersion ?? q.data?.version,
                  });
                } catch {
                  setParseError("JSON 格式有误，请检查后再保存。");
                }
              }}
            >
              <Save size={14} />
              {save.isPending ? "正在保存…" : "保存配置"}
            </Button>
          </footer>
        </div>
      )}
    </Sheet>
  );
}

/** 员工定义编辑：姓名、职责与专属系统提示词段。 */
export function AgentEditor({
  companyId,
  agent,
  onClose,
  onSaved,
}: {
  companyId: string;
  agent: Agent;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(agent.name);
  const [responsibilities, setResponsibilities] = useState(
    agent.responsibilities || "",
  );
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt || "");
  const submission = useRef<{ payload: string; requestId: string } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const input = {
        agentId: agentId(agent),
        name,
        responsibilities,
        systemPrompt,
        expectedVersion: agent.version ?? 0,
      };
      const payload = JSON.stringify(input);
      if (submission.current?.payload !== payload)
        submission.current = { payload, requestId: uuid() };
      const { requestId: id } = submission.current!;
      return action(companyId, "company_org", "updateMember", {
        ...input,
        requestId: id,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company", companyId] });
      onSaved();
    },
  });

  return (
    <Sheet
      open
      title={`${agent.name} · 编辑员工`}
      subtitle="保存后写回该员工的 agent.yaml；提示词随下一条消息生效。Agent ID、部门和岗位保持不变。"
      onClose={onClose}
    >
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label="姓名">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field
          label="系统提示词"
          hint="该员工专属的长期指令段，例如工作方式、优先级与禁止事项。留空表示不追加。"
        >
          <textarea
            className="code-input"
            rows={8}
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            placeholder="例如：先核对事实再行动；跨部门交付前先通过 company_im 通知相关成员。"
          />
        </Field>
        <Field label="职责与交付要求">
          <textarea
            rows={4}
            value={responsibilities}
            onChange={(event) => setResponsibilities(event.target.value)}
            required
          />
        </Field>
        <div className="identity-strip">
          <span>{agent.role}</span>
          <span>Agent ID · {agentId(agent)}</span>
          <span>部门 · {agent.groupId || agent.group_id}</span>
        </div>
        <ErrorBox error={save.error} />
        <footer className="sheet-actions">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            data-testid="agent-editor-save"
            disabled={save.isPending || !name.trim() || !responsibilities.trim()}
          >
            <Save size={14} />
            {save.isPending ? "正在保存…" : "保存员工定义"}
          </Button>
        </footer>
      </form>
    </Sheet>
  );
}
