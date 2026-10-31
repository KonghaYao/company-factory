import { useState, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2, RotateCcw, Save } from "lucide-react";
import { action, api, post, scoped, requestId } from "../lib/api";
import type { Company, Agent, Group, Scope } from "../lib/types";
import { Modal, Field, ErrorBox, Loading } from "./Common";
export function CreateCompany({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (company: Company) => void;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const submission = useRef<{ payload: string; requestId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      const input = { name, goal };
      const payload = JSON.stringify(input);
      if (submission.current?.payload !== payload)
        submission.current = { payload, requestId: requestId() };
      return post<{ company: Company }>("/api/action", {
        module: "company_org",
        operation: "createCompany",
        input: { ...input, requestId: submission.current.requestId },
      });
    },
    onSuccess: (data) => onCreated(data.company),
  });
  return (
    <Modal title="建立你的 Company" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <p className="modal-intro">
          一个组织，一份事实来源。初始化时会建立总部、HR
          和任务主管，以及各自的固定会话。
        </p>
        <Field label="公司名称">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：Acme Studio"
            required
          />
        </Field>
        <Field label="公司目标">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="希望这个团队完成什么？"
            rows={3}
          />
        </Field>
        <ErrorBox error={mutation.error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button
            data-testid="create-company-submit"
            disabled={mutation.isPending || !name.trim()}
            className="primary"
          >
            {mutation.isPending ? "正在初始化…" : "创建 Company"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function OrganizationModal({
  company,
  groups,
  onClose,
  onAskHR,
}: {
  company: Company;
  groups: Group[];
  onClose: () => void;
  onAskHR: (text: string) => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"group" | "member">("group");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [groupId, setGroupId] = useState(groups[0]?.id || "");
  const [role, setRole] = useState("developer");
  const mutation = useMutation({
    mutationFn: () =>
      action(
        company.id,
        "company_org",
        tab === "group" ? "createGroup" : "createMember",
        tab === "group"
          ? {
              id,
              name,
              description,
              responsibilities: description,
              requestId: requestId(),
            }
          : {
              id,
              agentId: id,
              name,
              groupId,
              role,
              responsibilities: description,
              requestId: requestId(),
            },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company", company.id] });
      onClose();
    },
  });
  return (
    <Modal title="组织设置" onClose={onClose}>
      <div className="segmented">
        <button
          className={tab === "group" ? "active" : ""}
          onClick={() => setTab("group")}
        >
          创建部门
        </button>
        <button
          className={tab === "member" ? "active" : ""}
          onClick={() => setTab("member")}
        >
          创建正式成员
        </button>
      </div>
      <p className="modal-intro">
        成员创建由 HR 职责管理。一个 Agent
        固定归属一个部门，一期不提供调组和离职。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (tab === "member") {
            onAskHR(
              `请根据以下定义创建一名正式成员。请核对部门和职责，并通过 company_org 创建，而不是只回复已完成。\n\n姓名：${name}\nAgent ID：${id}\n归属部门：${groupId}\n岗位：${role}\n职责与交付要求：${description}`,
            );
            onClose();
          } else mutation.mutate();
        }}
      >
        <Field label={tab === "group" ? "部门名称" : "成员姓名"}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="稳定 ID">
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            pattern="[a-z0-9][a-z0-9-]*"
            required
          />
        </Field>
        {tab === "member" && (
          <>
            <Field label="归属部门">
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
              >
                {groups.map((g) => (
                  <option value={g.id} key={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="岗位">
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="developer">Dev · 开发</option>
                <option value="preview">Preview · 联合预览</option>
                <option value="reviewer">Review · 验证</option>
              </select>
            </Field>
          </>
        )}
        <Field label="职责与交付要求">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            required
          />
        </Field>
        <ErrorBox error={mutation.error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={mutation.isPending}>
            {mutation.isPending
              ? "正在创建…"
              : tab === "member"
                ? "将定义交给 HR"
                : "创建部门"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function Configuration({
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
      setSuccess(
        "提交的配置已保存，重启后生效。后来输入的内容仍保留在编辑器中。",
      );
      qc.invalidateQueries({
        queryKey: ["configuration", scope.companyId, scope.agentId],
      });
    },
  });
  const restart = useMutation({
    mutationFn: () =>
      post(scoped(scope, "restart"), { companyId: scope.companyId }),
    onSuccess: () => {
      setSuccess("已应用保存的配置。Agent 身份、目录和 Session 保持不变。");
      qc.invalidateQueries();
    },
  });
  const serialized =
    value ??
    JSON.stringify(q.data?.saved || q.data?.configuration || {}, null, 2);
  return (
    <Modal title={`${agent.name} · 配置`} onClose={onClose} wide>
      <p className="modal-intro">
        保存不会热加载或打断工作。只有手动重启才会应用新配置；模型密钥在服务器环境中配置。
      </p>
      {q.isLoading ? (
        <Loading />
      ) : (
        <>
          <Field label="保存的配置 · JSON">
            <textarea
              className="code-input"
              rows={14}
              value={serialized}
              onChange={(e) => {
                if (value === null) setEditVersion(q.data?.version);
                setValue(e.target.value);
                setSuccess("");
              }}
            />
          </Field>
          {value !== null &&
            editVersion !== undefined &&
            q.data?.version !== editVersion && (
              <div className="notice">
                保存的配置已在另一处变化。当前草稿保留；直接保存会触发版本冲突，请先核对差异。
              </div>
            )}
          {q.data?.pendingRestart && (
            <div className="notice">有尚未应用的配置，重启后生效。</div>
          )}
          <ErrorBox
            error={q.error || save.error || restart.error || parseError}
          />
          {success && <p className="success">{success}</p>}
          <div className="modal-actions">
            <button
              data-testid="config-restart"
              className="secondary"
              disabled={restart.isPending}
              onClick={() => restart.mutate()}
            >
              <RotateCcw size={14} />
              {restart.isPending ? "正在重启…" : "重启 Agent"}
            </button>
            <button
              data-testid="config-save"
              className="primary"
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
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
