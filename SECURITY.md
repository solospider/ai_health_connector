# Security and Privacy Requirements

Health Connector processes sensitive personal health data. Production design must treat tenant isolation, credential protection, consent, deletion, and auditability as launch blockers rather than follow-up improvements.

## Current development limitations

The development server currently uses a configured development user identity and is suitable only for local/private testing. Production must derive the user from authenticated request context. A model/tool argument must never be accepted as the authoritative user identity.

## Required controls before public beta

### Authentication and tenant isolation

- Every MCP request must be authenticated.
- Authentication must resolve to exactly one internal user identity.
- Every database query touching user data must be scoped to that authenticated user.
- Cross-user authorization tests are required.
- User identifiers must never be supplied by the model as trust-bearing authorization input.

### Provider credentials

- Provider access and refresh tokens must be encrypted at rest.
- Encryption keys must be stored outside the database and source repository.
- Tokens, OAuth codes, client secrets, encryption keys, and Authorization headers must never be logged.
- Rotating refresh tokens must be persisted atomically.
- Provider disconnect must invalidate or remove stored credentials when supported.

### Network controls

- HTTPS only in production.
- Restrict CORS to required origins; never use `*` for production MCP traffic.
- Apply request size limits and rate limits.
- Add timeouts around provider requests and database operations.
- Reject malformed content types and unsupported methods.

### Logging and observability

Allowed in normal logs:

- request id
- authenticated internal user id or privacy-preserving surrogate
- tool name
- duration
- status/error class
- sync counts

Do not log:

- raw health payloads
- OAuth access/refresh tokens
- Authorization headers
- provider secrets
- detailed medical or wearable values unless explicitly required for a tightly controlled diagnostic trace

### Data lifecycle

Production must implement:

- explicit consent record per provider connection
- data-source disconnect
- user-requested export
- user-requested deletion
- cascading deletion of provider connections and stored health data
- documented retention policy

Deletion should cover raw records, normalized records, derived baselines, reports, cached artifacts, and authentication/account mappings under application control.

### Database

- Managed Postgres with encryption at rest.
- TLS for application-to-database connections in production.
- Least-privilege application role.
- Automated backups with documented retention.
- Restore testing.
- Indexes and constraints preserving tenant boundaries.

### Secrets

Production secrets must come from a managed secret store or deployment platform secret facility. `.env` is acceptable only for local development.

At minimum protect:

- Oura client secret
- token-encryption key
- database credentials
- application authentication secrets
- webhook signing secrets when introduced

## Privacy principles

1. Data minimization: request only scopes required for product features.
2. Purpose limitation: use connected health data only to provide user-requested health-data functionality.
3. No sale of personal health data.
4. No advertising profiles built from health data.
5. Transparent provider and retention controls.
6. Users must be able to disconnect a provider without contacting support.
7. Users must be able to delete their account and stored data.

## AI safety boundary

MCP tools should return accurate measurements, dates, provenance, and data-quality limitations. The AI layer should not transform wearable-derived metrics into unsupported diagnoses.

In particular:

- Oura breathing disturbance index is not a clinical AHI measurement.
- Daily SpO2 is not a minute-level oximetry trace.
- Wearable heart-rate and sleep metrics are not substitutes for clinical testing.
- Statistical anomaly detection should require sufficient personal baseline samples and must report uncertainty.

## Security launch checklist

- [ ] Production authentication integrated
- [ ] Cross-user isolation integration tests
- [ ] MCP authorization required
- [ ] Production CORS allowlist
- [ ] Rate limiting
- [ ] Request/body limits
- [ ] Secrets moved to managed store
- [ ] No credential/raw-health logging
- [ ] Export flow
- [ ] Delete-account/data flow
- [ ] Provider disconnect flow
- [ ] Audit events for consent, connect, disconnect, export, deletion
- [ ] Dependency/security scanning in CI
- [ ] Backup and restore runbook
- [ ] Incident response contact/process
