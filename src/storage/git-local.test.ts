import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CompanyStore } from "./company-store";

/** Real Git, local execution. Hooks are Agent-controlled code and now run with
 * host-user file access; only the directory containment check remains. */
test("Agent Git commits run locally, keep a minimal environment and stay inside the Agent root", async () => {
  const root = await mkdtemp(join(tmpdir(), "company-git-local-"));
  const dir = join(root, "agents", "local-agent");
  const outside = join(root, "companys", "private-company");
  const store = new CompanyStore(root);
  const priorSecret = process.env.COMPANY_TEST_HOST_SECRET;
  process.env.COMPANY_TEST_HOST_SECRET = "host-only-secret-must-not-inherit";
  try {
    await mkdir(dir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(dir, "claude.md"), "initial memory");
    await store.commit(dir, "Initial inside Agent repo");
    expect((await store.history(dir)).length).toBe(1);

    const hook = `#!/bin/sh\nprintf 'hook ran\\n' >> '${dir}/hook-proof'\nprintf '%s' "$COMPANY_TEST_HOST_SECRET" > '${dir}/environment-proof'\nexit 0\n`;
    await writeFile(join(dir, ".git/hooks/pre-commit"), hook);
    await chmod(join(dir, ".git/hooks/pre-commit"), 0o755);
    await writeFile(join(dir, "claude.md"), "updated memory");
    await store.commit(dir, "Commit with local hook");

    expect(await readFile(join(dir, "hook-proof"), "utf8")).toContain(
      "hook ran",
    );
    expect(await readFile(join(dir, "environment-proof"), "utf8")).toBe("");
    expect((await store.history(dir)).length).toBe(2);

    const escaped = join(root, "agents", "escaped");
    await symlink(outside, escaped);
    await expect(store.commit(escaped, "Outside the Agent root")).rejects.toThrow();
  } finally {
    if (priorSecret === undefined) delete process.env.COMPANY_TEST_HOST_SECRET;
    else process.env.COMPANY_TEST_HOST_SECRET = priorSecret;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
