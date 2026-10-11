import crypto from "node:crypto";
import { env } from "../config.js";
import { db } from "../db/pool.js";
import { encryptSecret } from "../crypto.js";

const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";

function base64urlSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export async function createOuraAuthorizationUrl(userId: string): Promise<string> {
  const state = crypto.randomBytes(32).toString("base64url");
  const codeVerifier = crypto.randomBytes(64).toString("base64url");
  const challenge = base64urlSha256(codeVerifier);

  await db.query(
    `INSERT INTO oauth_states(state, user_id, code_verifier, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [state, userId, codeVerifier]
  );

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.OURA_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.OURA_REDIRECT_URI);
  url.searchParams.set("scope", env.OURA_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

type TokenResponse = {
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export async function finishOuraAuthorization(code: string, state: string, grantedScopes?: string) {
  const result = await db.query(
    `DELETE FROM oauth_states
     WHERE state = $1 AND expires_at > now()
     RETURNING user_id, code_verifier`,
    [state]
  );
  if (result.rowCount !== 1) throw new Error("Invalid or expired OAuth state");

  const { user_id: userId, code_verifier: codeVerifier } = result.rows[0];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.OURA_REDIRECT_URI,
    client_id: env.OURA_CLIENT_ID,
    client_secret: env.OURA_CLIENT_SECRET,
    code_verifier: codeVerifier
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Oura token exchange failed: ${response.status} ${await response.text()}`);
  const token = (await response.json()) as TokenResponse;

  const scopes = (grantedScopes ?? env.OURA_SCOPES).split(/\s+/).filter(Boolean);
  await db.query(
    `INSERT INTO connections(user_id, provider, access_token, refresh_token, scopes, token_expires_at)
     VALUES ($1, 'oura', $2, $3, $4, now() + ($5 * interval '1 second'))
     ON CONFLICT (user_id, provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       scopes = EXCLUDED.scopes,
       token_expires_at = EXCLUDED.token_expires_at,
       status = 'active',
       updated_at = now()`,
    [userId, encryptSecret(token.access_token), encryptSecret(token.refresh_token), scopes, token.expires_in]
  );
  return userId as string;
}
