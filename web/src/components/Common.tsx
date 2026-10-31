import { useEffect, useRef, type ReactNode } from "react";
import { X, AlertCircle, LoaderCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
export const labels: Record<string, string> = {
  triage: "待分类",
  plan: "独立计划",
  code: "编写代码",
  ready_preview: "等待 Preview",
  preview: "联合 Preview",
  accepted: "用户验收通过",
  verifying: "CI / Code Review",
  ready_merge: "待合入",
  cancel: "已取消",
  pending: "待用户裁定",
  answered: "已处理",
  withdrawn: "已撤回",
  resolved: "已解决",
  open: "讨论中",
  saved: "已保存",
  delivered: "已送入会话",
  replied: "已回复",
  failed: "投递失败",
};
export const statusLabel = (s?: string) => labels[s || ""] || s || "—";
export const shortDate = (s?: string) =>
  s
    ? new Date(s).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
export function Markdown({ children }: { children?: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown>{children || ""}</ReactMarkdown>
    </div>
  );
}
export function Badge({ value }: { value?: string }) {
  return <span className={`badge badge-${value}`}>{statusLabel(value)}</span>;
}
export function Empty({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <div className="muted">{children}</div>
    </div>
  );
}
export function ErrorBox({ error }: { error: unknown }) {
  return error ? (
    <div className="error-box" role="alert">
      <AlertCircle size={15} />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  ) : null;
}
export function Loading({ label = "正在读取…" }: { label?: string }) {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={16} />
      {label}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭">
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
