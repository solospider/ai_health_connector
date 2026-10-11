import { randomUUID } from "node:crypto";
import { db } from "../db/pool.js";
import { ouraGet } from "./client.js";

type Collection<T = Record<string, unknown>> = { data: T[]; next_token?: string | null };

type AnyRecord = Record<string, any>;

export type OuraFreshnessResult = {
  status: "fresh" | "refreshed" | "not_connected" | "refresh_failed";
  last_sync_at: string | null;
  refreshed: boolean;
  start?: string;
  end?: string;
  counts?: Record<string, number>;
  error?: string;
};

export type OuraSyncStatus = {
  connected: boolean;
  connection_status: string | null;
  last_sync_at: string | null;
  age_minutes: number | null;
  cache_status: "fresh" | "stale" | "never_synced" | "not_connected";
  refresh_threshold_minutes: number;
  next_health_query_will_refresh: boolean;
  refresh_in_flight: boolean;
  latest_data_date: string | null;
  cached_records: Record<string, number>;
};

const refreshInFlight = new Map<string, Promise<OuraFreshnessResult>>();

async function fetchCollection(userId: string, endpoint: string, startDate: string, endDate: string) {
  const all: AnyRecord[] = [];
  let nextToken: string | undefined;
  do {
    const params: Record<string, string> = { start_date: startDate, end_date: endDate };
    if (nextToken) params.next_token = nextToken;
    const page = await ouraGet<Collection>(userId, `/v2/usercollection/${endpoint}`, params);
    all.push(...page.data);
    nextToken = page.next_token ?? undefined;
  } while (nextToken);
  return all;
}

async function saveRaw(userId: string, endpoint: string, records: AnyRecord[]) {
  for (const record of records) {
    const externalId = record.id ? String(record.id) : `${record.day ?? record.timestamp ?? randomUUID()}`;
    const day = record.day ?? null;
    await db.query(
      `INSERT INTO raw_provider_records(user_id, provider, endpoint, external_id, event_date, payload)
       VALUES ($1,'oura',$2,$3,$4,$5)
       ON CONFLICT(user_id, provider, endpoint, external_id)
       DO UPDATE SET payload=EXCLUDED.payload, fetched_at=now()`,
      [userId, endpoint, externalId, day, record]
    );
  }
}

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function normalizeDaily(userId: string, endpoint: string, records: AnyRecord[]) {
  for (const r of records) {
    if (!r.day) continue;
    const values: Record<string, number | null> = {};
    if (endpoint === "daily_sleep") values.sleep_score = n(r.score);
    if (endpoint === "daily_readiness") {
      values.readiness_score = n(r.score);
      values.temperature_deviation_c = n(r.temperature_deviation);
    }
    if (endpoint === "daily_activity") {
      values.activity_score = n(r.score);
      values.steps = n(r.steps);
    }

    await db.query(
      `INSERT INTO daily_metrics(user_id, date, source, sleep_score, readiness_score, activity_score,
         temperature_deviation_c, steps)
       VALUES ($1,$2,'oura',$3,$4,$5,$6,$7)
       ON CONFLICT(user_id,date,source) DO UPDATE SET
         sleep_score=COALESCE(EXCLUDED.sleep_score,daily_metrics.sleep_score),
         readiness_score=COALESCE(EXCLUDED.readiness_score,daily_metrics.readiness_score),
         activity_score=COALESCE(EXCLUDED.activity_score,daily_metrics.activity_score),
         temperature_deviation_c=COALESCE(EXCLUDED.temperature_deviation_c,daily_metrics.temperature_deviation_c),
         steps=COALESCE(EXCLUDED.steps,daily_metrics.steps), updated_at=now()`,
      [userId, r.day, values.sleep_score ?? null, values.readiness_score ?? null,
       values.activity_score ?? null, values.temperature_deviation_c ?? null, values.steps ?? null]
    );
  }
}

async function normalizeSleep(userId: string, records: AnyRecord[]) {
  // Sleep endpoint can contain multiple sleep periods per day. Prefer the longest period.
  const byDay = new Map<string, AnyRecord>();
  for (const r of records) {
    if (!r.day) continue;
    const current = byDay.get(r.day);
    if (!current || (r.total_sleep_duration ?? 0) > (current.total_sleep_duration ?? 0)) byDay.set(r.day, r);
  }
  for (const [day, r] of byDay) {
    await db.query(
      `INSERT INTO daily_metrics(user_id,date,source,total_sleep_seconds,deep_sleep_seconds,rem_sleep_seconds,
         efficiency,average_hrv_ms,resting_hr_bpm)
       VALUES($1,$2,'oura',$3,$4,$5,$6,$7,$8)
       ON CONFLICT(user_id,date,source) DO UPDATE SET
         total_sleep_seconds=EXCLUDED.total_sleep_seconds,
         deep_sleep_seconds=EXCLUDED.deep_sleep_seconds,
         rem_sleep_seconds=EXCLUDED.rem_sleep_seconds,
         efficiency=EXCLUDED.efficiency,
         average_hrv_ms=EXCLUDED.average_hrv_ms,
         resting_hr_bpm=EXCLUDED.resting_hr_bpm, updated_at=now()`,
      [userId, day, n(r.total_sleep_duration), n(r.deep_sleep_duration), n(r.rem_sleep_duration),
       n(r.efficiency), n(r.average_hrv), n(r.lowest_heart_rate ?? r.average_heart_rate)]
    );
  }
}

