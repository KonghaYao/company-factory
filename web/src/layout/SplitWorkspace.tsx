import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";

export type ColumnSizes = [number, number, number];

const STORAGE_KEY = "company.workbench.columns";
const DEFAULT_SIZES: ColumnSizes = [18, 34, 48];
const MINIMUMS: ColumnSizes = [200, 320, 360];

function clampSizes(next: number[], total: number): ColumnSizes {
  const sizes: ColumnSizes = [
    Math.max(MINIMUMS[0], next[0]),
    Math.max(MINIMUMS[1], next[1]),
    Math.max(MINIMUMS[2], next[2]),
  ];
  const sum = sizes.reduce((a, b) => a + b, 0);
  const overflow = sum - total;
  if (overflow > 0) {
    // 从最宽的列开始回收，保证三列都留得住最小宽度。
    let remaining = overflow;
    const order = [...sizes.keys()].sort((a, b) => sizes[b] - sizes[a]);
    for (const index of order) {
      const room = sizes[index] - MINIMUMS[index];
      const take = Math.min(room, remaining);
      sizes[index] -= take;
      remaining -= take;
      if (remaining <= 0) break;
    }
  }
  return sizes;
}

function readSizes(container: HTMLElement | null): ColumnSizes | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || !container) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const total = container.getBoundingClientRect().width;
    if (!total) return null;
    const pixels = parsed.map((value: number) =>
      value <= 100 ? (value / 100) * total : value,
    ) as ColumnSizes;
    return clampSizes(pixels, total);
  } catch {
    return null;
  }
}

/**
 * 三栏工作台：组织 / 会话 / 数据工作区。
 * 尺寸以像素保存，窗口缩放时按当前总宽重新分配，避免小屏压垮某一栏。
 */
export function SplitWorkspace({
  sidebar,
  chat,
  workspace,
}: {
  sidebar: ReactNode;
  chat: ReactNode;
  workspace: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<ColumnSizes | null>(null);
  const drag = useRef<{
    index: number;
    startX: number;
    start: ColumnSizes;
  } | null>(null);

  const persist = useCallback((next: ColumnSizes) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 存储不可用时不阻断拖拽。
    }
  }, []);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const total = container.getBoundingClientRect().width;
    const stored = readSizes(container);
    setSizes(
      stored ??
        clampSizes(
          DEFAULT_SIZES.map((value) => (value / 100) * total),
          total,
        ),
    );
    const onResize = () => {
      const width = container.getBoundingClientRect().width;
      if (!width) return;
      setSizes((current) => {
        if (!current) return current;
        const scale = width / current.reduce((a, b) => a + b, 0);
        return clampSizes(
          current.map((value) => value * scale),
          width,
        );
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = (index: number) => (event: PointerEvent) => {
    if (!sizes) return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { index, startX: event.clientX, start: [...sizes] };
  };

  const onPointerMove = (event: PointerEvent) => {
    const state = drag.current;
    const container = ref.current;
    if (!state || !container) return;
    const total = container.getBoundingClientRect().width;
    const delta = event.clientX - state.startX;
    const next = [...state.start] as ColumnSizes;
    next[state.index] = state.start[state.index] + delta;
    next[state.index + 1] = state.start[state.index + 1] - delta;
    setSizes(clampSizes(next, total));
  };

  const onPointerUp = () => {
    if (drag.current && sizes) persist(sizes);
    drag.current = null;
  };

  return (
    <div
      ref={ref}
      className="workbench"
      style={
        sizes
          ? {
              gridTemplateColumns: `${sizes[0]}px 6px ${sizes[1]}px 6px ${sizes[2]}px`,
            }
          : undefined
      }
    >
      <aside className="workbench-column workbench-sidebar">{sidebar}</aside>
      <div
        className="column-gutter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整组织栏宽度"
        onPointerDown={onPointerDown(0)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <section className="workbench-column workbench-chat">{chat}</section>
      <div
        className="column-gutter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整工作区宽度"
        onPointerDown={onPointerDown(1)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <section className="workbench-column workbench-data">{workspace}</section>
    </div>
  );
}
