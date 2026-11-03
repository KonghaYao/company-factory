import { McpServer } from "@modelcontextprotocol/server";
import { createGatewayRoutes } from "@peri-code/mcpp/gateway";
import {
  MODULE_OPERATIONS,
  READ_OPERATIONS,
  schemas,
  type CompanyModule,
} from "./operations";
import type { CallerContext } from "../domain/types";
import type { AccessControl } from "./security";

export type Dispatch = (
  module: CompanyModule,
  operation: string,
  caller: CallerContext,
  input: Record<string, unknown>,
) => Promise<unknown>;
/** Exactly three Company MCP modules; each request reconstructs a trusted identity. */
export function createCompanyMcp(access: AccessControl, dispatch: Dispatch) {
  const identities = new WeakMap<Request, CallerContext>();
  const gateway = createGatewayRoutes(
    (Object.keys(MODULE_OPERATIONS) as CompanyModule[]).map((module) => ({
      path: `/${module}/mcp`,
      createServer: async (context) => {
        const request = context.requestInfo;
        if (!request) throw new Error("HTTP identity is required");
        const caller = identities.get(request) ?? (await access.agent(request));
        const server = new McpServer(
          { name: module, version: "1.0.0" },
          {
            capabilities: { resources: { subscribe: true, listChanged: true } },
          },
        );
        for (const operation of MODULE_OPERATIONS[module]) {
          server.registerTool(
            operation,
            {
              description: `Company ${operation}. Identity is bound to the host credential. Mutations require requestId; versioned edits require expectedVersion. Errors: forbidden, not_current_owner, version_conflict, idempotency_conflict.${operation === "listIssues" ? " Returns {items,nextCursor}: bounded current-work summaries; use includeHistory/status for archived work and getIssue for full details." : operation === "workspace" ? " Returns a bounded profile and independent Issue, participating IM thread, and Preview summary indexes, including unanswered outgoing threads and accessible historical batches. Follow nextCursor as cursor, nextThreadCursor as threadCursor, and nextPreviewCursor as previewCursor. limit applies to each index; includeHistory/status filter Issues only. Read CLAUDE.md, getIssue, company_im.thread, and getPreview for details." : operation === "inbox" ? " Returns the caller's own received messages. Agent callers may pass only their own agentId; querying another Agent returns forbidden. Use thread(threadId) for a thread you participate in. Owner callers may pass agentId." : operation === "updates" ? " Newest-first immutable progress history; use getIssue for current todos." : operation === "addUpdate" ? " Append an immutable progress/blocker/decision record; does not change status." : operation === "updateTodos" ? " Update the ordered todo list; current owner or owner user; expectedVersion required; Agent callers must include a concise note, appended as an immutable update." : ""}`,
              inputSchema: schemas[operation],
              annotations: {
                readOnlyHint: READ_OPERATIONS.has(operation),
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: false,
              },
            },
            async (input) => {
              try {
                const result = await dispatch(
                  module,
                  operation,
                  caller,
                  (input ?? {}) as Record<string, unknown>,
                );
                return {
                  content: [
                    { type: "text" as const, text: JSON.stringify(result) },
                  ],
                };
              } catch (error) {
                const e = error as {
                  code?: string;
                  message?: string;
                  details?: unknown;
                };
                return {
                  isError: true,
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        error: {
                          code: e.code ?? "internal_error",
                          message: e.message ?? "Request failed",
                          details: e.details,
                        },
                      }),
                    },
                  ],
                };
              }
            },
          );
        }
        const uri = `company://current/${module}`;
        server.registerResource(
          module,
          uri,
          {
            title: module,
            mimeType: "application/json",
            description:
              "Current authenticated Company facts; subscription invalidates this view.",
          },
          async () => {
            const operation =
              module === "company_org"
                ? "organization"
                : module === "company_tasks"
                  ? "workspace"
                  : "inbox";
            const value = await dispatch(module, operation, caller, {
              agentId: caller.id,
            });
            return {
              contents: [
                {
                  uri,
                  mimeType: "application/json",
                  text: JSON.stringify(value),
                },
              ],
            };
          },
        );
        return server;
      },
    })),
  );
  return {
    paths: gateway.routes.map((route) => route.path),
    async fetch(request: Request) {
      identities.set(request, await access.agent(request));
      return gateway.fetch(request);
    },
    changed(kind?: string) {
      for (const endpoint of gateway.endpoints) {
        if (kind && !endpoint.path.includes(kind)) continue;
        const module = endpoint.path.split("/")[1];
        endpoint.subscriptions.resourceUpdated(`company://current/${module}`);
      }
    },
    close: gateway.close,
  };
}
