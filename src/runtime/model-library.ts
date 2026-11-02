/**
 * User-owned model library: profile → provider → model.
 *
 * The library file is host-only deployment configuration. It stores environment
 * variable *names* for endpoints and credentials, never their values. Agent
 * config selects a profile (`modelProfile`); the runtime resolves the profile's
 * per-tier bindings at provision/explicit restart and writes only the resolved
 * PeriConfig (with secrets) into the private 0600 effective-config snapshot.
 *
 * v2 nests providers and profiles by id:
 *
 * ```yaml
 * version: 2
 * activeProfile: default
 * providers:
 *   host-openai: { type: openai, baseUrlEnv: OPENAI_BASE_URL, apiKeyEnv: OPENAI_API_KEY }
 * profiles:
 *   default:
 *     activeAlias: sonnet
 *     tiers:
 *       sonnet: { provider: host-openai, modelEnv: OPENAI_DEFAULT_SONNET_MODEL }
 * ```
 *
 * v1 files (version 1 or the legacy providers/models/profiles arrays) are
 * rejected with `library_version_unsupported`; they are never guessed-migrated.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  DEFAULT_MODEL_ALIAS,
  MODEL_API_KEY_PLACEHOLDER,
  MODEL_PLACEHOLDER_BASE_URL,
  MODEL_TIERS,
  ModelConfigurationError,
  UNCONFIGURED_MODEL,
  isModelTier,
  type ModelTier,
} from "./model-settings";

export const MODEL_LIBRARY_VERSION = 2;
const LIBRARY_FILE = "model-library.yaml";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const idSchema = z.string().max(96).regex(ID_PATTERN);
// Agent config validates modelProfile with the same safe-id rule.
const profileIdSchema = z
  .string()
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const envNameSchema = z.string().max(128).regex(ENV_NAME_PATTERN);

const providerSchema = z
  .object({
    type: z.enum(["openai", "anthropic"]),
    label: z.string().max(200).optional(),
    // Only environment variable *names* are accepted. A literal baseUrl or any
    // credential value is rejected by the strict object.
    baseUrlEnv: envNameSchema.optional(),
    apiKeyEnv: envNameSchema.optional(),
    enabled: z.boolean().optional().default(true),
  })
  .strict();

const tierSchema = z
  .object({
    provider: idSchema,
    model: z.string().max(500).optional(),
    modelEnv: envNameSchema.optional(),
    label: z.string().max(200).optional(),
    enabled: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.model !== undefined && value.modelEnv !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "model and modelEnv are mutually exclusive",
      });
    if (value.model === undefined && value.modelEnv === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "exactly one of model or modelEnv is required",
      });
    if (value.model !== undefined && !value.model.trim())
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "model must not be empty",
      });
  });

const tiersSchema = z
  .object({
    fable: tierSchema.optional(),
    opus: tierSchema.optional(),
    sonnet: tierSchema.optional(),
    haiku: tierSchema.optional(),
  })
  .strict();

const profileSchema = z
  .object({
    label: z.string().max(200).optional(),
    activeAlias: z.enum(MODEL_TIERS),
    tiers: tiersSchema.default({}),
    enabled: z.boolean().optional().default(true),
  })
  .strict();

export const modelLibrarySchema = z
  .object({
    version: z.literal(MODEL_LIBRARY_VERSION),
    activeProfile: profileIdSchema,
    providers: z.record(idSchema, providerSchema).default({}),
    profiles: z.record(profileIdSchema, profileSchema).default({}),
  })
  .strict()
  .superRefine((library, ctx) => {
    if (!Object.hasOwn(library.profiles, library.activeProfile))
      ctx.addIssue({
        code: "custom",
        path: ["activeProfile"],
        message: `unknown profile reference: ${library.activeProfile}`,
      });
    for (const [profileId, profile] of Object.entries(library.profiles))
      for (const tier of MODEL_TIERS) {
        const binding = profile.tiers[tier];
        if (binding && !Object.hasOwn(library.providers, binding.provider))
          ctx.addIssue({
            code: "custom",
            path: ["profiles", profileId, "tiers", tier, "provider"],
            message: `unknown provider reference: ${binding.provider}`,
          });
      }
  });

export type ModelLibrary = z.infer<typeof modelLibrarySchema>;
export type ModelLibraryProvider = ModelLibrary["providers"][string] & {
  id: string;
};
export type ModelLibraryProfile = ModelLibrary["profiles"][string] & {
  id: string;
};
export type ModelLibraryTierBinding = z.infer<typeof tierSchema>;

export type ModelLibraryStatus = "ok" | "missing" | "insecure" | "invalid";
export type ModelLibraryState = {
  status: ModelLibraryStatus;
  path: string;
  revision: string | null;
  library: ModelLibrary | null;
  /** Stable diagnostic code; never contains a value. */
  error: string | null;
  /** Sanitized issue paths/codes, never the rejected values. */
  issues: string[];
};

