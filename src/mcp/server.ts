import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from "../config.js";
import { ensureOuraFresh, getOuraRawDiagnostic, getOuraSyncStatus } from "../oura/sync.js";
import {
  getDailySpO2,
  getDetailedSleep,
  getHeartRateSeries,
  getRespiratorySummary,
  getWorkouts
} from "../oura/details.js";
import {
  comparePeriods,
  findAnomalies,
  getBaseline,
  getDailySummary,
  getHealthContext,
  getMetricTrend,
  type Metric
} from "../analytics/queries.js";

const metricEnum = z.enum([
  "sleep_score",
  "readiness_score",
  "activity_score",
  "sleep_duration_hours",
  "hrv",
  "resting_hr",
  "temperature_deviation",
  "steps"
]);

const defaultAnomalyMetrics: Metric[] = [
  "sleep_duration_hours",
  "hrv",
  "resting_hr",
  "readiness_score",
  "activity_score",
  "steps"
];

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export function createHealthMcpServer(userId = env.DEV_USER_ID) {
  const server = new McpServer(
    { name: "personal-health-data", version: "0.7.0" },
    {
      instructions:
        "Read-only personal health tools. Before serving health queries, the server refreshes Oura data when the local cache is older than 15 minutes. The sync-status tool itself does not trigger a refresh. The raw diagnostic tool checks Oura API availability versus local raw and normalized layers without returning raw health payloads. Detailed sleep, SpO2, breathing-disturbance, respiratory, heart-rate, and workout tools read the user's synced Oura data. Oura daily SpO2 is a sleep-period daily average; do not imply minute-level oxygen saturation or diagnose sleep apnea from wearable data. Report measurements and statistical trends accurately. Treat insufficient baseline data as uncertain and do not diagnose disease from wearable data."
    }
  );

  const refresh = () => ensureOuraFresh(userId, 15, 3, 90);

  server.registerTool(
    "get_sync_status",
    {
      title: "Get Oura sync status",
      description:
        "Returns Oura connection and cache freshness information without triggering a refresh, including last sync time, cache age, whether the next health query will auto-refresh, latest local data date, and cached record counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      const data = await getOuraSyncStatus(userId, 15);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "get_oura_raw_status",
    {
      title: "Diagnose Oura data availability",
      description:
        "Checks one date directly against the Oura API and compares availability with the local raw cache and normalized daily metrics. Returns counts and availability only, not raw health payloads. Use this to diagnose why a date appears missing or stale.",
      inputSchema: { date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ date }) => {
      const data = await getOuraRawDiagnostic(userId, date);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "get_detailed_sleep",
    {
      title: "Get detailed Oura sleep",
      description:
        "Returns detailed sleep data for one day, including bedtime, total/light/deep/REM sleep, awake time, latency, efficiency, HRV, heart rate, breathing rate, sleep/readiness scores, temperature deviation, and Oura contributors.",
      inputSchema: { date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ date }) => {
      await refresh();
      const data = await getDetailedSleep(userId, date);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "get_daily_spo2",
    {
      title: "Get daily Oura SpO2",
      description:
        "Returns Oura's average blood-oxygen saturation recorded during sleep and the daily breathing disturbance index when available. This is not a minute-level SpO2 trace.",
      inputSchema: { date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ date }) => {
      await refresh();
      const data = await getDailySpO2(userId, date);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "get_respiratory_summary",
    {
      title: "Get Oura respiratory summary",
      description:
        "Returns the respiratory-related Oura data available for one sleep day: average SpO2, breathing disturbance index, average breathing rate, bedtime window, sleep duration, overnight heart rate, and HRV. Includes explicit limitations of Oura's daily SpO2 endpoint.",
      inputSchema: { date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ date }) => {
      await refresh();
      const data = await getRespiratorySummary(userId, date);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "get_heart_rate_series",
    {
      title: "Get Oura heart-rate series",
      description:
        "Returns timestamped Oura heart-rate samples for one day, including source plus daily min, max, and arithmetic average. Requires the heartrate scope.",
      inputSchema: { date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ date }) => {
      await refresh();
      const data = await getHeartRateSeries(userId, date);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "get_workouts",
    {
      title: "Get Oura workouts",
      description:
        "Returns synced Oura workouts across a date range, including activity, source, intensity, start/end time, calories, and distance when available.",
      inputSchema: {
        start_date: dateString,
        end_date: dateString
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ start_date, end_date }) => {
      await refresh();
      const data = await getWorkouts(userId, start_date, end_date);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "get_daily_health_summary",
    {
      title: "Get daily health summary",
      description: "Returns normalized Oura health metrics for one calendar day. Refreshes stale Oura data automatically.",
      inputSchema: { date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ date }) => {
      await refresh();
      const data = await getDailySummary(userId, date);
      return {
        content: [{ type: "text", text: data ? JSON.stringify(data) : `No synced data for ${date}` }],
        structuredContent: { date, data }
      };
    }
  );

  server.registerTool(
    "get_metric_trend",
    {
      title: "Get health metric trend",
      description: "Returns daily values of one normalized wearable metric across a date range. Refreshes stale Oura data automatically.",
      inputSchema: {
        metric: metricEnum,
        start_date: dateString,
        end_date: dateString
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ metric, start_date, end_date }) => {
      await refresh();
      const data = await getMetricTrend(userId, metric as Metric, start_date, end_date);
      return {
        content: [{ type: "text", text: JSON.stringify({ metric, start_date, end_date, data }) }],
        structuredContent: { metric, start_date, end_date, data }
      };
    }
  );

  server.registerTool(
    "get_baseline",
    {
      title: "Get personal baseline",
      description: "Calculates mean, median, standard deviation, min and max for one personal health metric. Refreshes stale Oura data automatically.",
      inputSchema: {
        metric: metricEnum,
        days: z.number().int().min(7).max(365).default(90)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ metric, days }) => {
      await refresh();
      const data = await getBaseline(userId, metric as Metric, days);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "compare_periods",
    {
      title: "Compare health periods",
      description: "Compares the average of a health metric between two date ranges. Refreshes stale Oura data automatically.",
      inputSchema: {
        metric: metricEnum,
        period_a_start: dateString,
        period_a_end: dateString,
        period_b_start: dateString,
        period_b_end: dateString
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ metric, period_a_start, period_a_end, period_b_start, period_b_end }) => {
      await refresh();
      const data = await comparePeriods(
        userId,
        metric as Metric,
        period_a_start,
        period_a_end,
        period_b_start,
        period_b_end
      );
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "get_health_context",
    {
      title: "Get health context",
      description:
        "Returns a compact multi-metric personal health context with latest values, recent averages, personal baselines, and deviations. Refreshes stale Oura data automatically. Baselines with fewer than 14 samples are explicitly marked insufficient.",
      inputSchema: {
        recent_days: z.number().int().min(1).max(30).default(7),
        baseline_days: z.number().int().min(14).max(365).default(90)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ recent_days, baseline_days }) => {
      await refresh();
      const data = await getHealthContext(userId, recent_days, baseline_days, 14);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  server.registerTool(
    "find_anomalies",
    {
      title: "Find health metric anomalies",
      description:
        "Finds current wearable metrics that differ materially from the user's personal baseline. Refreshes stale Oura data automatically. Metrics with fewer than 14 baseline samples are not classified as anomalous.",
      inputSchema: {
        metrics: z.array(metricEnum).min(1).max(8).optional(),
        baseline_days: z.number().int().min(14).max(365).default(90),
        z_threshold: z.number().min(0.5).max(5).default(1.5),
        percent_threshold: z.number().min(5).max(100).default(15)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ metrics, baseline_days, z_threshold, percent_threshold }) => {
      await refresh();
      const selectedMetrics = (metrics as Metric[] | undefined) ?? defaultAnomalyMetrics;
      const data = await findAnomalies(
        userId,
        selectedMetrics,
        baseline_days,
        14,
        z_threshold,
        percent_threshold
      );
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  );

  return server;
}
