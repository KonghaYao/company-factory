import type { ModelTier } from "../../lib/types";

/**
 * profile › provider › model，附带活动 alias。
 * 只渲染非敏感的链路名称；endpoint 与凭据值永远不会出现在这里。
 */
export function ModelChain({
  profile,
  provider,
  model,
  alias,
  empty = "未配置",
}: {
  profile?: string | null;
  provider?: string | null;
  model?: string | null;
  alias?: ModelTier | null;
  empty?: string;
}) {
  const parts = [profile, provider].filter(Boolean) as string[];
  const path = model
    ? [...parts, model].join(" › ")
    : parts.length
      ? `${parts.join(" › ")} › 未配置`
      : empty;
  return (
    <span
      className={`model-chain ${parts.length || model ? "" : "is-empty"}`.trim()}
      data-testid="model-chain"
    >
      <span className="model-chain-path">{path}</span>
      <span className="model-chain-alias">alias · {alias ?? "—"}</span>
    </span>
  );
}
