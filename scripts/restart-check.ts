/**
 * Read-only restart gate. It logs in as the owner, asks the running service
 * whether any Agent has unfinished work, and maps the answer to an exit code.
 * It never stops, starts, signals or spawns a process, and never prints the
 * owner token or session cookie.
 *
 * Exit codes: 0 SAFE, 2 BUSY, 3 UNVERIFIED, 1 usage/missing token.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RestartReadinessResult } from "../src/server/restart-readiness";

export interface RestartCheckOptions {
  baseUrl: string;
  token: string;
  companyId?: string;
  fetchImpl?: typeof fetch;
}
export interface RestartCheckOutcome {
  code: 0 | 2 | 3;
  httpStatus: number;
  result?: RestartReadinessResult;
  message?: string;
}

function endpoint(baseUrl: string, path: string) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
}

function sessionCookie(response: Response): string | null {
  const header = response.headers.get("set-cookie");
  const cookie = header?.split(";")[0]?.trim();
  return cookie?.startsWith("company_session=") ? cookie : null;
}

/** Login and query readiness. Network/login/parse failures are UNVERIFIED (3). */
export async function requestRestartReadiness(
  options: RestartCheckOptions,
): Promise<RestartCheckOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint(options.baseUrl, "/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: options.token }),
    });
  } catch {
    return { code: 3, httpStatus: 0, message: "无法连接服务" };
  }
  if (!response.ok)
    return {
      code: 3,
      httpStatus: response.status,
      message: "Owner 登录失败，无法确认人员状态",
    };
  const cookie = sessionCookie(response);
  if (!cookie)
    return {
      code: 3,
      httpStatus: response.status,
      message: "Owner 登录未返回会话，无法确认人员状态",
    };

  const url = endpoint(options.baseUrl, "/api/restart-readiness");
  if (options.companyId) url.searchParams.set("companyId", options.companyId);
  try {
    response = await fetchImpl(url, { headers: { cookie } });
  } catch {
    return { code: 3, httpStatus: 0, message: "无法连接服务" };
  }

  let result: RestartReadinessResult | undefined;
  try {
    const body = await response.json();
    if (body && typeof body === "object")
      result = body as RestartReadinessResult;
  } catch {
    // Unparseable bodies are never treated as a safe answer.
  }

  if (
    response.status === 200 &&
    result?.verified === true &&
    result.safeToRestart === true
  )
    return { code: 0, httpStatus: 200, result };
  if (response.status === 409 && result?.verified === true)
    return { code: 2, httpStatus: 409, result };
  if (response.status === 409)
    return {
      code: 3,
      httpStatus: 409,
      result,
      message: "服务报告忙，但响应不完整；按 UNVERIFIED 处理",
    };
  if (response.status === 503)
    return {
      code: 3,
      httpStatus: 503,
      result,
      message: "无法确认所有人员状态；按失败闭合处理",
    };
  return {
    code: 3,
    httpStatus: response.status,
    result,
    message: "重启检查返回了未预期状态",
  };
}

interface CliOptions {
  json: boolean;
  companyId?: string;
  baseUrl?: string;
  help: boolean;
}
class UsageError extends Error {}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--company") {
      const value = argv[++index];
      if (!value) throw new UsageError("--company 需要公司 ID");
      options.companyId = value;
    } else if (arg.startsWith("--company=")) {
      const value = arg.slice("--company=".length);
      if (!value) throw new UsageError("--company 需要公司 ID");
      options.companyId = value;
    } else if (arg === "--base-url") {
      const value = argv[++index];
      if (!value) throw new UsageError("--base-url 需要 URL");
      options.baseUrl = value;
    } else if (arg.startsWith("--base-url=")) {
      const value = arg.slice("--base-url=".length);
      if (!value) throw new UsageError("--base-url 需要 URL");
      options.baseUrl = value;
    } else throw new UsageError(`未知参数: ${arg}`);
  }
  return options;
}

async function ownerToken(): Promise<string | undefined> {
  const fromEnv = process.env.COMPANY_WEB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const home = process.env.COMPANY_HOME ?? join(homedir(), ".company");
  try {
    return (await readFile(join(home, "owner-token"), "utf8")).trim();
  } catch {
    return undefined;
  }
}

function defaultBaseUrl() {
  return (
    process.env.COMPANY_BASE_URL ??
    `http://${process.env.COMPANY_HOST ?? "127.0.0.1"}:${process.env.PORT ?? "3000"}`
  );
}

function printOutcome(outcome: RestartCheckOutcome, json: boolean) {
  if (json) {
    console.log(
      JSON.stringify(
        outcome.result ?? {
          status: outcome.httpStatus,
          message: outcome.message,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (outcome.code === 0) {
    const result = outcome.result!;
    console.log(
      `SAFE  server=${result.serverVersion} checkedAt=${result.checkedAt}`,
    );
    console.log("可以安全重启。");
    return;
  }
  if (outcome.code === 2) {
    const result = outcome.result!;
    console.log(
      `BUSY  server=${result.serverVersion} checkedAt=${result.checkedAt}`,
    );
    for (const agent of result.busy)
      console.log(
        `- ${agent.companyName} / ${agent.name} (${agent.agentId}) ` +
          `status=${agent.status} reasons=${agent.reasons.join(",")}` +
          (agent.sessionId ? ` session=${agent.sessionId}` : "") +
          (agent.threadId ? ` thread=${agent.threadId}` : "") +
          (agent.archived ? " archived=true" : ""),
      );
    console.log("不得重启；等待上述工作结束或先核对状态。");
    return;
  }
  console.log(`UNVERIFIED  http=${outcome.httpStatus}`);
  if (outcome.message) console.log(outcome.message);
  for (const error of outcome.result?.errors ?? [])
    console.log(
      `- ${error.code}${error.companyId ? ` company=${error.companyId}` : ""}` +
        `${error.agentId ? ` agent=${error.agentId}` : ""}: ${error.message}`,
    );
  console.log("不得重启；按失败闭合处理。");
}

function help() {
  console.log(`用法: bun scripts/restart-check.ts [--json] [--company <id>] [--base-url <url>]

只检查，不停止、不启动任何进程。
owner token 依次取 COMPANY_WEB_TOKEN、$COMPANY_HOME/owner-token（默认 ~/.company/owner-token）。

退出码: 0 SAFE / 2 BUSY / 3 UNVERIFIED / 1 用法错误或缺少 token`);
}

async function main(argv: string[]) {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    help();
    return 1;
  }
  if (options.help) {
    help();
    return 0;
  }
  const token = await ownerToken();
  if (!token) {
    console.error(
      "缺少 owner token：请设置 COMPANY_WEB_TOKEN 或准备 $COMPANY_HOME/owner-token。",
    );
    return 1;
  }
  const outcome = await requestRestartReadiness({
    baseUrl: options.baseUrl ?? defaultBaseUrl(),
    token,
    companyId: options.companyId,
  });
  printOutcome(outcome, options.json);
  return outcome.code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
