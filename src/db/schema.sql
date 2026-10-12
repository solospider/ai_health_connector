CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text,
  password_hash text,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users ((lower(email))) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('oura')),
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  token_expires_at timestamptz NOT NULL,
  last_sync_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_provider_records (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  endpoint text NOT NULL,
  external_id text,
  event_date date,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider, endpoint, external_id)
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date date NOT NULL,
  source text NOT NULL,
  sleep_score numeric,
  readiness_score numeric,
  activity_score numeric,
  total_sleep_seconds integer,
  deep_sleep_seconds integer,
  rem_sleep_seconds integer,
  efficiency numeric,
  average_hrv_ms numeric,
  resting_hr_bpm numeric,
  temperature_deviation_c numeric,
  spo2_average numeric,
  steps integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, date, source)
);

CREATE TABLE IF NOT EXISTS heart_rate_samples (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timestamp timestamptz NOT NULL,
  bpm numeric NOT NULL,
  source text NOT NULL,
  source_type text,
  PRIMARY KEY(user_id, timestamp, source)
);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_user_date
  ON daily_metrics(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_user_ts
  ON heart_rate_samples(user_id, timestamp DESC);
