import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";

export interface CollapsibleSectionProps {
  title: ReactNode;
  description?: ReactNode;
  /** 头部右侧操作区；不会包进展开按钮，避免嵌套 button */
  actions?: ReactNode;
  /** 折叠时内容高度上限（px），默认 160 */
  collapsedHeight?: number;
  /** 非受控初始状态，默认 false */
  defaultOpen?: boolean;
  /** 受控展开状态；传入时由父级维护 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 强制展开且禁止切换：编辑态使用 */
  lockOpen?: boolean;
  /** 始终可见的底部区域：评论表单使用 */
  footer?: ReactNode;
  className?: string;
  /** 用于 SSR 测试：root / trigger / body / footer 自动生成 data-testid */
  testId?: string;
  children: ReactNode;
}

/**
 * 固定上限高度的可折叠分区。
 *
 * 折叠只做视觉裁剪：内容始终留在 DOM，浏览器查找与 SSR 断言都稳定。
 * 折叠期间用 `inert` + `aria-hidden` + `pointer-events` 把预览区从交互与
 * 无障碍树中移除；只有真实溢出时才显示底部渐隐。
 */
export function CollapsibleSection({
  title,
  description,
  actions,
  collapsedHeight = 160,
  defaultOpen = false,
  open,
  onOpenChange,
  lockOpen = false,
  footer,
  className,
  testId,
  children,
}: CollapsibleSectionProps) {
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const expanded = lockOpen || (isControlled ? open : internalOpen);
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    if (expanded || !bodyRef.current || !innerRef.current) {
      setClipped(false);
      return;
    }
    if (typeof ResizeObserver === "undefined") return;
    const body = bodyRef.current;
    const inner = innerRef.current;
    const measure = () => setClipped(body.scrollHeight > body.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [expanded]);

  const toggle = () => {
    if (lockOpen) return;
    const next = !expanded;
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <section
      className={`collapsible-section ${className ?? ""}`.trim()}
      data-open={expanded}
      data-testid={testId}
      style={{ "--collapsible-h": `${collapsedHeight}px` } as CSSProperties}
    >
      <header className="section-head collapsible-head">
        <h3 className="collapsible-heading">
          <button
            type="button"
            className="collapsible-trigger"
            aria-expanded={expanded}
            aria-controls={bodyId}
            disabled={lockOpen}
            onClick={toggle}
            data-testid={testId ? `${testId}-trigger` : undefined}
          >
            <span className="collapsible-label">
              <span className="collapsible-title">{title}</span>
              {description ? (
                <span className="collapsible-desc">{description}</span>
              ) : null}
            </span>
            <ChevronRight
              className="collapsible-chevron"
              size={13}
              aria-hidden="true"
            />
          </button>
        </h3>
        {actions ? <div className="collapsible-actions">{actions}</div> : null}
      </header>

      <div
        ref={bodyRef}
        id={bodyId}
        className="collapsible-body"
        data-state={expanded ? "open" : "closed"}
        data-overflow={clipped || undefined}
        data-testid={testId ? `${testId}-body` : undefined}
        inert={!expanded}
        aria-hidden={!expanded || undefined}
      >
        <div ref={innerRef} className="collapsible-inner">
          {children}
        </div>
      </div>

      {footer ? (
        <div
          className="collapsible-footer"
          data-testid={testId ? `${testId}-footer` : undefined}
        >
          {footer}
        </div>
      ) : null}
    </section>
  );
}
