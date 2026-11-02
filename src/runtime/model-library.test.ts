import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModelLibrary,
  modelLibrarySchema,
  publicModelLibraryView,
  resolveModel,
} from "./model-library";
import { ModelConfigurationError, modelInfoFromSettings } from "./model-settings";

const roots: string[] = [];
async function root() {
  const value = await mkdtemp(join(tmpdir(), "company-model-library-"));
  roots.push(value);
  return value;
}
async function writeLibrary(
  base: string,
  body: string,
  mode = 0o600,
  name = "model-library.yaml",
) {
  const path = join(base, name);
  await writeFile(path, body, { mode });
  await chmod(path, mode);
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

const library = (options: {
  providers?: string;
  profiles?: string;
  activeProfile?: string;
  version?: number;
} = {}) => `version: ${options.version ?? 2}
activeProfile: ${options.activeProfile ?? "default"}
providers:
${options.providers ?? `  host-openai:
    type: openai
    baseUrlEnv: TEST_BASE_URL
    apiKeyEnv: TEST_API_KEY`}
profiles:
${options.profiles ?? `  default:
    label: Default profile
    activeAlias: sonnet
    tiers:
      sonnet:
        provider: host-openai
        modelEnv: TEST_SONNET_MODEL
      opus:
        provider: host-openai
        modelEnv: TEST_OPUS_MODEL`}
`;

const environment = {
  TEST_BASE_URL: "https://endpoint.invalid/v1",
  TEST_API_KEY: "secret-key-value",
  TEST_SONNET_MODEL: "sonnet-model-id",
  TEST_OPUS_MODEL: "opus-model-id",
};

const v2 = (options: {
  providers?: Record<string, unknown>;
  profiles?: Record<string, unknown>;
  activeProfile?: string;
} = {}) => ({
  version: 2,
  activeProfile: options.activeProfile ?? "default",
  providers: options.providers ?? {
    "host-openai": {
      type: "openai",
      baseUrlEnv: "TEST_BASE_URL",
      apiKeyEnv: "TEST_API_KEY",
    },
  },
  profiles: options.profiles ?? {
    default: {
      activeAlias: "sonnet",
      tiers: {
        sonnet: { provider: "host-openai", modelEnv: "TEST_SONNET_MODEL" },
      },
    },
  },
});

describe("model library v2 schema", () => {
  test("accepts a valid nested profile → provider → tier library", () => {
    const parsed = modelLibrarySchema.safeParse(
      v2({
        profiles: {
          default: {
            activeAlias: "sonnet",
            tiers: {
              fable: {
                provider: "host-openai",
                modelEnv: "TEST_OPUS_MODEL",
                label: "shared opus model",
              },
              opus: { provider: "host-openai", modelEnv: "TEST_OPUS_MODEL" },
              sonnet: {
                provider: "host-openai",
                modelEnv: "TEST_SONNET_MODEL",
              },
              haiku: { provider: "host-openai", model: "haiku-literal" },
            },
          },
        },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  test("rejects unknown top-level fields, including pasted credentials", () => {
    const parsed = modelLibrarySchema.safeParse({
      ...v2(),
      apiKey: "sk-this-must-never-be-accepted",
      models: [],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(JSON.stringify(parsed.error.issues)).not.toContain("sk-this");
  });

  test("rejects a literal baseUrl and any provider credential value", () => {
    for (const provider of [
      {
        type: "openai",
        baseUrl: "https://literal.invalid/v1",
        apiKeyEnv: "TEST_API_KEY",
      },
      { type: "openai", apiKey: "sk-leaked-value" },
      { type: "openai", baseUrlEnv: "not a name" },
      { type: "azure" },
    ]) {
      const parsed = modelLibrarySchema.safeParse(
        v2({
          providers: { p: provider },
          profiles: {
            default: {
              activeAlias: "sonnet",
              tiers: {
                sonnet: { provider: "p", modelEnv: "TEST_SONNET_MODEL" },
              },
            },
          },
        }),
      );
      expect(parsed.success).toBe(false);
    }
  });

  test("requires tier provider and exactly one of model or modelEnv", () => {
    for (const tier of [
      { modelEnv: "TEST_SONNET_MODEL" },
      { provider: "host-openai" },
      {
        provider: "host-openai",
        model: "literal",
        modelEnv: "TEST_SONNET_MODEL",
      },
      { provider: "host-openai", model: "   " },
    ]) {
      const parsed = modelLibrarySchema.safeParse(
        v2({
          profiles: {
            default: { activeAlias: "sonnet", tiers: { sonnet: tier } },
          },
        }),
      );
      expect(parsed.success).toBe(false);
    }
  });

  test("rejects unknown activeProfile and tier provider references", () => {
    expect(
      modelLibrarySchema.safeParse(v2({ activeProfile: "missing" })).success,
    ).toBe(false);
    expect(
      modelLibrarySchema.safeParse(
        v2({
          profiles: {
            default: {
              activeAlias: "sonnet",
              tiers: {
                sonnet: {
                  provider: "missing-provider",
                  modelEnv: "TEST_SONNET_MODEL",
                },
              },
            },
          },
        }),
      ).success,
    ).toBe(false);
  });

  test("rejects unknown tier names and profile fields", () => {
    expect(
      modelLibrarySchema.safeParse(
        v2({
          profiles: {
            default: {
              activeAlias: "sonnet",
              tiers: {
                turbo: {
                  provider: "host-openai",
                  modelEnv: "TEST_SONNET_MODEL",
                },
              },
            },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      modelLibrarySchema.safeParse(
        v2({
          profiles: {
            default: {
              activeAlias: "sonnet",
              bindings: { sonnet: "m" },
              tiers: {},
            },
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("model library loading safety", () => {
  test("v1 files are explicitly unsupported, never guessed-migrated", async () => {
    const base = await root();
    await writeLibrary(
      base,
      `version: 1
activeProfile: default
providers:
  - id: host-openai
    type: openai
profiles:
  - id: default
    activeAlias: sonnet
    bindings: {}
`,
    );
    expect(loadModelLibrary({ root: base, environment })).toMatchObject({
      status: "invalid",
      error: "library_version_unsupported",
      revision: null,
    });

    await writeLibrary(
      base,
      `activeProfile: default
providers: []
models: []
profiles: []
`,
    );
    expect(loadModelLibrary({ root: base, environment })).toMatchObject({
      status: "invalid",
      error: "library_version_unsupported",
    });
  });

  test("missing file is an explicit state, not a crash", async () => {
    const base = await root();
    expect(loadModelLibrary({ root: base, environment: {} })).toMatchObject({
      status: "missing",
      error: "library_missing",
    });
  });

  test("requires 0600 and rejects symlinks, hardlinks and foreign owners", async () => {
    const base = await root();
    await writeLibrary(base, library(), 0o644);
    expect(loadModelLibrary({ root: base, environment: {} })).toMatchObject({
      status: "insecure",
      error: "library_permissions",
    });

    await chmod(join(base, "model-library.yaml"), 0o600);
    const target = join(base, "target.yaml");
    await writeLibrary(base, library(), 0o600, "target.yaml");
    await writeLibrary(base, library(), 0o600, "library-link.yaml");
    await rm(join(base, "library-link.yaml"));
    await symlink(target, join(base, "library-link.yaml"));
    expect(
      loadModelLibrary({
        root: base,
        environment: {},
        overridePath: join(base, "library-link.yaml"),
      }),
    ).toMatchObject({ status: "insecure", error: "library_symlink" });

    const linked = join(base, "library-linked.yaml");
    await link(join(base, "model-library.yaml"), linked);
    expect(
      loadModelLibrary({
        root: base,
        environment: {},
        overridePath: linked,
      }),
    ).toMatchObject({ status: "insecure", error: "library_hardlink" });

    if (typeof process.getuid !== "function") return;
    const ownerBase = await root();
    await writeLibrary(ownerBase, library(), 0o600);
    const original = process.getuid;
    (process as any).getuid = () => (original() === 0 ? 1 : 0);
    try {
      expect(
        loadModelLibrary({ root: ownerBase, environment: {} }),
      ).toMatchObject({
        status: "insecure",
        error: "library_owner_mismatch",
      });
    } finally {
      (process as any).getuid = original;
    }
  });

  test("rejects override paths inside agents/companys/runtime workspace and relative paths", async () => {
    const base = await root();
    await mkdir(join(base, "agents", "dev"), { recursive: true });
    const forbidden = await writeLibrary(
      join(base, "agents", "dev"),
      library(),
      0o600,
    );
    expect(
      loadModelLibrary({
        root: base,
        environment: { COMPANY_MODEL_LIBRARY: forbidden },
      }),
    ).toMatchObject({ status: "insecure", error: "library_path_forbidden" });
    expect(
      loadModelLibrary({
        root: base,
        environment: { COMPANY_MODEL_LIBRARY: "relative/model-library.yaml" },
      }),
    ).toMatchObject({
      status: "insecure",
      error: "library_path_not_absolute",
    });
  });

  test("malformed YAML reports only yaml:line:col", async () => {
    const base = await root();
    await writeLibrary(base, "version: 2\nproviders: [\n");
    const state = loadModelLibrary({ root: base, environment });
    expect(state.status).toBe("invalid");
    expect(state.error).toBe("library_invalid_yaml");
    expect(state.issues[0]).toMatch(/^yaml:\d+:\d+$/);
  });

  test("schema errors are path:code only and never echo rejected values", async () => {
    const base = await root();
    await writeLibrary(
      base,
      library({
        providers: `  host-openai:
    type: openai
    apiKey: sk-leaked-value`,
      }),
    );
    const state = loadModelLibrary({ root: base, environment });
    expect(state.status).toBe("invalid");
    expect(state.error).toBe("library_schema_invalid");
    expect(state.issues.length).toBeGreaterThan(0);
    for (const issue of state.issues) expect(issue).toMatch(/^[^:]+:\w+$/);
    expect(JSON.stringify(state)).not.toContain("sk-leaked-value");
  });
});

describe("profile resolution", () => {
  test("resolves the active profile and expands all four tiers with sources", async () => {
    const base = await root();
    await writeLibrary(base, library());
    const state = loadModelLibrary({ root: base, environment });
    const resolved = resolveModel({ config: {}, library: state, environment });
    expect(resolved.metadata).toMatchObject({
      source: "profile",
      profile: "default",
      activeAlias: "sonnet",
      provider: "host-openai",
      model: "sonnet-model-id",
      configured: true,
      error: null,
      libraryRevision: state.revision,
    });
    expect(resolved.metadata.tiers).toEqual({
      fable: "sonnet-model-id",
      opus: "opus-model-id",
      sonnet: "sonnet-model-id",
      haiku: "sonnet-model-id",
    });
    expect(resolved.metadata.tierSources).toEqual({
      fable: "fallback",
      opus: "bound",
      sonnet: "bound",
      haiku: "fallback",
    });
    expect(resolved.metadata.tierProviders).toEqual({
      fable: "host-openai",
      opus: "host-openai",
      sonnet: "host-openai",
      haiku: "host-openai",
    });
    expect(resolved.config.active_alias).toBe("sonnet");
    expect(resolved.config.profiles.sonnet).toEqual({
      provider: "host-openai",
      model: "sonnet-model-id",
    });
  });

  test("config.modelAlias overrides the profile active alias", async () => {
    const base = await root();
    await writeLibrary(base, library());
    const resolved = resolveModel({
      config: { modelAlias: "opus" },
      library: loadModelLibrary({ root: base, environment }),
      environment,
    });
    expect(resolved.metadata.activeAlias).toBe("opus");
    expect(resolved.metadata.model).toBe("opus-model-id");
    expect(resolved.config.active_alias).toBe("opus");
  });

  test("profile.activeAlias selects the active tier when config.modelAlias is absent", async () => {
    for (const alias of ["opus", "fable"] as const) {
      const base = await root();
      await writeLibrary(
        base,
        library({
          profiles: `  default:
    activeAlias: ${alias}
    tiers:
      ${alias}:
        provider: host-openai
        model: model-${alias}`,
        }),
      );
      const resolved = resolveModel({
        config: {},
        library: loadModelLibrary({ root: base, environment }),
        environment,
      });
      expect(resolved.metadata.activeAlias).toBe(alias);
      expect(resolved.metadata.model).toBe(`model-${alias}`);
      expect(resolved.metadata.tiers[alias]).toBe(`model-${alias}`);
      expect(resolved.config.active_alias).toBe(alias);
    }
  });

  test("explicit profile is authoritative and never falls back when missing or disabled", async () => {
    const base = await root();
    await writeLibrary(base, library());
    const state = loadModelLibrary({ root: base, environment });
    for (const [config, profile] of [
      [{ modelProfile: "missing" }, "missing"],
      [{ modelProfile: "constructor" }, "constructor"],
      [{ modelProfile: "" }, "default"],
    ] as const) {
      const resolved = resolveModel({ config, library: state, environment });
      if (profile === "default") {
        expect(resolved.metadata.profile).toBe("default");
        expect(resolved.metadata.configured).toBe(true);
      } else {
        expect(resolved.metadata.profile).toBe(profile);
        expect(resolved.metadata.configured).toBe(false);
        expect(resolved.metadata.error).toBe("profile_not_found");
        expect(resolved.metadata.model).toBeNull();
        expect(resolved.config.providers[0]!.id).toBe("company-model");
      }
    }

    await writeLibrary(
      base,
      library({
        profiles: `  default:
    enabled: false
    activeAlias: sonnet
    tiers:
      sonnet:
        provider: host-openai
        modelEnv: TEST_SONNET_MODEL`,
      }),
    );
    const disabled = resolveModel({
      config: { modelProfile: "default" },
      library: loadModelLibrary({ root: base, environment }),
      environment,
    });
    expect(disabled.metadata.configured).toBe(false);
    expect(disabled.metadata.error).toBe("profile_disabled");
  });

  test("an invalid alias throws a ModelConfigurationError before resolving", async () => {
    const base = await root();
    await writeLibrary(base, library());
    expect(() =>
      resolveModel({
        config: { modelAlias: "gpt-4" },
        library: loadModelLibrary({ root: base, environment }),
        environment,
      }),
    ).toThrow(ModelConfigurationError);
  });

  test("unconfigured library still yields a Session-safe placeholder", async () => {
    const base = await root();
    const resolved = resolveModel({
      config: {},
      library: loadModelLibrary({ root: base, environment: {} }),
      environment: {},
    });
    expect(resolved.metadata.configured).toBe(false);
    expect(resolved.metadata.error).toBe("library_missing");
    expect(resolved.metadata.tierSources).toEqual({
      fable: "unbound",
      opus: "unbound",
      sonnet: "unbound",
      haiku: "unbound",
    });
    expect(resolved.config.providers).toHaveLength(1);
    expect(resolved.config.providers[0]!.id).toBe("company-model");
    expect(resolved.config.providers[0]!.models?.sonnet).toBe("unconfigured");
  });

  test("missing environment values and disabled providers are diagnosed by name", async () => {
    const base = await root();
    await writeLibrary(
      base,
      library({
        profiles: `  default:
    activeAlias: sonnet
    tiers:
      sonnet:
        provider: host-openai
        modelEnv: MISSING_SONNET_MODEL`,
      }),
    );
    const missingModel = resolveModel({
      config: {},
      library: loadModelLibrary({ root: base, environment }),
      environment,
    });
    expect(missingModel.metadata.configured).toBe(false);
    expect(missingModel.metadata.error).toBe("model_not_resolved");
    expect(missingModel.metadata.missing).toContain(
      "modelEnv:MISSING_SONNET_MODEL",
    );

    await writeLibrary(
      base,
      library({
        providers: `  host-openai:
    type: openai
    enabled: false
    baseUrlEnv: TEST_BASE_URL
    apiKeyEnv: TEST_API_KEY`,
      }),
    );
    const disabled = resolveModel({
      config: {},
      library: loadModelLibrary({ root: base, environment }),
      environment,
    });
    expect(disabled.metadata.configured).toBe(false);
    expect(disabled.metadata.error).toBe("provider_disabled");
    expect(disabled.metadata.missing).toContain(
      "provider:host-openai:disabled",
    );
    expect(JSON.stringify(disabled.metadata)).not.toContain(
      environment.TEST_API_KEY,
    );
    expect(JSON.stringify(disabled.metadata)).not.toContain(
      environment.TEST_BASE_URL,
    );
    expect(disabled.config.providers[0]!.apiKey).toBe(
      "not-configured-no-model-calls",
    );
  });

  test("PeriConfig includes only providers referenced by resolved tiers", async () => {
    const base = await root();
    await writeLibrary(
      base,
      library({
        providers: `  provider-a:
    type: openai
    baseUrlEnv: TEST_BASE_URL
    apiKeyEnv: TEST_API_KEY
  provider-b:
    type: anthropic
    baseUrlEnv: TEST_BASE_URL
    apiKeyEnv: TEST_API_KEY
  provider-unused:
    type: openai
    baseUrlEnv: TEST_BASE_URL
    apiKeyEnv: TEST_API_KEY`,
        profiles: `  default:
    activeAlias: sonnet
    tiers:
      opus:
        provider: provider-b
        model: model-b
      sonnet:
        provider: provider-a
        model: model-a`,
      }),
    );
    const resolved = resolveModel({
      config: {},
      library: loadModelLibrary({ root: base, environment }),
      environment,
    });
    expect(resolved.metadata.configured).toBe(true);
    expect(resolved.config.providers.map((item) => item.id)).toEqual([
      "provider-a",
      "provider-b",
    ]);
    expect(resolved.config.profiles.opus).toEqual({
      provider: "provider-b",
      model: "model-b",
    });
    expect(JSON.stringify(resolved.metadata)).not.toContain(
      environment.TEST_API_KEY,
    );
    expect(JSON.stringify(resolved.metadata)).not.toContain(
      environment.TEST_BASE_URL,
    );
  });
});

describe("public model library projection", () => {
  test("expands four tiers and exposes booleans without values", async () => {
    const base = await root();
    await writeLibrary(base, library());
    const state = loadModelLibrary({ root: base, environment });
    const view = publicModelLibraryView(state, environment);
    expect(view).toMatchObject({
      status: "ok",
      version: 2,
      activeProfile: "default",
      path: state.path,
      revision: state.revision,
    });
    expect(view.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(view.providers[0]).toMatchObject({
      id: "host-openai",
      endpointConfigured: true,
      credentialConfigured: true,
      baseUrlEnv: "TEST_BASE_URL",
      apiKeyEnv: "TEST_API_KEY",
    });
    const profile = view.profiles[0]!;
    expect(profile.tiers.map((tier) => tier.tier)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(profile.tiers.find((tier) => tier.tier === "sonnet")).toMatchObject({
      bound: true,
      provider: "host-openai",
      providerType: "openai",
      modelEnv: "TEST_SONNET_MODEL",
      modelConfigured: true,
      providerEnabled: true,
      endpointConfigured: true,
      credentialConfigured: true,
      missing: [],
      ready: true,
    });
    expect(profile.tiers.find((tier) => tier.tier === "haiku")).toMatchObject({
      bound: false,
      provider: null,
      modelConfigured: false,
      ready: false,
    });
    expect("models" in view).toBe(false);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(environment.TEST_API_KEY);
    expect(serialized).not.toContain(environment.TEST_BASE_URL);
    expect(serialized).not.toContain(environment.TEST_SONNET_MODEL);
    expect(serialized).not.toContain('"baseUrl"');
    expect(serialized).not.toContain('"apiKey"');
  });

  test("reports missing env names and disabled providers per tier", async () => {
    const base = await root();
    await writeLibrary(
      base,
      library({
        providers: `  host-openai:
    type: openai
    enabled: false
    baseUrlEnv: TEST_BASE_URL
    apiKeyEnv: TEST_API_KEY`,
        profiles: `  default:
    activeAlias: sonnet
    tiers:
      sonnet:
        provider: host-openai
        modelEnv: MISSING_SONNET_MODEL`,
      }),
    );
    const view = publicModelLibraryView(
      loadModelLibrary({ root: base, environment }),
      { ...environment, TEST_API_KEY: undefined },
    );
    const sonnet = view.profiles[0]!.tiers.find(
      (tier) => tier.tier === "sonnet",
    )!;
    expect(sonnet).toMatchObject({
      bound: true,
      providerEnabled: false,
      modelConfigured: false,
      ready: false,
    });
    expect(sonnet.missing).toContain("modelEnv:MISSING_SONNET_MODEL");
    expect(sonnet.missing).toContain("provider:host-openai:disabled");
    expect(sonnet.missing).toContain("apiKey:TEST_API_KEY");
  });

  test("literal model values are exposed but environment values never are", async () => {
    const base = await root();
    await writeLibrary(
      base,
      library({
        profiles: `  default:
    activeAlias: sonnet
    tiers:
      sonnet:
        provider: host-openai
        model: literal-model-id
        label: Literal`,
      }),
    );
    const view = publicModelLibraryView(
      loadModelLibrary({ root: base, environment }),
      environment,
    );
    expect(view.profiles[0]!.tiers.find((t) => t.tier === "sonnet")).toMatchObject(
      {
        model: "literal-model-id",
        modelEnv: null,
        modelConfigured: true,
        ready: true,
      },
    );
  });

  test("invalid states keep path/status/error without value leakage", async () => {
    const base = await root();
    const path = await writeLibrary(base, library(), 0o600);
    const state = loadModelLibrary({ root: base, environment });
    expect(state.status).toBe("ok");
    const view = publicModelLibraryView(
      { ...state, status: "invalid", error: "library_schema_invalid", library: null },
      environment,
    );
    expect(view).toMatchObject({
      status: "invalid",
      error: "library_schema_invalid",
      version: null,
      activeProfile: null,
      revision: null,
      profiles: [],
      providers: [],
      path,
    });
  });
});

describe("snapshot model info", () => {
  test("reads the current per-tier profile model and the legacy provider form", () => {
    const current = {
      config: {
        active_alias: "sonnet",
        providers: [{ id: "p", models: { sonnet: "provider-model" } }],
        profiles: { sonnet: { provider: "p", model: "profile-model" } },
      },
    };
    expect(modelInfoFromSettings(current)).toEqual({
      modelAlias: "sonnet",
      model: "profile-model",
    });
    const legacy = {
      config: {
        active_alias: "sonnet",
        providers: [{ id: "p", models: { sonnet: "provider-model" } }],
      },
    };
    expect(modelInfoFromSettings(legacy)).toEqual({
      modelAlias: "sonnet",
      model: "provider-model",
    });
    expect(modelInfoFromSettings({})).toEqual({ modelAlias: null, model: null });
  });
});
