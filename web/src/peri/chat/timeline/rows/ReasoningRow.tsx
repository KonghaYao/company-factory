import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, Eye, Sparkles } from 'lucide-react';
import { cn } from '../../../lib';
import type { TimelineWorkItem } from '../types';
import { ThinkingDetailsDialog } from './ThinkingDetailsDialog';

/** 单条 reasoning：运行中展开，结束后自动收起；turn 折叠内不画左侧竖线。 */
export function ReasoningRow({ item, rail = true }: { item: TimelineWorkItem; rail?: boolean }) {
  const streaming = item.status === 'pending' || item.status === 'streaming';
  const [expanded, setExpanded] = useState(streaming);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const userToggled = useRef(false);
  const detailsTriggerRef = useRef<HTMLButtonElement>(null);
  const clampId = useId();

  useEffect(() => {
    if (!userToggled.current) setExpanded(streaming);
  }, [streaming]);

  const text = item.text ?? '';
  const hasText = text.trim().length > 0;
  // 仅在收起时需要一行预览，避免展开/流式时对大文本做无谓的替换与复制。
  const preview = !expanded && hasText ? text.replace(/\s+/g, ' ').trim() : '';

  const closeDetails = useCallback(() => {
    setDetailsOpen(false);
    requestAnimationFrame(() => detailsTriggerRef.current?.focus());
  }, []);

  return (
    <div className="flex flex-col gap-1 py-1" data-slot="peri-reasoning-row">
      <div className="flex min-w-0 items-center gap-1 text-xs">
        <button
          type="button"
          className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={expanded}
          aria-controls={expanded && hasText ? clampId : undefined}
          onClick={() => {
            userToggled.current = true;
            setExpanded((value) => !value);
          }}
        >
          <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0">思考</span>
          {streaming ? <span className="text-muted-foreground/70 shrink-0">· 进行中</span> : null}
          {!expanded && hasText ? (
            <span className="text-muted-foreground/45 min-w-0 flex-1 truncate">{preview}</span>
          ) : null}
          <ChevronRight
            className={cn('ml-auto size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
            aria-hidden="true"
          />
        </button>

        {hasText ? (
          <button
            ref={detailsTriggerRef}
            type="button"
            data-slot="peri-reasoning-details"
            aria-haspopup="dialog"
            aria-label="查看完整思考内容"
            title="查看完整思考内容"
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/40 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
            onClick={() => setDetailsOpen(true)}
          >
            <Eye className="size-3" aria-hidden="true" />
            详情
          </button>
        ) : null}
      </div>

      {expanded && hasText ? (
        <div
          id={clampId}
          data-slot="peri-reasoning-clamp"
          className={cn(
            'flex max-h-20 min-w-0 flex-col justify-end overflow-hidden',
            rail && 'border-border/70 border-l-2 pl-2.5',
          )}
        >
          <p className="text-muted-foreground shrink-0 whitespace-pre-wrap text-[13px] leading-5 [overflow-wrap:anywhere]">
            {item.text}
          </p>
        </div>
      ) : null}

      {detailsOpen ? (
        <ThinkingDetailsDialog text={text} streaming={streaming} onClose={closeDetails} />
      ) : null}
    </div>
  );
}
