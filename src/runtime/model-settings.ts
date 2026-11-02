/**
 * Shared model vocabulary.
 *
 * Model selection itself now lives in `model-library.ts`: a profile selects a
 * provider-backed model for each tier, and the runtime resolves it at
 * provision/explicit restart. This module keeps only the stable vocabulary and
 * non-secret snapshot helpers shared by the library, runtime and UI.
 */
export const MODEL_TIERS = ["fable", "opus", "sonnet", "haiku"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const DEFAULT_MODEL_ALIAS: ModelTier = "sonnet";
export const UNCONFIGURED_MODEL = "unconfigured";
export const MODEL_PLACEHOLDER_BASE_URL = "http://127.0.0.1:9/v1";
export const MODEL_API_KEY_PLACEHOLDER = "not-configured-no-model-calls";

export class ModelConfigurationError extends Error {
  readonly code = "invalid_model_configuration";
  readonly status = 503;
}

export function isModelTier(value: unknown): value is ModelTier {
  return (
    typeof value === "string" &&
    (MODEL_TIERS as readonly string[]).includes(value)
  );
}

/**
 * Non-secret metadata projected from a PeriConfig snapshot. Never reads
 * credentials or endpoints. Supports both the current per-tier profile shape
 * and the earlier provider.models shape so an explicit restart can rebuild a
 * metadata-less snapshot.
 */
export function modelInfoFromSettings(settings: unknown): {
  modelAlias: ModelTier | null;
  model: string | null;
} {
  const config = (settings as { config?: unknown } | null | undefined)?.config;
  if (!config || typeof config !== "object")
    return { modelAlias: null, model: null };
  const record = config as {
    active_alias?: unknown;
    providers?: unknown;
    profiles?: unknown;
  };
  const alias = isModelTier(record.active_alias)
    ? record.active_alias
    : null;
  if (!alias) return { modelAlias: null, model: null };

  const profiles =
    record.profiles && typeof record.profiles === "object"
      ? (record.profiles as Record<string, unknown>)
      : {};
  const selected = profiles[alias] as { model?: unknown } | undefined;
  if (typeof selected?.model === "string" && selected.model !== UNCONFIGURED_MODEL)
    return { modelAlias: alias, model: selected.model };

  const providers = Array.isArray(record.providers) ? record.providers : [];
  const first = providers[0] as { models?: unknown } | undefined;
  const models =
    first && typeof first.models === "object" && first.models !== null
      ? (first.models as Record<string, unknown>)
      : {};
  const raw = models[alias];
  return {
    modelAlias: alias,
    model:
      typeof raw === "string" && raw !== UNCONFIGURED_MODEL ? raw : null,
  };
}
