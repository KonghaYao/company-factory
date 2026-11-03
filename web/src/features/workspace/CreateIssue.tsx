import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Issue } from "../../lib/types";
import { action } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import { Button, ErrorBox, Field, Sheet } from "../../ui/primitives";

export function CreateIssue({
  companyId,
  onClose,
  onCreated,
}: {
  companyId: string;
  onClose: () => void;
  onCreated: (issue: Issue) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const submission = useRef<{ payload: string; requestId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      const input = { title, body, summary: title };
      const payload = JSON.stringify(input);
      if (submission.current?.payload !== payload)
        submission.current = { payload, requestId: uuid() };
      return action(companyId, "company_tasks", "createIssue", {
        ...input,
        requestId: submission.current.requestId,
      });
    },
    onSuccess: (data) => onCreated(data.issue || data),
  });

  return (
    <Sheet
      open
      title="创建 Issue"
      subtitle="新 Issue 默认交给第一个部门的部长；部门尚未建立时会提示先创建部门与部长。聊天不会自动生成任务。"
      onClose={onClose}
    >
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <Field label="标题">
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="想要实现或解决什么？"
            required
          />
        </Field>
        <Field label="目标与验收要求 · Markdown">
          <textarea
            rows={8}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={"## 目标\n\n## 验收要求\n- "}
            required
          />
        </Field>
        <ErrorBox error={mutation.error} />
        <footer className="sheet-actions">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            data-testid="create-issue-submit"
            disabled={mutation.isPending || !title.trim() || !body.trim()}
          >
            {mutation.isPending ? "正在创建…" : "创建 Issue"}
          </Button>
        </footer>
      </form>
    </Sheet>
  );
}
