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

export type OuraRawDiagnostic = {
  date: string;
  oura_api: Record<string, { available: boolean; count: number }>;
  local_raw: Record<string, { available: boolean; count: number }>;
  normalized: {
    row_exists: boolean;
    sleep_score: boolean;
    readiness_score: boolean;
    activity_score: boolean;
    sleep_duration: boolean;
    hrv: boolean;
    resting_hr: boolean;
  };
  endpoint_status: Record<string, "available" | "not_available_from_oura" | "local_raw_missing" | "not_normalized">;
  diagnosis: string[];
};

const refreshInFlight = new Map<string, Promise<OuraFreshnessResult>>();

async function fetchCollectionWithParams(
  userId: string,
  endpoint: string,
  baseParams: Record<string, string>
) {
  const all: AnyRecord[] = [];
  let nextToken: string | undefined;
  do {
    const params = { ...baseParams };
    if (nextToken) params.next_token = nextToken;
    const page = await ouraGet<Collection>(userId, `/v2/usercollection/${endpoint}`, params);
    all.push(...page.data);
    nextToken = page.next_token ?? undefined;
  } while (nextToken);
  return all;
}

async function fetchCollection(userId: string, endpoint: string, startDate: string, endDate: string) {
  return fetchCollectionWithParams(userId, endpoint, { start_date: startDate, end_date: endDate });
}

function addUtcDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function dateFromIso(iso: string) {
  return iso.slice(0, 10);
}

export function heartRateWindows(startDate: string, endDate: string, maxDays = 30) {
  if (maxDays < 1) throw new Error("maxDays must be at least 1");

  const windows: Array<{ startDate: string; endDate: string }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const inclusiveEnd = dateFromIso(addUtcDays(cursor, maxDays - 1));
    const windowEnd = inclusiveEnd < endDate ? inclusiveEnd : endDate;
    windows.push({ startDate: cursor, endDate: windowEnd });
    cursor = dateFromIso(addUtcDays(windowEnd, 1));
  }
  return windows;
}

async function fetchHeartRate(userId: string, startDate: string, endDate: string) {
  const byTimestamp = new Map<string, AnyRecord>();
  for (const window of heartRateWindows(startDate, endDate)) {
    const records = await fetchCollectionWithParams(userId, "heartrate", {
      start_datetime: `${window.startDate}T00:00:00.000Z`,
      end_datetime: addUtcDays(window.endDate, 1)
    });
    for (const record of records) {
      const key = String(record.timestamp ?? record.id ?? JSON.stringify(record));
      byTimestamp.set(key, record);
    }
  }
  return [...byTimestamp.values()];
}

async function grantedScopes(userId: string) {
  const result = await db.query(
    `SELECT scopes FROM connections WHERE user_id=$1 AND provider='oura' LIMIT 1`,
    [userId]
  );
  const value = result.rows[0]?.scopes;
  return new Set<string>(Array.isArray(value) ? value.map(String) : []);
}

function eventDate(record: AnyRecord): string | null {
  if (typeof record.day === "string") return record.day;
  if (typeof record.timestamp === "string") return record.timestamp.slice(0, 10);
  if (typeof record.start_datetime === "string") return record.start_datetime.slice(0, 10);
  return null;
}

async function saveRaw(userId: string, endpoint: string, records: AnyRecord[]) {
  for (const record of records) {
    const externalId = record.id
      ? String(record.id)
      : String(record.timestamp ?? record.start_datetime ?? record.day ?? randomUUID());
    await db.query(
      `INSERT INTO raw_provider_records(user_id, provider, endpoint, external_id, event_date, payload)
       VALUES ($1,'oura',$2,$3,$4,$5)
       ON CONFLICT(user_id, provider, endpoint, external_id)
       DO UPDATE SET event_date=EXCLUDED.event_date, payload=EXCLUDED.payload, fetched_at=now()`,
      [userId, endpoint, externalId, eventDate(record), record]
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
      [
        userId,
        r.day,
        values.sleep_score ?? null,
        values.readiness_score ?? null,
        values.activity_score ?? null,
        values.temperature_deviation_c ?? null,
        values.steps ?? null
      ]
    );
  }
}

async function normalizeSleep(userId: string, records: AnyRecord[]) {
  const byDay = new Map<string, AnyRecord>();
  for (const r of records) {
    if (!r.day) continue;
    const current = byDay.get(r.day);
    if (!current || (r.total_sleep_duration ?? 0) > (current.total_sleep_duration ?? 0)) {
      byDay.set(r.day, r);
    }
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
      [
        userId,
        day,
        n(r.total_sleep_duration),
        n(r.deep_sleep_duration),
        n(r.rem_sleep_duration),
        n(r.efficiency),
        n(r.average_hrv),
        n(r.lowest_heart_rate ?? r.average_heart_rate)
      ]
    );
  }
}

