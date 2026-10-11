import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { env } from "./config.js";
import { db } from "./db/pool.js";
import { createHealthMcpServer } from "./mcp/server.js";
import { createOuraAuthorizationUrl, finishOuraAuthorization } from "./oura/oauth.js";
import { syncOura } from "./oura/sync.js";

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: import("node:http").ServerResponse, status: number, html: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function defaultSyncRange() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 89);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10)
  };
}

const httpServer = createServer(async (req, res) => {
  try {
    if (!req.url) return void res.writeHead(400).end("Missing URL");
    const url = new URL(req.url, env.BASE_URL);

    if (req.method === "GET" && url.pathname === "/") {
      const connection = await db.query(
        `SELECT status, scopes, last_sync_at FROM connections WHERE user_id=$1 AND provider='oura'`,
        [env.DEV_USER_ID]
      );
      const connected = Boolean(connection.rowCount);
      return void sendHtml(
        res,
        200,
        `<!doctype html><html><body style="font-family:system-ui;max-width:680px;margin:48px auto;padding:0 20px">
          <h1>Personal Health Data MVP</h1>
          <p>Oura: <strong>${connected ? "connected" : "not connected"}</strong></p>
          ${connected ? `<p>Last sync: ${connection.rows[0].last_sync_at ?? "never"}</p><a href="/sync/oura">Sync last 90 days</a>` : `<a href="/auth/oura/start">Connect Oura</a>`}
          <p>MCP endpoint: <code>${env.BASE_URL}/mcp</code></p>
        </body></html>`
      );
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      return void sendJson(res, 200, { ok: true });
    }

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

    if (req.method === "GET" && url.pathname === "/sync/oura") {
      const defaults = defaultSyncRange();
      const start = url.searchParams.get("start") ?? defaults.start;
      const end = url.searchParams.get("end") ?? defaults.end;
      const counts = await syncOura(env.DEV_USER_ID, start, end);
      return void sendJson(res, 200, { synced: true, start, end, counts });
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
  console.log(`Health MVP listening at ${env.BASE_URL}`);
  console.log(`MCP endpoint: ${env.BASE_URL}/mcp`);
});
