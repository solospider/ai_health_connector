# Railway Deployment

This guide deploys AI Health Connection as a single-user private alpha on Railway.

## 1. Create the Railway project

Create a new Railway project and choose **Deploy from GitHub repo**. Select:

```text
solospider/ai_health_connector
```

Use the `main` branch after the deployment PR is merged.

## 2. Add PostgreSQL

In the Railway project canvas, choose **+ New → Database → PostgreSQL**.

Keep the database private. The application service should reference the database service variable instead of exposing Postgres publicly.

In the application service Variables tab, add:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

If the database service is named something other than `Postgres`, replace `Postgres` with that service name.

## 3. Add application variables

Add these variables to the application service:

```text
OURA_CLIENT_ID=<your Oura client id>
OURA_CLIENT_SECRET=<your Oura client secret>
OURA_SCOPES=daily heartrate workout spo2
TOKEN_ENCRYPTION_KEY_BASE64=<existing 32-byte base64 key>
DEV_USER_ID=<existing UUID used by the local environment>
```

Do not set `PORT`; Railway provides it automatically.

Initially, `BASE_URL` and `OURA_REDIRECT_URI` can be added after Railway generates the public domain.

## 4. Generate the Railway domain

After the first deployment, open the application service:

**Settings → Networking → Generate Domain**

Suppose Railway assigns:

```text
https://ai-health-connection-production.up.railway.app
```

Then add/update:

```text
BASE_URL=https://ai-health-connection-production.up.railway.app
OURA_REDIRECT_URI=https://ai-health-connection-production.up.railway.app/auth/oura/callback
```

Redeploy after changing the variables.

## 5. Update the Oura developer application

In the Oura developer portal, add the exact Railway callback URL:

```text
https://ai-health-connection-production.up.railway.app/auth/oura/callback
```

The redirect URI must exactly match `OURA_REDIRECT_URI`.

## 6. Verify the deployment

Open:

```text
https://<railway-domain>/api/v1/health
```

Expected shape:

```json
{
  "service": "AI Health Connection",
  "status": "ok",
  "version": "0.8.0"
}
```

Then verify:

```text
https://<railway-domain>/
https://<railway-domain>/api/v1/connections
https://<railway-domain>/api/v1/sync/status
https://<railway-domain>/auth/oura/start
https://<railway-domain>/mcp
```

Use a POST request for `/api/v1/sync` and the MCP protocol for `/mcp`; simply opening those endpoints in a browser is not a complete functional test.

## Railway config in this repository

`railway.toml` configures:

- `npm run build` during build
- `npm run db:init:prod` as the pre-deploy database initialization step
- `npm run start` to run the compiled Node application
- `/api/v1/health` as Railway's health check

The build copies `src/db/schema.sql` into `dist/db/schema.sql` so the compiled database initializer can run in the pre-deploy container.

## Security scope

This deployment remains a single-user private alpha. `DEV_USER_ID` is still a development identity, and the REST/MCP endpoints do not yet implement production multi-user authentication and authorization. Do not expose this deployment as a public multi-user health-data service until the authentication/security milestone is complete.
