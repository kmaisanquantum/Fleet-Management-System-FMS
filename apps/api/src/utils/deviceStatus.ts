/**
 * Shared offline-watchdog helpers. A device is online when its most recent
 * successful ingest is within `DEVICE_OFFLINE_MINUTES` (default 15).
 */
export function offlineWindowMinutes(): number {
  const raw = Number(process.env.DEVICE_OFFLINE_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 15;
}

/** Handles both SQLite `YYYY-MM-DD HH:MM:SS` (UTC) and ISO-8601 timestamps. */
export function isDeviceOnline(lastSeenAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const iso = lastSeenAt.includes("T") ? lastSeenAt : lastSeenAt.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return now - t <= offlineWindowMinutes() * 60 * 1000;
}

/** SQLite-compatible UTC timestamp (`YYYY-MM-DD HH:MM:SS`). */
export function nowSql(date: Date = new Date()): string {
  return date.toISOString().replace("T", " ").substring(0, 19);
}
