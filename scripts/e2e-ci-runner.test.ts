import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_FIXTURE_PATH,
  CiRunnerError,
  assertCiChallenge,
  assertEnvWhitelist,
  assertSafeCodeRef,
  assertSafeRepoPath,
  buildBwrapCiRunSpec,
  buildDockerCiRunSpec,
  chooseCiRunner,
  exportCommitTree,
  gitBlobId,
  gitEnvironment,
  inspectWorktreeAgainstCommit,
  parseCiReport,
  parseGitLsTree,
  runGitText,
  sha256Hex,
  treeDigest,
  type CiManifest,
  type CiTreeEntry,
} from "./e2e-ci-runner";

const roots: string[] = [];
const CHALLENGE = "0123456789abcdef0123456789abcdef";
function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "cf-ci-runner-test."));
  roots.push(path);
  return path;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function entryFor(path: string, content: string, mode: "100644" | "100755" = "100644"): CiTreeEntry {
  const bytes = Buffer.from(content);
  return {
    path,
    mode,
    blob: gitBlobId(bytes),
    sha256: sha256Hex(bytes),
    size: bytes.length,
  };
}


function manifestFor(entries: CiTreeEntry[]): CiManifest {
  return {
    version: 1,
    commit: "1".repeat(40),
    parent: null,
    entries,
    parentEntries: [],
    treeSha256: treeDigest(entries),
  };
}

function runFixture(
  mode: "ci" | "review",
  subject: string,
  manifestPath: string,
  challenge = CHALLENGE,
): { status: number; stdout: Buffer; stderr: Buffer } {
  const result = spawnSync(
    process.execPath,
    [CI_FIXTURE_PATH, mode, subject, manifestPath, challenge],
    {
      encoding: null,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" },
      timeout: 20_000,
    },
  );
  return {
    status: result.status ?? -1,
    stdout: Buffer.from(result.stdout ?? []),
    stderr: Buffer.from(result.stderr ?? []),
  };
}

