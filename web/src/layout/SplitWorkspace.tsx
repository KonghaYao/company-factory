import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";

export type ColumnSizes = [number, number, number];

const STORAGE_KEY = "company.workbench.columns";
const DEFAULT_SIZES: ColumnSizes = [18, 34, 48];
const MINIMUMS: ColumnSizes = [200, 320, 360];
const GUTTER = 6;
const GUTTERS = GUTTER * 2;

/**
 * 三列可分配的宽度：元素内容盒宽度再扣除两条 gutter。
 * clientWidth 包含 padding、不含滚动条；computed padding 兼容 1180px 处的 14→10 切换。
 */
function availableWidth(container: HTMLElement): number {
  const style = getComputedStyle(container);
  const padding =
    Number.parseFloat(style.paddingLeft) +
    Number.parseFloat(style.paddingRight);
  return Math.max(0, container.clientWidth - padding - GUTTERS);
}

function clampSizes(next: number[], total: number): ColumnSizes {
  const sizes: ColumnSizes = [
    Math.max(MINIMUMS[0], next[0]),
    Math.max(MINIMUMS[1], next[1]),
    Math.max(MINIMUMS[2], next[2]),
  ];
  let overflow = sizes.reduce((a, b) => a + b, 0) - total;
  if (overflow > 0) {
    // 优先从最宽的列回收，尽量保住三列的最小宽度。
    const order = [...sizes.keys()].sort((a, b) => sizes[b] - sizes[a]);
    for (const index of order) {
      const take = Math.min(sizes[index] - MINIMUMS[index], overflow);
      sizes[index] -= take;
      overflow -= take;
      if (overflow <= 0) break;
    }
    // 901–911px 的极端窄桌面：最小宽度之和仍超出可用宽度，
    // 由最宽列继续吸收，宁可略低于最小宽度也不能溢出视口。
    if (overflow > 0) {
      for (const index of order) {
        const take = Math.min(sizes[index], overflow);
        sizes[index] -= take;
        overflow -= take;
        if (overflow <= 0) break;
      }
    }
  }
  return sizes;
}

function readSizes(
  container: HTMLElement | null,
  total: number,
): ColumnSizes | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || !container || !total) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const pixels = parsed.map((value: number) =>
      value <= 100 ? (value / 100) * total : value,
    ) as ColumnSizes;
    const sum = pixels.reduce((a, b) => a + b, 0);
    const scaled =
      sum > 0 ? pixels.map((value) => (value / sum) * total) : pixels;
    return clampSizes(scaled, total);
  } catch {
    return null;
  }
}

/**
 * 三栏工作台：组织 / 会话 / 数据工作区。
 * 尺寸以像素保存；以扣除左右 padding 和两条 gutter 后的可用宽度为基准，
 * 窗口缩放时按新基准重新分配，避免右列被裁切。
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
    const total = availableWidth(container);
    const stored = readSizes(container, total);
    setSizes(
      stored ??
        clampSizes(
          DEFAULT_SIZES.map((value) => (value / 100) * total),
          total,
        ),
    );
    const onResize = () => {
      const width = availableWidth(container);
      if (!width) return;
      setSizes((current) => {
        if (!current) return current;
        const currentTotal = current.reduce((a, b) => a + b, 0);
        if (!currentTotal) {
          return clampSizes(
            DEFAULT_SIZES.map((value) => (value / 100) * width),
            width,
          );
        }
        const scale = width / currentTotal;
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
    const total = availableWidth(container);
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
              gridTemplateColumns: `${sizes[0]}px ${GUTTER}px ${sizes[1]}px ${GUTTER}px ${sizes[2]}px`,
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
