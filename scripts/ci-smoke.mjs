import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const expectedUserId = process.env.DEV_USER_ID ?? "00000000-0000-0000-0000-000000000001";
const databaseUrl = process.env.DATABASE_URL;
const inviteCode = process.env.REGISTRATION_INVITE_CODE;

if (!databaseUrl) throw new Error("DATABASE_URL is required for CI smoke tests");

async function request(path, options = {}) {
  return fetch(new URL(path, baseUrl), { redirect: "manual", ...options });
}

async function json(path, options = {}) {
  const response = await request(path, options);
  const body = await response.json();
  return { response, body };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function register(email) {
  const { response, body } = await json("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple", invite_code: inviteCode })
  });
  assert.equal(response.status, 201);
  assert.equal(body.user.email, email);
  assert.ok(body.access_token);
  assert.ok(response.headers.get("set-cookie")?.includes("HttpOnly"));
  return body;
}

const checks = [];
function passed(name) {
  checks.push(name);
  console.log(`✓ ${name}`);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1::text[])`,
    [["users", "sessions", "oauth_clients", "oauth_authorization_codes", "oauth_tokens", "connections", "oauth_states", "raw_provider_records", "daily_metrics", "heart_rate_samples"]]
  );
  assert.equal(tables.rowCount, 10);
  passed("database schema contains auth, OAuth, and health tables");

  const userRow = await client.query(`SELECT id, timezone FROM users WHERE id=$1`, [expectedUserId]);
  assert.equal(userRow.rowCount, 1);
  passed("database initialization remains backwards compatible with development user");

  {
    const { response, body } = await json("/api/v1/health");
    assert.equal(response.status, 200);
    assert.equal(body.service, "AI Health Connection");
    assert.equal(body.status, "ok");
    assert.equal(body.version, "1.2.0");
    passed("public health endpoint remains available");
  }

  {
    const signupPage = await request("/signup");
    assert.equal(signupPage.status, 200);
    const html = await signupPage.text();
    assert.match(html, /Create account &amp; Connect Oura/);
    assert.doesNotMatch(signupPage.headers.get("content-security-policy") ?? "", /form-action/);

    const signupForm = new URLSearchParams({
      email: "onboarding@example.com",
      password: "correct-horse-battery-staple",
      confirm_password: "correct-horse-battery-staple"
    });
    if (inviteCode) signupForm.set("invite_code", inviteCode);
    const signup = await request("/signup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: signupForm.toString()
    });
    assert.equal(signup.status, 303);
    assert.equal(signup.headers.get("location"), "/auth/oura/start");
    const setCookie = signup.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /aihc_session=/);
    const cookie = setCookie.split(";")[0];

    const ouraStart = await request("/auth/oura/start", { headers: { cookie } });
    assert.equal(ouraStart.status, 302);
    const ouraLocation = new URL(ouraStart.headers.get("location"));
    assert.equal(ouraLocation.hostname, "cloud.ouraring.com");
    const state = ouraLocation.searchParams.get("state");
    assert.ok(state);
    const onboardingUser = await client.query(`SELECT id FROM users WHERE email='onboarding@example.com' LIMIT 1`);
    assert.equal(onboardingUser.rowCount, 1);
    const stateRow = await client.query(`SELECT user_id FROM oauth_states WHERE state=$1`, [state]);
    assert.equal(String(stateRow.rows[0].user_id), String(onboardingUser.rows[0].id));
    passed("browser signup creates a session and continues directly into user-bound Oura OAuth");
  }

  {
    const { response, body } = await json("/.well-known/oauth-protected-resource");
    assert.equal(response.status, 200);
    assert.equal(body.resource, `${baseUrl}/mcp`);
    assert.deepEqual(body.scopes_supported, ["health:read"]);
    assert.deepEqual(body.authorization_servers, [baseUrl]);
    passed("protected resource metadata is discoverable");
  }

  {
    const { response, body } = await json("/.well-known/oauth-authorization-server");
    assert.equal(response.status, 200);
    assert.equal(body.issuer, baseUrl);
    assert.equal(body.authorization_endpoint, `${baseUrl}/oauth/authorize`);
    assert.equal(body.token_endpoint, `${baseUrl}/oauth/token`);
    assert.equal(body.registration_endpoint, `${baseUrl}/oauth/register`);
    assert.ok(body.code_challenge_methods_supported.includes("S256"));
    assert.equal(body.authorization_response_iss_parameter_supported, true);
    passed("OAuth authorization server metadata advertises RFC 9207 issuer identification");
  }

  {
    const { response, body } = await json("/api/v1/me");
    assert.equal(response.status, 401);
    assert.equal(body.error, "Authentication required");
    assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    passed("protected endpoints reject anonymous requests with OAuth discovery challenge");
  }

  const userA = await register("alice@example.com");
  const userB = await register("bob@example.com");
  assert.notEqual(userA.user.id, userB.user.id);
  passed("two users can register independently");

  await client.query(
    `INSERT INTO connections(user_id, provider, access_token, refresh_token, scopes, token_expires_at)
     VALUES ($1, 'oura', 'test-access', 'test-refresh', ARRAY['daily'], now() + interval '1 hour')`,
    [userA.user.id]
  );

  {
    const a = await json("/api/v1/connections", { headers: bearer(userA.access_token) });
    const b = await json("/api/v1/connections", { headers: bearer(userB.access_token) });
    assert.equal(a.body.connections.length, 1);
    assert.deepEqual(b.body.connections, []);
    passed("connection data is isolated by authenticated user_id");
  }

  {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const registration = await json("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT CI",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      })
    });
    assert.equal(registration.response.status, 201);
    const clientId = registration.body.client_id;
    assert.ok(clientId);

    const authorize = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "health:read",
      state: "ci-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${baseUrl}/mcp`
    });

    const authorizePage = await request(`/oauth/authorize?${authorize.toString()}`);
    assert.equal(authorizePage.status, 200);
    assert.doesNotMatch(authorizePage.headers.get("content-security-policy") ?? "", /form-action/);
    passed("authorization page CSP does not block the OAuth form submission");

    const form = new URLSearchParams(authorize);
    form.set("email", "alice@example.com");
    form.set("password", "correct-horse-battery-staple");
    const approval = await request("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    assert.equal(approval.status, 303);
    const callback = new URL(approval.headers.get("location"));
    assert.equal(callback.searchParams.get("state"), "ci-state");
    assert.equal(callback.searchParams.get("iss"), baseUrl);
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${baseUrl}/mcp`
    });
    const token = await json("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenForm.toString()
    });
    assert.equal(token.response.status, 200);
    assert.equal(token.body.token_type, "Bearer");
    assert.ok(token.body.access_token);
    assert.ok(token.body.refresh_token);

    const me = await json("/api/v1/me", { headers: bearer(token.body.access_token) });
    assert.equal(me.response.status, 200);
    assert.equal(me.body.user.id, userA.user.id);
    passed("stable ChatGPT callback + 303 redirect + issuer identification + PKCE issues a user-bound OAuth token");
  }

  {
    const response = await request("/auth/oura/start", { headers: bearer(userA.access_token) });
    assert.equal(response.status, 302);
    const location = response.headers.get("location");
    assert.ok(location);
    const authorizationUrl = new URL(location);
    const state = authorizationUrl.searchParams.get("state");
    const stateRow = await client.query(`SELECT user_id FROM oauth_states WHERE state=$1`, [state]);
    assert.equal(String(stateRow.rows[0].user_id), userA.user.id);
    passed("Oura OAuth state is bound to authenticated user");
  }

  {
    const response = await request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
    passed("MCP rejects anonymous requests and advertises OAuth metadata");
  }

  {
    const logout = await json("/api/v1/auth/logout", {
      method: "POST",
      headers: bearer(userB.access_token)
    });
    assert.equal(logout.response.status, 200);
    const after = await json("/api/v1/me", { headers: bearer(userB.access_token) });
    assert.equal(after.response.status, 401);
    passed("logout revokes the session token");
  }

  {
    const response = await request("/healthz");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, "1.2.0");
    passed("legacy health endpoint remains compatible");
  }

  console.log(`\n${checks.length} smoke regression checks passed.`);
} finally {
  await client.end();
}
