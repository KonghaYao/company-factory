import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AVATAR_COLORS,
  CompanyDomain,
  type CallerContext,
  type DomainOptions,
  fallbackAvatarColor,
  isAvatarColor,
} from "../src/domain";

// Real Company files and Git; only provisioning and Agent Git are replaced.
const roots: string[] = [];
let sequence = 0;
const requestId = () => `avatar-domain-${++sequence}`;

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function unitDomain(options: DomainOptions) {
  const domain = new CompanyDomain(options);
  const commit = domain.store.commit.bind(domain.store);
  domain.store.commit = async (directory, message) => {
    if (directory.startsWith(join(options.root, "agents") + "/")) return;
    return commit(directory, message);
  };
  return domain;
}

async function fixture(extra: Partial<DomainOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "company-avatar-domain-"));
  roots.push(root);
  const domain = unitDomain({
    root,
    provisionAgent: async (input) => ({
      sessionId: input.sessionId ?? `unit-session-${input.agentId}`,
    }),
    ...extra,
  });
  return { root, domain };
}

const owner: CallerContext = {
  type: "user",
  id: "avatar-owner",
  companyId: "",
};

async function company(options: Partial<DomainOptions> = {}) {
  const { root, domain } = await fixture(options);
  const created = await domain.createCompany(owner, {
    name: "Avatar fixture",
    requestId: requestId(),
  });
  const companyId = created.company.id;
  const user = { ...owner, companyId };
  const hr: CallerContext = {
    type: "agent",
    id: `${companyId}-hr`,
    companyId,
  };
  const supervisor: CallerContext = {
    type: "agent",
    id: `${companyId}-supervisor`,
    companyId,
  };
  const companyPath = join(root, "companys", companyId, "company.yaml");
  return { root, domain, companyId, user, hr, supervisor, companyPath };
}

function colorOf(view: { agents: { agentId: string; avatarColor?: unknown }[] }, agentId: string) {
  return view.agents.find((agent) => agent.agentId === agentId)?.avatarColor;
}

