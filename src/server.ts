import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleApiRequest } from "./api/routes.js";
import { env } from "./config.js";
import { createHealthMcpServer } from "./mcp/server.js";
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
      const connections = await getConnections(env.DEV_USER_ID);
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
              <h2 style="margin-top:0">Oura connection</h2>
              <p>Status: <strong>${connected ? oura?.status ?? "connected" : "not connected"}</strong></p>
              ${connected ? `<p>Last sync: ${oura?.last_sync_at ?? "never"}</p><p><a href="/sync/oura">Sync last 90 days</a></p>` : `<p><a href="/auth/oura/start">Connect Oura</a></p>`}
            </section>
            <section style="margin-top:28px">
              <h2>Endpoints</h2>
              <ul>
                <li><code>GET /api/v1/health</code></li>
                <li><code>GET /api/v1/me</code></li>
                <li><code>GET /api/v1/connections</code></li>
                <li><code>GET /api/v1/sync/status</code></li>
                <li><code>POST /api/v1/sync</code></li>
                <li><code>POST /mcp</code></li>
              </ul>
            </section>
          </body>
        </html>`
      );
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      return void sendJson(res, 200, { ok: true, service: "AI Health Connection", version: PRODUCT_VERSION });
    }

    if (await handleApiRequest(req, res, url, env.DEV_USER_ID)) return;

    if (req.method === "GET" && url.pathname === "/auth/oura/start") {
      const location = await createOuraAuthorizationUrl(env.DEV_USER_ID);
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
      await finishOuraAuthorization(code, state, scope);
      res.writeHead(302, { location: "/" });
      return void res.end();
    }

    // Backwards-compatible development endpoint. New clients should use POST /api/v1/sync.
    if (req.method === "GET" && url.pathname === "/sync/oura") {
      const start = url.searchParams.get("start") ?? undefined;
      const end = url.searchParams.get("end") ?? undefined;
      const result = await triggerSync(env.DEV_USER_ID, start, end);
      return void sendJson(res, 200, result);
    }

    if (req.method === "OPTIONS" && url.pathname === "/mcp") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization",
        "Access-Control-Expose-Headers": "Mcp-Session-Id"
      });
      return void res.end();
    }

    const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
    if (url.pathname === "/mcp" && req.method && MCP_METHODS.has(req.method)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      // Development MVP: one configured user. Production must derive user identity
      // from authenticated MCP authorization, never from model-supplied tool arguments.
      const mcp = createHealthMcpServer(env.DEV_USER_ID);
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
});
