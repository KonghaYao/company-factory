import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, UserRoundPen } from "lucide-react";
import { action, requestId } from "../lib/api";
import type { Agent } from "../lib/types";
import { Modal, Field, ErrorBox } from "./Common";

/**
 * 员工定义编辑：姓名、职责与专属系统提示词段。
 * Agent ID、部门和岗位是固定身份，不在编辑范围内。
 */
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
        agentId: agent.id || agent.agentId || agent.agent_id || "",
        name,
        responsibilities,
        systemPrompt,
        expectedVersion: agent.version ?? 0,
      };
      const payload = JSON.stringify(input);
      if (submission.current?.payload !== payload)
        submission.current = { payload, requestId: requestId() };
      return action(companyId, "company_org", "updateMember", {
        ...input,
        requestId: submission.current.requestId,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company", companyId] });
      onSaved();
    },
  });
  return (
    <Modal title={`${agent.name} · 编辑员工`} onClose={onClose}>
      <p className="modal-intro">
        保存后写回该员工的 agent.yaml。系统提示词段会随下一条消息提供给模型；Agent
        ID、部门和岗位保持不变。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="姓名">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field
          label="系统提示词"
          hint="这是该员工专属的长期指令段，例如工作方式、优先级和禁止事项。留空表示不追加额外提示。"
        >
          <textarea
            className="code-input"
            rows={8}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="例如：你先核对事实再行动；涉及跨部门交付时，先通过 company_im 通知相关成员。"
          />
        </Field>
        <Field label="职责与交付要求">
          <textarea
            rows={4}
            value={responsibilities}
            onChange={(e) => setResponsibilities(e.target.value)}
            required
          />
        </Field>
        <div className="agent-identity">
          <span>
            <UserRoundPen size={13} /> {agent.role}
          </span>
          <span>Agent ID：{agent.id || agent.agentId || agent.agent_id}</span>
          <span>部门：{agent.groupId || agent.group_id}</span>
        </div>
        <ErrorBox error={save.error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button
            data-testid="agent-editor-save"
            className="primary"
            disabled={save.isPending || !name.trim() || !responsibilities.trim()}
          >
            <Save size={14} />
            {save.isPending ? "正在保存…" : "保存员工定义"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
