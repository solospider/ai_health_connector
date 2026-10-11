import { db } from "../db/pool.js";

const metricColumns = {
  sleep_score: "sleep_score",
  readiness_score: "readiness_score",
  activity_score: "activity_score",
  sleep_duration_hours: "total_sleep_seconds / 3600.0",
  hrv: "average_hrv_ms",
  resting_hr: "resting_hr_bpm",
  temperature_deviation: "temperature_deviation_c",
  steps: "steps"
} as const;

export type Metric = keyof typeof metricColumns;

export async function getMetricTrend(userId: string, metric: Metric, startDate: string, endDate: string) {
  const expr = metricColumns[metric];
  const r = await db.query(
    `SELECT date::text, (${expr})::float8 AS value
     FROM daily_metrics
     WHERE user_id=$1 AND date BETWEEN $2 AND $3 AND (${expr}) IS NOT NULL
     ORDER BY date`,
    [userId, startDate, endDate]
  );
  return r.rows;
}

export async function getBaseline(userId: string, metric: Metric, days: number) {
  const expr = metricColumns[metric];
  const r = await db.query(
    `SELECT count(*)::int AS samples,
            avg(${expr})::float8 AS mean,
            percentile_cont(0.5) within group (order by ${expr})::float8 AS median,
            stddev_samp(${expr})::float8 AS stddev,
            min(${expr})::float8 AS min,
            max(${expr})::float8 AS max
     FROM daily_metrics
     WHERE user_id=$1 AND date >= current_date - ($2::int - 1) AND (${expr}) IS NOT NULL`,
    [userId, days]
  );
  return { metric, days, ...r.rows[0] };
}

export async function getDailySummary(userId: string, date: string) {
  const r = await db.query(
    `SELECT date::text, sleep_score::float8, readiness_score::float8, activity_score::float8,
            total_sleep_seconds, deep_sleep_seconds, rem_sleep_seconds, efficiency::float8,
            average_hrv_ms::float8, resting_hr_bpm::float8,
            temperature_deviation_c::float8, spo2_average::float8, steps
     FROM daily_metrics WHERE user_id=$1 AND date=$2`,
    [userId, date]
  );
  return r.rows[0] ?? null;
}

export async function comparePeriods(
  userId: string,
  metric: Metric,
  aStart: string, aEnd: string,
  bStart: string, bEnd: string
) {
  const expr = metricColumns[metric];
  const r = await db.query(
    `SELECT
       avg(${expr}) FILTER (WHERE date BETWEEN $2 AND $3)::float8 AS period_a,
       avg(${expr}) FILTER (WHERE date BETWEEN $4 AND $5)::float8 AS period_b
     FROM daily_metrics
     WHERE user_id=$1 AND date BETWEEN LEAST($2::date,$4::date) AND GREATEST($3::date,$5::date)`,
    [userId, aStart, aEnd, bStart, bEnd]
  );
  const a = r.rows[0].period_a as number | null;
  const b = r.rows[0].period_b as number | null;
  return {
    metric,
    period_a: { start: aStart, end: aEnd, average: a },
    period_b: { start: bStart, end: bEnd, average: b },
    absolute_change: a != null && b != null ? b - a : null,
    percent_change: a != null && b != null && a !== 0 ? ((b - a) / a) * 100 : null
  };
}

type MetricSnapshot = {
  metric: Metric;
  latest: { date: string; value: number } | null;
  recent: { days: number; samples: number; average: number | null };
  baseline: {
    days: number;
    samples: number;
    mean: number | null;
    stddev: number | null;
    status: "ready" | "insufficient_data";
  };
  deviation: {
    absolute: number | null;
    percent: number | null;
    z_score: number | null;
  };
};