const insecure = (
  path: string,
  error: string,
): ModelLibraryState => ({
  status: "insecure",
  path,
  revision: null,
  library: null,
  error,
  issues: [],
});

const invalid = (
  path: string,
  error: string,
  issues: string[] = [],
): ModelLibraryState => ({
  status: "invalid",
  path,
  revision: null,
  library: null,
  error,
  issues,
});

function within(child: string, parent: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realpathOr(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function modelLibraryPath(input: {
  root: string;
  environment?: Record<string, string | undefined>;
  overridePath?: string;
}): { path: string; error: string | null } {
  const environment = input.environment ?? {};
  const override =
    input.overridePath ?? environment.COMPANY_MODEL_LIBRARY?.trim();
  if (!override) return { path: join(resolve(input.root), LIBRARY_FILE), error: null };
  if (!isAbsolute(override))
    return { path: override, error: "library_path_not_absolute" };
  return { path: resolve(override), error: null };
}

/** v1 (version 1 or legacy arrays) is explicitly unsupported, never guessed. */
function unsupportedVersion(document: unknown) {
  if (!document || typeof document !== "object" || Array.isArray(document))
    return false;
  const record = document as Record<string, unknown>;
  if (record.version !== undefined && record.version !== MODEL_LIBRARY_VERSION)
    return true;
  return (
    Array.isArray(record.providers) ||
    Array.isArray(record.profiles) ||
    Array.isArray(record.models)
  );
}

/** Sanitized YAML location (`yaml:line:col`); never the parser message. */
function yamlPosition(error: unknown): string[] {
  const position = (error as { linePos?: Array<{ line?: unknown; col?: unknown }> })
    ?.linePos?.[0];
  if (typeof position?.line === "number" && typeof position.col === "number")
    return [`yaml:${position.line}:${position.col}`];
  return ["yaml"];
}

/**
 * Read and validate the library without throwing. Missing, unsafe, unreadable
 * and malformed files all surface as an explicit state so the service keeps
 * running and Agents report `model_not_configured` instead of crashing.
 */
export function loadModelLibrary(input: {
  root: string;
  environment?: Record<string, string | undefined>;
  overridePath?: string;
}): ModelLibraryState {
  const environment = input.environment ?? {};
  const located = modelLibraryPath({
    root: input.root,
    environment,
    overridePath: input.overridePath,
  });
  if (located.error) return insecure(located.path, located.error);
  const path = located.path;
  const root = resolve(input.root);
  const forbidden = [
    join(root, "agents"),
    join(root, "companys"),
    join(root, "runtime", "workspace"),
  ];
  if (forbidden.some((dir) => within(resolve(path), dir)))
    return insecure(path, "library_path_forbidden");

  let stats;
  try {
    stats = lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT")
      return {
        status: "missing",
        path,
        revision: null,
        library: null,
        error: "library_missing",
        issues: [],
      };
    return insecure(path, "library_unreadable");
  }
  if (stats.isSymbolicLink()) return insecure(path, "library_symlink");
  if (!stats.isFile()) return insecure(path, "library_not_regular");
  if (stats.nlink !== 1) return insecure(path, "library_hardlink");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid())
    return insecure(path, "library_owner_mismatch");
  if ((stats.mode & 0o777) !== 0o600)
    return insecure(path, "library_permissions");

  const resolvedPath = realpathOr(path);
  if (
    forbidden.some((dir) => within(resolvedPath, realpathOr(dir))) ||
    forbidden.some((dir) => within(resolvedPath, resolve(dir)))
  )
    return insecure(path, "library_path_forbidden");

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return insecure(path, "library_unreadable");
  }

  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    return invalid(path, "library_invalid_yaml", yamlPosition(error));
  }
  if (document === null || document === undefined)
    return invalid(path, "library_empty");

  if (unsupportedVersion(document))
    return invalid(path, "library_version_unsupported", ["version:unsupported"]);

  const parsed = modelLibrarySchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 20)
      .map((issue) => {
        const at = issue.path.length
          ? issue.path
              .map((part) =>
                typeof part === "number" ? `[${part}]` : String(part),
              )
              .join(".")
          : "$";
        return `${at}:${issue.code}`;
      });
    return invalid(path, "library_schema_invalid", issues);
  }

  return {
    status: "ok",
    path,
    revision: createHash("sha256").update(text).digest("hex"),
    library: parsed.data,
    error: null,
    issues: [],
  };
}

