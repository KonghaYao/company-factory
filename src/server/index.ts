import { websocket } from "@hono/bun";
import { createApplication } from "./app";
const hostname = process.env.COMPANY_HOST ?? "127.0.0.1";
if (
  !["127.0.0.1", "localhost", "::1"].includes(hostname) &&
  !process.env.COMPANY_WEB_TOKEN
)
  throw new Error(
    "Non-loopback hosting requires COMPANY_WEB_TOKEN and an explicit COMPANY_BASE_URL",
  );
const port = Number(process.env.PORT ?? 3000);
const application = await createApplication({
  baseUrl: process.env.COMPANY_BASE_URL ?? `http://${hostname}:${port}`,
});
const server = Bun.serve({
  hostname,
  port,
  fetch: application.app.fetch,
  websocket,
  idleTimeout: 60,
});
console.log(
  `Company Factory: http://${hostname}:${server.port}/#access=${application.ownerToken}\nData: ${application.root}\nKeep this local access URL private.\nThree Company MCP modules; official Peri runtime + default Workspace.`,
);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    server.stop();
    await application.close();
    process.exit(0);
  });
