import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CompanyStore } from "./company-store";

/** Real Git + real bubblewrap tests. No mocked process execution or fake sandbox. */
test("Agent Git hooks, fsmonitor and clean filters cannot escape to host paths or host secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "company-git-sandbox-"));
  const dir = join(root, "agents", "malicious-agent");
  const companyDir = join(root, "companys", "private-company");
  const outside = join(root, "outside-marker");
  const business = join(companyDir, "protected.md");
  const store = new CompanyStore(root);
  const priorSecret = process.env.COMPANY_TEST_HOST_SECRET;
  process.env.COMPANY_TEST_HOST_SECRET = "host-only-secret-must-not-inherit";
  try {
    await mkdir(dir, { recursive: true });
    await mkdir(companyDir, { recursive: true });
    await writeFile(business, "protected business facts");
    await writeFile(join(dir, "claude.md"), "initial memory");
    await store.commit(dir, "Initial inside Agent repo");
    const payload = `#!/bin/sh\nprintf 'inside hook ran\\n' >> '${dir}/hook-proof'\nprintf '%s' "$COMPANY_TEST_HOST_SECRET" > '${dir}/environment-proof'\nprintf 'escaped' > '${outside}' 2>/dev/null || true\nprintf 'corrupted' > '${business}' 2>/dev/null || true\nexit 0\n`;
    await writeFile(join(dir, ".git/hooks/pre-commit"), payload);
    await chmod(join(dir, ".git/hooks/pre-commit"), 0o755);
    await writeFile(join(dir, "claude.md"), "updated memory");
    await store.commit(dir, "Commit malicious pre-commit safely");
    expect(await readFile(join(dir, "hook-proof"), "utf8")).toContain(
      "inside hook ran",
    );
    expect(await readFile(join(dir, "environment-proof"), "utf8")).toBe("");
    await expect(access(outside)).rejects.toThrow();
    expect(await readFile(business, "utf8")).toBe("protected business facts");
    expect((await store.history(dir)).length).toBeGreaterThanOrEqual(2);

    // Repository config is equally untrusted: fsmonitor and clean filters execute
    // during status/add, not only during commit.
    const config = await readFile(join(dir, ".git/config"), "utf8");
    await writeFile(
      join(dir, "fsmonitor.sh"),
      `#!/bin/sh\nprintf 'fsmonitor ran\\n' >> '${dir}/fsmonitor-proof'\nprintf 'escaped' > '${outside}' 2>/dev/null || true\nprintf '\\000'\n`,
    );
    await chmod(join(dir, "fsmonitor.sh"), 0o755);
    await writeFile(
      join(dir, "filter.sh"),
      `#!/bin/sh\nprintf 'filter ran\\n' >> '${dir}/filter-proof'\nprintf 'escaped' > '${outside}' 2>/dev/null || true\ncat\n`,
    );
    await chmod(join(dir, "filter.sh"), 0o755);
    await writeFile(
      join(dir, ".git/config"),
      `${config}\n[core]\n\tfsmonitor = ${dir}/fsmonitor.sh\n[filter "malicious"]\n\tclean = ${dir}/filter.sh\n\trequired = true\n`,
    );
    await writeFile(join(dir, ".gitattributes"), "*.txt filter=malicious\n");
    await writeFile(join(dir, "test.txt"), "keep this content\n");
    await store.commit(dir, "Contain fsmonitor and clean filter");
    expect(await readFile(join(dir, "fsmonitor-proof"), "utf8")).toContain(
      "fsmonitor ran",
    );
    expect(await readFile(join(dir, "filter-proof"), "utf8")).toContain(
      "filter ran",
    );
    await expect(access(outside)).rejects.toThrow();
    expect(await readFile(business, "utf8")).toBe("protected business facts");
  } finally {
    if (priorSecret === undefined) delete process.env.COMPANY_TEST_HOST_SECRET;
    else process.env.COMPANY_TEST_HOST_SECRET = priorSecret;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
