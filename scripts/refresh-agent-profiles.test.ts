import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshAgentProfiles } from "./refresh-agent-profiles";
import { COMPANY_ASSETS_GUIDANCE, TASK_PROGRESS_GUIDANCE } from "../src/domain/templates";
import { CompanyStore } from "../src/storage/company-store";

const OLD_BLOCK = [
  "<!-- company:profile:start -->",
  "# Company profile (host-managed)",
  "",
  "## Role",
  "developer",
  "",
  "## Role guidance",
  "OLD_GUIDANCE",
  "<!-- company:profile:end -->",
].join("\n");

describe("refresh agent profiles", () => {
  let root: string;
  let agentYaml: string;

  async function agent(agentId: string, companyId: string, memory: string) {
    const directory = join(root, "agents", agentId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "agent.yaml"),
      `agentId: ${agentId}\ncompanyId: ${companyId}\nrole: developer\nname: ${agentId}\nresponsibilities: Build ${agentId}\nsystemPrompt: Verify ${agentId}\nconfig:\n  instructions: Follow ${agentId}\nversion: 7\nconfigVersion: 3\nappliedConfigVersion: 3\n`,
    );
    await writeFile(join(directory, "CLAUDE.md"), memory);
    return directory;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "company-refresh-profiles-"));
    agentYaml = `agentId: dev-a\ncompanyId: acme\nrole: developer\nname: dev-a\nresponsibilities: Build dev-a\nsystemPrompt: Verify dev-a\nconfig:\n  instructions: Follow dev-a\nversion: 7\nconfigVersion: 3\nappliedConfigVersion: 3\n`;
    await agent(
      "dev-a",
      "acme",
      `FREE_BEFORE_DEV_A\n${OLD_BLOCK}\nFREE_AFTER_DEV_A\n`,
    );
    await agent(
      "dev-b",
      "beta",
      `FREE_BEFORE_DEV_B\n${OLD_BLOCK}\nFREE_AFTER_DEV_B\n`,
    );
    await agent(
      "broken",
      "acme",
      "FREE_BROKEN\n<!-- company:profile:start -->\nunclosed managed block\n",
    );
    const badIdentity = join(root, "agents", "bad-identity");
    await mkdir(badIdentity, { recursive: true });
    await writeFile(
      join(badIdentity, "agent.yaml"),
      "agentId: bad-identity\ncompanyId: ''\ntoken: SUPER_SECRET_TOKEN\nrole: developer\n",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("defaults to dry-run and leaves files untouched", async () => {
    const before = await readFile(join(root, "agents", "dev-a", "CLAUDE.md"), "utf8");
    const results = await refreshAgentProfiles(root, { agentId: "dev-a" });
    expect(results).toEqual([
      expect.objectContaining({
        agentId: "dev-a",
        companyId: "acme",
        status: "would-update",
      }),
    ]);
    expect(results[0]!.blocks).toEqual(
      expect.arrayContaining(["Task progress", "Company assets"]),
    );
    expect(await readFile(join(root, "agents", "dev-a", "CLAUDE.md"), "utf8")).toBe(
      before,
    );
    expect(
      await readFile(join(root, "agents", "dev-a", "agent.yaml"), "utf8"),
    ).toBe(agentYaml);
  });

  test("filters by company, reports invalid blocks, and never prints memory", async () => {
    const results = await refreshAgentProfiles(root);
    expect(results.map((result) => result.agentId)).toEqual([
      "bad-identity",
      "broken",
      "dev-a",
      "dev-b",
    ]);
    expect(
      results.find((result) => result.agentId === "bad-identity"),
    ).toMatchObject({
      status: "error",
      detail: expect.stringContaining("invalid companyId"),
    });
    expect(results.find((result) => result.agentId === "broken")).toMatchObject({
      status: "error",
      detail: expect.stringContaining("invalid_document"),
    });
    expect(JSON.stringify(results)).not.toContain("FREE_BROKEN");
    expect(JSON.stringify(results)).not.toContain("FREE_BEFORE_DEV_A");
    expect(JSON.stringify(results)).not.toContain("SUPER_SECRET_TOKEN");
    expect(
      results.find((result) => result.agentId === "dev-b"),
    ).toMatchObject({ companyId: "beta", status: "would-update" });

    const acme = await refreshAgentProfiles(root, { companyId: "acme" });
    expect(acme.map((result) => [result.agentId, result.status])).toEqual([
      ["bad-identity", "error"],
      ["broken", "error"],
      ["dev-a", "would-update"],
    ]);
  });

  test("--apply replaces only the managed block, commits per member and is idempotent", async () => {
    const directory = join(root, "agents", "dev-a");
    const result = await refreshAgentProfiles(root, {
      dryRun: false,
      companyId: "acme",
      agentId: "dev-a",
    });
    expect(result).toEqual([
      expect.objectContaining({
        agentId: "dev-a",
        status: "updated",
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      }),
    ]);
    const memory = await readFile(join(directory, "CLAUDE.md"), "utf8");
    expect(memory).toContain("FREE_BEFORE_DEV_A");
    expect(memory).toContain("FREE_AFTER_DEV_A");
    expect(memory).toContain("## Task progress");
    expect(memory).toContain(TASK_PROGRESS_GUIDANCE);
    expect(memory).toContain("## Company assets");
    expect(memory).toContain(COMPANY_ASSETS_GUIDANCE);
    expect(memory).not.toContain("OLD_GUIDANCE");
    expect((memory.match(/<!-- company:profile:start -->/g) ?? []).length).toBe(1);
    expect(
      await readFile(join(directory, "agent.yaml"), "utf8"),
    ).toBe(agentYaml);

    const store = new CompanyStore(root);
    const history = await store.history(directory);
    expect(history[0]?.message).toBe("Refresh Company-managed profile guidance");
    const head = (await store.agentGitSnapshot(directory))?.head;
    expect(head).toBe(result[0]!.commit);

    const again = await refreshAgentProfiles(root, {
      dryRun: false,
      agentId: "dev-a",
    });
    expect(again).toEqual([
      { agentId: "dev-a", companyId: "acme", status: "unchanged" },
    ]);
    expect((await store.agentGitSnapshot(directory))?.head).toBe(head);
  });
});
