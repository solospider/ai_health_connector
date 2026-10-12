import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleApiRequest } from "./api/routes.js";
import { authenticatedUserId, sendUnauthorized } from "./auth/http.js";
import { handleOAuthRequest } from "./auth/oauth.js";
import { env } from "./config.js";
import { handleFamilyRequest } from "./family.js";
import { createFamilyHealthMcpServer } from "./mcp/family-server.js";
import { handleOnboardingRequest } from "./onboarding.js";
import { startOuraBackgroundSync } from "./oura/background-sync.js";
import { createOuraAuthorizationUrl, finishOuraAuthorization } from "./oura/oauth.js";
import { PRODUCT_VERSION, getConnections, triggerSync } from "./services/health-platform.js";

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: import("node:http").ServerResponse, status: number, html: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

const httpServer = createServer(async (req, res) => {
  try {
    if (!req.url) return void res.writeHead(400).end("Missing URL");
    const url = new URL(req.url, env.BASE_URL);

    if (req.method === "GET" && url.pathname === "/") {
      const userId = await authenticatedUserId(req);
      const connections = userId ? await getConnections(userId) : [];
      const oura = connections.find((connection) => connection.provider === "oura");
      const connected = Boolean(oura);
      return void sendHtml(
        res,
        200,
        `<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>AI Health Connection</title>
          </head>
          <body style="font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:64px auto;padding:0 24px;line-height:1.5;color:#18212b">
            <p style="font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:12px">AI Health Connection · v${PRODUCT_VERSION}</p>
            <h1 style="font-size:42px;line-height:1.05;margin:12px 0">Your health data, connected to AI.</h1>
            <p style="font-size:18px;color:#4b5563">Connect wearable data once, keep it synchronized, and expose a stable health context to ChatGPT and other authorized AI clients.</p>
            <section style="margin-top:36px;padding:24px;border:1px solid #e5e7eb;border-radius:16px">
              <h2 style="margin-top:0">Account</h2>
              <p>Status: <strong>${userId ? "authenticated" : "not authenticated"}</strong></p>
              ${userId ? `<p>Oura: <strong>${connected ? oura?.status ?? "connected" : "not connected"}</strong></p>${connected ? `<p>Last sync: ${oura?.last_sync_at ?? "never"}</p><p><a href="/sync/oura">Sync last 90 days</a></p>` : `<p><a href="/auth/oura/start">Connect Oura</a></p>`}<p><a href="/family">Manage family profiles</a></p>` : `<p><a href="/signup">Create an account &amp; connect Oura</a></p><p><a href="/login">Already have an account? Sign in</a></p>`}
            </section>
          </body>
        </html>`
      );
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      return void sendJson(res, 200, { ok: true, service: "AI Health Connection", version: PRODUCT_VERSION });
    }

    if (await handleOnboardingRequest(req, res, url)) return;

    if (await handleFamilyRequest(req, res, url)) return;

    if (await handleOAuthRequest(req, res, url)) return;

    if (await handleApiRequest(req, res, url)) return;

    if (req.method === "GET" && url.pathname === "/auth/oura/start") {
      const userId = await authenticatedUserId(req);
      if (!userId) return void sendUnauthorized(res);
      const location = await createOuraAuthorizationUrl(userId);
      res.writeHead(302, { location });
      return void res.end();
    }

    if (req.method === "GET" && url.pathname === "/auth/oura/callback") {
      const error = url.searchParams.get("error");
      if (error) return void sendHtml(res, 400, `<h1>Oura authorization failed</h1><p>${error}</p>`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const scope = url.searchParams.get("scope") ?? undefined;
      if (!code || !state) return void sendJson(res, 400, { error: "Missing code or state" });
      const userId = await finishOuraAuthorization(code, state, scope);
      void triggerSync(userId).catch((syncError) => console.error("Initial Oura backfill failed", syncError));
      res.writeHead(303, { location: "/setup/complete", "cache-control": "no-store" });
      return void res.end();
    }

    if (req.method === "GET" && url.pathname === "/sync/oura") {
      const userId = await authenticatedUserId(req);
      if (!userId) return void sendUnauthorized(res);
      const start = url.searchParams.get("start") ?? undefined;
      const end = url.searchParams.get("end") ?? undefined;
      const result = await triggerSync(userId, start, end);
      return void sendJson(res, 200, result);
    }

    if (req.method === "OPTIONS" && url.pathname === "/mcp") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization",
        "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate"
      });
      return void res.end();
    }

    const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
    if (url.pathname === "/mcp" && req.method && MCP_METHODS.has(req.method)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");

      const userId = await authenticatedUserId(req);
      if (!userId) return void sendUnauthorized(res);
      const mcp = createFamilyHealthMcpServer(userId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404).end("Not Found");
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal error" });
    else res.end();
  }
});

httpServer.listen(env.PORT, () => {
  console.log(`AI Health Connection v${PRODUCT_VERSION} listening at ${env.BASE_URL}`);
  console.log(`REST API: ${env.BASE_URL}/api/v1/health`);
  console.log(`MCP endpoint: ${env.BASE_URL}/mcp`);
  startOuraBackgroundSync();
});
