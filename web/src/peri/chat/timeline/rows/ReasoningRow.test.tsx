import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReasoningRow } from './ReasoningRow';
import { ThinkingDetailsContent } from './ThinkingDetailsDialog';
import type { TimelineWorkItem } from '../types';

function reasoning(overrides: Partial<TimelineWorkItem> = {}): TimelineWorkItem {
  return {
    kind: 'reasoning',
    id: 'entry-1:block-1',
    entryId: 'entry-1',
    blockId: 'block-1',
    status: 'streaming',
    label: '思考',
    text: '',
    createdAt: null,
    completedAt: null,
    failed: false,
    ...overrides,
  };
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (predicate(element)) return element;
  return findElement(element.props.children as ReactNode, predicate);
}

describe('ReasoningRow', () => {
  test('streaming renders a four-line clamp with a details entry and keeps the full text', () => {
    const text = '第一行\n第二行\n第三行\n第四行\n第五行';
    const html = renderToStaticMarkup(
      <ReasoningRow item={reasoning({ status: 'streaming', text })} />,
    );

    expect(html).toContain('data-slot="peri-reasoning-clamp"');
    expect(html).toContain('max-h-20');
    expect(html).toContain('justify-end');
    expect(html).toContain('overflow-hidden');
    expect(html).toContain('leading-5');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="查看完整思考内容"');
    expect(html).toContain('data-slot="peri-reasoning-details"');
    // 裁剪只发生在视觉层，完整原文仍在 DOM 中。
    for (const line of text.split('\n')) expect(html).toContain(line);
  });

  test('progressive text updates keep the latest content in the clamp', () => {
    const first = renderToStaticMarkup(
      <ReasoningRow item={reasoning({ text: '第一段' })} />,
    );
    const second = renderToStaticMarkup(
      <ReasoningRow item={reasoning({ text: '第一段\n第二段' })} />,
    );

    expect(first).toContain('第一段');
    expect(second).toContain('第一段');
    expect(second).toContain('第二段');
    expect(second).toContain('justify-end');
  });

  test('completed reasoning stays collapsed but still offers details and a one-line preview', () => {
    const html = renderToStaticMarkup(
      <ReasoningRow
        item={reasoning({ status: 'completed', text: '第一行\n第二行' })}
      />,
    );

    expect(html).not.toContain('data-slot="peri-reasoning-clamp"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('第一行 第二行');
    expect(html).toContain('aria-expanded="false"');
  });

  test('blank reasoning renders neither a clamp nor a details entry', () => {
    const html = renderToStaticMarkup(
      <ReasoningRow item={reasoning({ text: ' \n ' })} />,
    );

    expect(html).not.toContain('data-slot="peri-reasoning-clamp"');
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('data-slot="peri-reasoning-details"');
  });

  test('long unbroken text opts into anywhere wrapping', () => {
    const html = renderToStaticMarkup(
      <ReasoningRow item={reasoning({ text: 'x'.repeat(5000) })} />,
    );

    expect(html).toContain('[overflow-wrap:anywhere]');
    expect(html).toContain('x'.repeat(5000));
  });

  test('the expand button reflects streaming and completed states', () => {
    const streaming = renderToStaticMarkup(
      <ReasoningRow item={reasoning({ status: 'streaming', text: '思考中' })} />,
    );
    const completed = renderToStaticMarkup(
      <ReasoningRow item={reasoning({ status: 'completed', text: '已完成' })} />,
    );

    expect(streaming).toContain('aria-expanded="true"');
    expect(completed).toContain('aria-expanded="false"');
  });
});

describe('ThinkingDetailsContent', () => {
  test('shows the complete raw text and closes through the close control', () => {
    const text = `完整思考第一行\n完整思考第二行\n${'x'.repeat(300)}`;
    let closed = 0;
    let copied = 0;
    const tree = ThinkingDetailsContent({
      text,
      streaming: true,
      onClose: () => {
        closed += 1;
      },
      titleId: 'thinking-title',
      descId: 'thinking-desc',
      panelRef: { current: null },
      isCopied: false,
      onCopy: () => {
        copied += 1;
      },
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="thinking-title"');
    expect(html).toContain('aria-describedby="thinking-desc"');
    expect(html).toContain('思考详情');
    expect(html).toContain('思考仍在进行，内容会继续更新');
    expect(html).toContain('完整思考第一行');
    expect(html).toContain('完整思考第二行');
    expect(html).toContain('x'.repeat(300));
    expect(html).toContain('aria-label="关闭思考详情"');
    expect(html).toContain('aria-label="复制思考内容"');

    const close = findElement(tree, (element) => element.props['aria-label'] === '关闭思考详情');
    expect(close).not.toBeNull();
    (close!.props.onClick as () => void)();
    expect(closed).toBe(1);

    const copy = findElement(tree, (element) => element.props['aria-label'] === '复制思考内容');
    expect(copy).not.toBeNull();
    (copy!.props.onClick as () => void)();
    expect(copied).toBe(1);
  });

  test('completed reasoning reports the full-content subtitle', () => {
    const html = renderToStaticMarkup(
      ThinkingDetailsContent({
        text: '已完成思考',
        streaming: false,
        onClose: () => {},
        titleId: 'thinking-title',
        descId: 'thinking-desc',
        panelRef: { current: null },
        isCopied: false,
        onCopy: () => {},
      }),
    );

    expect(html).toContain('完整思考内容');
    expect(html).not.toContain('思考仍在进行');
  });
});
