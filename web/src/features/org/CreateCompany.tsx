import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Company } from "../../lib/types";
import { post } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import { Button, ErrorBox, Field, Sheet } from "../../ui/primitives";

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
        submission.current = { payload, requestId: uuid() };
      const { requestId: id } = submission.current!;
      return post<{ company: Company }>("/api/action", {
        module: "company_org",
        operation: "createCompany",
        input: { ...input, requestId: id },
      });
    },
    onSuccess: (data) => onCreated(data.company),
  });

  return (
    <Sheet
      open
      title="建立你的 Company"
      subtitle="一个组织，一份事实来源。初始化会创建总部、HR 与秘书，以及各自的固定会话。"
      onClose={onClose}
    >
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <Field label="公司名称">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：Acme Studio"
            required
          />
        </Field>
        <Field label="公司目标" hint="写清这支团队要长期交付什么。">
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="希望这个团队完成什么？"
            rows={4}
          />
        </Field>
        <ErrorBox error={mutation.error} />
        <footer className="sheet-actions">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            data-testid="create-company-submit"
            disabled={mutation.isPending || !name.trim()}
          >
            {mutation.isPending ? "正在初始化…" : "创建 Company"}
          </Button>
        </footer>
      </form>
    </Sheet>
  );
}