async function legacyCompany(
  memberIds: readonly string[] = ["legacy-hr", "legacy-dev"],
) {
  const { root, domain } = await fixture();
  const companyId = "legacy-avatar";
  const user: CallerContext = { type: "user", id: "legacy-owner", companyId };
  const hr: CallerContext = {
    type: "agent",
    id: "legacy-hr",
    companyId,
  };
  const directory = join(root, "companys", companyId);
  const memberRoles = memberIds.map(
    (agentId, index) => [agentId, index === 0 ? "hr" : "developer"] as const,
  );
  await domain.store.putYaml(join(directory, "company.yaml"), {
    id: companyId,
    name: "Legacy avatar",
    goal: "",
    roles: { hr: { permissions: [] }, developer: { permissions: [] } },
    created_at: "2026-01-01T00:00:00.000Z",
    version: 1,
  });
  await domain.store.putYaml(join(directory, "roster.yaml"), {
    version: 1,
    members: memberRoles.map(([agentId, role]) => ({
      agentId,
      groupId: role === "hr" ? "headquarters" : "team",
      role,
    })),
  });
  await domain.store.putYaml(join(directory, "events", "initialization.yaml"), {
    hash: "legacy-avatar",
    status: "complete",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  await domain.store.initGit(directory);
  for (const [agentId, role] of memberRoles) {
    const agentDir = join(root, "agents", agentId);
    await mkdir(agentDir, { recursive: true });
    await domain.store.putYaml(join(agentDir, "agent.yaml"), {
      agentId,
      companyId,
      role,
      name: agentId,
      responsibilities: role,
      systemPrompt: "",
      directory: agentDir,
      sessionId: `legacy-session-${agentId}`,
      config: {},
      effectiveConfig: {},
      configVersion: 1,
      appliedConfigVersion: 1,
      version: 1,
      authToken: "a".repeat(64),
    });
    await writeFile(join(agentDir, "CLAUDE.md"), "# Memory\n", "utf8");
    await writeFile(join(agentDir, ".mcp.json"), "{}\n", "utf8");
  }
  return {
    root,
    domain,
    companyId,
    user,
    hr,
    companyPath: join(directory, "company.yaml"),
  };
}

describe("Company avatar colors", () => {
  test("createCompany persists distinct valid colors for both fixed members", async () => {
    const { domain, user, hr, supervisor, companyPath } = await company();
    const stored = await domain.store.yaml(companyPath);
    const hrColor = stored.memberColors[hr.id];
    const supervisorColor = stored.memberColors[supervisor.id];
    expect(isAvatarColor(hrColor)).toBe(true);
    expect(isAvatarColor(supervisorColor)).toBe(true);
    expect(hrColor).not.toBe(supervisorColor);

    const ownerView = await domain.organization(user);
    const agentView = await domain.organization(hr);
    expect(colorOf(ownerView, hr.id)).toBe(hrColor);
    expect(colorOf(ownerView, supervisor.id)).toBe(supervisorColor);
    expect(colorOf(agentView, hr.id)).toBe(hrColor);
    expect(colorOf(agentView, supervisor.id)).toBe(supervisorColor);

    const members = await domain.members(user);
    expect(members.find((member) => member.agentId === hr.id)?.avatarColor).toBe(
      hrColor,
    );
    expect(
      members.find((member) => member.agentId === supervisor.id)?.avatarColor,
    ).toBe(supervisorColor);

    const agentRecord = await domain.getAgent(user, { agentId: hr.id });
    expect(agentRecord).not.toHaveProperty("avatarColor");
    expect(
      await readFile(join(agentRecord.directory, "agent.yaml"), "utf8"),
    ).not.toContain("avatarColor");
  });

  test("createMember assigns persisted unused colors and replays without rerandomizing", async () => {
    const { domain, user, hr, companyPath } = await company();
    const ids = ["dev-a", "dev-b", "dev-c"];
    for (const agentId of ids) {
      await domain.createMember(hr, {
        agentId,
        name: agentId,
        role: "developer",
        responsibilities: "Color allocation",
        requestId: requestId(),
      });
    }
    const stored = await domain.store.yaml(companyPath);
    const colors = [hr.id, "dev-a", "dev-b", "dev-c"].map(
      (agentId) => stored.memberColors[agentId],
    );
    expect(colors.every((color) => isAvatarColor(color))).toBe(true);
    expect(new Set(colors).size).toBe(colors.length);

    const request = requestId();
    const first = await domain.createMember(hr, {
      agentId: "dev-replay",
      name: "Dev Replay",
      role: "developer",
      responsibilities: "Replay",
      requestId: request,
    });
    const afterFirst = await domain.store.yaml(companyPath);
    const replay = await domain.createMember(hr, {
      agentId: "dev-replay",
      name: "Dev Replay",
      role: "developer",
      responsibilities: "Replay",
      requestId: request,
    });
    const afterReplay = await domain.store.yaml(companyPath);
    expect(replay.agentId).toBe(first.agentId);
    expect(afterReplay.version).toBe(afterFirst.version);
    expect(afterReplay.memberColors["dev-replay"]).toBe(
      afterFirst.memberColors["dev-replay"],
    );
    expect(
      colorOf(await domain.organization(user), "dev-replay"),
    ).toBe(afterFirst.memberColors["dev-replay"]);
  });

  test("a failed provision retry reuses the pre-reserved color", async () => {
    let fail = true;
    const { domain, hr, companyPath } = await company({
      provisionAgent: async (input) => {
        if (fail && input.agentId === "dev-retry") {
          fail = false;
          throw Object.assign(new Error("unit failure"), {
            code: "runtime_error",
            status: 500,
          });
        }
        return { sessionId: `unit-session-${input.agentId}` };
      },
    });
    const request = requestId();
    const input = {
      agentId: "dev-retry",
      name: "Dev Retry",
      role: "developer",
      responsibilities: "Retry",
      requestId: request,
    };
    await expect(domain.createMember(hr, input)).rejects.toMatchObject({
      code: "runtime_error",
    });
    const reserved = await domain.store.yaml(companyPath);
    const color = reserved.memberColors["dev-retry"];
    expect(isAvatarColor(color)).toBe(true);
    await domain.createMember(hr, input);
    const retried = await domain.store.yaml(companyPath);
    expect(retried.memberColors["dev-retry"]).toBe(color);
    expect(retried.version).toBe(reserved.version);
  });

  test("legacy companies read stable fallbacks without writing", async () => {
    const { domain, user, hr, companyPath } = await legacyCompany();
    const before = await readFile(companyPath, "utf8");
    const first = await domain.organization(user);
    const second = await domain.organization(user);
    expect(colorOf(first, "legacy-hr")).toBe("slate");
    expect(colorOf(first, "legacy-dev")).toBe("rose");
    expect(colorOf(second, "legacy-hr")).toBe("slate");
    expect(colorOf(second, "legacy-dev")).toBe("rose");
    expect(colorOf(await domain.organization(hr), "legacy-dev")).toBe("rose");
    expect(
      (await domain.members(user)).find(
        (member) => member.agentId === "legacy-dev",
      )?.avatarColor,
    ).toBe("rose");
    const stored = await domain.store.yaml(companyPath);
    expect(stored).not.toHaveProperty("memberColors");
    expect(await readFile(companyPath, "utf8")).toBe(before);
  });

  test("nine legacy members get distinct stable colors despite hash collisions", async () => {
    const ids = [
      "legacy-0",
      "legacy-11",
      "legacy-1",
      "legacy-10",
      "legacy-2",
      "legacy-17",
      "legacy-3",
      "legacy-12",
      "legacy-4",
    ];
    expect(new Set(ids.map(fallbackAvatarColor)).size).toBeLessThan(ids.length);
    const { domain, user, companyPath } = await legacyCompany(ids);
    const first = await domain.organization(user);
    const colors = ids.map((agentId) => colorOf(first, agentId));
    expect(colors.every((color) => isAvatarColor(color))).toBe(true);
    expect(new Set(colors).size).toBe(ids.length);
    const second = await domain.organization(user);
    expect(ids.map((agentId) => colorOf(second, agentId))).toEqual(colors);
    expect(await domain.store.yaml(companyPath)).not.toHaveProperty(
      "memberColors",
    );
  });

  test("createMember freezes old fallbacks before assigning a new color", async () => {
    const { domain, user, hr, companyPath } = await legacyCompany();
    const before = await domain.organization(user);
    const hrBefore = colorOf(before, "legacy-hr");
    const devBefore = colorOf(before, "legacy-dev");
    await domain.createMember(hr, {
      agentId: "legacy-new",
      name: "Legacy New",
      role: "developer",
      responsibilities: "New member",
      requestId: requestId(),
    });
    const after = await domain.organization(user);
    expect(colorOf(after, "legacy-hr")).toBe(hrBefore);
    expect(colorOf(after, "legacy-dev")).toBe(devBefore);
    expect(colorOf(after, "legacy-new")).not.toBe(hrBefore);
    expect(colorOf(after, "legacy-new")).not.toBe(devBefore);
    const stored = await domain.store.yaml(companyPath);
    expect(stored.memberColors["legacy-hr"]).toBe(hrBefore);
    expect(stored.memberColors["legacy-dev"]).toBe(devBefore);
    expect(stored.memberColors["legacy-new"]).toBe(
      colorOf(after, "legacy-new"),
    );
  });

  test("owner color changes freeze other legacy fallbacks and preserve unknown keys", async () => {
    const { domain, user, hr, companyPath } = await legacyCompany();
    const before = await domain.organization(user);
    const devBefore = colorOf(before, "legacy-dev");
    const current = await domain.store.yaml(companyPath);
    current.memberColors = {
      "gone-agent": "teal",
      historical: "chartreuse",
    };
    await domain.store.putYaml(companyPath, current);
    await domain.updateMember(user, {
      agentId: "legacy-hr",
      avatarColor: "violet",
      version: 1,
      requestId: requestId(),
    });
    const after = await domain.organization(user);
    expect(colorOf(after, "legacy-hr")).toBe("violet");
    expect(colorOf(after, "legacy-dev")).toBe(devBefore);
    expect(colorOf(after, "legacy-dev")).not.toBe("teal");
    const stored = await domain.store.yaml(companyPath);
    expect(stored.memberColors).toMatchObject({
      "legacy-hr": "violet",
      "legacy-dev": devBefore,
      "gone-agent": "teal",
      historical: "chartreuse",
    });
    expect(
      await readFile(
        join(domain.store.root, "agents", "legacy-hr", "agent.yaml"),
        "utf8",
      ),
    ).not.toContain("avatarColor");
  });

  test("archive and restore keep the member color", async () => {
    const { domain, user, hr } = await company();
    await domain.createMember(hr, {
      agentId: "dev-archive",
      name: "Dev Archive",
      role: "developer",
      responsibilities: "Archive",
      requestId: requestId(),
    });
    const before = await domain.organization(user);
    const expected = colorOf(before, "dev-archive");
    await domain.archiveMember(hr, {
      agentId: "dev-archive",
      version: before.organization.version,
      requestId: requestId(),
    });
    const archived = await domain.organization(user);
    expect(
      archived.agents.find((agent) => agent.agentId === "dev-archive")?.status,
    ).toBe("archived");
    expect(colorOf(archived, "dev-archive")).toBe(expected);
    await domain.restoreMember(hr, {
      agentId: "dev-archive",
      version: archived.organization.version,
      requestId: requestId(),
    });
    const restored = await domain.organization(user);
    expect(colorOf(restored, "dev-archive")).toBe(expected);
    expect(
      restored.agents.find((agent) => agent.agentId === "dev-archive")?.status,
    ).toBe("active");
  });
});
