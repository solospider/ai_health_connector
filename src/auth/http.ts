import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "../config.js";
import { authenticateOAuthAccessToken, protectedResourceMetadataUrl } from "./oauth.js";
import { authenticateSessionToken } from "./service.js";

export function requestSessionToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim() || null;

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "aihc_session") return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function authenticatedUserId(req: IncomingMessage): Promise<string | null> {
  const token = requestSessionToken(req);
  if (token) {
    const sessionUserId = await authenticateSessionToken(token);
    if (sessionUserId) return sessionUserId;
    const oauth = await authenticateOAuthAccessToken(token);
    if (oauth) return oauth.userId;
  }
  if (!env.AUTH_REQUIRED) return env.DEV_USER_ID;
  return null;
}

export function setSessionCookie(res: ServerResponse, token: string, expiresAt: string) {
  const secure = env.BASE_URL.startsWith("https://") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `aihc_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(expiresAt).toUTCString()}${secure}`
  );
}

export function clearSessionCookie(res: ServerResponse) {
  const secure = env.BASE_URL.startsWith("https://") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `aihc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  );
}

export function sendUnauthorized(res: ServerResponse, scope = "health:read") {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${protectedResourceMetadataUrl()}", scope="${scope}"`
  );
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify({ error: "Authentication required" }));
}
