import assert from "node:assert/strict";
import pg from "pg";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const expectedUserId = process.env.DEV_USER_ID ?? "00000000-0000-0000-0000-000000000001";
const databaseUrl = process.env.DATABASE_URL;
const inviteCode = process.env.REGISTRATION_INVITE_CODE;

if (!databaseUrl) throw new Error("DATABASE_URL is required for CI smoke tests");

async function request(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    redirect: "manual",
    ...options
  });
  return response;
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
    [["users", "sessions", "connections", "oauth_states", "raw_provider_records", "daily_metrics", "heart_rate_samples"]]
  );
  assert.equal(tables.rowCount, 7);
  passed("database schema contains auth and health tables");

  const userRow = await client.query(`SELECT id, timezone FROM users WHERE id=$1`, [expectedUserId]);
  assert.equal(userRow.rowCount, 1);
  passed("database initialization remains backwards compatible with development user");

  {
    const { response, body } = await json("/api/v1/health");
    assert.equal(response.status, 200);
    assert.equal(body.service, "AI Health Connection");
    assert.equal(body.status, "ok");
    assert.equal(body.version, "1.0.0");
    assert.ok(Number.isFinite(Date.parse(body.timestamp)));
    passed("public health endpoint remains available");
  }

  {
    const { response, body } = await json("/api/v1/me");
    assert.equal(response.status, 401);
    assert.equal(body.error, "Authentication required");
    passed("protected REST endpoints reject anonymous requests");
  }

  const userA = await register("alice@example.com");
  passed("user A can register and receives a session token");
  const userB = await register("bob@example.com");
  passed("user B can register independently");
  assert.notEqual(userA.user.id, userB.user.id);

  {
    const { response, body } = await json("/api/v1/me", { headers: bearer(userA.access_token) });
    assert.equal(response.status, 200);
    assert.equal(body.user.id, userA.user.id);
    assert.equal(body.user.email, "alice@example.com");
    passed("session token resolves user identity server-side");
  }

  await client.query(
    `INSERT INTO connections(user_id, provider, access_token, refresh_token, scopes, token_expires_at)
     VALUES ($1, 'oura', 'test-access', 'test-refresh', ARRAY['daily'], now() + interval '1 hour')`,
    [userA.user.id]
  );

  {
    const a = await json("/api/v1/connections", { headers: bearer(userA.access_token) });
    const b = await json("/api/v1/connections", { headers: bearer(userB.access_token) });
    assert.equal(a.response.status, 200);
    assert.equal(a.body.connections.length, 1);
    assert.equal(b.response.status, 200);
    assert.deepEqual(b.body.connections, []);
    passed("connection data is isolated by authenticated user_id");
  }

  {
    const response = await request("/auth/oura/start", { headers: bearer(userA.access_token) });
    assert.equal(response.status, 302);
    const location = response.headers.get("location");
    assert.ok(location);
    const authorizationUrl = new URL(location);
    assert.equal(authorizationUrl.origin, "https://cloud.ouraring.com");
    assert.equal(authorizationUrl.pathname, "/oauth/authorize");
    assert.ok(authorizationUrl.searchParams.get("state"));
    assert.ok(authorizationUrl.searchParams.get("code_challenge"));
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");

    const state = authorizationUrl.searchParams.get("state");
    const stateRow = await client.query(`SELECT user_id FROM oauth_states WHERE state=$1`, [state]);
    assert.equal(stateRow.rowCount, 1);
    assert.equal(String(stateRow.rows[0].user_id), userA.user.id);
    passed("Oura OAuth state is bound to authenticated user");
  }

  {
    const response = await request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 401);
    passed("MCP rejects anonymous requests before tool execution");
  }

  {
    const { response, body } = await json("/api/v1/sync?start=2026-10-12&end=2026-10-11", {
      method: "POST",
      headers: bearer(userB.access_token)
    });
    assert.equal(response.status, 400);
    assert.match(body.error, /start must not be after end/);
    passed("authenticated sync validation remains intact");
  }

  {
    const login = await json("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", password: "correct-horse-battery-staple" })
    });
    assert.equal(login.response.status, 200);
    assert.ok(login.body.access_token);
    passed("registered user can log in");
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
    const { response, body } = await json("/auth/oura/callback");
    assert.equal(response.status, 400);
    assert.equal(body.error, "Missing code or state");
    passed("Oura callback rejects missing code/state");
  }

  {
    const response = await request("/healthz");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, "1.0.0");
    passed("legacy health endpoint remains compatible");
  }

  console.log(`\n${checks.length} smoke regression checks passed.`);
} finally {
  await client.end();
}
