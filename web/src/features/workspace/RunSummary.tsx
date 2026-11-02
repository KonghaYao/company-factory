import { Activity, AlertTriangle, ArrowUpRight, Ban } from "lucide-react";
import type { Runtime } from "../../lib/types";
import { Badge } from "../../ui/primitives";
import { ModelChain } from "../models/ModelChain";

type RunState = "running" | "error" | "blocked" | "idle";
type TurnTone = "accent" | "success" | "danger" | "warning" | "faint" | "neutral";

function describeTurn(status?: string | null): {
  label: string;
  tone: TurnTone;
} {
  if (!status) return { label: "—", tone: "faint" };
  switch (status) {
    case "running":
    case "in_progress":
    case "active":
      return { label: "运行中", tone: "accent" };
    case "completed":
    case "succeeded":
      return { label: "已完成", tone: "success" };
    case "failed":
      return { label: "失败", tone: "danger" };
    case "error":
      return { label: "错误", tone: "danger" };
    case "cancelled":
      return { label: "已取消", tone: "warning" };
    case "aborted":
    case "stopped":
      return { label: "已中止", tone: "warning" };
    default:
      return { label: status, tone: "neutral" };
  }
}

/** 运行摘要只回答「现在运行得怎么样」；错误正文与任务明细仍在卡片之外。 */
export function RunSummary({
  runtime,
  onModel,
}: {
  runtime?: Runtime;
  onModel: () => void;
}) {
  const turnStatus = runtime?.activeTurn?.status ?? null;
  const busy = Boolean(
    runtime?.busy || runtime?.running || turnStatus === "running",
  );
  const failed = Boolean(
    runtime?.error || turnStatus === "error" || turnStatus === "failed",
  );
  const blocked = !failed && Boolean(runtime?.executionBlocked || runtime?.closed);
  const state: RunState = failed
    ? "error"
    : blocked
      ? "blocked"
      : busy
        ? "running"
        : "idle";

  const title =
    state === "error"
      ? "运行出现异常"
      : state === "blocked"
        ? "执行已阻断"
        : state === "running"
          ? "正在执行工作"
          : "等待新的输入";
  const subtitle =
    state === "error"
      ? runtime?.error
        ? "运行状态来自 Peri，不代表业务验收通过；错误详情见下方。"
        : "运行状态来自 Peri，不代表业务验收通过。"
      : state === "blocked"
        ? "执行已被阻断；请在主列重新加载或重启会话。"
        : state === "running"
          ? "运行状态来自 Peri，不代表业务验收通过。"
          : "未完成 Issue 或等待裁定不会被显示为忙碌。";

  const Icon =
    state === "error" ? AlertTriangle : state === "blocked" ? Ban : Activity;
  const turn = describeTurn(turnStatus);
  const queueCount = runtime?.queueState?.count ?? runtime?.queue?.length ?? 0;

  return (
    <section
      className="run-summary"
      data-state={state}
      data-testid="run-summary"
      aria-labelledby="run-summary-title"
    >
      <div className="run-summary-head">
        <span className="run-summary-icon">
          <Icon size={14} aria-hidden="true" />
        </span>
        <div className="run-summary-copy">
          <div className="run-summary-title-row">
            <h2 id="run-summary-title">{title}</h2>
            {state === "running" && (
              <span className="live-pill" aria-label="实时运行中">
                LIVE
              </span>
            )}
            {state === "error" && <Badge tone="danger">异常</Badge>}
            {state === "blocked" && <Badge tone="warning">已阻断</Badge>}
          </div>
          <p className="run-summary-subtitle">{subtitle}</p>
        </div>
      </div>

      <dl className="runtime-facts">
        <div className="runtime-fact runtime-fact-model">
          <dt>
            模型
            <span className="model-chain-alias">
              alias · {runtime?.modelAlias ?? "—"}
            </span>
          </dt>
          <dd className="runtime-model">
            <ModelChain
              profile={runtime?.modelProfile}
              provider={runtime?.modelProvider}
              model={runtime?.model}
              alias={runtime?.modelAlias}
              showAlias={false}
            />
            <button
              type="button"
              className="model-detail-link"
              data-testid="model-detail"
              aria-label="查看模型详情"
              title="查看模型详情"
              onClick={onModel}
            >
              详情
              <ArrowUpRight size={11} aria-hidden="true" />
            </button>
          </dd>
        </div>
        <div className="runtime-fact runtime-fact-turn">
          <dt>当前回合</dt>
          <dd
            className="runtime-turn"
            data-turn-id={runtime?.activeTurn?.turnId}
            data-status={turnStatus ?? undefined}
          >
            <span
              className="turn-dot"
              data-tone={turn.tone}
              aria-hidden="true"
            />
            {turn.label}
          </dd>
        </div>
        <div className="runtime-fact runtime-fact-queue">
          <dt>旧队列</dt>
          <dd data-active={queueCount > 0 ? "true" : undefined}>
            {queueCount} 条
            {queueCount > 0 && (
              <span className="text-muted-foreground">（只读，不会自动执行）</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
