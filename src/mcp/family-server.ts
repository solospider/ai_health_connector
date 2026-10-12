import { z } from "zod";
import {
  getDailySpO2,
  getDetailedSleep,
  getHeartRateSeries,
  getRespiratorySummary,
  getWorkouts
} from "../oura/details.js";
import { ensureOuraFresh } from "../oura/sync.js";
import {
  findAnomalies,
  getDailySummary,
  getHealthContext,
  getMetricTrend,
  type Metric
} from "../analytics/queries.js";
import { listFamilyProfiles, resolveFamilyProfile } from "../services/family.js";
import { createHealthMcpServer } from "./server.js";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const profileString = z.string().min(1).max(80).describe("Family profile name, for example Heng; use self for the authenticated user's own data");
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
const anomalyMetrics = z.array(metricEnum).min(1).max(8).optional();
const defaultAnomalyMetrics: Metric[] = [
  "sleep_duration_hours",
  "hrv",
  "resting_hr",
  "readiness_score",
  "activity_score",
  "steps"
];

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>
  };
}

export function createFamilyHealthMcpServer(ownerUserId: string) {
  const server = createHealthMcpServer(ownerUserId);

  async function target(profile: string) {
    const resolved = await resolveFamilyProfile(ownerUserId, profile);
    await ensureOuraFresh(resolved.userId, 15, 3, 90);
    return resolved;
  }

  server.registerTool(
    "get_family_profiles",
    {
      title: "List authorized family health profiles",
      description:
        "Lists the authenticated user's own health profile plus family profiles that explicitly granted this account read access. Use the returned profile names with the family health tools; never guess a profile that is not listed.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => result({ profiles: await listFamilyProfiles(ownerUserId) })
  );

  server.registerTool(
    "get_family_health_context",
    {
      title: "Get family member health context",
      description:
        "Returns recent multi-metric health context for one explicitly authorized family profile. The profile parameter is a family alias such as Heng, or self.",
      inputSchema: {
        profile: profileString,
        recent_days: z.number().int().min(1).max(30).default(7),
        baseline_days: z.number().int().min(14).max(365).default(90)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ profile, recent_days, baseline_days }) => {
      const resolved = await target(profile);
      return result({ profile: resolved.profile, data: await getHealthContext(resolved.userId, recent_days, baseline_days, 14) });
    }
  );

  server.registerTool(
    "get_family_daily_health_summary",
    {
      title: "Get family member daily health summary",
      description: "Returns normalized Oura health metrics for one day for an explicitly authorized family profile.",
      inputSchema: { profile: profileString, date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ profile, date }) => {
      const resolved = await target(profile);
      return result({ profile: resolved.profile, date, data: await getDailySummary(resolved.userId, date) });
    }
  );

  server.registerTool(
    "get_family_detailed_sleep",
    {
      title: "Get family member detailed sleep",
      description: "Returns detailed Oura sleep metrics for one day for an explicitly authorized family profile.",
      inputSchema: { profile: profileString, date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ profile, date }) => {
      const resolved = await target(profile);
      return result({ profile: resolved.profile, data: await getDetailedSleep(resolved.userId, date) });
    }
  );

  server.registerTool(
    "get_family_metric_trend",
    {
      title: "Get family member metric trend",
      description: "Returns a daily health metric trend across a date range for an explicitly authorized family profile.",
      inputSchema: { profile: profileString, metric: metricEnum, start_date: dateString, end_date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ profile, metric, start_date, end_date }) => {
      const resolved = await target(profile);
      const data = await getMetricTrend(resolved.userId, metric as Metric, start_date, end_date);
      return result({ profile: resolved.profile, metric, start_date, end_date, data });
    }
  );

  server.registerTool(
    "get_family_spo2",
    {
      title: "Get family member daily SpO2",
      description: "Returns Oura sleep-period average SpO2 and breathing disturbance data for an explicitly authorized family profile.",
      inputSchema: { profile: profileString, date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ profile, date }) => {
      const resolved = await target(profile);
      return result({ profile: resolved.profile, data: await getDailySpO2(resolved.userId, date) });
    }
  );

  server.registerTool(
    "get_family_respiratory_summary",
    {
      title: "Get family member respiratory summary",
      description: "Returns Oura respiratory-related sleep data for an explicitly authorized family profile.",
      inputSchema: { profile: profileString, date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ profile, date }) => {
      const resolved = await target(profile);
      return result({ profile: resolved.profile, data: await getRespiratorySummary(resolved.userId, date) });
    }
  );

  server.registerTool(
    "get_family_heart_rate_series",
    {
      title: "Get family member heart-rate series",
      description: "Returns timestamped Oura heart-rate samples for one day for an explicitly authorized family profile.",
      inputSchema: { profile: profileString, date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ profile, date }) => {
      const resolved = await target(profile);
      return result({ profile: resolved.profile, data: await getHeartRateSeries(resolved.userId, date) });
    }
  );

  server.registerTool(
    "get_family_workouts",
    {
      title: "Get family member workouts",
      description: "Returns synced Oura workouts across a date range for an explicitly authorized family profile.",
      inputSchema: { profile: profileString, start_date: dateString, end_date: dateString },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ profile, start_date, end_date }) => {
      const resolved = await target(profile);
      return result({ profile: resolved.profile, data: await getWorkouts(resolved.userId, start_date, end_date) });
    }
  );

  server.registerTool(
    "find_family_anomalies",
    {
      title: "Find family member health anomalies",
      description: "Finds wearable metrics that differ materially from baseline for an explicitly authorized family profile.",
      inputSchema: {
        profile: profileString,
        metrics: anomalyMetrics,
        baseline_days: z.number().int().min(14).max(365).default(90),
        z_threshold: z.number().min(0.5).max(5).default(1.5),
        percent_threshold: z.number().min(5).max(100).default(15)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ profile, metrics, baseline_days, z_threshold, percent_threshold }) => {
      const resolved = await target(profile);
      const selected = (metrics as Metric[] | undefined) ?? defaultAnomalyMetrics;
      const data = await findAnomalies(resolved.userId, selected, baseline_days, 14, z_threshold, percent_threshold);
      return result({ profile: resolved.profile, data });
    }
  );

  return server;
}
