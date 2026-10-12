import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../db/pool.js";
import { env } from "../config.js";
import { verifyUserCredentials } from "./service.js";

const OAUTH_SCOPES = ["health:read"];
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_DAYS = 30;

export function mcpResource() {
  return new URL("/mcp", env.BASE_URL).toString();
}

export function oauthIssuer() {
  return new URL("/", env.BASE_URL).toString().replace(/\/$/, "");
}

export function protectedResourceMetadataUrl() {
  return new URL("/.well-known/oauth-protected-resource", env.BASE_URL).toString();
}

function hashToken(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier: string) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff"
  });
  res.end(html);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readBody(req: IncomingMessage, limit = 32_768) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req: IncomingMessage) {
  return new URLSearchParams(await readBody(req));
}

async function readJson(req: IncomingMessage) {
  const raw = await readBody(req);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function parseScopes(scope: string | null) {
  const requested = (scope ?? OAUTH_SCOPES.join(" ")).split(/\s+/).filter(Boolean);
  if (requested.length === 0 || requested.some((item) => !OAUTH_SCOPES.includes(item))) {
    throw new Error("invalid_scope");
  }
  return [...new Set(requested)];
}

function validRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}

async function getClient(clientId: string) {
  const result = await db.query(
    `SELECT client_id, client_name, redirect_uris, token_endpoint_auth_method
       FROM oauth_clients WHERE client_id=$1 LIMIT 1`,
    [clientId]
  );
  return result.rows[0] ?? null;
}

function authorizeHtml(params: Record<string, string>, clientName: string, error?: string) {
  const hidden = Object.entries(params)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize AI Health Connection</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:64px auto;padding:0 24px;line-height:1.5;color:#18212b"><h1>Connect AI Health Connection</h1><p><strong>${escapeHtml(clientName)}</strong> is requesting read access to your synced health data.</p>${error ? `<p style="color:#b42318">${escapeHtml(error)}</p>` : ""}<form method="post" action="/oauth/authorize">${hidden}<label>Email<br><input name="email" type="email" autocomplete="username" required style="width:100%;padding:10px;margin:6px 0 16px"></label><label>Password<br><input name="password" type="password" autocomplete="current-password" required style="width:100%;padding:10px;margin:6px 0 20px"></label><button type="submit" style="padding:10px 18px">Authorize ChatGPT</button></form><p style="margin-top:24px;color:#667085;font-size:13px">This grants ChatGPT access only to the account you authenticate here. You can revoke access by deleting the OAuth token from AI Health Connection.</p></body></html>`;
}

async function validateAuthorizationParams(params: URLSearchParams) {
  const responseType = params.get("response_type") ?? "";
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const codeChallengeMethod = params.get("code_challenge_method") ?? "";
  const state = params.get("state") ?? "";
  const resource = params.get("resource") ?? "";
  const scopes = parseScopes(params.get("scope"));

  if (responseType !== "code") throw new Error("unsupported_response_type");
  if (!clientId || !redirectUri || !codeChallenge || !state) throw new Error("invalid_request");
  if (codeChallengeMethod !== "S256") throw new Error("invalid_request");
  if (resource !== mcpResource()) throw new Error("invalid_target");

  const client = await getClient(clientId);
  if (!client) throw new Error("invalid_client");
  const redirectUris = Array.isArray(client.redirect_uris) ? client.redirect_uris.map(String) : [];
  if (!redirectUris.includes(redirectUri)) throw new Error("invalid_redirect_uri");

  return {
    client,
    clientId,
    redirectUri,
    codeChallenge,
    state,
    resource,
    scopes
  };
}

async function issueTokens(userId: string, clientId: string, scopes: string[], resource: string) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  await db.query(
    `INSERT INTO oauth_tokens(user_id, client_id, access_token_hash, refresh_token_hash, scopes, resource, access_expires_at, refresh_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 second'), now() + ($8 * interval '1 day'))`,
    [userId, clientId, hashToken(accessToken), hashToken(refreshToken), scopes, resource, ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS]
  );
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: scopes.join(" ")
  };
}

export async function authenticateOAuthAccessToken(token: string) {
  if (!token) return null;
  const result = await db.query(
    `UPDATE oauth_tokens
        SET last_used_at=now()
      WHERE access_token_hash=$1 AND access_expires_at > now() AND resource=$2
      RETURNING user_id, scopes, resource`,
    [hashToken(token), mcpResource()]
  );
  if (result.rowCount !== 1) return null;
  return {
    userId: String(result.rows[0].user_id),
    scopes: Array.isArray(result.rows[0].scopes) ? result.rows[0].scopes.map(String) : [],
    resource: String(result.rows[0].resource)
  };
}

