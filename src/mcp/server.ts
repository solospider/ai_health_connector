import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from "../config.js";
import { ensureOuraFresh } from "../oura/sync.js";
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
    { name: "personal-health-data", version: "0.3.0" },
    {
      instructions:
        "Read-only personal health tools. Before serving health queries, the server refreshes Oura data when the local cache is older than 15 minutes. Report measurements and statistical trends accurately. Treat insufficient baseline data as uncertain and do not diagnose disease from wearable data."
    }
  );

  const refresh = () => ensureOuraFresh(userId, 15, 3, 90);

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