export async function syncOura(userId: string, startDate: string, endDate: string) {
  const endpoints = ["daily_sleep", "daily_readiness", "daily_activity", "sleep"];
  const counts: Record<string, number> = {};
  for (const endpoint of endpoints) {
    const records = await fetchCollection(userId, endpoint, startDate, endDate);
    counts[endpoint] = records.length;
    await saveRaw(userId, endpoint, records);
    if (endpoint === "sleep") await normalizeSleep(userId, records);
    else await normalizeDaily(userId, endpoint, records);
  }
  await db.query(`UPDATE connections SET last_sync_at=now() WHERE user_id=$1 AND provider='oura'`, [userId]);
  return counts;
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function getOuraSyncStatus(userId: string, maxAgeMinutes = 15): Promise<OuraSyncStatus> {
  const connection = await db.query(
    `SELECT status, last_sync_at FROM connections WHERE user_id=$1 AND provider='oura' LIMIT 1`,
    [userId]
  );

  if (!connection.rowCount) {
    return {
      connected: false,
      connection_status: null,
      last_sync_at: null,
      age_minutes: null,
      cache_status: "not_connected",
      refresh_threshold_minutes: maxAgeMinutes,
      next_health_query_will_refresh: false,
      refresh_in_flight: refreshInFlight.has(userId),
      latest_data_date: null,
      cached_records: {}
    };
  }

  const rawLastSync = connection.rows[0].last_sync_at as Date | string | null;
  const lastSync = rawLastSync ? new Date(rawLastSync) : null;
  const now = new Date();
  const validLastSync = lastSync && Number.isFinite(lastSync.getTime()) ? lastSync : null;
  const ageMinutes = validLastSync
    ? Math.max(0, (now.getTime() - validLastSync.getTime()) / 60_000)
    : null;
  const stale = ageMinutes == null || ageMinutes >= maxAgeMinutes;

  const latest = await db.query(
    `SELECT MAX(date)::text AS latest_data_date
       FROM daily_metrics
      WHERE user_id=$1 AND source='oura'`,
    [userId]
  );

  const counts = await db.query(
    `SELECT endpoint, COUNT(*)::int AS count
       FROM raw_provider_records
      WHERE user_id=$1 AND provider='oura'
      GROUP BY endpoint
      ORDER BY endpoint`,
    [userId]
  );

  const cachedRecords: Record<string, number> = {};
  for (const row of counts.rows) cachedRecords[String(row.endpoint)] = Number(row.count);

  return {
    connected: true,
    connection_status: String(connection.rows[0].status ?? "connected"),
    last_sync_at: validLastSync?.toISOString() ?? null,
    age_minutes: ageMinutes == null ? null : Math.round(ageMinutes * 10) / 10,
    cache_status: validLastSync ? (stale ? "stale" : "fresh") : "never_synced",
    refresh_threshold_minutes: maxAgeMinutes,
    next_health_query_will_refresh: stale,
    refresh_in_flight: refreshInFlight.has(userId),
    latest_data_date: latest.rows[0]?.latest_data_date ?? null,
    cached_records: cachedRecords
  };
}

/**
 * Keeps cached Oura data reasonably fresh for interactive MCP queries.
 *
 * - If the last sync is newer than maxAgeMinutes, no API call is made.
 * - If stale, only the most recent recentDays calendar days are re-fetched.
 * - If the connection has never been synced, initialSyncDays are fetched.
 * - Concurrent tool calls share one refresh promise, avoiding duplicate Oura API traffic.
 * - Refresh failures are reported to callers so cached data can still be used.
 */
export async function ensureOuraFresh(
  userId: string,
  maxAgeMinutes = 15,
  recentDays = 3,
  initialSyncDays = 90
): Promise<OuraFreshnessResult> {
  const existing = refreshInFlight.get(userId);
  if (existing) return existing;

  const work = (async (): Promise<OuraFreshnessResult> => {
    const connection = await db.query(
      `SELECT status, last_sync_at FROM connections WHERE user_id=$1 AND provider='oura' LIMIT 1`,
      [userId]
    );

    if (!connection.rowCount) {
      return { status: "not_connected", last_sync_at: null, refreshed: false };
    }

    const rawLastSync = connection.rows[0].last_sync_at as Date | string | null;
    const lastSync = rawLastSync ? new Date(rawLastSync) : null;
    const now = new Date();

    if (lastSync && Number.isFinite(lastSync.getTime())) {
      const ageMs = now.getTime() - lastSync.getTime();
      if (ageMs < maxAgeMinutes * 60_000) {
        return {
          status: "fresh",
          last_sync_at: lastSync.toISOString(),
          refreshed: false
        };
      }
    }

    const end = dateOnly(now);
    const daysToFetch = lastSync ? recentDays : initialSyncDays;
    const startDate = new Date(now);
    startDate.setUTCDate(startDate.getUTCDate() - Math.max(0, daysToFetch - 1));
    const start = dateOnly(startDate);

    try {
      const counts = await syncOura(userId, start, end);
      return {
        status: "refreshed",
        last_sync_at: new Date().toISOString(),
        refreshed: true,
        start,
        end,
        counts
      };
    } catch (error) {
      return {
        status: "refresh_failed",
        last_sync_at: lastSync?.toISOString() ?? null,
        refreshed: false,
        start,
        end,
        error: error instanceof Error ? error.message : "Unknown Oura refresh error"
      };
    }
  })();

  refreshInFlight.set(userId, work);
  try {
    return await work;
  } finally {
    refreshInFlight.delete(userId);
  }
}
