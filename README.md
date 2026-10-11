# Personal Health Data MVP — Oura → normalized data → MCP → ChatGPT

A small first implementation of a user-authorized personal health data layer.

## Included

- Oura OAuth2 server-side flow with PKCE
- AES-256-GCM encryption for stored Oura tokens
- Rotating/single-use Oura refresh token handling
- Raw Oura response storage for future reprocessing
- Normalized daily health metrics in PostgreSQL
- Oura sync for daily sleep, readiness, activity, and sleep periods
- Read-only MCP tools:
  - `get_daily_health_summary`
  - `get_metric_trend`
  - `get_baseline`
  - `compare_periods`
  - `get_health_context`
  - `find_anomalies`
- Streamable HTTP MCP endpoint at `/mcp`

## Baseline behavior

`get_health_context` and `find_anomalies` use a personal baseline. A metric needs at least 14 samples before it is treated as having a reliable baseline. Until then, it is returned as `insufficient_data` and is not classified as anomalous.

The default anomaly logic uses:

- absolute z-score >= `1.5`, or
- when standard deviation is unavailable, absolute percent deviation >= `15%`

These are statistical flags, not medical diagnoses.

## Important MVP limitation

The current repo is **single-user development mode**. `DEV_USER_ID` represents the authenticated user. Do not deploy it as a multi-user public service yet. Before that, add MCP authorization and derive `user_id` from the authenticated session/token—not from a tool parameter or request supplied by the model.

## 1. Create an Oura developer app

Register an OAuth application in Oura's developer portal. Set its callback URL to:

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

Click **Connect Oura**, approve access, then **Sync last 90 days**.

## 5. Test MCP locally

```bash
npx @modelcontextprotocol/inspector@latest
```

Use Streamable HTTP:

```text
http://localhost:8787/mcp
```

Examples:

```text
get_baseline(metric="hrv", days=90)
get_metric_trend(metric="sleep_duration_hours", start_date="2026-10-01", end_date="2026-10-11")
get_health_context(recent_days=7, baseline_days=90)
find_anomalies(baseline_days=90)
```

## 6. Connect to ChatGPT during development

Expose port 8787 through an HTTPS tunnel, then add the resulting `https://.../mcp` endpoint as a custom MCP server / ChatGPT app integration.

## Next engineering steps

1. Add real MCP authorization and per-user sessions.
2. Add an incremental background sync worker rather than browser-triggered sync.
3. Add heart-rate time series and workouts.
4. Add lagged correlation analytics.
5. Add explicit consent/audit logs and delete/export flows.
6. Add a second provider such as Apple Health or Garmin to validate the normalized schema.

## Product/legal note

Oura's API/MCP terms govern what can be built with Oura data. This MVP is structured as a user-authorized health data interoperability and analysis layer rather than an Oura replacement. Review the current Oura agreement before public launch.