async function handleRegistration(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readJson(req);
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((v): v is string => typeof v === "string") : [];
    const authMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
    if (!redirectUris.length || redirectUris.some((uri) => !validRedirectUri(uri))) {
      return sendJson(res, 400, { error: "invalid_redirect_uri" });
    }
    if (authMethod !== "none") return sendJson(res, 400, { error: "invalid_client_metadata" });
    const clientId = `aihc_${randomToken(24)}`;
    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "ChatGPT";
    await db.query(
      `INSERT INTO oauth_clients(client_id, client_name, redirect_uris, token_endpoint_auth_method)
       VALUES ($1, $2, $3, 'none')`,
      [clientId, clientName, redirectUris]
    );
    return sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    });
  } catch {
    return sendJson(res, 400, { error: "invalid_client_metadata" });
  }
}

async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL) {
  const params = req.method === "POST" ? await readForm(req) : url.searchParams;
  try {
    const validated = await validateAuthorizationParams(params);
    const preserved: Record<string, string> = {};
    for (const key of ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"]) {
      const value = params.get(key);
      if (value != null) preserved[key] = value;
    }

    if (req.method === "GET") {
      return sendHtml(res, 200, authorizeHtml(preserved, String(validated.client.client_name ?? "ChatGPT")));
    }

    const email = params.get("email") ?? "";
    const password = params.get("password") ?? "";
    const user = await verifyUserCredentials(email, password);
    if (!user) {
      return sendHtml(res, 401, authorizeHtml(preserved, String(validated.client.client_name ?? "ChatGPT"), "Invalid email or password"));
    }

    const code = randomToken();
    await db.query(
      `INSERT INTO oauth_authorization_codes(code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes')`,
      [hashToken(code), validated.clientId, user.id, validated.redirectUri, validated.codeChallenge, validated.scopes, validated.resource]
    );
    const redirect = new URL(validated.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", validated.state);
    redirect.searchParams.set("iss", oauthIssuer());
    res.writeHead(302, { location: redirect.toString(), "cache-control": "no-store" });
    return res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_request";
    return sendJson(res, 400, { error: message });
  }
}

async function handleToken(req: IncomingMessage, res: ServerResponse) {
  const form = await readForm(req);
  const grantType = form.get("grant_type") ?? "";
  const clientId = form.get("client_id") ?? "";
  const resource = form.get("resource") ?? "";
  if (!clientId || resource !== mcpResource()) return sendJson(res, 400, { error: "invalid_request" });
  const client = await getClient(clientId);
  if (!client) return sendJson(res, 401, { error: "invalid_client" });

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    if (!code || !redirectUri || !verifier) return sendJson(res, 400, { error: "invalid_request" });
    const result = await db.query(
      `DELETE FROM oauth_authorization_codes
        WHERE code_hash=$1 AND expires_at > now()
        RETURNING client_id, user_id, redirect_uri, code_challenge, scopes, resource`,
      [hashToken(code)]
    );
    if (result.rowCount !== 1) return sendJson(res, 400, { error: "invalid_grant" });
    const row = result.rows[0];
    if (String(row.client_id) !== clientId || String(row.redirect_uri) !== redirectUri || String(row.resource) !== resource || pkceChallenge(verifier) !== String(row.code_challenge)) {
      return sendJson(res, 400, { error: "invalid_grant" });
    }
    const scopes = Array.isArray(row.scopes) ? row.scopes.map(String) : [];
    return sendJson(res, 200, await issueTokens(String(row.user_id), clientId, scopes, resource));
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token") ?? "";
    if (!refreshToken) return sendJson(res, 400, { error: "invalid_request" });
    const result = await db.query(
      `DELETE FROM oauth_tokens
        WHERE refresh_token_hash=$1 AND refresh_expires_at > now() AND client_id=$2 AND resource=$3
        RETURNING user_id, scopes`,
      [hashToken(refreshToken), clientId, resource]
    );
    if (result.rowCount !== 1) return sendJson(res, 400, { error: "invalid_grant" });
    const scopes = Array.isArray(result.rows[0].scopes) ? result.rows[0].scopes.map(String) : [];
    return sendJson(res, 200, await issueTokens(String(result.rows[0].user_id), clientId, scopes, resource));
  }

  return sendJson(res, 400, { error: "unsupported_grant_type" });
}

export async function handleOAuthRequest(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/mcp/.well-known/oauth-protected-resource")) {
    sendJson(res, 200, {
      resource: mcpResource(),
      authorization_servers: [oauthIssuer()],
      scopes_supported: OAUTH_SCOPES,
      resource_documentation: new URL("/", env.BASE_URL).toString()
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer: oauthIssuer(),
      authorization_endpoint: new URL("/oauth/authorize", env.BASE_URL).toString(),
      token_endpoint: new URL("/oauth/token", env.BASE_URL).toString(),
      registration_endpoint: new URL("/oauth/register", env.BASE_URL).toString(),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: OAUTH_SCOPES,
      authorization_response_iss_parameter_supported: true
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/register") {
    await handleRegistration(req, res);
    return true;
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/oauth/authorize") {
    await handleAuthorize(req, res, url);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    await handleToken(req, res);
    return true;
  }

  return false;
}
