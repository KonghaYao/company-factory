/**
 * Pure model-matrix resolution for one Agent activation.
 *
 * Precedence for each tier:
 *   1. config.models[tier]
 *   2. config.model, for the active alias only (legacy explicit override)
 *   3. PERI_MODEL_ID_<TIER>
 *   4. PERI_MODEL_ID
 *   5. "unconfigured"
 *
 * When no four-tier source exists (no config.models entry and no tier env), the
 * legacy `config.model` fills every tier, preserving the old single-model behavior.
 * Once any four-tier source exists, `config.model` only overrides the active alias
 * and never leaks into the other tiers.
 *
 * Environment variables are never consumed from `config.settings`. Credentials,
 * provider and endpoint may only come from the trusted host environment; the
 * Agent-writable `.env` is deliberately not an input to this module.
 */
export const MODEL_TIERS = ["fable", "opus", "sonnet", "haiku"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const DEFAULT_MODEL_ALIAS: ModelTier = "sonnet";
export const UNCONFIGURED_MODEL = "unconfigured";
export const MODEL_PLACEHOLDER_BASE_URL = "http://127.0.0.1:9/v1";
export const MODEL_API_KEY_PLACEHOLDER = "not-configured-no-model-calls";
const TIER_ENV_PREFIX = "PERI_MODEL_ID_";

export class ModelConfigurationError extends Error {
  readonly code = "invalid_model_configuration";
  readonly status = 503;
}

export type ResolvedModelMatrix = {
  activeAlias: ModelTier;
  tiers: Record<ModelTier, string>;
  provider: string;
  baseUrl: string;
  apiKey: string | undefined;
  configured: boolean;
  /** Non-secret diagnostics for the active gate only. */
  missing: string[];
};

type AgentModelConfig = {
  model?: unknown;
  modelAlias?: unknown;
  models?: unknown;
  provider?: unknown;
  apiKeyEnv?: unknown;
  baseUrl?: unknown;
  settings?: unknown;
  [key: string]: unknown;
};
export type { AgentModelConfig };

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function tierEnvName(tier: ModelTier) {
  return `${TIER_ENV_PREFIX}${tier.toUpperCase()}`;
}

function isTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

function readAlias(config: AgentModelConfig): ModelTier {
  const raw = config.modelAlias;
  if (raw === undefined || raw === null) return DEFAULT_MODEL_ALIAS;
  if (typeof raw !== "string" || !isTier(raw))
    throw new ModelConfigurationError(
      `modelAlias must be one of ${MODEL_TIERS.join(", ")}.`,
    );
  return raw;
}

function readModelOverrides(
  config: AgentModelConfig,
): Partial<Record<ModelTier, string>> {
  const raw = config.models;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new ModelConfigurationError(
      "config.models must be an object keyed by fable, opus, sonnet or haiku.",
    );
  const overrides: Partial<Record<ModelTier, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isTier(key))
      throw new ModelConfigurationError(
        `Unknown model tier in config.models: ${key}.`,
      );
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string")
      throw new ModelConfigurationError(
        `config.models.${key} must be a non-empty string when provided.`,
      );
    const normalized = text(value);
    if (normalized) overrides[key] = normalized;
  }
  return overrides;
}

function assertKnownTierEnvironment(
  environment: Record<string, string | undefined>,
) {
  for (const key of Object.keys(environment)) {
    if (!key.startsWith(TIER_ENV_PREFIX)) continue;
    const suffix = key.slice(TIER_ENV_PREFIX.length);
    // Only exact uppercase tier names are accepted. A lowercase/mixed-case name
    // would otherwise be treated as "known" while the resolver reads the uppercase
    // key and silently falls back, hiding a real typo.
    if (
      !isTier(suffix.toLowerCase()) ||
      suffix !== suffix.toUpperCase() ||
      suffix === ""
    )
      throw new ModelConfigurationError(
        `Unknown model environment variable ${key}; expected ${MODEL_TIERS
          .map(tierEnvName)
          .join(", ")} or PERI_MODEL_ID.`,
      );
  }
}

