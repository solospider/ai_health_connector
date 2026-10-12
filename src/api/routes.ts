import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticatedUserId, clearSessionCookie, requestSessionToken, sendUnauthorized, setSessionCookie } from "../auth/http.js";
import { loginUser, registerUser, revokeSessionToken } from "../auth/service.js";
import { PRODUCT_VERSION, getConnections, getSyncStatus, getUserProfile, triggerSync } from "../services/health-platform.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function validDate(value: string | null) {
  return value == null || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/")) return false;

  if (req.method === "GET" && url.pathname === "/api/v1/health") {
    sendJson(res, 200, {
      service: "AI Health Connection",
      status: "ok",
      version: PRODUCT_VERSION,
      timestamp: new Date().toISOString()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/auth/register") {
    try {
      const body = await readJson(req);
      const email = typeof body.email === "string" ? body.email : "";
      const password = typeof body.password === "string" ? body.password : "";
      const inviteCode = typeof body.invite_code === "string" ? body.invite_code : undefined;
      const result = await registerUser(email, password, inviteCode);
      setSessionCookie(res, result.session.token, result.session.expiresAt);
      sendJson(res, 201, { user: result.user, access_token: result.session.token, expires_at: result.session.expiresAt });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Registration failed" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/auth/login") {
    try {
      const body = await readJson(req);
      const email = typeof body.email === "string" ? body.email : "";
      const password = typeof body.password === "string" ? body.password : "";
      const result = await loginUser(email, password);
      setSessionCookie(res, result.session.token, result.session.expiresAt);
      sendJson(res, 200, { user: result.user, access_token: result.session.token, expires_at: result.session.expiresAt });
    } catch {
      sendJson(res, 401, { error: "Invalid email or password" });
    }
    return true;
  }

  const userId = await authenticatedUserId(req);
  if (!userId) {
    sendUnauthorized(res);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {
    const token = requestSessionToken(req);
    if (token) await revokeSessionToken(token);
    clearSessionCookie(res);
    sendJson(res, 200, { status: "logged_out" });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/me") {
    const user = await getUserProfile(userId);
    if (!user) sendJson(res, 404, { error: "User not found" });
    else sendJson(res, 200, { user });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/connections") {
    const connections = await getConnections(userId);
    sendJson(res, 200, { connections });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/sync/status") {
    const status = await getSyncStatus(userId);
    sendJson(res, 200, status);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/sync") {
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    if (!validDate(start) || !validDate(end)) {
      sendJson(res, 400, { error: "start and end must use YYYY-MM-DD" });
      return true;
    }
    if ((start && !end) || (!start && end)) {
      sendJson(res, 400, { error: "start and end must be provided together" });
      return true;
    }
    if (start && end && start > end) {
      sendJson(res, 400, { error: "start must not be after end" });
      return true;
    }

    const result = await triggerSync(userId, start ?? undefined, end ?? undefined);
    sendJson(res, 200, result);
    return true;
  }

  sendJson(res, 404, { error: "API route not found" });
  return true;
}
