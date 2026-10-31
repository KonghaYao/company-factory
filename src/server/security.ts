import { timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { CallerContext } from "../domain/types";

export class AccessError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 403,
  ) {
    super(message);
  }
}
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Local single-user UI and independent per-agent bearer identities. Never trusts input.role/id. */
export class AccessControl {
  private readonly webSession = crypto.randomUUID() + crypto.randomUUID();
  constructor(
    readonly root: string,
    readonly baseUrl: string,
    readonly webToken?: string,
  ) {}
  allowed(request: Request) {
    const expected = new URL(this.baseUrl);
    const incoming = new URL(request.url);
    const allowedHosts = new Set([expected.host]);
    if (["127.0.0.1", "localhost", "[::1]"].includes(expected.hostname)) {
      allowedHosts.add(`localhost:${expected.port || "80"}`);
      allowedHosts.add(`127.0.0.1:${expected.port || "80"}`);
    }
    if (!allowedHosts.has(incoming.host))
      throw new AccessError("forbidden", "Unrecognized host");
    const origin = request.headers.get("origin");
    if (origin && !allowedHosts.has(new URL(origin).host))
      throw new AccessError("forbidden", "Cross-origin requests are rejected");
    const site = request.headers.get("sec-fetch-site");
    if (site === "cross-site")
      throw new AccessError("forbidden", "Cross-site requests are rejected");
  }
  private hasCookie(request: Request) {
    return (request.headers.get("cookie") || "")
      .split(";")
      .some((value) =>
        equal(value.trim(), `company_session=${this.webSession}`),
      );
  }
  cookie() {
    return `company_session=${this.webSession}; HttpOnly; SameSite=Strict; Path=/`;
  }
  bootstrap(request: Request) {
    this.allowed(request);
    if (!this.hasCookie(request))
      throw new AccessError(
        "unauthorized",
        "Sign in with COMPANY_WEB_TOKEN",
        401,
      );
    return this.cookie();
  }
  login(request: Request, token: string) {
    this.allowed(request);
    if (!this.webToken || !equal(token, this.webToken))
      throw new AccessError("unauthorized", "Invalid local access token", 401);
    return this.cookie();
  }
  user(request: Request, companyId: string): CallerContext {
    this.allowed(request);
    if (!this.hasCookie(request))
      throw new AccessError(
        "unauthorized",
        "Open the Company workbench first",
        401,
      );
    return { type: "user", id: "owner", companyId };
  }
  async agent(request: Request): Promise<CallerContext> {
    this.allowed(request);
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer "))
      throw new AccessError(
        "unauthorized",
        "An agent bearer credential is required",
        401,
      );
    const token = authorization.slice(7);
    if (token.length < 32 || token.length > 512)
      throw new AccessError("unauthorized", "Invalid agent credential", 401);
    for (const entry of await readdir(join(this.root, "agents"), {
      withFileTypes: true,
    }).catch(() => [])) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name))
        continue;
      const agent = await readFile(
        join(this.root, "agents", entry.name, "agent.yaml"),
        "utf8",
      )
        .then(parse)
        .catch(() => null);
      if (agent?.authToken && equal(token, String(agent.authToken)))
        return { type: "agent", id: agent.agentId, companyId: agent.companyId };
    }
    throw new AccessError("unauthorized", "Unknown agent credential", 401);
  }
}