export type ModelTierSource = "bound" | "fallback" | "unbound";

export type ModelResolutionMetadata = {
  source: "profile";
  profile: string | null;
  activeAlias: ModelTier;
  provider: string | null;
  model: string | null;
  tiers: Record<ModelTier, string>;
  tierProviders: Record<ModelTier, string | null>;
  /** Where each tier's displayed model came from. */
  tierSources: Record<ModelTier, ModelTierSource>;
  configured: boolean;
  missing: string[];
  error: string | null;
  libraryRevision: string | null;
  resolvedAt: string;
};

type Credential = {
  id: string;
  type: "openai" | "anthropic";
  baseUrl: string | null;
  apiKey: string | null;
  baseUrlEnv: string;
  apiKeyEnv: string;
};

export type ResolvedModel = {
  metadata: ModelResolutionMetadata;
  /** PeriConfig model fragment; contains secrets and must stay host-only. */
  config: {
    active_alias: ModelTier;
    providers: Array<{
      id: string;
      type: "openai" | "anthropic";
      apiKey: string;
      baseUrl: string;
      models?: Partial<Record<ModelTier, string>>;
    }>;
    profiles: Partial<
      Record<ModelTier, { provider: string; model?: string }>
    >;
  };
};

type TierState = {
  model: string | null;
  provider: string | null;
};

type BoundResult =
  | { kind: "unbound" }
  | { kind: "ok"; state: TierState }
  | { kind: "error"; state: TierState; missing: string[] };

function defaultBaseUrlEnv(type: "openai" | "anthropic") {
  return type === "openai" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL";
}

