import { db } from "../db/pool.js";

export type DetailedSleep = {
  date: string;
  available: boolean;
  sleep_score: number | null;
  bedtime_start: string | null;
  bedtime_end: string | null;
  total_sleep_seconds: number | null;
  time_in_bed_seconds: number | null;
  awake_time_seconds: number | null;
  light_sleep_seconds: number | null;
  deep_sleep_seconds: number | null;
  rem_sleep_seconds: number | null;
  latency_seconds: number | null;
  efficiency_percent: number | null;
  average_hrv_ms: number | null;
  average_heart_rate_bpm: number | null;
  lowest_heart_rate_bpm: number | null;
  average_breath_bpm: number | null;
  readiness_score: number | null;
  temperature_deviation_c: number | null;
  contributors: {
    sleep?: Record<string, unknown> | null;
    readiness?: Record<string, unknown> | null;
  };
  source_records: {
    sleep: number;
    daily_sleep: number;
    daily_readiness: number;
  };
};

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function chooseLongestSleep(records: Record<string, any>[]) {
  if (!records.length) return null;
  return records.reduce((best, current) =>
    (current.total_sleep_duration ?? 0) > (best.total_sleep_duration ?? 0) ? current : best
  );
}

async function rawRecords(userId: string, endpoint: string, date: string) {
  const result = await db.query(
    `SELECT payload
       FROM raw_provider_records
      WHERE user_id=$1 AND provider='oura' AND endpoint=$2 AND event_date=$3::date
      ORDER BY fetched_at DESC`,
    [userId, endpoint, date]
  );
  return result.rows.map((row) => row.payload as Record<string, any>);
}

export async function getDetailedSleep(userId: string, date: string): Promise<DetailedSleep> {
  const [sleepRecords, dailySleepRecords, readinessRecords] = await Promise.all([
    rawRecords(userId, "sleep", date),
    rawRecords(userId, "daily_sleep", date),
    rawRecords(userId, "daily_readiness", date)
  ]);

  const sleep = chooseLongestSleep(sleepRecords);
  const dailySleep = dailySleepRecords[0] ?? null;
  const readiness = readinessRecords[0] ?? null;

  return {
    date,
    available: Boolean(sleep || dailySleep || readiness),
    sleep_score: asNumber(dailySleep?.score),
    bedtime_start: asString(sleep?.bedtime_start),
    bedtime_end: asString(sleep?.bedtime_end),
    total_sleep_seconds: asNumber(sleep?.total_sleep_duration),
    time_in_bed_seconds: asNumber(sleep?.time_in_bed),
    awake_time_seconds: asNumber(sleep?.awake_time),
    light_sleep_seconds: asNumber(sleep?.light_sleep_duration),
    deep_sleep_seconds: asNumber(sleep?.deep_sleep_duration),
    rem_sleep_seconds: asNumber(sleep?.rem_sleep_duration),
    latency_seconds: asNumber(sleep?.latency),
    efficiency_percent: asNumber(sleep?.efficiency),
    average_hrv_ms: asNumber(sleep?.average_hrv),
    average_heart_rate_bpm: asNumber(sleep?.average_heart_rate),
    lowest_heart_rate_bpm: asNumber(sleep?.lowest_heart_rate),
    average_breath_bpm: asNumber(sleep?.average_breath),
    readiness_score: asNumber(readiness?.score),
    temperature_deviation_c: asNumber(readiness?.temperature_deviation),
    contributors: {
      sleep: asObject(dailySleep?.contributors),
      readiness: asObject(readiness?.contributors)
    },
    source_records: {
      sleep: sleepRecords.length,
      daily_sleep: dailySleepRecords.length,
      daily_readiness: readinessRecords.length
    }
  };
}
