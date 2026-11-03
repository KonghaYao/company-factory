import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertCircle, LoaderCircle, X } from "lucide-react";
import { avatarColorAttribute } from "../lib/avatar";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
}) {
  return (
    <button
      className={`btn btn-${variant} btn-${size} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}

export function IconButton({
  className = "",
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      className={`icon-btn ${className}`.trim()}
      title={label}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}

export function Avatar({
  name,
  tone = "agent",
  size = "sm",
  color,
}: {
  name: string;
  tone?: "agent" | "user" | "system";
  size?: "xs" | "sm" | "md";
  /** Company 成员调色板 id；仅 agent 头像使用，user/system 始终忽略。 */
  color?: string;
}) {
  const label = (name || "?").trim().slice(0, 1).toUpperCase() || "?";
  const avatarColor = tone === "agent" ? avatarColorAttribute(color) : undefined;
  return (
    <span
      className={`avatar avatar-${tone} avatar-${size}`}
      data-avatar-color={avatarColor}
      aria-hidden="true"
    >
      {tone === "user" ? "我" : label}
    </span>
  );
}

export function Badge({
  value,
  tone = "neutral",
  children,
}: {
  value?: string;
  tone?: "neutral" | "positive" | "warning" | "danger" | "active";
  children?: ReactNode;
}) {
  return (
    <span className={`badge badge-${tone}`}>{children ?? value}</span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <span className="empty-icon">{icon}</span>}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="notice notice-danger" role="alert">
      <AlertCircle size={14} />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

export function Loading({ label = "正在读取…" }: { label?: string }) {
  return (
    <div className="loading-line">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string; count?: number }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.id}
          role="tab"
          aria-selected={option.id === value}
          className={option.id === value ? "active" : ""}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          {option.count !== undefined && option.count > 0 && (
            <span className="segmented-count">{option.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Sheet({
  open,
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`sheet ${wide ? "sheet-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="sheet-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
