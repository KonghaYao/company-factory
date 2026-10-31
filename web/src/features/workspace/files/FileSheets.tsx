import { Button, ErrorBox, Field, Sheet } from "../../../ui/primitives";

/** 新建文件与提交变更都是轻量 Sheet，表单状态由 FilesView 统一持有。 */
export function CreateFileSheet({
  open,
  path,
  content,
  pending,
  error,
  onPath,
  onContent,
  onClose,
  onSubmit,
}: {
  open: boolean;
  path: string;
  content: string;
  pending: boolean;
  error: unknown;
  onPath: (value: string) => void;
  onContent: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Sheet open={open} title="新建文件" onClose={onClose}>
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <p className="sheet-intro">
          文件会直接写入当前 Agent 的活动目录，并立即出现在 Git
          变更中；提交时再决定如何记录历史。
        </p>
        <Field label="相对活动目录的路径" hint="例如 browser-note.md">
          <input
            value={path}
            onChange={(event) => onPath(event.target.value)}
            placeholder="notes/plan.md"
            required
            autoFocus
          />
        </Field>
        <Field label="初始内容">
          <textarea
            rows={7}
            value={content}
            onChange={(event) => onContent(event.target.value)}
          />
        </Field>
        <ErrorBox error={error} />
        <footer className="sheet-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || !path.trim()}
          >
            {pending ? "正在创建…" : "创建文件"}
          </Button>
        </footer>
      </form>
    </Sheet>
  );
}

export function CommitSheet({
  open,
  message,
  pending,
  error,
  onMessage,
  onClose,
  onSubmit,
}: {
  open: boolean;
  message: string;
  pending: boolean;
  error: unknown;
  onMessage: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Sheet open={open} title="提交变更" onClose={onClose}>
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <p className="sheet-intro">
          提交只包含当前 Agent 活动目录中的变更。说明会写入 Git
          历史，便于之后追溯是谁改了什么。
        </p>
        <Field label="提交说明">
          <input
            value={message}
            onChange={(event) => onMessage(event.target.value)}
            placeholder="记录这次变更的目的"
            autoFocus
          />
        </Field>
        <ErrorBox error={error} />
        <footer className="sheet-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || !message.trim()}
          >
            {pending ? "正在提交…" : "提交"}
          </Button>
        </footer>
      </form>
    </Sheet>
  );
}