export function resolveModelMatrix(input: {
  config?: AgentModelConfig | null;
  environment?: Record<string, string | undefined>;
}): ResolvedModelMatrix {
  const config = input.config ?? {};
  const environment = input.environment ?? {};
  assertKnownTierEnvironment(environment);

  const activeAlias = readAlias(config);
  const overrides = readModelOverrides(config);
  const legacyModel = text(config.model);
  const tierFromEnvironment = Object.fromEntries(
    MODEL_TIERS.map((tier) => [
      tier,
      text(environment[tierEnvName(tier)]),
    ]),
  ) as Record<ModelTier, string | undefined>;
  const hasFourTierSource =
    Object.keys(overrides).length > 0 ||
    MODEL_TIERS.some((tier) => Boolean(tierFromEnvironment[tier]));
  const environmentBase = text(environment.PERI_MODEL_ID);
  // `config.model` is a legacy whole-Agent override only while no four-tier source
  // exists. With per-tier configuration it must not fill unrelated tiers.
  const legacyBase = hasFourTierSource
    ? undefined
    : legacyModel ?? environmentBase;

  const tiers = {} as Record<ModelTier, string>;
  for (const tier of MODEL_TIERS) {
    tiers[tier] =
      overrides[tier] ??
      (tier === activeAlias ? legacyModel : undefined) ??
      tierFromEnvironment[tier] ??
      legacyBase ??
      (hasFourTierSource ? environmentBase : undefined) ??
      UNCONFIGURED_MODEL;
  }

  const provider =
    text(config.provider) ??
    text(environment.PERI_MODEL_PROVIDER) ??
    "openai";
  const baseUrl =
    text(config.baseUrl) ??
    text(environment.PERI_MODEL_BASE_URL) ??
    MODEL_PLACEHOLDER_BASE_URL;
  const apiKeyEnv = text(config.apiKeyEnv) ?? "PERI_MODEL_API_KEY";
  const apiKey = text(environment[apiKeyEnv]);

  const missing: string[] = [];
  if (!apiKey) missing.push(`apiKey:${apiKeyEnv}`);
  if (baseUrl === MODEL_PLACEHOLDER_BASE_URL) missing.push("baseUrl");
  if (tiers[activeAlias] === UNCONFIGURED_MODEL)
    missing.push(`model:${activeAlias}`);

  return {
    activeAlias,
    tiers,
    provider,
    baseUrl,
    apiKey,
    configured:
      Boolean(apiKey) &&
      tiers[activeAlias] !== UNCONFIGURED_MODEL &&
      baseUrl !== MODEL_PLACEHOLDER_BASE_URL,
    missing,
  };
}

/**
 * The only entry point used by the runtime to resolve deployment credentials.
 *
 * `agentEnvironment` represents an Agent-writable source such as `<agent>/.env`.
 * It is accepted so call sites and tests can state the trust boundary explicitly,
 * but it is deliberately never read: provider, base URL, API key and model IDs
 * must come from the trusted host environment or user-owned `agent.yaml` config.
 */
export function resolveTrustedModelMatrix(input: {
  config?: AgentModelConfig | null;
  hostEnvironment?: Record<string, string | undefined>;
  agentEnvironment?: Record<string, string | undefined>;
}): ResolvedModelMatrix {
  return resolveModelMatrix({
    config: input.config,
    environment: input.hostEnvironment ?? {},
  });
}

/** PeriConfig model fragment. `profiles` only binds a provider, never a second model copy. */
export function buildModelConfig(matrix: ResolvedModelMatrix) {
  return {
    active_alias: matrix.activeAlias,
    providers: [
      {
        id: "company-model",
        type: matrix.provider,
        apiKey: matrix.apiKey ?? MODEL_API_KEY_PLACEHOLDER,
        baseUrl: matrix.baseUrl,
        models: { ...matrix.tiers },
      },
    ],
    profiles: Object.fromEntries(
      MODEL_TIERS.map((tier) => [tier, { provider: "company-model" }]),
    ) as Record<ModelTier, { provider: string }>,
  };
}

/** Non-secret metadata for runtime snapshots. Never reads credentials or endpoints. */
export function modelInfoFromSettings(settings: unknown): {
  modelAlias: ModelTier | null;
  model: string | null;
} {
  const config = (settings as { config?: unknown } | null | undefined)?.config;
  if (!config || typeof config !== "object") return { modelAlias: null, model: null };
  const record = config as {
    active_alias?: unknown;
    providers?: unknown;
  };
  const alias =
    typeof record.active_alias === "string" && isTier(record.active_alias)
      ? record.active_alias
      : null;
  if (!alias) return { modelAlias: null, model: null };
  const providers = Array.isArray(record.providers) ? record.providers : [];
  const first = providers[0] as { models?: unknown } | undefined;
  const models =
    first && typeof first.models === "object" && first.models !== null
      ? (first.models as Record<string, unknown>)
      : {};
  const raw = models[alias];
  const model =
    typeof raw === "string" && raw !== UNCONFIGURED_MODEL ? raw : null;
  return { modelAlias: alias, model };
}
