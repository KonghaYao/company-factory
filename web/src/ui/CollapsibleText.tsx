import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";

export interface CollapsibleTextProps {
  /** 是否展开；由父级按评论 id 维护 */
  open: boolean;
  /** 受控切换；锁定态不会触发 */
  onOpenChange: (open: boolean) => void;
  /** 折叠时正文最大高度（px），默认 136 */
  collapsedHeight?: number;
  /** 强制展开且不渲染切换按钮：编辑态使用 */
  locked?: boolean;
  /**
   * 测试/特殊嵌入覆盖：
   * - true：按溢出处理（显示按钮、可裁剪）
   * - false：按不溢出处理（不裁剪、不显示按钮）
   * - undefined：运行时用 ResizeObserver 测量
   */
  overflowing?: boolean;
  /** 展开按钮的 aria-label 上下文，例如作者名 */
  contextLabel?: string;
  /** 可见文案，默认「展开全文」/「收起」 */
  expandLabel?: string;
  collapseLabel?: string;
  className?: string;
  /** SSR 测试：root/body/toggle 自动派生 data-testid */
  testId?: string;
  children: ReactNode;
}

/**
 * 正文局部折叠：只裁剪正文，不接管标题、meta 或底部操作。
 *
 * 折叠只做视觉截断，内容始终留在 DOM；只有实测溢出且处于折叠态时，
 * 才用 `inert` + `aria-hidden` 把正文从交互与无障碍树中移除。
 */
export function CollapsibleText({
  open,
  onOpenChange,
  collapsedHeight = 136,
  locked = false,
  overflowing,
  contextLabel,
  expandLabel = "展开全文",
  collapseLabel = "收起",
  className,
  testId,
  children,
}: CollapsibleTextProps) {
  const isExpanded = locked || open;
  const bodyId = useId();
  const innerRef = useRef<HTMLDivElement>(null);
  const [measuredOverflow, setMeasuredOverflow] = useState<boolean | null>(null);

  useEffect(() => {
    if (locked || overflowing !== undefined) return;
    const inner = innerRef.current;
    if (!inner) return;
    const measure = () => {
      const next = inner.scrollHeight > collapsedHeight + 1;
      setMeasuredOverflow((prev) => (prev === next ? prev : next));
    };
    // ResizeObserver 不可用时至少测一次，按钮仍能出现。
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [collapsedHeight, locked, overflowing]);

  const overflow = overflowing ?? measuredOverflow;
  const bodyState = !isExpanded && overflow !== false ? "collapsed" : "expanded";
  const hidden = !isExpanded && overflow === true;
  const showToggle = overflow === true && !locked;
  const label = isExpanded ? collapseLabel : expandLabel;

  const toggle = () => {
    if (locked) return;
    onOpenChange(!isExpanded);
  };

  return (
    <div
      className={`collapsible-text ${className ?? ""}`.trim()}
      data-open={isExpanded}
      data-overflow={overflow === null ? undefined : overflow}
      data-locked={locked ? "true" : undefined}
      data-testid={testId}
      style={{ "--collapsible-text-h": `${collapsedHeight}px` } as CSSProperties}
    >
      <div
        id={bodyId}
        className="collapsible-text-body"
        data-state={bodyState}
        data-testid={testId ? `${testId}-body` : undefined}
        inert={hidden}
        aria-hidden={hidden || undefined}
      >
        <div ref={innerRef} className="collapsible-text-inner">
          {children}
        </div>
      </div>

      {showToggle ? (
        <button
          type="button"
          className="collapsible-text-toggle"
          aria-expanded={isExpanded}
          aria-controls={bodyId}
          aria-label={
            contextLabel ? `${label}：${contextLabel}` : label
          }
          onClick={toggle}
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          <span>{label}</span>
          <ChevronDown
            className="collapsible-text-chevron"
            size={12}
            aria-hidden="true"
          />
        </button>
      ) : null}
    </div>
  );
}
