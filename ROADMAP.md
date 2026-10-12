# Productization Roadmap

## v0.8 — Production foundation

Goal: make the service safe to operate for a small invited private beta without changing the core Oura analytics behavior.

### Authentication and identity

- Replace fixed development identity in production request paths.
- Add authenticated MCP request context -> internal user mapping.
- Keep `DEV_USER_ID` only behind explicit development mode.
- Add cross-user isolation tests.

### Environment and deployment

- Add explicit `APP_ENV=development|test|production`.
- Require production-only security settings when `APP_ENV=production`.
- Restrict production CORS.
- Add production Docker image and deployment instructions.
- Add startup/readiness checks that include database connectivity.

### Database lifecycle

- Move from one-shot schema initialization toward versioned migrations.
- Add consent/audit event tables.
- Add deletion/export support foundations.
- Preserve raw provider records for deterministic reprocessing.

### Reliability

- Make optional Oura endpoints fail independently so one provider feature does not abort an otherwise valid sync.
- Add provider-request timeouts and retry classification.
- Improve sync diagnostics per endpoint.

### CI

- Typecheck on every PR.
- Add unit tests for metric calculations.
- Add integration tests for authentication and tenant isolation.
- Add dependency/security scanning.

## v0.9 — Reliable ingestion

Goal: remove dependence on user-triggered/query-triggered refresh for normal operation.

- Background synchronization worker.
- Incremental provider sync.
- Exponential backoff and retry queues.
- Refresh-token failure recovery.
- Provider connection health state.
- Data completeness score.
- Sync latency/error metrics.
- User-visible stale-data warnings.

## v1.0 — Private beta product

Goal: a coherent product that non-developer users can onboard themselves into.

### Account and web surface

- Sign in / sign out.
- Connect / reconnect / disconnect Oura.
- View granted scopes.
- Last sync and connection-health status.
- Subscription/account page.
- Export my data.
- Delete my data/account.

### MCP / ChatGPT experience

- Stable versioned tool schemas.
- Daily summary.
- Detailed sleep.
- Respiratory/SpO2 summary.
- Heart-rate series.
- Workouts.
- Trends and period comparisons.
- Personal baselines.
- Anomaly detection with minimum-data safeguards.
- Weekly health report.

### Trust

- Published privacy policy and terms aligned with actual implementation.
- Consent copy reviewed for each data source.
- Security review completed.
- User-facing data provenance and limitations.

## v1.1 — Health intelligence

- Rolling 30/60/90-day baselines.
- Multi-metric context summaries.
- Lagged correlations with safeguards against causal overclaiming.
- Weekly/monthly changes and notable observations.
- Report generation for user review/sharing.
- Better missing-data and sensor-quality handling.

## v1.2 — Apple Health bridge

- Lightweight iOS companion.
- HealthKit permission flow.
- Background upload to normalized ingestion API.
- Source provenance preserved per sample/metric.
- Conflict/deduplication rules when Oura and Apple Health overlap.

## v1.3 — Second server-side wearable provider

Add one of Whoop, Garmin, or COROS to validate provider-neutral abstractions.

Required before declaring success:

- Same analytics query works across both providers.
- Provider-specific fields remain available in raw storage.
- Unified metric semantics are documented.

## v2 — Multi-source personal health intelligence

Potential sources:

- Oura
- Apple Health
- Whoop
- Garmin
- COROS
- CPAP
- CGM

Product features:

- Cross-source timelines.
- Source confidence and conflict resolution.
- Sleep + CPAP correlations.
- CGM + sleep/activity correlations.
- Family plans with isolated member identities and consent.
- Partner/API access.

## Immediate implementation order

1. Production authentication + user identity boundary.
2. Production CORS and request hardening.
3. Versioned migrations + audit/consent schema.
4. CI/typecheck/tests.
5. Background sync foundation.
6. Account/connect/disconnect/delete web flow.
7. Subscription gating.
8. Weekly report.
9. Apple Health design/bridge.

## Explicit non-goals for the next release

- Clinical diagnosis.
- Replacing a sleep study or CPAP report.
- Advertising based on health data.
- Selling health data.
- Supporting many providers before the identity/security layer is production-ready.
