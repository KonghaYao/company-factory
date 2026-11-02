import { describe, expect, test } from "bun:test";
import {
  appliedTierRows,
  libraryProfile,
  libraryStatusHint,
  libraryStatusLabel,
  libraryStatusTone,
  libraryTierRows,
  modelErrorLabel,
  modelMissingLabel,
  modelRevisionMismatch,
  shortRevision,
  tierSourceLabel,
} from "./model";
import type { ModelLibraryProfileView } from "./types";

// Keep this list aligned with the codes emitted by src/runtime/model-library.ts.
const BACKEND_CODES = [
  "library_missing",
  "library_unreadable",
  "library_insecure",
  "library_invalid",
  "library_invalid_yaml",
  "library_empty",
  "library_schema_invalid",
  "library_version_unsupported",
  "library_symlink",
  "library_hardlink",
  "library_permissions",
  "library_owner_mismatch",
  "library_not_regular",
  "library_path_forbidden",
  "library_path_not_absolute",
  "profile_not_found",
  "profile_disabled",
  "default_profile_missing",
  "model_not_resolved",
  "provider_not_found",
  "provider_disabled",
  "base_url_missing",
  "credential_missing",
];

describe("model diagnostics", () => {
  test("labels every backend code without echoing a value", () => {
    for (const code of BACKEND_CODES) {
      const label = modelErrorLabel(code);
      expect(label).not.toContain(code);
      expect(label).not.toMatch(/https?:\/\//);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(modelErrorLabel("library_unreadable")).toContain("无法读取");
    expect(modelErrorLabel("profile_disabled")).toContain("已禁用");
    expect(modelErrorLabel("provider_disabled")).toContain("已禁用");
  });

  test("revision mismatch only fires when both revisions differ", () => {
    expect(modelRevisionMismatch("a".repeat(64), "b".repeat(64))).toBe(true);
    expect(modelRevisionMismatch("a".repeat(64), "a".repeat(64))).toBe(false);
    expect(modelRevisionMismatch("a".repeat(64), null)).toBe(false);
    expect(modelRevisionMismatch(null, "b".repeat(64))).toBe(false);
    expect(shortRevision("c9034aa734d3ffff")).toBe("c9034aa734d3");
  });

  test("v1 libraries point at the v2 schema without echoing content", () => {
    const label = modelErrorLabel("library_version_unsupported");
    expect(label).toContain("version 2");
    expect(label).not.toContain("library_version_unsupported");
  });

  test("tier diagnostics keep names only", () => {
    expect(modelMissingLabel("tier:sonnet:unbound")).toBe("档位 sonnet 未绑定");
    expect(modelMissingLabel("tier:opus:disabled")).toBe("档位 opus 已禁用");
    expect(modelMissingLabel("modelEnv:OPENAI_SONNET_MODEL")).toContain(
      "OPENAI_SONNET_MODEL",
    );
    expect(modelMissingLabel("apiKey:OPENAI_API_KEY")).not.toContain("sk-");
  });

  test("library status labels, tones and repair hints", () => {
    expect(libraryStatusLabel("ok")).toBe("可用");
    expect(libraryStatusLabel("missing")).toBe("文件缺失");
    expect(libraryStatusLabel("insecure")).toBe("文件不安全");
    expect(libraryStatusLabel("invalid")).toBe("文件无效");
    expect(libraryStatusTone("ok")).toBe("positive");
    expect(libraryStatusTone("missing")).toBe("warning");
    expect(libraryStatusTone("invalid")).toBe("danger");
    for (const status of ["ok", "missing", "insecure", "invalid"] as const) {
      const hint = libraryStatusHint(status);
      expect(hint.length).toBeGreaterThan(0);
      expect(hint).not.toMatch(/https?:\/\//);
    }
    expect(tierSourceLabel("bound")).toBe("绑定");
    expect(tierSourceLabel("fallback")).toBe("回退");
    expect(tierSourceLabel("unbound")).toBe("未绑定");
  });
});

const profile: ModelLibraryProfileView = {
  id: "default",
  label: "默认",
  activeAlias: "sonnet",
  enabled: true,
  tiers: [
    {
      tier: "fable",
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
      missing: ["tier:fable:unbound"],
      ready: false,
    },
    {
      tier: "opus",
      bound: true,
      provider: "host",
      providerType: "openai",
      label: null,
      model: null,
      modelEnv: "OPENAI_OPUS_MODEL",
      modelConfigured: true,
      providerEnabled: true,
      endpointConfigured: true,
      credentialConfigured: true,
      missing: [],
      ready: true,
    },
    {
      tier: "sonnet",
      bound: true,
      provider: "host",
      providerType: "openai",
      label: null,
      model: "sonnet-literal",
      modelEnv: null,
      modelConfigured: true,
      providerEnabled: true,
      endpointConfigured: true,
      credentialConfigured: true,
      missing: [],
      ready: true,
    },
    {
      tier: "haiku",
      bound: true,
      provider: "host",
      providerType: "openai",
      label: null,
      model: null,
      modelEnv: "MISSING_HAIKU",
      modelConfigured: false,
      providerEnabled: true,
      endpointConfigured: true,
      credentialConfigured: false,
      missing: ["modelEnv:MISSING_HAIKU", "apiKey:OPENAI_API_KEY"],
      ready: false,
    },
  ],
};

describe("tier rows", () => {
  test("library rows expose source kind and active alias without values", () => {
    const rows = libraryTierRows(profile);
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.tier === "sonnet")?.active).toBe(true);
    expect(rows.find((row) => row.tier === "sonnet")?.modelSource).toBe("model");
    expect(rows.find((row) => row.tier === "opus")?.modelSource).toBe("modelEnv");
    expect(rows.find((row) => row.tier === "opus")?.modelEnv).toBe(
      "OPENAI_OPUS_MODEL",
    );
    expect(rows.find((row) => row.tier === "fable")?.source).toBe("unbound");
    expect(rows.find((row) => row.tier === "fable")?.ready).toBe(false);
    expect(rows.find((row) => row.tier === "haiku")?.credentialConfigured).toBe(
      false,
    );
    for (const row of rows) expect(row.appliedModel).toBeNull();
    const rendered = JSON.stringify(rows);
    expect(rendered).not.toContain("sk-");
    expect(rendered).not.toMatch(/https?:\/\//);
  });

  test("applied rows require v2 tier detail and mark the active alias", () => {
    expect(appliedTierRows(undefined)).toBeNull();
    expect(appliedTierRows({ modelTiers: null })).toBeNull();
    const rows = appliedTierRows({
      modelAlias: "haiku",
      modelTiers: {
        fable: "a",
        opus: "b",
        sonnet: "c",
        haiku: "d",
      },
      modelTierProviders: {
        fable: "host",
        opus: "host",
        sonnet: "host",
        haiku: null,
      },
      modelTierSources: {
        fable: "fallback",
        opus: "bound",
        sonnet: "bound",
        haiku: "unbound",
      },
    })!;
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.active)).toHaveLength(1);
    expect(rows.find((row) => row.tier === "haiku")?.active).toBe(true);
    expect(rows.find((row) => row.tier === "haiku")?.source).toBe("unbound");
    expect(rows.find((row) => row.tier === "fable")?.source).toBe("fallback");
    expect(rows.find((row) => row.tier === "opus")?.bound).toBe(true);
    expect(rows.find((row) => row.tier === "fable")?.appliedModel).toBe("a");
    expect(rows.find((row) => row.tier === "opus")?.appliedModel).toBe("b");
    expect(rows.find((row) => row.tier === "sonnet")?.appliedModel).toBe("c");
    expect(rows.find((row) => row.tier === "haiku")?.appliedModel).toBe("d");
    const rendered = JSON.stringify(rows);
    expect(rendered).not.toContain("sk-");
    expect(rendered).not.toMatch(/https?:\/\//);
  });

  test("libraryProfile finds only known profiles", () => {
    const library = {
      status: "ok" as const,
      error: null,
      issues: [],
      path: "/tmp/model-library.yaml",
      version: 2,
      activeProfile: "default",
      revision: "a".repeat(64),
      profiles: [profile],
      providers: [],
    };
    expect(libraryProfile(library, "default")?.id).toBe("default");
    expect(libraryProfile(library, "missing")).toBeUndefined();
    expect(libraryProfile(undefined, "default")).toBeUndefined();
  });
});
