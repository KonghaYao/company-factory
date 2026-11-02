import { mkdir, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

// Official released upstream runtime, not an npm placeholder or local reimplementation.
const version = "4.4.1";
const platform =
  process.platform === "linux"
    ? "linux"
    : process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : null;
const arch =
  process.arch === "x64"
    ? "x86_64"
    : process.arch === "arm64"
      ? "aarch64"
      : process.arch === "riscv64" && platform === "linux"
        ? "riscv64"
        : null;
if (!platform || !arch)
  throw new Error(
    `No official Peri ${version} build is available for ${process.platform}/${process.arch}. Install it manually and set PERI_BINARY.`,
  );
if (platform === "windows" && arch !== "x86_64")
  throw new Error(
    `No official Peri ${version} Windows build is available for ${process.arch}.`,
  );
const windows = platform === "windows";
const extension = windows ? "zip" : "tar.gz";
const asset = `peri-${platform}-${arch}.${extension}`;
const base = `https://github.com/KonghaYao/peri/releases/download/agent-v${version}`;
const directory = resolve(".tools/peri");
await mkdir(directory, { recursive: true });
async function download(name: string) {
  const response = await fetch(`${base}/${name}`);
  if (!response.ok)
    throw new Error(`Download failed: ${response.status} ${name}`);
  return Buffer.from(await response.arrayBuffer());
}
const [archive, check] = await Promise.all([
  download(asset),
  download(`${asset}.sha256`),
]);
const expected = check.toString().trim().split(/\s+/)[0];
const actual = createHash("sha256").update(archive).digest("hex");
if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected)
  throw new Error(
    "Official Peri release checksum mismatch; archive not extracted.",
  );
const archivePath = join(directory, asset);
await writeFile(archivePath, archive);
await writeFile(join(directory, `${asset}.sha256`), check);
const unpack = spawnSync(
  "tar",
  [windows ? "-xf" : "-xzf", archivePath, "-C", directory],
  { stdio: "inherit" },
);
if (unpack.status !== 0) throw new Error("Archive extraction failed.");
const binary = join(directory, windows ? "peri.exe" : "peri");
if (!windows) await chmod(binary, 0o755);
const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
if (result.status !== 0 || !result.stdout.includes(version))
  throw new Error(`Peri version validation failed: ${result.stderr}`);
console.log(
  `${result.stdout.trim()} installed at ${binary}\nSHA256 ${actual}`,
);
