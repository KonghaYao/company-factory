import type {
  ModelLibraryProfileView,
  ModelLibraryView,
  ModelTier,
  Runtime,
} from "./types";

/** Human-readable model diagnostics. Never renders endpoint or credential values. */
const ERROR_LABELS: Record<string, string> = {
  library_missing: "模型库文件不存在",
  library_insecure: "模型库文件不安全（权限或路径不符合要求）",
  library_invalid: "模型库文件格式无效",
  library_invalid_yaml: "模型库 YAML 无法解析",
  library_unreadable: "模型库文件无法读取",
  library_empty: "模型库文件为空",
  library_schema_invalid: "模型库结构不符合 schema",
  library_version_unsupported: "模型库版本不受支持（需要 version 2）",
  library_symlink: "模型库不能是符号链接",
  library_hardlink: "模型库不能是硬链接",
  library_permissions: "模型库文件必须为 0600",
  library_owner_mismatch: "模型库文件不属于当前服务用户",
  library_not_regular: "模型库路径不是普通文件",
  library_path_forbidden: "模型库不能位于 agents、companys 或 runtime/workspace 内",
  library_path_not_absolute: "COMPANY_MODEL_LIBRARY 必须是绝对路径",
  profile_not_found: "引用的 profile 不存在",
  profile_disabled: "引用的 profile 已禁用",
  default_profile_missing: "模型库没有默认 profile",
  model_not_resolved: "活动档位没有可用模型",
  provider_not_found: "模型引用的 provider 不存在",
  provider_disabled: "模型引用的 provider 已禁用",
  base_url_missing: "活动 provider 缺少 base URL",
  credential_missing: "活动 provider 缺少凭据",
};

export const MODEL_TIERS: ModelTier[] = ["fable", "opus", "sonnet", "haiku"];

export function tierLabel(tier: ModelTier): string {
  return tier[0].toUpperCase() + tier.slice(1);
}

export function modelErrorLabel(code?: string | null): string {
  if (!code) return "模型尚未配置";
  return ERROR_LABELS[code] ?? `模型尚未配置（${code}）`;
}

/** Convert a `kind:name` diagnostic to a label containing names only. */
export function modelMissingLabel(item: string): string {
  if (item.startsWith("apiKey:"))
    return `缺少环境变量 ${item.slice("apiKey:".length)}`;
  if (item.startsWith("baseUrlEnv:"))
    return `缺少环境变量 ${item.slice("baseUrlEnv:".length)}`;
  if (item.startsWith("modelEnv:"))
    return `缺少环境变量 ${item.slice("modelEnv:".length)}`;
  if (item.startsWith("tier:")) {
    const [, tier, state] = item.split(":");
    if (state === "unbound") return `档位 ${tier} 未绑定`;
    if (state === "disabled") return `档位 ${tier} 已禁用`;
    return `档位 ${tier}`;
  }
  if (item.startsWith("model:")) {
    const value = item.slice("model:".length);
    if (value.endsWith(":disabled"))
      return `模型 ${value.slice(0, -":disabled".length)} 已禁用`;
    return `档位 ${value} 没有可用模型`;
  }
  if (item.startsWith("provider:")) {
    const value = item.slice("provider:".length);
    if (value.endsWith(":disabled"))
      return `Provider ${value.slice(0, -":disabled".length)} 已禁用`;
    if (value.endsWith(":not_found")) return "Provider 不存在";
    return `Provider ${value}`;
  }
  if (item === "baseUrl") return "缺少 base URL";
  if (item.startsWith("profile:")) return "没有可用的 profile";
  if (item.startsWith("library:")) return "模型库不可用";
  return item;
}

export function modelReason(
  error?: string | null,
  missing?: string[] | null,
): string {
  const reason = modelErrorLabel(error);
  const details = (missing ?? []).map(modelMissingLabel);
  return details.length ? `${reason}：${details.join("；")}` : reason;
}

export function modelChain(input: {
  modelProfile?: string | null;
  modelProvider?: string | null;
  model?: string | null;
}): string {
  return [input.modelProfile, input.modelProvider, input.model]
    .filter(Boolean)
    .join(" › ");
}

