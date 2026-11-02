import { Star } from "lucide-react";
import type { ModelTierRow } from "../../lib/model";
import {
  modelMissingLabel,
  tierLabel,
  tierSourceLabel,
} from "../../lib/model";
import { Badge } from "../../ui/primitives";

function sourceLabel(row: ModelTierRow): string {
  if (row.modelEnv) return `modelEnv · ${row.modelEnv}`;
  if (row.modelSource === "model") return "model";
  if (row.source) return tierSourceLabel(row.source);
  return "—";
}

function statusBadge(row: ModelTierRow, origin: "library" | "applied") {
  if (origin === "applied")
    return (
      <Badge tone={row.source === "unbound" ? "warning" : "positive"}>
        {row.source === "unbound" ? "回退" : "已应用"}
      </Badge>
    );
  return row.ready ? (
    <Badge tone="positive">可用</Badge>
  ) : (
    <Badge tone="warning">未就绪</Badge>
  );
}

/**
 * 四档表：库文件与已应用快照共用同一结构。
 * - 库文件：绑定 / provider + 类型 / 模型来源 model|modelEnv / ready
 * - 已应用：绑定 / provider / 已解析模型 ID（非密钥）/ 绑定来源 bound|fallback|unbound / 已应用
 * 只显示名称、环境变量名与模型 ID，不显示任何 endpoint 或凭据。
 */
export function ModelTierTable({
  rows,
  origin,
  label,
}: {
  rows: ModelTierRow[];
  origin: "library" | "applied";
  label?: string;
}) {
  return (
    <div
      className="model-tier-table"
      role="table"
      aria-label={
        label ?? (origin === "library" ? "模型库四档" : "已应用四档")
      }
      data-origin={origin}
      data-testid={`model-tier-table-${origin}`}
    >
      <div className="model-tier-row model-tier-head" role="row">
        <span role="columnheader">档位</span>
        <span role="columnheader">绑定</span>
        <span role="columnheader">provider</span>
        <span role="columnheader">
          {origin === "applied" ? "模型" : "模型来源"}
        </span>
        <span role="columnheader">状态</span>
      </div>
      {rows.map((row) => {
        const missing = row.missing
          .map(modelMissingLabel)
          .filter((item) => item !== `档位 ${row.tier} 未绑定`);
        return (
          <div
            className={`model-tier-row ${row.active ? "is-active" : ""}`.trim()}
            role="row"
            key={row.tier}
            aria-current={row.active ? "true" : undefined}
            data-tier={row.tier}
          >
            <span className="model-tier-name" role="rowheader">
              {row.active && (
                <Star
                  size={11}
                  className="model-tier-star"
                  fill="currentColor"
                  aria-label="活动档位"
                />
              )}
              {tierLabel(row.tier)}
            </span>
            <span className="model-tier-binding" role="cell">
              {row.bound ? "已绑定" : "未绑定"}
            </span>
            <span className="model-tier-provider" role="cell">
              {row.bound && row.provider
                ? `${row.provider}${row.providerType ? ` · ${row.providerType}` : ""}`
                : "—"}
            </span>
            <span
              className="model-tier-source"
              role="cell"
              data-testid={
                origin === "applied"
                  ? `model-tier-model-${row.tier}`
                  : undefined
              }
            >
              {origin === "applied" ? row.appliedModel ?? "—" : sourceLabel(row)}
            </span>
            <span className="model-tier-status" role="cell">
              {statusBadge(row, origin)}
            </span>
            {origin === "library" && missing.length > 0 && (
              <small className="model-tier-missing">
                {missing.join("；")}
              </small>
            )}
          </div>
        );
      })}
    </div>
  );
}
