import { env } from "../config.js";
import { db } from "../db/pool.js";
import { ensureOuraFresh } from "./sync.js";

let interval: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

async function runBackgroundSyncForUser(userId: string) {
  try {
    const result = await ensureOuraFresh(
      userId,
      env.BACKGROUND_SYNC_INTERVAL_MINUTES,
      env.BACKGROUND_SYNC_RECENT_DAYS,
      env.BACKGROUND_SYNC_RECENT_DAYS
    );

    if (result.status === "refreshed") {
      console.log(
        `[oura-sync] user=${userId} background refresh ${result.start}..${result.end}`,
        result.counts ?? {}
      );
    } else if (result.status === "refresh_failed") {
      console.error(`[oura-sync] user=${userId} background refresh failed: ${result.error ?? "unknown error"}`);
    }
  } catch (error) {
    console.error(
      `[oura-sync] user=${userId} background refresh crashed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

async function runBackgroundSync() {
  const result = await db.query(
    `SELECT user_id
       FROM connections
      WHERE provider='oura' AND status='active'
      ORDER BY user_id`
  );
  for (const row of result.rows) {
    await runBackgroundSyncForUser(String(row.user_id));
  }
}

export function startOuraBackgroundSync() {
  if (!env.BACKGROUND_SYNC_ENABLED || interval || startupTimer) return;

  const intervalMs = env.BACKGROUND_SYNC_INTERVAL_MINUTES * 60_000;
  const startupDelayMs = env.BACKGROUND_SYNC_STARTUP_DELAY_SECONDS * 1000;

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runBackgroundSync();
  }, startupDelayMs);
  startupTimer.unref();

  interval = setInterval(() => {
    void runBackgroundSync();
  }, intervalMs);
  interval.unref();

  console.log(
    `[oura-sync] multi-user background sync enabled every ${env.BACKGROUND_SYNC_INTERVAL_MINUTES} minutes ` +
      `(recent window ${env.BACKGROUND_SYNC_RECENT_DAYS} days)`
  );
}
