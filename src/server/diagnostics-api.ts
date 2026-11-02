import { Hono } from "hono";
import type { DiagnosticsSink } from "../runtime/diagnostics";
import type { AccessControl } from "./security";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Owner-only, read-only runtime diagnostics.
 *
 * Authentication reuses the existing `company_session` cookie. There is no
 * write/delete endpoint, no path parameter and no raw file response.
 */
export function createDiagnosticsApi(deps: {
  diagnostics: DiagnosticsSink;
  access: AccessControl;
}): Hono {
  const api = new Hono();

  api.get("/api/diagnostics/runtime", async (c) => {
    deps.access.user(c.req.raw, "");
    const raw = c.req.query("limit");
    let limit = DEFAULT_LIMIT;
    if (raw !== undefined) {
      if (!/^\d+$/.test(raw))
        return c.json(
          { ok: false, code: "invalid_limit", message: `limit must be an integer from 1 to ${MAX_LIMIT}` },
          400,
        );
      limit = Number(raw);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
        return c.json(
          { ok: false, code: "invalid_limit", message: `limit must be an integer from 1 to ${MAX_LIMIT}` },
          400,
        );
    }

    const result = await deps.diagnostics.read(limit);
    return c.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      ...result,
      returned: result.entries.length,
    });
  });

  return api;
}
