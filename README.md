# AI Health Connection

A user-authorized personal health data layer that connects wearable data to AI clients through a stable API and MCP interface.

## Current product stage

**v0.8.0 — Product API Foundation**

The repository is still in **single-user development mode**. `DEV_USER_ID` represents the authenticated user. Do not deploy it as a public multi-user health service yet. Production must derive `user_id` from authenticated sessions/tokens and enforce per-user authorization at both REST and MCP boundaries.

## Included

- Oura OAuth2 server-side flow with PKCE
- AES-256-GCM encryption for stored Oura tokens
- Correct handling of Oura rotating/single-use refresh tokens
- Raw Oura response storage for future reprocessing
- Normalized daily health metrics in PostgreSQL
- Oura sync for daily sleep/readiness/activity, sleep periods, SpO2, heart rate, and workouts when scopes are granted
- Detailed sleep and respiratory summaries, including Oura breathing disturbance index when available
- Trend, baseline, comparison, anomaly, and compact health-context analytics
- Streamable HTTP MCP endpoint at `/mcp`
- Product REST API under `/api/v1`
- Basic product landing page and Oura connection status at `/`

## Product endpoints

```text
GET  /api/v1/health
GET  /api/v1/me
GET  /api/v1/connections
GET  /api/v1/sync/status
POST /api/v1/sync
POST /mcp
```

`POST /api/v1/sync` defaults to the last 90 days. An explicit range can be supplied as query parameters:

```text
POST /api/v1/sync?start=2026-10-01&end=2026-10-11
```

The legacy development endpoint `GET /sync/oura` remains available for compatibility.

## Architecture

```text
Oura
  ↓ OAuth + sync
PostgreSQL raw + normalized data
  ↓
Shared service layer
  ├── REST API /api/v1/*
  └── MCP /mcp
        ↓
      ChatGPT / authorized AI clients
```

## 1. Create an Oura developer app

Register an OAuth application in Oura's developer portal. For local development, set its callback URL to:

```text
http://localhost:8787/auth/oura/callback
```

Copy the Client ID and Client Secret.

## 2. Configure

```bash
cp .env.example .env
```

Generate a 32-byte encryption key:

```bash
openssl rand -base64 32
```

Put it in `TOKEN_ENCRYPTION_KEY_BASE64` and fill in the Oura credentials.

## 3. Run Postgres

```bash
docker compose up -d
```

## 4. Install + initialize

```bash
npm install
npm run db:init
npm run typecheck
npm run dev
```

Open:

```text
http://localhost:8787
```

Click **Connect Oura**, approve access, then sync data.

## 5. Test the REST API

```bash
curl http://localhost:8787/api/v1/health
curl http://localhost:8787/api/v1/connections
curl http://localhost:8787/api/v1/sync/status
curl -X POST http://localhost:8787/api/v1/sync
```

## 6. Test MCP locally

```bash
npx @modelcontextprotocol/inspector@latest
```

Use Streamable HTTP:

```text
http://localhost:8787/mcp
```

Representative tools include:

- `get_sync_status`
- `get_detailed_sleep`
- `get_daily_spo2`
- `get_respiratory_summary`
- `get_heart_rate_series`
- `get_workouts`
- `get_daily_health_summary`
- `get_metric_trend`
- `get_baseline`
- `compare_periods`
- `get_health_context`
- `find_anomalies`

## 7. Connect to ChatGPT during development

Expose port 8787 through an HTTPS tunnel, then add the resulting `https://.../mcp` endpoint as a custom MCP server / plugin in ChatGPT.

## Next engineering steps

1. Add real user authentication and sessions for the website/API.
2. Add OAuth-style authorization for MCP clients and derive the user identity from the authenticated principal.
3. Move sync to an incremental/background job instead of requiring a browser/API trigger.
4. Add explicit consent, audit logs, disconnect/delete/export flows, and rate limiting.
5. Deploy behind a stable HTTPS domain rather than a development tunnel.
6. Add a second provider to validate the normalized multi-provider schema.

## Product/legal note

Health data is sensitive. Public launch requires a production security/privacy review in addition to provider-specific API terms. The current code is intended for development and architecture validation, not as a production medical system.