export async function syncOura(userId: string, startDate: string, endDate: string) {
  const scopes = await grantedScopes(userId);
  const counts: Record<string, number> = {};

  const dailyEndpoints = ["daily_sleep", "daily_readiness", "daily_activity", "sleep"];
  for (const endpoint of dailyEndpoints) {
    const records = await fetchCollection(userId, endpoint, startDate, endDate);
    counts[endpoint] = records.length;
    await saveRaw(userId, endpoint, records);
    if (endpoint === "sleep") await normalizeSleep(userId, records);
    else await normalizeDaily(userId, endpoint, records);
  }

  if (scopes.has("spo2") || scopes.has("spo2Daily")) {
    const records = await fetchCollection(userId, "daily_spo2", startDate, endDate);
    counts.daily_spo2 = records.length;
    await saveRaw(userId, "daily_spo2", records);
  }

  if (scopes.has("workout")) {
    const records = await fetchCollection(userId, "workout", startDate, endDate);
    counts.workout = records.length;
    await saveRaw(userId, "workout", records);
  }

  if (scopes.has("heartrate")) {
    const records = await fetchHeartRate(userId, startDate, endDate);
    counts.heartrate = records.length;
    await saveRaw(userId, "heartrate", records);
  }

  await db.query(
    `UPDATE connections SET last_sync_at=now() WHERE user_id=$1 AND provider='oura'`,
    [userId]
  );
  return counts;
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function getOuraRawDiagnostic(userId: string, date: string): Promise<OuraRawDiagnostic> {
  const endpoints = ["daily_sleep", "daily_readiness", "daily_activity", "sleep"] as const;
  const apiCounts: Record<string, number> = {};

  for (const endpoint of endpoints) {
    const records = await fetchCollection(userId, endpoint, date, date);
    apiCounts[endpoint] = records.length;
  }

  const raw = await db.query(
    `SELECT endpoint, COUNT(*)::int AS count
       FROM raw_provider_records
      WHERE user_id=$1 AND provider='oura' AND event_date=$2::date
      GROUP BY endpoint`,
    [userId, date]
  );

  const rawCounts: Record<string, number> = {};
  for (const endpoint of endpoints) rawCounts[endpoint] = 0;
  for (const row of raw.rows) rawCounts[String(row.endpoint)] = Number(row.count);

  const normalizedResult = await db.query(
    `SELECT sleep_score, readiness_score, activity_score, total_sleep_seconds,
            average_hrv_ms, resting_hr_bpm
       FROM daily_metrics
      WHERE user_id=$1 AND source='oura' AND date=$2::date
      LIMIT 1`,
    [userId, date]
  );
  const normalizedRow = normalizedResult.rows[0] ?? null;

  const normalized = {
    row_exists: Boolean(normalizedRow),
    sleep_score: normalizedRow?.sleep_score != null,
    readiness_score: normalizedRow?.readiness_score != null,
    activity_score: normalizedRow?.activity_score != null,
    sleep_duration: normalizedRow?.total_sleep_seconds != null,
    hrv: normalizedRow?.average_hrv_ms != null,
    resting_hr: normalizedRow?.resting_hr_bpm != null
  };

  const ouraApi: Record<string, { available: boolean; count: number }> = {};
  const localRaw: Record<string, { available: boolean; count: number }> = {};
  const endpointStatus: OuraRawDiagnostic["endpoint_status"] = {};
  const diagnosis: string[] = [];

  for (const endpoint of endpoints) {
    const apiCount = apiCounts[endpoint] ?? 0;
    const localCount = rawCounts[endpoint] ?? 0;
    ouraApi[endpoint] = { available: apiCount > 0, count: apiCount };
    localRaw[endpoint] = { available: localCount > 0, count: localCount };

    const normalizedAvailable =
      endpoint === "daily_sleep"
        ? normalized.sleep_score
        : endpoint === "daily_readiness"
          ? normalized.readiness_score
          : endpoint === "daily_activity"
            ? normalized.activity_score
            : normalized.sleep_duration;

    if (apiCount === 0) {
      endpointStatus[endpoint] = "not_available_from_oura";
      diagnosis.push(`${endpoint}: Oura API returned no record for ${date}.`);
    } else if (localCount === 0) {
      endpointStatus[endpoint] = "local_raw_missing";
      diagnosis.push(`${endpoint}: Oura API has data, but local raw cache has no record.`);
    } else if (!normalizedAvailable) {
      endpointStatus[endpoint] = "not_normalized";
      diagnosis.push(`${endpoint}: raw data exists locally, but normalized daily metric is missing.`);
    } else {
      endpointStatus[endpoint] = "available";
    }
  }

  if (diagnosis.length === 0) diagnosis.push(`All checked Oura layers contain data for ${date}.`);

  return {
    date,
    oura_api: ouraApi,
    local_raw: localRaw,
    normalized,
    endpoint_status: endpointStatus,
    diagnosis
  };
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
