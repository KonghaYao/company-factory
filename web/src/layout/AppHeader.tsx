import { Boxes, ChevronRight, Cpu } from "lucide-react";

/**
 * 全局顶栏只承担三件事：品牌、当前上下文、本地状态。
 * 组织切换在两栏内部完成，避免顶栏变成第二个导航。
 */
export function AppHeader({
  companyName,
  agentName,
  onOpenModels,
}: {
  companyName?: string;
  agentName?: string;
  onOpenModels: () => void;
}) {
  return (
    <header className="app-header">
      <a className="brand" href="/" aria-label="Company Factory 首页">
        <span className="brand-mark">
          <Boxes size={18} />
        </span>
        <span className="brand-name">
          Company<strong>Factory</strong>
        </span>
      </a>
      <nav className="breadcrumb" aria-label="当前位置">
        <span>工作台</span>
        <ChevronRight size={12} />
        <span className={companyName ? "crumb-strong" : "crumb-muted"}>
          {companyName || "未命名组织"}
        </span>
        {agentName && (
          <>
            <ChevronRight size={12} />
            <span className="crumb-strong">{agentName}</span>
          </>
        )}
      </nav>
      <div className="header-status">
        <button
          type="button"
          className="header-action"
          data-testid="open-model-library"
          aria-label="模型库"
          title="模型库"
          onClick={onOpenModels}
        >
          <Cpu size={14} />
          <span className="header-action-label">模型库</span>
        </button>
        <span className="pulse-dot" aria-hidden="true" />
        本地优先
        <span className="status-sep" />
        <span className="header-user">我</span>
      </div>
    </header>
  );
}
