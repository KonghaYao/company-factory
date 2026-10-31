import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Company, Group } from "../../lib/types";
import { action, requestId } from "../../lib/api";
import {
  Button,
  ErrorBox,
  Field,
  Segmented,
  Sheet,
} from "../../ui/primitives";

type Mode = "group" | "member";

/**
 * 二期约束：正式成员由 HR 创建，这里只把结构化定义交给 HR 执行。
 * 部门则直接通过 company_org 落地。
 */
export function OrganizationSheet({
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
  const [tab, setTab] = useState<Mode>("group");
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
    <Sheet
      open
      title="组织设置"
      subtitle="一个 Agent 固定归属一个部门；一期不提供调组和离职。"
      onClose={onClose}
    >
      <Segmented
        value={tab}
        options={[
          { id: "group", label: "创建部门" },
          { id: "member", label: "创建正式成员" },
        ]}
        onChange={setTab}
      />
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
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
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label="稳定 ID" hint="小写字母、数字与连字符，创建后不可更改。">
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            pattern="[a-z0-9][a-z0-9-]*"
            placeholder="engineering"
            required
          />
        </Field>
        {tab === "member" && (
          <div className="form-grid">
            <Field label="归属部门">
              <select
                value={groupId}
                onChange={(event) => setGroupId(event.target.value)}
              >
                {groups.map((group) => (
                  <option value={group.id} key={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="岗位">
              <select
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                <option value="developer">Dev · 开发</option>
                <option value="preview">Preview · 联合预览</option>
                <option value="reviewer">Review · 验证</option>
              </select>
            </Field>
          </div>
        )}
        <Field label="职责与交付要求">
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            placeholder="这名成员负责什么、如何交付、哪些事情需要先请示。"
            required
          />
        </Field>
        <ErrorBox error={mutation.error} />
        <footer className="sheet-actions">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={mutation.isPending}>
            {mutation.isPending
              ? "正在创建…"
              : tab === "member"
                ? "将定义交给 HR"
                : "创建部门"}
          </Button>
        </footer>
      </form>
    </Sheet>
  );
}