function defaultApiKeyEnv(type: "openai" | "anthropic") {
  return type === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

function credential(
  id: string,
  provider: ModelLibraryProvider,
  environment: Record<string, string | undefined>,
): Credential {
  const baseUrlEnv = provider.baseUrlEnv ?? defaultBaseUrlEnv(provider.type);
  const apiKeyEnv = provider.apiKeyEnv ?? defaultApiKeyEnv(provider.type);
  return {
    id,
    type: provider.type,
    baseUrl: text(environment[baseUrlEnv]) ?? null,
    apiKey: text(environment[apiKeyEnv]) ?? null,
    baseUrlEnv,
    apiKeyEnv,
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function placeholderConfig(alias: ModelTier): ResolvedModel["config"] {
  return {
    active_alias: alias,
    providers: [
      {
        id: "company-model",
        type: "openai",
        apiKey: MODEL_API_KEY_PLACEHOLDER,
        baseUrl: MODEL_PLACEHOLDER_BASE_URL,
        models: Object.fromEntries(
          MODEL_TIERS.map((tier) => [tier, UNCONFIGURED_MODEL]),
        ) as Record<ModelTier, string>,
      },
    ],
    profiles: Object.fromEntries(
      MODEL_TIERS.map((tier) => [tier, { provider: "company-model" }]),
    ) as Record<ModelTier, { provider: string }>,
  };
}

function readAlias(config: Record<string, unknown>): ModelTier | undefined {
  const raw = config.modelAlias;
  if (raw === undefined || raw === null) return undefined;
  if (!isModelTier(raw))
    throw new ModelConfigurationError(
      `modelAlias must be one of ${MODEL_TIERS.join(", ")}.`,
    );
  return raw;
}

function readProfileId(config: Record<string, unknown>): string | undefined {
  const raw = config.modelProfile;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string")
    throw new ModelConfigurationError("modelProfile must be a string.");
  return text(raw);
}

function metadata(input: {
  alias: ModelTier;
  profile: string | null;
  states: Record<ModelTier, TierState>;
  sources: Record<ModelTier, ModelTierSource>;
  configured: boolean;
  missing: string[];
  error: string | null;
  revision: string | null;
  now: Date;
}): ModelResolutionMetadata {
  const active = input.states[input.alias];
  return {
    source: "profile",
    profile: input.profile,
    activeAlias: input.alias,
    provider: active.provider,
    model: input.configured ? active.model : null,
    tiers: Object.fromEntries(
      MODEL_TIERS.map((tier) => [
        tier,
        input.states[tier].model ?? UNCONFIGURED_MODEL,
      ]),
    ) as Record<ModelTier, string>,
    tierProviders: Object.fromEntries(
      MODEL_TIERS.map((tier) => [tier, input.states[tier].provider]),
    ) as Record<ModelTier, string | null>,
    tierSources: { ...input.sources },
    configured: input.configured,
    missing: input.missing,
    error: input.error,
    libraryRevision: input.revision,
    resolvedAt: input.now.toISOString(),
  };
}

/**
 * Resolve an Agent configuration against the library.
 *
 * Precedence: explicit `config.modelProfile` (missing/disabled is final, never
 * falls back) → library `activeProfile` → unconfigured. The active tier is
 * `config.modelAlias ?? profile.activeAlias`; invalid aliases throw.
 */
export function resolveModel(input: {
  config?: Record<string, unknown> | null;
  library: ModelLibraryState;
  environment?: Record<string, string | undefined>;
  now?: Date;
}): ResolvedModel {
  const config = input.config ?? {};
  const environment = input.environment ?? {};
  const now = input.now ?? new Date();
  const configAlias = readAlias(config);
  const requestedProfile = readProfileId(config);
  const revision = input.library.status === "ok" ? input.library.revision : null;
  const emptyStates = Object.fromEntries(
    MODEL_TIERS.map((tier) => [tier, { model: null, provider: null }]),
  ) as Record<ModelTier, TierState>;
  const emptySources = Object.fromEntries(
    MODEL_TIERS.map((tier) => [tier, "unbound"]),
  ) as Record<ModelTier, ModelTierSource>;
  const unconfigured = (
    profile: string | null,
    error: string,
    missing: string[],
    alias: ModelTier,
  ): ResolvedModel => ({
    metadata: metadata({
      alias,
      profile,
      states: emptyStates,
      sources: emptySources,
      configured: false,
      missing,
      error,
      revision,
      now,
    }),
    config: placeholderConfig(alias),
  });

  if (input.library.status !== "ok" || !input.library.library)
    return unconfigured(
      requestedProfile ?? null,
      input.library.error ??
        (input.library.status === "missing"
          ? "library_missing"
          : "library_invalid"),
      [`library:${input.library.status}`],
      configAlias ?? DEFAULT_MODEL_ALIAS,
    );

  const library = input.library.library;
  const lookupProfile = (id: string): ModelLibraryProfile | undefined => {
    if (!Object.hasOwn(library.profiles, id)) return undefined;
    const entry = library.profiles[id];
    return entry ? { id, ...entry } : undefined;
  };
  let profile: ModelLibraryProfile | undefined;
  let profileId: string | null;
  if (requestedProfile !== undefined) {
    profileId = requestedProfile;
    profile = lookupProfile(requestedProfile);
    if (!profile)
      return unconfigured(
        profileId,
        "profile_not_found",
        ["profile:not_found"],
        configAlias ?? DEFAULT_MODEL_ALIAS,
      );
    if (!profile.enabled)
      return unconfigured(
        profileId,
        "profile_disabled",
        ["profile:disabled"],
        configAlias ?? profile.activeAlias,
      );
  } else {
    profileId = library.activeProfile;
    profile = lookupProfile(profileId);
    if (!profile)
      return unconfigured(
        profileId,
        "profile_not_found",
        ["profile:not_found"],
        configAlias ?? DEFAULT_MODEL_ALIAS,
      );
    if (!profile.enabled)
      return unconfigured(
        profileId,
        "profile_disabled",
        ["profile:disabled"],
        configAlias ?? profile.activeAlias,
      );
  }

  const alias = configAlias ?? profile.activeAlias;

  const providers = new Map<string, ModelLibraryProvider>(
    Object.entries(library.providers).map(([id, provider]) => [
      id,
      { id, ...provider },
    ]),
  );
  const credentials = new Map<string, Credential>();
  for (const [id, provider] of providers)
    credentials.set(id, credential(id, provider, environment));

  const bound = {} as Record<ModelTier, BoundResult>;
  for (const tier of MODEL_TIERS) {
    const binding = profile.tiers[tier];
    if (binding === undefined) {
      bound[tier] = { kind: "unbound" };
      continue;
    }
    const provider = providers.get(binding.provider);
    const missing: string[] = [];
    let modelId: string | null = null;
    if (!binding.enabled) missing.push(`tier:${tier}:disabled`);
    else if (binding.model !== undefined) modelId = binding.model;
    else if (binding.modelEnv !== undefined) {
      modelId = text(environment[binding.modelEnv]) ?? null;
      if (!modelId) missing.push(`modelEnv:${binding.modelEnv}`);
    }
    if (!provider) {
      missing.push(`provider:${binding.provider}:not_found`);
      modelId = null;
    } else if (!provider.enabled) {
      missing.push(`provider:${binding.provider}:disabled`);
      modelId = null;
    }
    const state = {
      model: modelId,
      provider: modelId && provider ? provider.id : null,
    };
    bound[tier] =
      modelId && missing.length === 0
        ? { kind: "ok", state }
        : { kind: "error", state, missing };
  }

  const fallbackOrder = [
    alias,
    DEFAULT_MODEL_ALIAS,
    ...MODEL_TIERS.filter(
      (tier) => tier !== alias && tier !== DEFAULT_MODEL_ALIAS,
    ),
  ];
  const states = {} as Record<ModelTier, TierState>;
  const sources = {} as Record<ModelTier, ModelTierSource>;
  for (const tier of MODEL_TIERS) {
    const own = bound[tier];
    if (own.kind !== "unbound") {
      states[tier] = own.state;
      sources[tier] = "bound";
      continue;
    }
    const fallback = fallbackOrder
      .map((candidate) => bound[candidate])
      .find(
        (candidate): candidate is { kind: "ok"; state: TierState } =>
          candidate.kind === "ok",
      );
    states[tier] = fallback?.state ?? { model: null, provider: null };
    sources[tier] = fallback ? "fallback" : "unbound";
  }

  const activeState = states[alias];
  const activeProvider = activeState.provider
    ? providers.get(activeState.provider)
    : undefined;
  const activeCredential = activeState.provider
    ? credentials.get(activeState.provider)
    : undefined;
  const missing: string[] = [];
  const own = bound[alias];
  if (own.kind === "error") missing.push(...own.missing);
  if (!activeState.model) missing.push(`model:${alias}`);
  if (activeCredential && !activeCredential.baseUrl) {
    missing.push("baseUrl");
    if (activeCredential.baseUrlEnv)
      missing.push(`baseUrlEnv:${activeCredential.baseUrlEnv}`);
  }
  if (activeCredential && !activeCredential.apiKey)
    missing.push(`apiKey:${activeCredential.apiKeyEnv}`);
  if (activeState.provider && !activeProvider)
    missing.push(`provider:${activeState.provider}:not_found`);

  const configured = Boolean(
    activeState.model && activeProvider?.enabled && activeCredential?.baseUrl && activeCredential?.apiKey,
  );
  let error: string | null = null;
  if (!activeState.model) {
    // A disabled provider nulls the tier state; keep the more specific reason.
    error =
      own.kind === "error" &&
      own.missing.some(
        (item) => item.startsWith("provider:") && item.endsWith(":disabled"),
      )
        ? "provider_disabled"
        : "model_not_resolved";
  } else if (!activeProvider) error = "provider_not_found";
  else if (!activeProvider.enabled) error = "provider_disabled";
  else if (!activeCredential?.baseUrl) error = "base_url_missing";
  else if (!activeCredential.apiKey) error = "credential_missing";

  if (!configured) {
    return {
      metadata: metadata({
        alias,
        profile: profileId,
        states,
        sources,
        configured: false,
        missing: [...new Set(missing)],
        error,
        revision,
        now,
      }),
      config: placeholderConfig(alias),
    };
  }

  const used: string[] = [];
  for (const tier of MODEL_TIERS) {
    const providerId = states[tier].provider;
    if (providerId && !used.includes(providerId)) used.push(providerId);
  }
  const activeProviderId = activeState.provider ?? used[0]!;
  return {
    metadata: metadata({
      alias,
      profile: profileId,
      states,
      sources,
      configured: true,
      missing: [],
      error: null,
      revision,
      now,
    }),
    config: {
      active_alias: alias,
      providers: used.map((id) => {
        const provider = providers.get(id)!;
        const secret = credentials.get(id)!;
        return {
          id,
          type: provider.type,
          apiKey: secret.apiKey ?? MODEL_API_KEY_PLACEHOLDER,
          baseUrl: secret.baseUrl ?? MODEL_PLACEHOLDER_BASE_URL,
        };
      }),
      profiles: Object.fromEntries(
        MODEL_TIERS.map((tier) => [
          tier,
          {
            provider: states[tier].provider ?? activeProviderId,
            model: states[tier].model ?? UNCONFIGURED_MODEL,
          },
        ]),
      ) as Record<ModelTier, { provider: string; model: string }>,
    },
  };
}

export type PublicModelLibraryTier = {
  tier: ModelTier;
  bound: boolean;
  provider: string | null;
  providerType: "openai" | "anthropic" | null;
  label: string | null;
  model: string | null;
  modelEnv: string | null;
  modelConfigured: boolean;
  providerEnabled: boolean;
  endpointConfigured: boolean;
  credentialConfigured: boolean;
  missing: string[];
  ready: boolean;
};

export type PublicModelLibraryProvider = {
  id: string;
  type: "openai" | "anthropic";
  label: string | null;
  enabled: boolean;
  baseUrlEnv: string;
  apiKeyEnv: string;
  endpointConfigured: boolean;
  credentialConfigured: boolean;
};

export type PublicModelLibrary = {
  status: ModelLibraryStatus;
  error: string | null;
  issues: string[];
  path: string;
  version: number | null;
  activeProfile: string | null;
  revision: string | null;
  profiles: Array<{
    id: string;
    label: string | null;
    activeAlias: ModelTier;
    enabled: boolean;
    /** Always expands to all four tiers; absent bindings are `bound: false`. */
    tiers: PublicModelLibraryTier[];
  }>;
  providers: PublicModelLibraryProvider[];
};

function publicTier(input: {
  tier: ModelTier;
  binding: ModelLibraryTierBinding | undefined;
  providers: Map<string, ModelLibraryProvider>;
  credentials: Map<string, Credential>;
  environment: Record<string, string | undefined>;
}): PublicModelLibraryTier {
  const { tier, binding } = input;
  if (!binding)
    return {
      tier,
      bound: false,
      provider: null,
      providerType: null,
      label: null,
      model: null,
      modelEnv: null,
      modelConfigured: false,
      providerEnabled: false,
      endpointConfigured: false,
      credentialConfigured: false,
      missing: [`tier:${tier}:unbound`],
      ready: false,
    };
  const provider = input.providers.get(binding.provider);
  const secret = input.credentials.get(binding.provider);
  const model = binding.model ?? null;
  const modelEnv = binding.modelEnv ?? null;
  const resolved =
    model ?? (modelEnv ? text(input.environment[modelEnv]) : undefined);
  const modelConfigured = Boolean(binding.enabled && resolved);
  const providerEnabled = Boolean(provider?.enabled);
  const endpointConfigured = Boolean(secret?.baseUrl);
  const credentialConfigured = Boolean(secret?.apiKey);
  const missing: string[] = [];
  if (!binding.enabled) missing.push(`tier:${tier}:disabled`);
  if (!modelConfigured)
    missing.push(modelEnv ? `modelEnv:${modelEnv}` : `model:${tier}`);
  if (!provider) missing.push(`provider:${binding.provider}:not_found`);
  else if (!provider.enabled)
    missing.push(`provider:${binding.provider}:disabled`);
  if (!endpointConfigured) {
    missing.push("baseUrl");
    if (secret) missing.push(`baseUrlEnv:${secret.baseUrlEnv}`);
  }
  if (!credentialConfigured)
    missing.push(`apiKey:${secret?.apiKeyEnv ?? binding.provider}`);
  return {
    tier,
    bound: true,
    provider: binding.provider,
    providerType: provider?.type ?? null,
    label: binding.label ?? null,
    // Only the literal library value is exposed; env-resolved IDs stay host-only.
    model,
    modelEnv,
    modelConfigured,
    providerEnabled,
    endpointConfigured,
    credentialConfigured,
    missing,
    ready: Boolean(
      modelConfigured &&
        provider &&
        provider.enabled &&
        endpointConfigured &&
        credentialConfigured,
    ),
  };
}

/** Browser-safe projection: no endpoint, credential, or environment values. */
export function publicModelLibraryView(
  state: ModelLibraryState,
  environment: Record<string, string | undefined> = {},
): PublicModelLibrary {
  if (state.status !== "ok" || !state.library)
    return {
      status: state.status,
      error: state.error,
      issues: state.issues,
      path: state.path,
      version: null,
      activeProfile: null,
      revision: null,
      profiles: [],
      providers: [],
    };
  const library = state.library;
  const providers = new Map<string, ModelLibraryProvider>(
    Object.entries(library.providers).map(([id, provider]) => [
      id,
      { id, ...provider },
    ]),
  );
  const credentials = new Map<string, Credential>();
  for (const [id, provider] of providers)
    credentials.set(id, credential(id, provider, environment));
  return {
    status: state.status,
    error: null,
    issues: [],
    path: state.path,
    version: library.version,
    activeProfile: library.activeProfile,
    revision: state.revision,
    profiles: Object.entries(library.profiles).map(([id, profile]) => ({
      id,
      label: profile.label ?? null,
      activeAlias: profile.activeAlias,
      enabled: profile.enabled,
      tiers: MODEL_TIERS.map((tier) =>
        publicTier({
          tier,
          binding: profile.tiers[tier],
          providers,
          credentials,
          environment,
        }),
      ),
    })),
    providers: [...providers.values()].map((provider) => {
      const secret = credentials.get(provider.id)!;
      return {
        id: provider.id,
        type: provider.type,
        label: provider.label ?? null,
        enabled: provider.enabled,
        baseUrlEnv: secret.baseUrlEnv,
        apiKeyEnv: secret.apiKeyEnv,
        endpointConfigured: Boolean(secret.baseUrl),
        credentialConfigured: Boolean(secret.apiKey),
      };
    }),
  };
}
