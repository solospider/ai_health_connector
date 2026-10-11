import { randomUUID } from "node:crypto";
import { db } from "../db/pool.js";
import { ouraGet } from "./client.js";

type Collection<T = Record<string, unknown>> = { data: T[]; next_token?: string | null };

type AnyRecord = Record<string, any>;

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
