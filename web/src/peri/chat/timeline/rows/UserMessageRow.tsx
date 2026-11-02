import { createContext, useContext, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Entry } from '../../runtime';
import { useCopyToClipboard } from '../../../hooks';

export type UserMessagePresentation = (entry: Entry) => ReactNode | null;
/** 无 Provider 时保持 Peri 默认气泡；Provider 返回 null 表示交回默认渲染。 */
export const UserMessagePresentationContext =
  createContext<UserMessagePresentation | null>(null);

const LONG_MESSAGE_CHARS = 480;
const LONG_MESSAGE_LINES = 10;

function isLongMessage(text: string): boolean {
  return text.length > LONG_MESSAGE_CHARS || text.split('\n').length > LONG_MESSAGE_LINES;
}

function userText(entry: Entry): string {
  return entry.blocks
    .filter((block): block is Extract<Entry['blocks'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** 用户消息：右对齐气泡；复制只在有正文时出现。 */
export function UserMessageRow({ entry }: { entry: Entry }) {
  const presentation = useContext(UserMessagePresentationContext);
  const presented = presentation?.(entry);
  const text = userText(entry);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const [expanded, setExpanded] = useState(false);
  if (presented !== null && presented !== undefined) return <>{presented}</>;
  const collapsible = isLongMessage(text);
  const collapsed = collapsible && !expanded;
  return (
    <div className="group flex flex-col items-end gap-1" data-slot="peri-user-message">
      <div className="text-muted-foreground me-1 text-[11px]">你</div>
      <div className="bg-[var(--chat-user-bubble)] text-foreground relative max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
        <div
          className={collapsed ? 'max-h-48 overflow-hidden' : undefined}
          data-collapsed={collapsed || undefined}
        >
          {text || '（空消息）'}
        </div>
        {collapsible && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground mt-1 block text-[11px] font-medium"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : '展开全文'}
          </button>
        )}
        {text && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground absolute -bottom-2 -left-7 inline-flex size-6 items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label="复制消息"
            onClick={() => copyToClipboard(text)}
          >
            {isCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}