async function getMetricSnapshot(
  userId: string,
  metric: Metric,
  recentDays: number,
  baselineDays: number,
  minBaselineSamples: number
): Promise<MetricSnapshot> {
  const expr = metricColumns[metric];
  const r = await db.query(
    `WITH values AS (
       SELECT date, (${expr})::float8 AS value
       FROM daily_metrics
       WHERE user_id=$1
         AND date >= current_date - ($3::int - 1)
         AND (${expr}) IS NOT NULL
     ),
     latest AS (
       SELECT date::text AS date, value
       FROM values
       ORDER BY date DESC
       LIMIT 1
     ),
     recent AS (
       SELECT count(*)::int AS samples, avg(value)::float8 AS average
       FROM values
       WHERE date >= current_date - ($2::int - 1)
     ),
     baseline AS (
       SELECT count(*)::int AS samples,
              avg(value)::float8 AS mean,
              stddev_samp(value)::float8 AS stddev
       FROM values
     )
     SELECT
       (SELECT date FROM latest) AS latest_date,
       (SELECT value FROM latest) AS latest_value,
       recent.samples AS recent_samples,
       recent.average AS recent_average,
       baseline.samples AS baseline_samples,
       baseline.mean AS baseline_mean,
       baseline.stddev AS baseline_stddev
     FROM recent CROSS JOIN baseline`,
    [userId, recentDays, baselineDays]
  );

  const row = r.rows[0];
  const latestValue = row.latest_value as number | null;
  const baselineMean = row.baseline_mean as number | null;
  const baselineStddev = row.baseline_stddev as number | null;
  const baselineSamples = Number(row.baseline_samples ?? 0);
  const baselineReady = baselineSamples >= minBaselineSamples;

  const absolute = baselineReady && latestValue != null && baselineMean != null
    ? latestValue - baselineMean
    : null;
  const percent = absolute != null && baselineMean != null && baselineMean !== 0
    ? (absolute / baselineMean) * 100
    : null;
  const zScore = baselineReady && absolute != null && baselineStddev != null && baselineStddev > 0
    ? absolute / baselineStddev
    : null;

  return {
    metric,
    latest: row.latest_date != null && latestValue != null
      ? { date: row.latest_date as string, value: latestValue }
      : null,
    recent: {
      days: recentDays,
      samples: Number(row.recent_samples ?? 0),
      average: row.recent_average as number | null
    },
    baseline: {
      days: baselineDays,
      samples: baselineSamples,
      mean: baselineMean,
      stddev: baselineStddev,
      status: baselineReady ? "ready" : "insufficient_data"
    },
    deviation: {
      absolute,
      percent,
      z_score: zScore
    }
  };
}

const healthContextMetrics: Metric[] = [
  "sleep_duration_hours",
  "hrv",
  "resting_hr",
  "readiness_score",
  "activity_score",
  "steps"
];

export async function getHealthContext(
  userId: string,
  recentDays = 7,
  baselineDays = 90,
  minBaselineSamples = 14
) {
  const metrics = await Promise.all(
    healthContextMetrics.map((metric) =>
      getMetricSnapshot(userId, metric, recentDays, baselineDays, minBaselineSamples)
    )
  );

  const availableMetrics = metrics.filter((m) => m.latest !== null).length;
  const readyBaselines = metrics.filter((m) => m.baseline.status === "ready").length;

  return {
    generated_at: new Date().toISOString(),
    recent_window_days: recentDays,
    baseline_window_days: baselineDays,
    minimum_baseline_samples: minBaselineSamples,
    data_quality: {
      available_metrics: availableMetrics,
      total_metrics: metrics.length,
      ready_baselines: readyBaselines,
      note:
        readyBaselines === 0
          ? `Personal baselines are not yet reliable. At least ${minBaselineSamples} samples are required per metric.`
          : null
    },
    metrics
  };
}

export async function findAnomalies(
  userId: string,
  metrics: Metric[],
  baselineDays = 90,
  minBaselineSamples = 14,
  zThreshold = 1.5,
  percentThreshold = 15
) {
  const snapshots = await Promise.all(
    metrics.map((metric) => getMetricSnapshot(userId, metric, 7, baselineDays, minBaselineSamples))
  );

  const anomalies = snapshots
    .filter((snapshot) => snapshot.baseline.status === "ready" && snapshot.latest != null)
    .map((snapshot) => {
      const z = snapshot.deviation.z_score;
      const pct = snapshot.deviation.percent;
      const isAnomaly =
        (z != null && Math.abs(z) >= zThreshold) ||
        (z == null && pct != null && Math.abs(pct) >= percentThreshold);

      return {
        ...snapshot,
        is_anomaly: isAnomaly,
        direction:
          snapshot.deviation.absolute == null
            ? null
            : snapshot.deviation.absolute > 0
              ? "above_baseline"
              : snapshot.deviation.absolute < 0
                ? "below_baseline"
                : "at_baseline"
      };
    })
    .filter((x) => x.is_anomaly)
    .sort((a, b) => {
      const az = Math.abs(a.deviation.z_score ?? 0);
      const bz = Math.abs(b.deviation.z_score ?? 0);
      if (az !== bz) return bz - az;
      return Math.abs(b.deviation.percent ?? 0) - Math.abs(a.deviation.percent ?? 0);
    });

  const insufficientBaseline = snapshots
    .filter((snapshot) => snapshot.baseline.status === "insufficient_data")
    .map((snapshot) => ({
      metric: snapshot.metric,
      samples: snapshot.baseline.samples,
      required_samples: minBaselineSamples
    }));

  return {
    generated_at: new Date().toISOString(),
    baseline_window_days: baselineDays,
    thresholds: {
      z_score_absolute: zThreshold,
      percent_absolute_fallback: percentThreshold
    },
    anomalies,
    insufficient_baseline: insufficientBaseline,
    note:
      insufficientBaseline.length > 0
        ? "Metrics without enough personal baseline samples are not classified as anomalous."
        : null
  };
}
