import type { IncomingMessage, ServerResponse } from "node:http";
import { PRODUCT_VERSION, getConnections, getSyncStatus, getUserProfile, triggerSync } from "../services/health-platform.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function validDate(value: string | null) {
  return value == null || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  userId: string
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
