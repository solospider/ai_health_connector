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

export async function getDailySpO2(userId: string, date: string) {
  const records = await rawRecords(userId, "daily_spo2", date);
  const record = records[0] ?? null;
  return {
    date,
    available: Boolean(record),
    average_spo2_percent: asNumber(record?.spo2_percentage?.average),
    source_records: records.length
  };
}

export async function getHeartRateSeries(userId: string, date: string) {
  const records = await rawRecords(userId, "heartrate", date);
  const samples = records
    .map((record) => ({
      timestamp: asString(record.timestamp),
      bpm: asNumber(record.bpm),
      source: asString(record.source)
    }))
    .filter((sample) => sample.timestamp && sample.bpm != null)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  const bpms = samples.map((sample) => sample.bpm as number);
  return {
    date,
    available: samples.length > 0,
    sample_count: samples.length,
    min_bpm: bpms.length ? Math.min(...bpms) : null,
    max_bpm: bpms.length ? Math.max(...bpms) : null,
    average_bpm: bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : null,
    samples
  };
}

export async function getWorkouts(userId: string, startDate: string, endDate: string) {
  const result = await db.query(
    `SELECT payload
       FROM raw_provider_records
      WHERE user_id=$1 AND provider='oura' AND endpoint='workout'
        AND event_date BETWEEN $2::date AND $3::date
      ORDER BY event_date, fetched_at`,
    [userId, startDate, endDate]
  );

  const workouts = result.rows.map((row) => {
    const record = row.payload as Record<string, any>;
    return {
      id: asString(record.id),
      day: asString(record.day),
      activity: asString(record.activity),
      label: asString(record.label),
      source: asString(record.source),
      intensity: asString(record.intensity),
      start_datetime: asString(record.start_datetime),
      end_datetime: asString(record.end_datetime),
      calories: asNumber(record.calories),
      distance_meters: asNumber(record.distance)
    };
  });

  return {
    start_date: startDate,
    end_date: endDate,
    count: workouts.length,
    workouts
  };
}