describe("clean code_ref validation", () => {
  test("only lowercase 40-hex commits are accepted", () => {
    expect(assertSafeCodeRef("a".repeat(40))).toBe("a".repeat(40));
    for (const value of ["HEAD", "A".repeat(40), "a".repeat(39), "a".repeat(41), ""])
      expect(() => assertSafeCodeRef(value)).toThrow(CiRunnerError);
  });

  test("repository paths cannot escape the export root", () => {
    expect(assertSafeRepoPath("src/e2e.ts")).toBe("src/e2e.ts");
    expect(assertSafeRepoPath(".github/workflows/ci.yml")).toBe(".github/workflows/ci.yml");
    for (const value of [
      "/etc/passwd",
      "../x",
      "a/../../b",
      ".git/config",
      "a\\b",
      "line\nbreak",
      "tab\tpath",
      "control\u0007path",
      "del\u007fpath",
      "",
    ])
      expect(() => assertSafeRepoPath(value)).toThrow(CiRunnerError);
  });

  test("CI challenges are lowercase hex and bind the run", () => {
    expect(assertCiChallenge(CHALLENGE)).toBe(CHALLENGE);
    for (const value of ["", "A".repeat(32), "a".repeat(31), "a".repeat(65), "z".repeat(32)])
      expect(() => assertCiChallenge(value)).toThrow(CiRunnerError);
  });

  test("git ls-tree parsing rejects symlinks, gitlinks and unsafe paths", () => {
    const blob = "a".repeat(40);
    const parsed = parseGitLsTree(
      Buffer.from(`100644 blob ${blob}\tsrc/e2e.ts\0`),
    );
    expect(parsed).toEqual([
      { path: "src/e2e.ts", mode: "100644", type: "blob", object: blob },
    ]);
    expect(() =>
      parseGitLsTree(Buffer.from(`120000 blob ${blob}\tlink\0`)),
    ).toThrow(CiRunnerError);
    expect(() =>
      parseGitLsTree(Buffer.from(`160000 commit ${blob}\tsub\0`)),
    ).toThrow(CiRunnerError);
    expect(() =>
      parseGitLsTree(Buffer.from(`100644 blob ${blob}\t../escape\0`)),
    ).toThrow(CiRunnerError);
  });

  test("host git environment is rebuilt without inherited Git control variables", () => {
    const env = gitEnvironment("/tmp/e2e-home");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe("1");
    expect(env.GIT_GRAFT_FILE).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  test("tree digest is independent of entry order", () => {
    const a = entryFor("src/e2e.ts", "export const a = 1;\n");
    const b = entryFor("README.md", "# demo\n");
    expect(treeDigest([a, b])).toBe(treeDigest([b, a]));
    expect(treeDigest([a, b])).toHaveLength(64);
  });
});

describe("isolated runner specs", () => {
  function specInputs() {
    const root = tempRoot();
    const subject = join(root, "subject");
    const fixture = join(root, "check.ts");
    const manifest = join(root, "expected.json");
    mkdirSync(subject, { recursive: true });
    writeFileSync(fixture, "fixture\n", { mode: 0o644 });
    writeFileSync(manifest, "{}\n", { mode: 0o644 });
    return {
      root,
      subject,
      fixture,
      manifest,
      forbidden: [join(root, "company-e2e.root"), join(root, "home/.company")],
    };
  }

  test("docker spec is network-none, read-only and secret-free", () => {
    const input = specInputs();
    const spec = buildDockerCiRunSpec({
      dockerBinary: "/usr/bin/docker",
      image: "oven/bun:1.4.4",
      containerName: "company-e2e-ci-test",
      mode: "ci",
      subjectDir: input.subject,
      fixturePath: input.fixture,
      manifestPath: input.manifest,
      challenge: CHALLENGE,
      forbiddenPaths: input.forbidden,
    });
    expect(spec.backend).toBe("docker");
    expect(spec.command).toBe("/usr/bin/docker");
    expect(spec.args[0]).toBe("run");
    expect(spec.args.join(" ")).not.toContain("package.json");
    expect(spec.args.join(" ")).not.toContain("e2e:ci");
    expect(spec.args).toContain("--network=none");
    expect(spec.args).toContain("--read-only");
    expect(spec.args).toContain("--cap-drop=ALL");
    expect(spec.args).toContain("--security-opt=no-new-privileges");
    expect(spec.args).toContain("--pull=never");
    expect(spec.args).toContain(CHALLENGE);
    expect(spec.args).toContain("--rm");
    expect(spec.args).toContain("--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777");
    expect(spec.args.join(" ")).not.toContain("PERI_MODEL");
    expect(spec.args.join(" ")).not.toContain("COMPANY_WEB_TOKEN");
    expect(spec.args.join(" ")).not.toContain("owner-token");
    expect(Object.keys(spec.env).sort()).toEqual(["HOME", "LANG", "PATH"]);
    expect(spec.mounts.map((mount) => mount.target).sort()).toEqual([
      "/ci/check.ts",
      "/ci/expected.json",
      "/subject",
    ]);
    expect(spec.mounts.every((mount) => mount.readonly)).toBe(true);
    expect(spec.isolation.networkNone).toBe(true);
    expect(spec.isolation.noE2eRootMount).toBe(true);
    expect(spec.isolation.noSecretEnv).toBe(true);
    const bare = buildDockerCiRunSpec({
      dockerBinary: "docker",
      image: "oven/bun:1.4.4",
      containerName: "company-e2e-ci-test",
      mode: "ci",
      subjectDir: input.subject,
      fixturePath: input.fixture,
      manifestPath: input.manifest,
      challenge: CHALLENGE,
      forbiddenPaths: input.forbidden,
    });
    expect(bare.command).toBe("docker");
  });

  test("docker spec refuses mounts overlapping the E2E root or user data", () => {
    const input = specInputs();
    const insideRoot = join(input.forbidden[0]!, "subject");
    mkdirSync(insideRoot, { recursive: true });
    expect(() =>
      buildDockerCiRunSpec({
        dockerBinary: "/usr/bin/docker",
        image: "oven/bun:1.4.4",
        containerName: "company-e2e-ci-test",
        mode: "ci",
        subjectDir: insideRoot,
        fixturePath: input.fixture,
        manifestPath: input.manifest,
      challenge: CHALLENGE,
        forbiddenPaths: input.forbidden,
      }),
    ).toThrow(CiRunnerError);
    expect(() =>
      buildDockerCiRunSpec({
        dockerBinary: "/usr/bin/docker",
        image: "oven/bun:1.4.4",
        containerName: "company-e2e-ci-test",
        mode: "ci",
        subjectDir: "/",
        fixturePath: input.fixture,
        manifestPath: input.manifest,
      challenge: CHALLENGE,
        forbiddenPaths: input.forbidden,
      }),
    ).toThrow(CiRunnerError);
  });

  test("bwrap spec is an explicit no-network read-only sandbox", () => {
    const input = specInputs();
    const spec = buildBwrapCiRunSpec({
      bwrapBinary: "/usr/bin/bwrap",
      bunBinary: process.execPath,
      mode: "review",
      subjectDir: input.subject,
      fixturePath: input.fixture,
      manifestPath: input.manifest,
      challenge: CHALLENGE,
      systemRoBinds: ["/usr", "/bin"],
      forbiddenPaths: input.forbidden,
    });
    expect(spec.backend).toBe("bwrap");
    expect(spec.command).toBe("/usr/bin/bwrap");
    expect(spec.args.join(" ")).not.toContain("package.json");
    expect(spec.args).toContain("--unshare-net");
    expect(spec.args).toContain("--clearenv");
    expect(spec.args[spec.args.indexOf("--setenv") + 1]).toBe("PATH");
    expect(spec.args).toContain("--unshare-user");
    expect(spec.args).toContain("--ro-bind");
    expect(spec.args).not.toContain("--bind");
    expect(spec.args).not.toContain("--dev-bind");
    expect(spec.args).toContain("--tmpfs");
    expect(spec.args).toContain(CHALLENGE);
    expect(spec.args.join(" ")).not.toContain("PERI_MODEL");
    expect(spec.args.join(" ")).not.toContain("COMPANY_WEB_TOKEN");
    expect(Object.keys(spec.env).sort()).toEqual([
      "BUN_INSTALL",
      "HOME",
      "LANG",
      "NO_COLOR",
      "PATH",
    ]);
    expect(spec.mounts.every((mount) => mount.readonly)).toBe(true);
  });

  test("bwrap refuses system binds outside the fixed allow-list", () => {
    const input = specInputs();
    expect(() =>
      buildBwrapCiRunSpec({
        bwrapBinary: "/usr/bin/bwrap",
        bunBinary: process.execPath,
        mode: "ci",
        subjectDir: input.subject,
        fixturePath: input.fixture,
        manifestPath: input.manifest,
      challenge: CHALLENGE,
        systemRoBinds: ["/home/user"],
        forbiddenPaths: input.forbidden,
      }),
    ).toThrow(CiRunnerError);
  });

  test("secret-shaped environment keys are rejected", () => {
    expect(() =>
      assertEnvWhitelist({
        PATH: "/usr/bin",
        HOME: "/tmp",
        PERI_MODEL_API_KEY: "not-a-real-key",
      }),
    ).toThrow(CiRunnerError);
    expect(() =>
      assertEnvWhitelist({ PATH: "/usr/bin", HOME: "/tmp", BUN_INSTALL: "/tmp/bun" }),
    ).not.toThrow();
  });

  test("missing Docker or a missing local image is a hard failure", () => {
    expect(() =>
      chooseCiRunner({
        requested: "docker",
        platform: "linux",
        dockerAvailable: false,
        dockerImageAvailable: true,
        bwrapAvailable: true,
      }),
    ).toThrow(CiRunnerError);
    expect(() =>
      chooseCiRunner({
        requested: "docker",
        platform: "linux",
        dockerAvailable: true,
        dockerImageAvailable: false,
        bwrapAvailable: true,
      }),
    ).toThrow(CiRunnerError);
    expect(() =>
      chooseCiRunner({
        requested: undefined,
        platform: "linux",
        dockerAvailable: false,
        dockerImageAvailable: false,
        bwrapAvailable: true,
      }),
    ).toThrow(CiRunnerError);
    expect(
      chooseCiRunner({
        requested: "docker",
        platform: "linux",
        dockerAvailable: true,
        dockerImageAvailable: true,
        bwrapAvailable: false,
      }),
    ).toBe("docker");
    expect(
      chooseCiRunner({
        requested: "bwrap",
        platform: "linux",
        dockerAvailable: false,
        dockerImageAvailable: false,
        bwrapAvailable: true,
      }),
    ).toBe("bwrap");
    expect(() =>
      chooseCiRunner({
        requested: "bwrap",
        platform: "darwin",
        dockerAvailable: false,
        dockerImageAvailable: false,
        bwrapAvailable: true,
      }),
    ).toThrow(CiRunnerError);
  });
});

describe("fixture report validation", () => {
  test("canonical report is accepted; tampering is rejected", () => {
    const entries = [
      entryFor("src/e2e.ts", "export function run() {\n  return 1;\n}\n"),
      entryFor("README.md", "# demo\n"),
    ];
    const manifest = manifestFor(entries);
    const checks = {
      conflictMarkersAbsent: true,
      deliveryExportPresent: true,
      fileModesMatched: true,
      forbiddenPathsAbsent: true,
      manifestMatched: true,
      previewArtifactsAbsent: true,
      srcEntryPresent: true,
      typescriptSyntaxValid: true,
      whitespaceClean: true,
    };
    const report = {
      version: 1,
      mode: "ci",
      challenge: CHALLENGE,
      commit: manifest.commit,
      treeSha256: manifest.treeSha256,
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      checks,
    };
    const stdout = Buffer.from(JSON.stringify(report) + "\n");
    expect(
      parseCiReport(stdout, { mode: "ci", manifest, challenge: CHALLENGE }).commit,
    ).toBe(manifest.commit);
    expect(() =>
      parseCiReport(
        Buffer.from(JSON.stringify({ ...report, challenge: "f".repeat(32) }) + "\n"),
        { mode: "ci", manifest, challenge: CHALLENGE },
      ),
    ).toThrow(CiRunnerError);
    expect(() =>
      parseCiReport(Buffer.from(JSON.stringify({ ...report, commit: "2".repeat(40) }) + "\n"), {
        mode: "ci",
        manifest,
        challenge: CHALLENGE,
      }),
    ).toThrow(CiRunnerError);
    expect(() =>
      parseCiReport(
        Buffer.from(
          JSON.stringify({ ...report, checks: { ...checks, whitespaceClean: false } }) + "\n",
        ),
        { mode: "ci", manifest, challenge: CHALLENGE },
      ),
    ).toThrow(CiRunnerError);
    expect(() =>
      parseCiReport(Buffer.from(JSON.stringify({ ...report, extra: "PERI_MODEL_API_KEY" }) + "\n"), {
        mode: "ci",
        manifest,
        challenge: CHALLENGE,
      }),
    ).toThrow(CiRunnerError);
    expect(() =>
      parseCiReport(Buffer.concat([stdout, Buffer.from("trailer\n")]), {
        mode: "ci",
        manifest,
        challenge: CHALLENGE,
      }),
    ).toThrow(CiRunnerError);
  });
});

describe("worktree observation", () => {
  test("measures expected test artifacts and unexpected edits without git status", () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(home, { recursive: true });
    const git = (args: string[]) => runGitText(repo, args, { home });
    expect(git(["init"]).status).toBe(0);
    writeFileSync(join(repo, "README.md"), "# demo\n", { mode: 0o644 });
    writeFileSync(join(repo, "src/e2e.ts"), "export const x = 1;\n", {
      mode: 0o644,
    });
    expect(git(["add", "-A"]).status).toBe(0);
    expect(
      git([
        "-c",
        "user.name=E2E Test",
        "-c",
        "user.email=e2e@localhost",
        "commit",
        "-m",
        "initial",
      ]).status,
    ).toBe(0);
    const head = git(["rev-parse", "HEAD"]).stdout;
    const expectedArtifacts = [
      /^e2e-preview-marker\.txt$/,
      /^\.preview\.log$/,
      /^\.e2e-ci\//,
    ];
    const clean = inspectWorktreeAgainstCommit({
      worktree: repo,
      commit: head,
      home,
      expectedArtifacts,
    });
    expect(clean.state).toBe("clean");
    expect(clean.headMatchesCommit).toBe(true);

    writeFileSync(join(repo, "e2e-preview-marker.txt"), "marker\n");
    writeFileSync(join(repo, ".preview.log"), "log\n");
    mkdirSync(join(repo, ".e2e-ci/run/ci"), { recursive: true });
    writeFileSync(join(repo, ".e2e-ci/run/ci/check.ts"), "fixture\n");
    const expected = inspectWorktreeAgainstCommit({
      worktree: repo,
      commit: head,
      home,
      expectedArtifacts,
    });
    expect(expected.state).toBe("dirty_expected");
    expect(expected.dirtyEntries).toBe(3);
    expect(expected.unexpectedEntries).toBe(0);

    writeFileSync(join(repo, "README.md"), "# changed\n");
    const unexpected = inspectWorktreeAgainstCommit({
      worktree: repo,
      commit: head,
      home,
      expectedArtifacts,
    });
    expect(unexpected.state).toBe("dirty_unexpected");
    expect(unexpected.unexpectedEntries).toBe(1);
    expect(unexpected.headMatchesCommit).toBe(true);
  });

  test("does not execute git clean filters or hooks from the worktree", () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    const home = join(root, "home");
    const marker = join(root, "filter-ran");
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    const git = (args: string[]) => runGitText(repo, args, { home });
    expect(git(["init"]).status).toBe(0);
    writeFileSync(join(repo, "data.txt"), "committed\n", { mode: 0o644 });
    expect(git(["add", "-A"]).status).toBe(0);
    expect(
      git([
        "-c",
        "user.name=E2E Test",
        "-c",
        "user.email=e2e@localhost",
        "commit",
        "-m",
        "initial",
      ]).status,
    ).toBe(0);
    const head = git(["rev-parse", "HEAD"]).stdout;
    expect(
      git(["config", "filter.evil.clean", `sh -c 'touch ${marker}; cat'`]).status,
    ).toBe(0);
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil\n");
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    writeFileSync(join(repo, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    const observation = inspectWorktreeAgainstCommit({
      worktree: repo,
      commit: head,
      home,
      expectedArtifacts: [/^\.gitattributes$/],
    });
    expect(observation.supported).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("clean export and fixture round-trip", () => {
  test("exports only the accepted commit and the fixture verifies it", () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    const home = join(root, "home");
    const exportDir = join(root, "export");
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(exportDir, { recursive: true });
    const git = (args: string[]) => runGitText(repo, args, { home });
    expect(git(["init"]).status).toBe(0);
    writeFileSync(join(repo, "README.md"), "# demo\n", { mode: 0o644 });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src/e2e.ts"),
      "export function run() {\n  return 1;\n}\n",
      { mode: 0o644 },
    );
    expect(git(["add", "-A"]).status).toBe(0);
    expect(
      git([
        "-c",
        "user.name=E2E Test",
        "-c",
        "user.email=e2e@localhost",
        "commit",
        "-m",
        "initial",
      ]).status,
    ).toBe(0);
    const head = git(["rev-parse", "HEAD"]).stdout;
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const manifest = exportCommitTree({
      projectRoot: repo,
      codeRef: head,
      destination: exportDir,
      home,
    });
    expect(manifest.commit).toBe(head);
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "README.md",
      "src/e2e.ts",
    ]);
    expect(manifest.treeSha256).toBe(treeDigest(manifest.entries));
    const manifestPath = join(root, "expected.json");
    writeFileSync(manifestPath, JSON.stringify(manifest) + "\n", { mode: 0o644 });
    const result = runFixture("ci", exportDir, manifestPath);
    expect(result.status).toBe(0);
    const repeated = runFixture("ci", exportDir, manifestPath);
    expect(repeated.status).toBe(0);
    expect(repeated.stdout.equals(result.stdout)).toBe(true);
    const report = parseCiReport(result.stdout, {
      mode: "ci",
      manifest,
      challenge: CHALLENGE,
    });
    expect(report.files).toBe(2);
    expect(report.challenge).toBe(CHALLENGE);
    const review = runFixture("review", exportDir, manifestPath);
    expect(review.status).toBe(0);
    const reviewReport = parseCiReport(review.stdout, {
      mode: "review",
      manifest,
      challenge: CHALLENGE,
    });
    expect(reviewReport.review?.added).toBe(2);
    expect(runFixture("ci", exportDir, manifestPath, "not-a-challenge").status).not.toBe(0);
    expect(runFixture("ci", exportDir, manifestPath, "f".repeat(32)).stdout.equals(result.stdout)).toBe(false);

    const secretExport = join(root, "secret-export");
    mkdirSync(secretExport);
    expect(() =>
      exportCommitTree({
        projectRoot: repo,
        codeRef: head,
        destination: secretExport,
        home,
        forbiddenValues: ["return 1"],
      }),
    ).toThrow(CiRunnerError);
  });

  test("the fixture rejects extra files, symlinks, whitespace and secret filenames", () => {
    const root = tempRoot();
    const subject = join(root, "subject");
    const manifestPath = join(root, "expected.json");
    mkdirSync(join(subject, "src"), { recursive: true });
    writeFileSync(
      join(subject, "src/e2e.ts"),
      "export function run() {\n  return 1;\n}\n",
      { mode: 0o644 },
    );
    const entries = [
      entryFor("src/e2e.ts", "export function run() {\n  return 1;\n}\n"),
    ];
    const manifest = manifestFor(entries);
    writeFileSync(manifestPath, JSON.stringify(manifest) + "\n", { mode: 0o644 });

    expect(runFixture("ci", subject, manifestPath).status).toBe(0);

    writeFileSync(join(subject, "extra.txt"), "extra\n", { mode: 0o644 });
    expect(runFixture("ci", subject, manifestPath).status).not.toBe(0);
    rmSync(join(subject, "extra.txt"));

    symlinkSync("/etc/hosts", join(subject, "link"));
    expect(runFixture("ci", subject, manifestPath).status).not.toBe(0);
    rmSync(join(subject, "link"));

    writeFileSync(
      join(subject, "src/e2e.ts"),
      "export function run() {\n  return 1; \n}\n",
      { mode: 0o644 },
    );
    expect(runFixture("ci", subject, manifestPath).status).not.toBe(0);

    writeFileSync(
      join(subject, "src/e2e.ts"),
      "export function run() {\n  return 1;\n}\n",
      { mode: 0o644 },
    );
    const marker = "E2E_PREVIEW_marker\n";
    writeFileSync(join(subject, "e2e-preview-marker.txt"), marker, { mode: 0o644 });
    const markerManifest = manifestFor([
      entryFor("src/e2e.ts", "export function run() {\n  return 1;\n}\n"),
      entryFor("e2e-preview-marker.txt", marker),
    ]);
    const markerManifestPath = join(root, "marker-expected.json");
    writeFileSync(markerManifestPath, JSON.stringify(markerManifest) + "\n", {
      mode: 0o644,
    });
    expect(runFixture("ci", subject, markerManifestPath).status).not.toBe(0);
  });
});
