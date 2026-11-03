import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  Company,
  Organization,
  OrgNodeKind,
} from "../../lib/types";
import { agentOrgPath } from "../../lib/types";
import { action } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import {
  activeNodeOptions,
  defaultParentId,
  parentNodeOptions,
} from "./orgNodeOptions";
import {
  Button,
  ErrorBox,
  Field,
  Segmented,
  Sheet,
} from "../../ui/primitives";

type Mode = "node" | "member";

const KINDS: { id: OrgNodeKind; label: string }[] = [
  { id: "company", label: "公司" },
  { id: "division", label: "事业部" },
  { id: "department", label: "部门" },
  { id: "team", label: "团队" },
  { id: "squad", label: "小组" },
  { id: "committee", label: "委员会" },
];

/**
 * 节点定义直接通过 company_org 落地；正式成员仍交给 HR 的固定身份创建，
 * 避免用户界面伪装 Agent。移动与归档由组织树入口单独触发。
 */
export function OrganizationSheet({
  company,
  organization,
  agents,
  editNodeId,
  parentId,
  onClose,
  onAskHR,
}: {
  company: Company;
  organization: Organization | null;
  agents: Agent[];
  editNodeId?: string;
  parentId?: string;
  onClose: () => void;
  onAskHR: (text: string) => void;
}) {
  const qc = useQueryClient();
  const editing = organization?.nodes.find((node) => node.id === editNodeId);
  const options = useMemo(() => activeNodeOptions(organization), [organization]);
  const parentOptions = useMemo(
    () => parentNodeOptions(organization, editing?.id),
    [organization, editing?.id],
  );
  const [tab, setTab] = useState<Mode>("node");
  const [name, setName] = useState(editing?.name ?? "");
  const [id, setId] = useState(editing?.id ?? "");
  const [kind, setKind] = useState<OrgNodeKind>(
    editing?.kind ?? (parentId ? "department" : "division"),
  );
  const [parent, setParent] = useState(
    defaultParentId(editing, parentId, options),
  );
  const [order, setOrder] = useState(
    editing ? String(editing.order) : "",
  );
  const [leadPersonId, setLeadPersonId] = useState(
    editing?.leadPersonId ?? "",
  );
  const [description, setDescription] = useState(
    editing?.responsibilities ?? "",
  );
  const [groupId, setGroupId] = useState(options[0]?.node.id ?? "");
  const [role, setRole] = useState("developer");
  const saveNode = useMutation({
    mutationFn: () =>
      action(
        company.id,
        "company_org",
        editing ? "updateOrgNode" : "createOrgNode",
        editing
          ? {
              id: editing.id,
              name,
              kind,
              parentId: parent || null,
              order: order === "" ? undefined : Number(order),
              leadPersonId: leadPersonId || null,
              responsibilities: description,
              expectedVersion: organization!.version,
              requestId: uuid(),
            }
          : {
              id,
              name,
              kind,
              parentId: parent || null,
              order: order === "" ? undefined : Number(order),
              responsibilities: description,
              requestId: uuid(),
            },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company", company.id] });
      onClose();
    },
  });
  const askHR = () => {
    const node = options.find((item) => item.node.id === groupId);
    onAskHR(
      `请根据以下定义创建一名正式成员。请核对部门和职责，并通过 company_org 创建，而不是只回复已完成。\n\n姓名：${name}\nAgent ID：${id}\n归属部门：${node?.path ?? (groupId || "暂不分配")}\n岗位：${role}\n职责与交付要求：${description}`,
    );
    onClose();
  };

  return (
    <Sheet
      open
      title={editing ? `编辑组织节点 · ${editing.name}` : "组织设置"}
      subtitle={
        editing
          ? "节点只定义组织树；成员身份、固定会话与权限由人员实体独立保存。"
          : "成员可移动到任意节点；移动只改变组织归属，不改身份、会话与权限。"
      }
      onClose={onClose}
    >
      {!editing && (
        <Segmented
          value={tab}
          options={[
            { id: "node", label: "新建节点" },
            { id: "member", label: "创建正式成员" },
          ]}
          onChange={setTab}
        />
      )}
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (editing || tab === "node") saveNode.mutate();
          else askHR();
        }}
      >
        <Field label={tab === "member" && !editing ? "成员姓名" : "节点名称"}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        {!editing && (
          <Field
            label="稳定 ID"
            hint="小写字母、数字与连字符，创建后不可更改。"
          >
            <input
              value={id}
              onChange={(event) => setId(event.target.value)}
              pattern="[a-z0-9][a-z0-9-]*"
              placeholder="engineering"
              required
            />
          </Field>
        )}
        {(editing || tab === "node") && (
          <div className="form-grid">
            <Field label="节点类型">
              <select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as OrgNodeKind)
                }
              >
                {KINDS.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="父节点"
              hint="留空表示根节点；迁移不会自动改变既有层级，也不能选择自身或子树。"
            >
              <select
                value={parent}
                onChange={(event) => setParent(event.target.value)}
              >
                <option value="">根节点</option>
                {parentOptions.map((item) => (
                  <option value={item.node.id} key={item.node.id}>
                    {item.path}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="同级排序" hint="留空追加到末尾。">
              <input
                type="number"
                min={0}
                value={order}
                onChange={(event) => setOrder(event.target.value)}
              />
            </Field>
            {editing && (
              <Field label="节点负责人" hint="仅展示汇报关系，不授予权限。">
                <select
                  value={leadPersonId}
                  onChange={(event) => setLeadPersonId(event.target.value)}
                >
                  <option value="">未指定</option>
                  {agents
                    .filter((agent) => agent.status !== "archived")
                    .map((agent) => (
                      <option
                        value={agent.agentId || agent.id}
                        key={agent.agentId || agent.id}
                      >
                        {agent.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
          </div>
        )}
        {tab === "member" && !editing && (
          <div className="form-grid">
            <Field label="归属节点" hint="可留空，稍后通过组织树移动。">
              <select
                value={groupId}
                onChange={(event) => setGroupId(event.target.value)}
              >
                <option value="">暂不分配</option>
                {options.map((item) => (
                  <option value={item.node.id} key={item.node.id}>
                    {item.path}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="岗位（访问角色）">
              <select
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                <option value="developer">Dev · 开发</option>
                <option value="preview">Preview · 联合预览</option>
                <option value="reviewer">Review · 验证</option>
                <option value="department-head">Department Head · 部长</option>
                <option value="hr">HR · 人事</option>
                <option value="secretary">Secretary · 秘书</option>
              </select>
            </Field>
          </div>
        )}
        <Field
          label={tab === "member" && !editing ? "职责与交付要求" : "节点职责"}
        >
          <textarea
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            required={tab === "member" && !editing}
          />
        </Field>
        <ErrorBox
          error={saveNode.error}
        />
        <footer className="sheet-actions">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            data-testid="org-sheet-submit"
            disabled={saveNode.isPending}
          >
            {saveNode.isPending
              ? "正在保存…"
              : editing
                ? "保存节点"
                : tab === "node"
                  ? "创建节点"
                  : "交给 HR 创建"}
          </Button>
        </footer>
      </form>
    </Sheet>
  );
}

/** 移动只发送 organization placement 变更；不存在重启、唤醒或消息副作用。 */
export function MoveMemberSheet({
  company,
  organization,
  agent,
  onClose,
  onMoved,
}: {
  company: Company;
  organization: Organization | null;
  agent: Agent;
  onClose: () => void;
  onMoved: (message: string) => void;
}) {
  const qc = useQueryClient();
  const options = useMemo(() => activeNodeOptions(organization), [organization]);
  const current = agent.placement?.nodeId ?? "";
  const [nodeId, setNodeId] = useState(
    options.find((item) => item.node.id !== current)?.node.id ??
      options[0]?.node.id ??
      "",
  );
  const [title, setTitle] = useState(agent.placement?.title ?? "");
  const move = useMutation({
    mutationFn: () =>
      action(company.id, "company_org", "moveMember", {
        agentId: agent.agentId || agent.id,
        nodeId,
        title:
          title === (agent.placement?.title ?? "")
            ? undefined
            : title,
        expectedVersion: organization?.version ?? 0,
        requestId: uuid(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company", company.id] });
      onMoved(
        `${agent.name} 已移动；身份、固定会话、权限与 Issue/IM 归属保持不变。`,
      );
      onClose();
    },
  });
  return (
    <Sheet
      open
      title={`移动成员 · ${agent.name}`}
      subtitle={`当前路径：${agentOrgPath(agent) || "未分配"}。移动只改 organization.yaml。`}
      onClose={onClose}
    >
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          move.mutate();
        }}
      >
        <Field label="目标节点">
          <select
            value={nodeId}
            onChange={(event) => setNodeId(event.target.value)}
            disabled={!options.length}
          >
            {options.map((item) => (
              <option value={item.node.id} key={item.node.id}>
                {item.path}
              </option>
            ))}
          </select>
        </Field>
        <Field label="展示岗位" hint="可选；不影响访问角色与权限。">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：后端负责人"
          />
        </Field>
        {!options.length && (
          <div className="notice notice-warn">
            还没有可用的组织节点，请先在组织设置中创建。
          </div>
        )}
        <ErrorBox error={move.error} />
        <footer className="sheet-actions">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            data-testid="move-member-submit"
            disabled={move.isPending || !nodeId}
          >
            {move.isPending ? "正在移动…" : "移动成员"}
          </Button>
        </footer>
      </form>
    </Sheet>
  );
}

/** 恢复必须立刻选择节点，避免产生组织树中不可见的未分配成员。 */
export function RestoreMemberSheet({
  company,
  organization,
  agent,
  onClose,
  onRestored,
}: {
  company: Company;
  organization: Organization;
  agent: Agent;
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const qc = useQueryClient();
  const options = useMemo(() => activeNodeOptions(organization), [organization]);
  const [nodeId, setNodeId] = useState(options[0]?.node.id ?? "");
  const restore = useMutation({
    mutationFn: () =>
      action(company.id, "company_org", "restoreMember", {
        agentId: agent.agentId || agent.id,
        nodeId,
        expectedVersion: organization.version,
        requestId: uuid(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company", company.id] });
      onRestored(
        `${agent.name} 已恢复并放入组织节点；身份、固定会话、IM 与 Issue 保持不变。`,
      );
      onClose();
    },
  });
  return (
    <Sheet
      open
      title={`恢复成员 · ${agent.name}`}
      subtitle="恢复必须选择组织节点；身份、固定会话、权限与历史记录保持不变。"
      onClose={onClose}
    >
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          restore.mutate();
        }}
      >
        <Field label="归属节点">
          <select
            value={nodeId}
            onChange={(event) => setNodeId(event.target.value)}
            disabled={!options.length}
          >
            {options.map((item) => (
              <option value={item.node.id} key={item.node.id}>
                {item.path}
              </option>
            ))}
          </select>
        </Field>
        {!options.length && (
          <div className="notice notice-warn">
            还没有可用的组织节点，请先在组织设置中创建，再恢复成员。
          </div>
        )}
        <ErrorBox error={restore.error} />
        <footer className="sheet-actions">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            data-testid="restore-member-submit"
            disabled={restore.isPending || !nodeId}
          >
            {restore.isPending ? "正在恢复…" : "恢复成员"}
          </Button>
        </footer>
      </form>
    </Sheet>
  );
}
