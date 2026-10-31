import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL_ALIAS,
  MODEL_PLACEHOLDER_BASE_URL,
  MODEL_TIERS,
  ModelConfigurationError,
  buildModelConfig,
  modelInfoFromSettings,
  resolveModelMatrix,
  resolveTrustedModelMatrix,
} from "./model-settings";

const credentials = {
  PERI_MODEL_API_KEY: "test-key-not-a-real-secret",
  PERI_MODEL_BASE_URL: `https://example.invalid/v1`,
};

describe("four-tier model settings", () => {
  test("a single PERI_MODEL_ID resolves all tiers and keeps sonnet active", () => {
    const matrix = resolveModelMatrix({
      config: {},
      environment: {
        ...credentials,
        PERI_MODEL_ID: "base-model",
      },
    });
    expect(matrix.activeAlias).toBe(DEFAULT_MODEL_ALIAS);
    expect(matrix.tiers).toEqual({
      fable: "base-model",
      opus: "base-model",
      sonnet: "base-model",
      haiku: "base-model",
    });
    expect(matrix.configured).toBe(true);
    expect(matrix.missing).toEqual([]);
  });

  test("four tier environment variables map to four provider models with no model copy in profiles", () => {
    const matrix = resolveModelMatrix({
      config: {},
      environment: {
        ...credentials,
        PERI_MODEL_ID: "base-model",
        PERI_MODEL_ID_FABLE: "fable-model",
        PERI_MODEL_ID_OPUS: "opus-model",
        PERI_MODEL_ID_SONNET: "sonnet-model",
        PERI_MODEL_ID_HAIKU: "haiku-model",
      },
    });
    expect(matrix.tiers).toEqual({
      fable: "fable-model",
      opus: "opus-model",
      sonnet: "sonnet-model",
      haiku: "haiku-model",
    });
    expect(matrix.activeAlias).toBe("sonnet");

    const settings = buildModelConfig(matrix);
    expect(settings.active_alias).toBe("sonnet");
    expect(Object.keys(settings.providers[0]!.models).sort()).toEqual(
      [...MODEL_TIERS].sort(),
    );
    expect(settings.providers[0]!.models).toEqual({
      fable: "fable-model",
      opus: "opus-model",
      sonnet: "sonnet-model",
      haiku: "haiku-model",
    });
    expect(Object.keys(settings.profiles).sort()).toEqual([...MODEL_TIERS].sort());
    for (const tier of MODEL_TIERS)
      expect(settings.profiles[tier]).toEqual({ provider: "company-model" });
  });

  test("missing tiers fall back to the legacy base model", () => {
    const matrix = resolveModelMatrix({
      config: {},
      environment: {
        ...credentials,
        PERI_MODEL_ID: "base-model",
        PERI_MODEL_ID_FABLE: "fable-model",
        PERI_MODEL_ID_HAIKU: "haiku-model",
      },
    });
    expect(matrix.tiers).toEqual({
      fable: "fable-model",
      opus: "base-model",
      sonnet: "base-model",
      haiku: "haiku-model",
    });
  });

  test("modelAlias selects the active tier and its gate", () => {
    const matrix = resolveModelMatrix({
      config: { modelAlias: "fable" },
      environment: {
        ...credentials,
        PERI_MODEL_ID: "base-model",
        PERI_MODEL_ID_FABLE: "fable-model",
      },
    });
    expect(matrix.activeAlias).toBe("fable");
    expect(matrix.tiers.fable).toBe("fable-model");
    expect(buildModelConfig(matrix).active_alias).toBe("fable");
    expect(matrix.configured).toBe(true);
  });

  test("config.models overrides a single tier", () => {
    const matrix = resolveModelMatrix({
      config: { models: { haiku: "haiku-override" } },
      environment: {
        ...credentials,
        PERI_MODEL_ID: "base-model",
        PERI_MODEL_ID_HAIKU: "haiku-env",
      },
    });
    expect(matrix.tiers.haiku).toBe("haiku-override");
    expect(matrix.tiers.sonnet).toBe("base-model");
  });

  test("legacy config.model overrides only the active tier while explicit tier env still applies", () => {
    const matrix = resolveModelMatrix({
      config: { model: "legacy-model" },
      environment: {
        ...credentials,
        PERI_MODEL_ID: "base-model",
        PERI_MODEL_ID_FABLE: "fable-model",
        PERI_MODEL_ID_OPUS: "opus-model",
        PERI_MODEL_ID_SONNET: "sonnet-env",
        PERI_MODEL_ID_HAIKU: "haiku-model",
      },
    });
    expect(matrix.tiers).toEqual({
      fable: "fable-model",
      opus: "opus-model",
      sonnet: "legacy-model",
      haiku: "haiku-model",
    });
  });

  test("legacy config.model does not leak into non-active tiers when a four-tier source exists", () => {
    const partial = resolveModelMatrix({
      config: { model: "legacy-model" },
      environment: {
        ...credentials,
        PERI_MODEL_ID: "base-model",
        PERI_MODEL_ID_FABLE: "fable-model",
      },
    });
    expect(partial.tiers).toEqual({
      fable: "fable-model",
      opus: "base-model",
      sonnet: "legacy-model",
      haiku: "base-model",
    });

    const withoutBase = resolveModelMatrix({
      config: { model: "legacy-model", models: { haiku: "haiku-override" } },
      environment: credentials,
    });
    expect(withoutBase.tiers).toEqual({
      fable: "unconfigured",
      opus: "unconfigured",
      sonnet: "legacy-model",
      haiku: "haiku-override",
    });
    expect(withoutBase.configured).toBe(true);
  });

  test("legacy single-model behavior still fills every tier from config.model", () => {
    const matrix = resolveModelMatrix({
      config: { model: "legacy-model" },
      environment: credentials,
    });
    expect(matrix.tiers).toEqual({
      fable: "legacy-model",
      opus: "legacy-model",
      sonnet: "legacy-model",
      haiku: "legacy-model",
    });
    expect(matrix.configured).toBe(true);
  });

  test("missing apiKey, baseUrl or active model disables configured and reports non-secret diagnostics", () => {
    const noKey = resolveModelMatrix({
      config: {},
      environment: {
        PERI_MODEL_BASE_URL: "https://example.invalid/v1",
        PERI_MODEL_ID: "base-model",
      },
    });
    expect(noKey.configured).toBe(false);
    expect(noKey.missing).toContain("apiKey:PERI_MODEL_API_KEY");

    const noBase = resolveModelMatrix({
      config: {},
      environment: {
        PERI_MODEL_API_KEY: "test-key-not-a-real-secret",
        PERI_MODEL_ID: "base-model",
      },
    });
    expect(noBase.baseUrl).toBe(MODEL_PLACEHOLDER_BASE_URL);
    expect(noBase.configured).toBe(false);
    expect(noBase.missing).toContain("baseUrl");

    const noModel = resolveModelMatrix({ config: {}, environment: credentials });
    expect(noModel.tiers.sonnet).toBe("unconfigured");
    expect(noModel.configured).toBe(false);
    expect(noModel.missing).toContain("model:sonnet");
  });

  test("the active gate ignores a missing non-active tier", () => {
    const matrix = resolveModelMatrix({
      config: { modelAlias: "opus", models: { opus: "opus-model" } },
      environment: {
        ...credentials,
        PERI_MODEL_ID: "base-model",
      },
    });
    expect(matrix.configured).toBe(true);
    expect(matrix.tiers.fable).toBe("base-model");
    expect(matrix.tiers.haiku).toBe("base-model");
  });

  test("unknown PERI_MODEL_ID_* keys are rejected without echoing values", () => {
    const value = "typo-value-must-not-leak";
    let error: unknown;
    try {
      resolveModelMatrix({
        config: {},
        environment: {
          ...credentials,
          PERI_MODEL_ID: "base-model",
          PERI_MODEL_ID_SONNETT: value,
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ModelConfigurationError);
    expect((error as ModelConfigurationError).code).toBe(
      "invalid_model_configuration",
    );
    expect((error as Error).message).toContain("PERI_MODEL_ID_SONNETT");
    expect((error as Error).message).not.toContain(value);
  });

  test("lowercase or mixed-case tier names are rejected instead of silently ignored", () => {
    for (const name of ["PERI_MODEL_ID_fable", "PERI_MODEL_ID_Fable"]) {
      const value = "lowercase-value-must-not-leak";
      let error: unknown;
      try {
        resolveModelMatrix({
          config: {},
          environment: {
            ...credentials,
            PERI_MODEL_ID: "base-model",
            [name]: value,
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ModelConfigurationError);
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).not.toContain(value);
    }
  });

  test("agent-writable environment cannot redirect the trusted host credentials", () => {
    const trusted = {
      PERI_MODEL_API_KEY: "trusted-host-key",
      PERI_MODEL_BASE_URL: "https://trusted-host.invalid/v1",
      PERI_MODEL_PROVIDER: "anthropic",
      PERI_MODEL_ID: "trusted-base-model",
      PERI_MODEL_ID_FABLE: "trusted-fable-model",
    };
    const agentWritable = {
      PERI_MODEL_API_KEY: "attacker-key",
      PERI_MODEL_BASE_URL: "https://attacker.invalid/v1",
      PERI_MODEL_PROVIDER: "openai",
      PERI_MODEL_ID: "attacker-base-model",
      PERI_MODEL_ID_FABLE: "attacker-fable-model",
      PERI_MODEL_ID_SONNETT: "attacker-typo-must-not-leak",
    };
    const matrix = resolveTrustedModelMatrix({
      config: {},
      hostEnvironment: trusted,
      agentEnvironment: agentWritable,
    });
    expect(matrix.baseUrl).toBe(trusted.PERI_MODEL_BASE_URL);
    expect(matrix.apiKey).toBe(trusted.PERI_MODEL_API_KEY);
    expect(matrix.provider).toBe(trusted.PERI_MODEL_PROVIDER);
    expect(matrix.tiers).toEqual({
      fable: "trusted-fable-model",
      opus: "trusted-base-model",
      sonnet: "trusted-base-model",
      haiku: "trusted-base-model",
    });
    const settings = buildModelConfig(matrix);
    expect(settings.providers[0]!.baseUrl).toBe(trusted.PERI_MODEL_BASE_URL);
    expect(settings.providers[0]!.apiKey).toBe(trusted.PERI_MODEL_API_KEY);
  });

  test("a legacy effective-config snapshot keeps three tiers on cold wake without inventing fable", () => {
    const legacySettings = {
      config: {
        active_alias: "sonnet",
        providers: [
          {
            id: "company-model",
            type: "openai",
            apiKey: "snapshot-key",
            baseUrl: "https://snapshot.invalid/v1",
            models: {
              opus: "legacy-opus",
              sonnet: "legacy-sonnet",
              haiku: "legacy-haiku",
            },
          },
        ],
        profiles: {
          opus: { provider: "company-model" },
          sonnet: { provider: "company-model" },
          haiku: { provider: "company-model" },
        },
      },
    };
    const before = JSON.stringify(legacySettings);
    expect(modelInfoFromSettings(legacySettings)).toEqual({
      modelAlias: "sonnet",
      model: "legacy-sonnet",
    });
    // Pure snapshot projection: it must not add fable or mutate the frozen object.
    expect(JSON.stringify(legacySettings)).toBe(before);
    expect(
      Object.keys(legacySettings.config.providers[0]!.models).sort(),
    ).toEqual(["haiku", "opus", "sonnet"]);
  });

  test("four-tier snapshot shape reports the active fable model and not a leaked key", () => {
    const matrix = resolveModelMatrix({
      config: { modelAlias: "fable" },
      environment: {
        ...credentials,
        PERI_MODEL_ID: "base-model",
        PERI_MODEL_ID_FABLE: "fable-model",
      },
    });
    const settings = { config: buildModelConfig(matrix) };
    expect(modelInfoFromSettings(settings)).toEqual({
      modelAlias: "fable",
      model: "fable-model",
    });
    expect(JSON.stringify(modelInfoFromSettings(settings))).not.toContain(
      credentials.PERI_MODEL_API_KEY,
    );
    expect(modelInfoFromSettings({})).toEqual({ modelAlias: null, model: null });
    expect(
      modelInfoFromSettings({
        config: {
          active_alias: "sonnet",
          providers: [{ models: { sonnet: "unconfigured" } }],
        },
      }),
    ).toEqual({ modelAlias: "sonnet", model: null });
  });

  test("unknown config.models tiers and invalid aliases are rejected", () => {
    expect(() =>
      resolveModelMatrix({
        config: { models: { gpt: "unexpected" } },
        environment: credentials,
      }),
    ).toThrow(ModelConfigurationError);
    expect(() =>
      resolveModelMatrix({
        config: { modelAlias: "gpt-4" },
        environment: credentials,
      }),
    ).toThrow(ModelConfigurationError);
  });

  test("config.settings is reserved and never influences the matrix", () => {
    const matrix = resolveModelMatrix({
      config: {
        settings: {
          active_alias: "fable",
          model: "settings-model",
          models: { sonnet: "settings-sonnet" },
          providers: [{ apiKey: "settings-key" }],
        },
      },
      environment: {},
    });
    expect(matrix.activeAlias).toBe("sonnet");
    expect(matrix.tiers).toEqual({
      fable: "unconfigured",
      opus: "unconfigured",
      sonnet: "unconfigured",
      haiku: "unconfigured",
    });
    expect(matrix.configured).toBe(false);
  });

  test("provider and baseUrl precedence keeps config over environment", () => {
    const matrix = resolveModelMatrix({
      config: {
        provider: "anthropic",
        baseUrl: "https://config.invalid/v1",
        apiKeyEnv: "TEST_AGENT_KEY",
        model: "config-model",
      },
      environment: {
        ...credentials,
        PERI_MODEL_PROVIDER: "openai",
        PERI_MODEL_BASE_URL: "https://env.invalid/v1",
        TEST_AGENT_KEY: "agent-key-not-a-real-secret",
      },
    });
    expect(matrix.provider).toBe("anthropic");
    expect(matrix.baseUrl).toBe("https://config.invalid/v1");
    expect(matrix.apiKey).toBe("agent-key-not-a-real-secret");
    expect(matrix.configured).toBe(true);
  });
});