/** The library revision changed since this Agent's snapshot was applied. */
export function modelRevisionMismatch(
  currentRevision?: string | null,
  appliedRevision?: string | null,
): boolean {
  return Boolean(
    currentRevision && appliedRevision && currentRevision !== appliedRevision,
  );
}

export function shortRevision(value: string): string {
  return value.slice(0, 12);
}

export function libraryStatusLabel(status: ModelLibraryView["status"]): string {
  switch (status) {
    case "ok":
      return "可用";
    case "missing":
      return "文件缺失";
    case "insecure":
      return "文件不安全";
    case "invalid":
      return "文件无效";
  }
}

export function libraryStatusTone(
  status: ModelLibraryView["status"],
): "positive" | "warning" | "danger" {
  if (status === "ok") return "positive";
  if (status === "missing") return "warning";
  return "danger";
}

export function libraryStatusHint(
  status: ModelLibraryView["status"],
): string {
  switch (status) {
    case "ok":
      return "修改模型库后，已有 Agent 需手动重启才会应用。";
    case "missing":
      return "在 $COMPANY_HOME/model-library.yaml 创建 0600 模型库文件，然后刷新。";
    case "insecure":
      return "修正模型库文件的权限、所有者或路径，然后刷新。";
    case "invalid":
      return "按 v2 schema（version 2、嵌套 providers/profiles）修正模型库文件，然后刷新。";
  }
}

export type ModelTierSource = "bound" | "fallback" | "unbound";

export function tierSourceLabel(source?: ModelTierSource | null): string {
  switch (source) {
    case "bound":
      return "绑定";
    case "fallback":
      return "回退";
    case "unbound":
      return "未绑定";
    default:
      return "—";
  }
}

/**
 * Normalized row shared by the library file view and the applied runtime
 * snapshot. Secret values are never part of this shape — only env var names.
 */
export type ModelTierRow = {
  tier: ModelTier;
  active: boolean;
  bound: boolean;
  provider: string | null;
  providerType: string | null;
  modelSource: "model" | "modelEnv" | null;
  modelEnv: string | null;
  /** Resolved model ID from the applied runtime snapshot; never a secret. */
  appliedModel: string | null;
  source: ModelTierSource | null;
  /** `null` means the applied snapshot carries no readiness flags. */
  ready: boolean | null;
  missing: string[];
  providerEnabled: boolean | null;
  endpointConfigured: boolean | null;
  credentialConfigured: boolean | null;
};

export function libraryTierRows(
  profile: ModelLibraryProfileView,
): ModelTierRow[] {
  return profile.tiers.map((tier) => ({
    tier: tier.tier,
    active: profile.activeAlias === tier.tier,
    bound: tier.bound,
    provider: tier.provider,
    providerType: tier.providerType,
    modelSource: tier.model ? "model" : tier.modelEnv ? "modelEnv" : null,
    modelEnv: tier.modelEnv,
    appliedModel: null,
    source: tier.bound ? "bound" : "unbound",
    ready: tier.ready,
    missing: tier.missing,
    providerEnabled: tier.providerEnabled,
    endpointConfigured: tier.endpointConfigured,
    credentialConfigured: tier.credentialConfigured,
  }));
}

/** Returns null for snapshots that predate per-tier detail (`modelTierNotice`). */
export function appliedTierRows(
  runtime?: Pick<
    Runtime,
    | "modelAlias"
    | "modelTiers"
    | "modelTierProviders"
    | "modelTierSources"
  > | null,
): ModelTierRow[] | null {
  if (!runtime?.modelTiers) return null;
  const { modelTiers } = runtime;
  return MODEL_TIERS.map((tier) => {
    const source = runtime.modelTierSources?.[tier] ?? null;
    return {
      tier,
      active: runtime.modelAlias === tier,
      bound: source === "bound",
      provider: runtime.modelTierProviders?.[tier] ?? null,
      providerType: null,
      modelSource: null,
      modelEnv: null,
      appliedModel: modelTiers[tier] ?? null,
      source,
      ready: null,
      missing: [],
      providerEnabled: null,
      endpointConfigured: null,
      credentialConfigured: null,
    };
  });
}

export function libraryProfile(
  library?: ModelLibraryView | null,
  id?: string | null,
): ModelLibraryProfileView | undefined {
  if (!library || !id) return undefined;
  return library.profiles.find((profile) => profile.id === id);
}

