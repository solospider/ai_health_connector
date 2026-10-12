import { db } from "../db/pool.js";
import { getOuraSyncStatus, syncOura } from "../oura/sync.js";

export const PRODUCT_VERSION = "0.9.0";

export function defaultSyncRange(days = 90) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(0, days - 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10)
  };
}

export async function getUserProfile(userId: string) {
  const result = await db.query(
    `SELECT id, timezone, created_at FROM users WHERE id=$1 LIMIT 1`,
    [userId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: String(row.id),
    timezone: String(row.timezone),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}

export async function getConnections(userId: string) {
  const result = await db.query(
    `SELECT provider, status, scopes, last_sync_at, created_at
       FROM connections
      WHERE user_id=$1
      ORDER BY provider`,
    [userId]
  );

  return result.rows.map((row) => ({
    provider: String(row.provider),
    status: String(row.status),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    last_sync_at: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
    connected_at: row.created_at ? new Date(row.created_at).toISOString() : null
  }));
}

export async function getSyncStatus(userId: string) {
  return {
    provider: "oura",
    ...(await getOuraSyncStatus(userId, 15))
  };
}

export async function triggerSync(userId: string, start?: string, end?: string) {
  const defaults = defaultSyncRange();
  const resolvedStart = start ?? defaults.start;
  const resolvedEnd = end ?? defaults.end;
  const counts = await syncOura(userId, resolvedStart, resolvedEnd);
  const status = await getSyncStatus(userId);

  return {
    provider: "oura",
    status: "success" as const,
    start: resolvedStart,
    end: resolvedEnd,
    counts,
    sync: status
  };
}
