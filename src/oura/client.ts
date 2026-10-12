import { env } from "../config.js";
import { db } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "../crypto.js";

const API_BASE = "https://api.ouraring.com";
const TOKEN_URL = `${API_BASE}/oauth/token`;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const refreshInFlight = new Map<string, Promise<string>>();

type Connection = {
  access_token: string;
  refresh_token: string;
  token_expires_at: Date;
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

async function loadConnection(userId: string): Promise<Connection> {
  const r = await db.query(
    `SELECT access_token, refresh_token, token_expires_at
     FROM connections WHERE user_id=$1 AND provider='oura' AND status='active'`,
    [userId]
  );
  if (!r.rowCount) throw new Error("Oura is not connected");
  return r.rows[0];
}

async function refresh(userId: string, encryptedRefreshToken: string): Promise<string> {
  const existing = refreshInFlight.get(userId);
  if (existing) return existing;

  const work = (async () => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decryptSecret(encryptedRefreshToken),
      client_id: env.OURA_CLIENT_ID,
      client_secret: env.OURA_CLIENT_SECRET
    });
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    if (!response.ok) throw new Error(`Oura refresh failed: ${response.status} ${await response.text()}`);
    const token = (await response.json()) as TokenResponse;

    // Oura refresh tokens are single-use; update access + refresh atomically.
    await db.query(
      `UPDATE connections SET access_token=$2, refresh_token=$3,
         token_expires_at=now() + ($4 * interval '1 second'), updated_at=now()
       WHERE user_id=$1 AND provider='oura'`,
      [userId, encryptSecret(token.access_token), encryptSecret(token.refresh_token), token.expires_in]
    );
    return token.access_token;
  })();

  refreshInFlight.set(userId, work);
  try {
    return await work;
  } finally {
    refreshInFlight.delete(userId);
  }
}

async function getAccessToken(userId: string, forceRefresh = false): Promise<string> {
  const c = await loadConnection(userId);
  const expiresAt = new Date(c.token_expires_at).getTime();
  if (!forceRefresh && expiresAt > Date.now() + 60_000) return decryptSecret(c.access_token);
  return refresh(userId, c.refresh_token);
}

function retryDelayMs(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    const when = Date.parse(retryAfter);
    if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ouraGet<T>(userId: string, path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(path, API_BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let token = await getAccessToken(userId);
  let refreshedAfterUnauthorized = false;
  const maxAttempts = 4;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });

      if (response.status === 401 && !refreshedAfterUnauthorized) {
        token = await getAccessToken(userId, true);
        refreshedAfterUnauthorized = true;
        continue;
      }

      if (response.ok) return response.json() as Promise<T>;

      const body = await response.text();
      if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts - 1) {
        throw new Error(`Oura API ${path} failed: ${response.status} ${body}`);
      }
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
      if (response && !RETRYABLE_STATUS.has(response.status)) throw error;
    }

    await sleep(retryDelayMs(response, attempt));
  }

  throw new Error(`Oura API ${path} failed after retries`);
}
