import assert from "node:assert/strict";
import pg from "pg";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const expectedUserId = process.env.DEV_USER_ID ?? "00000000-0000-0000-0000-000000000001";
const databaseUrl = process.env.DATABASE_URL;

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
    [["users", "connections", "oauth_states", "raw_provider_records", "daily_metrics", "heart_rate_samples"]]
  );
  assert.equal(tables.rowCount, 6);
  passed("database schema contains all core tables");

  const userRow = await client.query(`SELECT id, timezone FROM users WHERE id=$1`, [expectedUserId]);
  assert.equal(userRow.rowCount, 1);
  assert.equal(userRow.rows[0].timezone, "America/Los_Angeles");
  passed("database initialization creates the development user");

  {
    const { response, body } = await json("/api/v1/health");
    assert.equal(response.status, 200);
    assert.equal(body.service, "AI Health Connection");
    assert.equal(body.status, "ok");
    assert.equal(body.version, "0.9.0");
    assert.ok(Number.isFinite(Date.parse(body.timestamp)));
    passed("GET /api/v1/health");
  }

  {
    const { response, body } = await json("/api/v1/me");
    assert.equal(response.status, 200);
    assert.equal(body.user.id, expectedUserId);
    assert.equal(body.user.timezone, "America/Los_Angeles");
    passed("GET /api/v1/me");
  }

  {
    const { response, body } = await json("/api/v1/connections");
    assert.equal(response.status, 200);
    assert.deepEqual(body.connections, []);
    passed("GET /api/v1/connections with a fresh database");
  }

  {
    const { response, body } = await json("/api/v1/sync/status");
    assert.equal(response.status, 200);
    assert.equal(body.provider, "oura");
    assert.equal(body.connected, false);
    assert.equal(body.cache_status, "not_connected");
    passed("GET /api/v1/sync/status before Oura is connected");
  }

  {
    const { response, body } = await json("/api/v1/not-a-route");
    assert.equal(response.status, 404);
    assert.equal(body.error, "API route not found");
    passed("unknown API routes return JSON 404");
  }

  {
    const { response, body } = await json("/api/v1/sync?start=bad&end=2026-10-11", { method: "POST" });
    assert.equal(response.status, 400);
    assert.match(body.error, /YYYY-MM-DD/);
    passed("sync rejects malformed dates");
  }

  {
    const { response, body } = await json("/api/v1/sync?start=2026-10-01", { method: "POST" });
    assert.equal(response.status, 400);
    assert.match(body.error, /provided together/);
    passed("sync requires start and end together");
  }

  {
    const { response, body } = await json("/api/v1/sync?start=2026-10-12&end=2026-10-11", { method: "POST" });
    assert.equal(response.status, 400);
    assert.match(body.error, /start must not be after end/);
    passed("sync rejects reversed date ranges");
  }

  {
    const response = await request("/auth/oura/start");
    assert.equal(response.status, 302);
    const location = response.headers.get("location");
    assert.ok(location);
    const authorizationUrl = new URL(location);
    assert.equal(authorizationUrl.origin, "https://cloud.ouraring.com");
    assert.equal(authorizationUrl.pathname, "/oauth/authorize");
    assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
    assert.equal(authorizationUrl.searchParams.get("client_id"), process.env.OURA_CLIENT_ID);
    assert.equal(
      authorizationUrl.searchParams.get("redirect_uri"),
      process.env.OURA_REDIRECT_URI ?? new URL("/auth/oura/callback", baseUrl).toString()
    );
    assert.ok(authorizationUrl.searchParams.get("state"));
    assert.ok(authorizationUrl.searchParams.get("code_challenge"));
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");

    const state = authorizationUrl.searchParams.get("state");
    const stateRow = await client.query(`SELECT user_id FROM oauth_states WHERE state=$1`, [state]);
    assert.equal(stateRow.rowCount, 1);
    assert.equal(String(stateRow.rows[0].user_id), expectedUserId);
    passed("Oura OAuth start creates PKCE state and correct redirect URL");
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
    assert.equal(body.version, "0.9.0");
    passed("legacy /healthz remains compatible");
  }

  console.log(`\n${checks.length} smoke regression checks passed.`);
} finally {
  await client.end();
}
