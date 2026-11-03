import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type LayoutStorage,
} from "react-resizable-panels";

const PANEL_IDS = ["workbench-org", "workbench-chat", "workbench-data"];
const LAYOUT_ID = "company.workbench.layout";
const LEGACY_STORAGE_KEY = "company.workbench.columns";
const NARROW_QUERY = "(max-width: 900px)";

/** Panel 的内层容器默认 overflow:auto；三栏内部各自滚动，这里保持旧的裁切行为。 */
const PANEL_STYLE: CSSProperties = { overflow: "hidden" };

function isStoredLayout(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const layout = parsed as Record<string, unknown>;
    if (Object.keys(layout).length !== PANEL_IDS.length) return false;
    const values = PANEL_IDS.map((id) => layout[id]);
    if (
      !values.every(
        (value) =>
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 100,
      )
    ) {
      return false;
    }
    // 库保存的是归一化百分比；总和明显偏离 100 视为损坏数据。
    const total = (values as number[]).reduce((sum, value) => sum + value, 0);
    return Math.abs(total - 100) <= 0.5;
  } catch {
    return false;
  }
}

/**
 * 旧键保存的是三栏像素数组；按总和折算成库需要的百分比。
 * 读取或折算失败时返回 null，由 useDefaultLayout 回退到 Panel 默认比例。
 */
function legacyLayout(): string | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== PANEL_IDS.length) {
      return null;
    }
    if (
      !parsed.every(
        (value) =>
          typeof value === "number" && Number.isFinite(value) && value > 0,
      )
    ) {
      return null;
    }
    const sizes = parsed as number[];
    const total = sizes.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return null;
    const layout = Object.fromEntries(
      PANEL_IDS.map((id, index) => [id, (sizes[index] / total) * 100]),
    );
    return JSON.stringify(layout);
  } catch {
    return null;
  }
}

/** 新键损坏或旧键不可迁移时都回退默认布局，不让存储问题打断渲染。 */
const layoutStorage: LayoutStorage = {
  getItem(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return isStoredLayout(raw) ? raw : null;
      return legacyLayout();
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 存储不可用时不阻断拖拽。
    }
  },
};

function useIsNarrow(): boolean {
  const [isNarrow, setIsNarrow] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const update = () => setIsNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isNarrow;
}

/**
 * 三栏工作台：组织 / 会话 / 数据工作区。
 * 宽屏使用 react-resizable-panels 提供拖拽与键盘调整；
 * 窄屏直接渲染纵向堆叠容器，避免库的内联 flex 布局与 CSS 媒体查询相互覆盖。
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
  const isNarrow = useIsNarrow();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: LAYOUT_ID,
    panelIds: PANEL_IDS,
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  });

  if (isNarrow) {
    return (
      <div className="workbench">
        <aside className="workbench-column workbench-sidebar">{sidebar}</aside>
        <section className="workbench-column workbench-chat">{chat}</section>
        <section className="workbench-column workbench-data">
          {workspace}
        </section>
      </div>
    );
  }

  return (
    <Group
      className="workbench"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <Panel
        id={PANEL_IDS[0]}
        className="workbench-column workbench-sidebar"
        defaultSize="18%"
        minSize={200}
        style={PANEL_STYLE}
        role="region"
        aria-label="组织栏"
      >
        {sidebar}
      </Panel>
      <Separator className="column-gutter" aria-label="调整组织栏宽度" />
      <Panel
        id={PANEL_IDS[1]}
        className="workbench-column workbench-chat"
        defaultSize="34%"
        minSize={320}
        style={PANEL_STYLE}
        role="region"
        aria-label="会话栏"
      >
        {chat}
      </Panel>
      <Separator className="column-gutter" aria-label="调整工作区宽度" />
      <Panel
        id={PANEL_IDS[2]}
        className="workbench-column workbench-data"
        defaultSize="48%"
        minSize={360}
        style={PANEL_STYLE}
        role="region"
        aria-label="工作区"
      >
        {workspace}
      </Panel>
    </Group>
  );
}
