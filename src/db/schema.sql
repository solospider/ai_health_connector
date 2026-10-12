CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text,
  password_hash text,
  display_name text,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
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

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id text PRIMARY KEY,
  client_name text,
  redirect_uris text[] NOT NULL,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires_at ON oauth_authorization_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  access_token_hash text NOT NULL UNIQUE,
  refresh_token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  resource text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access_expires_at ON oauth_tokens(access_expires_at);

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

CREATE TABLE IF NOT EXISTS family_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_user_id <> profile_user_id),
  UNIQUE(owner_user_id, profile_user_id)
);
CREATE INDEX IF NOT EXISTS idx_family_access_owner ON family_access(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_family_access_profile ON family_access(profile_user_id, status);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_user_date
  ON daily_metrics(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_user_ts
  ON heart_rate_samples(user_id, timestamp DESC);
