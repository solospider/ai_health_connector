# Health Connector — Product Strategy

## Product thesis

Health Connector is an AI-native personal health data layer. It connects authorized health data sources, stores raw records for reprocessing, normalizes cross-provider metrics, builds personal baselines, and exposes safe read-only tools to AI clients through MCP.

The product should not compete with device vendors on sensors or proprietary scores. It should make longitudinal health data portable, queryable, comparable, and understandable across sources.

## Positioning

**Your health data finally has memory.**

Connect once, then ask AI about your personal baseline, trends, recovery, sleep, activity, respiratory signals, and changes over time.

Core differentiation:

1. Personal baseline instead of population averages.
2. Longitudinal context instead of one-off screenshots.
3. Cross-source analysis instead of one device silo.
4. AI-native access through MCP rather than another dashboard-only product.

## Initial target users

Primary private-beta users:

- Oura power users who actively monitor sleep, HRV, recovery, and respiratory metrics.
- Quantified-self / biohacking users who care about longitudinal trends.
- Users with multiple health devices who want one analysis layer.
- Sleep-focused users who may later combine Oura with CPAP or oximetry data.

## Private beta scope

### Data sources

Launch with Oura only. Add Apple Health next, then one additional server-to-server wearable provider to validate the normalized schema.

### Core experiences

Users should be able to:

- Connect and disconnect Oura securely.
- See last-sync status and data freshness.
- Ask for a daily health summary.
- Inspect detailed sleep stages, HRV, overnight heart rate, breathing rate, SpO2, and breathing disturbance index when available.
- View trends over a date range.
- Compare two periods.
- Build a personal baseline.
- Identify statistically unusual deviations only when enough baseline data exists.
- Receive weekly summaries after enough data has accumulated.
- Delete their account and health data.

## Pricing hypothesis

Pricing should monetize longitudinal intelligence, not basic data access.

| Tier | Suggested price | Product boundary |
| --- | ---: | --- |
| Free | $0 | 1 source, recent history, daily summaries, basic queries |
| Pro | $12.99/month | 365-day history, baselines, anomaly detection, weekly reports, richer analysis |
| Pro+ | $24.99/month | Multi-source analysis, CPAP/CGM/Apple Health integrations, advanced correlations |
| Family | $39.99/month | Multiple isolated member profiles with separate consent and permissions |

Annual billing should be introduced after retention is understood.

## Monetization principles

- Never sell health data.
- Avoid advertising as a primary business model.
- Charge for storage duration, cross-source integration, advanced analytics, reports, and automation.
- Keep core consent, export, and deletion controls available to all users.

## Success metrics for private beta

The first beta should optimize for product value and trust, not top-line revenue.

Track:

- Activation: connected provider + first successful health query.
- D7 / D30 retained users.
- Queries per active user per week.
- Percentage of users who accumulate >=14 days of usable baseline data.
- Weekly-report open/read rate.
- Frequency of sync failures and stale-data incidents.
- Percentage of answers supported by complete enough data vs insufficient-data responses.
- Upgrade intent and willingness to pay.

## Product boundaries

Health Connector is a wellness and personal-data interpretation product, not a diagnostic medical device.

The product should:

- Separate measurements from interpretation.
- Surface missing data and confidence limitations.
- Avoid converting wearable-derived indices into clinical diagnoses.
- Clearly distinguish wearable metrics from validated clinical measurements.
- Encourage professional evaluation when the data pattern or user symptoms warrant it.

## Longer-term platform direction

Target architecture:

```text
Oura ---------\
Apple Health --\
Garmin ---------\
Whoop ----------- > Unified Health Data Layer -> Personal Analytics -> MCP / API -> AI clients
CPAP -----------/
CGM ------------/
```

The long-term asset is the provider-neutral health data and analytics layer, not a single ChatGPT integration.

## Distribution

Start ChatGPT-first because MCP is already implemented and the conversational use case is strong. Do not remain ChatGPT-only.

Longer term support:

- ChatGPT plugin / MCP
- Web dashboard for account, consent, connections, subscription, export, and deletion
- Lightweight iOS companion for Apple Health ingestion
- API access for B2B / partner integrations

## v1 launch criteria

Do not call the service production-ready until all of the following are true:

- Authenticated multi-user isolation.
- No fixed development user identity in production paths.
- Production MCP authorization.
- Token encryption and rotation validated.
- Background sync with retries and observability.
- Explicit consent records.
- Account export and deletion flows.
- Restricted production CORS.
- Structured logs that exclude raw health payloads and credentials.
- Security and privacy review completed.
- Integration tests for cross-user isolation.
