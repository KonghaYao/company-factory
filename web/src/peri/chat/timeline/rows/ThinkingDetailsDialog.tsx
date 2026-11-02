import { useEffect, useId, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, X } from 'lucide-react';
import { useCopyToClipboard, useFocusTrap } from '../../../hooks';

interface ThinkingDetailsDialogProps {
  text: string;
  streaming: boolean;
  onClose: () => void;
}

interface ThinkingDetailsContentProps extends ThinkingDetailsDialogProps {
  titleId: string;
  descId: string;
  panelRef: RefObject<HTMLDivElement | null>;
  isCopied: boolean;
  onCopy: () => void;
}

/** 弹窗内容与控件；portal、焦点陷阱和键盘关闭由外层负责。 */
export function ThinkingDetailsContent({
  text,
  streaming,
  onClose,
  titleId,
  descId,
  panelRef,
  isCopied,
  onCopy,
}: ThinkingDetailsContentProps) {
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-slot="peri-thinking-dialog"
      className="bg-background text-foreground flex max-h-[min(90dvh,720px)] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border shadow-xl"
    >
      <header className="flex shrink-0 items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold">
            思考详情
          </h2>
          <p id={descId} className="text-muted-foreground mt-0.5 text-xs">
            {streaming ? '思考仍在进行，内容会继续更新' : '完整思考内容'}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={isCopied ? '已复制思考内容' : '复制思考内容'}
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/40 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
            onClick={onCopy}
          >
            {isCopied ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            {isCopied ? '已复制' : '复制'}
          </button>
          <button
            type="button"
            aria-label="关闭思考详情"
            className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/40 inline-flex size-8 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div
        data-slot="peri-thinking-dialog-body"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 [scrollbar-gutter:stable]"
      >
        <p className="text-foreground/85 whitespace-pre-wrap text-[13px] leading-5 [overflow-wrap:anywhere]">
          {text}
        </p>
      </div>

      <span role="status" className="sr-only">
        {isCopied ? '已复制思考内容' : ''}
      </span>
    </div>
  );
}

/**
 * reasoning 完整内容弹窗：portal 到 body，避免被时间线虚拟列表的行结构裁剪。
 * 挂载即打开；关闭后的焦点归由调用方负责。
 */
export function ThinkingDetailsDialog({ text, streaming, onClose }: ThinkingDetailsDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  useFocusTrap(true, panelRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="peri-chat fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      data-slot="peri-thinking-dialog-layer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <ThinkingDetailsContent
        text={text}
        streaming={streaming}
        onClose={onClose}
        titleId={titleId}
        descId={descId}
        panelRef={panelRef}
        isCopied={isCopied}
        onCopy={() => copyToClipboard(text)}
      />
    </div>,
    document.body,
  );
}
