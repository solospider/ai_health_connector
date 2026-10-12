import { env } from "../config.js";
import { ensureOuraFresh } from "./sync.js";

let interval: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

async function runBackgroundSync(userId: string) {
  try {
    // Private-alpha background sync intentionally keeps the fetch window small.
    // Historical backfill remains a separate operation until the known Oura
    // heartrate >30-day range limitation is handled explicitly.
    const result = await ensureOuraFresh(
      userId,
      env.BACKGROUND_SYNC_INTERVAL_MINUTES,
      env.BACKGROUND_SYNC_RECENT_DAYS,
      env.BACKGROUND_SYNC_RECENT_DAYS
    );

    if (result.status === "refreshed") {
      console.log(
        `[oura-sync] background refresh ${result.start}..${result.end}`,
        result.counts ?? {}
      );
    } else if (result.status === "refresh_failed") {
      console.error(`[oura-sync] background refresh failed: ${result.error ?? "unknown error"}`);
    }
  } catch (error) {
    console.error(
      `[oura-sync] background refresh crashed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

export function startOuraBackgroundSync(userId: string) {
  if (!env.BACKGROUND_SYNC_ENABLED || interval || startupTimer) return;

  const intervalMs = env.BACKGROUND_SYNC_INTERVAL_MINUTES * 60_000;
  const startupDelayMs = env.BACKGROUND_SYNC_STARTUP_DELAY_SECONDS * 1000;

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runBackgroundSync(userId);
  }, startupDelayMs);
  startupTimer.unref();

  interval = setInterval(() => {
    void runBackgroundSync(userId);
  }, intervalMs);
  interval.unref();

  console.log(
    `[oura-sync] background sync enabled every ${env.BACKGROUND_SYNC_INTERVAL_MINUTES} minutes ` +
      `(recent window ${env.BACKGROUND_SYNC_RECENT_DAYS} days)`
  );
}
