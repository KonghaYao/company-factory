import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  AtSign,
  CircleDot,
  Command,
  FileCode2,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import type {
  FileReference,
  Issue,
  Runtime,
} from "../../lib/types";
import { formatLines } from "../../lib/format";
import { statusLabel } from "../../lib/format";
import {
  Button,
  ErrorBox,
  IconButton,
  Spinner,
} from "../../ui/primitives";

type Picker = "issue" | "file" | "commands" | null;

/**
 * 输入区是整个工作台的核心动作面：
 * 上下文（Issue / 代码引用）在草稿上方显式可见，能力与命令收在左下角。
 */
export function Composer({
  agentName,
  draft,
  references,
  issueId,
  issues,
  runtime,
  sending,
  stopping,
  error,
  onDraft,
  onReferences,
  onIssue,
  onSend,
  onStop,
}: {
  agentName: string;
  draft: string;
  references: FileReference[];
  issueId?: string;
  issues: Issue[];
  runtime?: Runtime;
  sending: boolean;
  stopping: boolean;
  error: unknown;
  onDraft: (text: string) => void;
  onReferences: (references: FileReference[]) => void;
  onIssue: (id?: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const [picker, setPicker] = useState<Picker>(null);
  const [path, setPath] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const issue = issues.find((item) => String(item.id) === issueId);
  const busy = Boolean(
    runtime?.busy ||
      runtime?.running ||
      runtime?.activeTurn?.status === "running",
  );
  const commands = commandNames(runtime);

  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [draft]);

  const toggle = (next: Picker) => setPicker((current) => (current === next ? null : next));

  const submit = () => {
    if (!draft.trim() || sending) return;
    onSend();
  };

  const addReference = () => {
    const reference = parseReference(path);
    if (!reference) return;
    onReferences([...references, reference]);
    setPath("");
    setPicker(null);
  };

  const insertCommand = (name: string) => {
    const needsSpace = draft && !/\s$/.test(draft);
    onDraft(`${draft}${needsSpace ? " " : ""}/${name} `);
    setPicker(null);
    boxRef.current?.focus();
  };

  return (
    <div className="composer">
      {(issue || references.length > 0) && (
        <div className="composer-context">
          {issue && (
            <span className="ctx-chip">
              <CircleDot size={12} />
              <span className="ctx-label">
                #{issue.id} {issue.title}
              </span>
              <button
                aria-label="取消关联任务"
                onClick={() => onIssue(undefined)}
              >
                <X size={11} />
              </button>
            </span>
          )}
          {references.map((reference, index) => (
            <span className="ctx-chip" key={`${reference.path}-${index}`}>
              <FileCode2 size={12} />
              <span className="ctx-label">
                {reference.path}
                {formatLines(reference.startLine, reference.endLine)}
              </span>
              <button
                aria-label={`移除引用 ${reference.path}`}
                onClick={() =>
                  onReferences(references.filter((_, i) => i !== index))
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {picker && (
        <div className="composer-popover">
          <header>
            <strong>
              {picker === "issue"
                ? "关联任务"
                : picker === "file"
                  ? "引用文件"
                  : "命令与技能"}
            </strong>
            <IconButton label="关闭" onClick={() => setPicker(null)}>
              <X size={13} />
            </IconButton>
          </header>
          {picker === "issue" && (
            <div className="picker-list">
              {issues.length === 0 && (
                <p className="picker-empty">当前没有关联任务。</p>
              )}
              {issues.map((item) => (
                <button
                  key={item.id}
                  className={String(item.id) === issueId ? "is-active" : ""}
                  onClick={() => {
                    onIssue(String(item.id));
                    setPicker(null);
                    boxRef.current?.focus();
                  }}
                >
                  <span>
                    <em>#{item.id}</em>
                    {item.title}
                  </span>
                  <small>{statusLabel(item.status)}</small>
                </button>
              ))}
              {issue && (
                <button
                  className="picker-clear"
                  onClick={() => {
                    onIssue(undefined);
                    setPicker(null);
                  }}
                >
                  取消关联
                </button>
              )}
            </div>
          )}
          {picker === "file" && (
            <form
              className="picker-form"
              onSubmit={(event) => {
                event.preventDefault();
                addReference();
              }}
            >
              <label className="field">
                <span className="field-label">文件路径</span>
                <input
                  autoFocus
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="claude.md 或 notes/plan.md:12-20"
                />
              </label>
              <p className="picker-hint">
                可附加行号区间。精确代码选区可在文件编辑器中用引用按钮添加。
              </p>
              <Button
                variant="secondary"
                size="sm"
                disabled={!path.trim()}
                type="submit"
              >
                加入引用
              </Button>
            </form>
          )}
          {picker === "commands" && (
            <div className="picker-list">
              {commands.length === 0 && (
                <p className="picker-empty">当前会话没有可用的命令或技能。</p>
              )}
              {commands.map((name) => (
                <button key={name} onClick={() => insertCommand(name)}>
                  <span>
                    <em>/{name}</em>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <textarea
        ref={boxRef}
        className="composer-input"
        rows={1}
        aria-label={`向 ${agentName} 发送消息`}
        value={draft}
        placeholder={`给 ${agentName} 发消息…`}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            submit();
          }
        }}
      />

      <div className="composer-footer">
        <div className="composer-tools">
          <IconButton
            label="关联任务"
            className={picker === "issue" ? "is-active" : ""}
            onClick={() => toggle("issue")}
          >
            <CircleDot size={15} />
          </IconButton>
          <IconButton
            label="引用文件"
            className={picker === "file" ? "is-active" : ""}
            onClick={() => toggle("file")}
          >
            <Paperclip size={15} />
          </IconButton>
          <IconButton
            label="命令与技能"
            className={picker === "commands" ? "is-active" : ""}
            onClick={() => toggle("commands")}
          >
            <Command size={15} />
          </IconButton>
          <span className="composer-hint">
            <AtSign size={11} />
            {busy ? "运行中 · 消息会进入 Peri 队列" : "Enter 发送 · Shift+Enter 换行"}
          </span>
        </div>
        <div className="composer-send">
          {busy && (
            <Button
              variant="ghost"
              size="sm"
              disabled={stopping}
              onClick={onStop}
              title="停止当前回合"
            >
              <Square size={12} />
              停止
            </Button>
          )}
          <button
            className="send-button"
            aria-label="发送消息"
            disabled={!draft.trim() || sending}
            onClick={submit}
          >
            {sending ? <Spinner size={15} /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

function commandNames(runtime?: Runtime): string[] {
  const list = [
    ...(runtime?.capabilities?.commands || []),
    ...(runtime?.capabilities?.skills || []),
  ];
  return Array.from(
    new Set(
      list
        .map((item: any) =>
          typeof item === "string" ? item : item.name || item.id || item.command,
        )
        .filter(Boolean) as string[],
    ),
  );
}

/** `notes/plan.md:12-20` → 引用对象；无行号时退化为整文件引用。 */
function parseReference(raw: string): FileReference | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const match = value.match(/^(.*?)(?::(\d+)(?:[-–](\d+))?)?$/);
  const path = (match?.[1] || value).trim();
  if (!path) return undefined;
  const startLine = match?.[2] ? Number(match[2]) : undefined;
  const endLine = match?.[3] ? Number(match[3]) : startLine;
  return { path, startLine, endLine };
}
