import { db } from "../db";
import { ApiError } from "../middleware/errorHandler";
import { getBusinessRuleBoolean, getBusinessRuleNumber } from "../routes/settings";
import { persistFleetAlerts } from "./fleetAlerts";
import { nowSql } from "../utils/deviceStatus";

export interface CameraFeedRow {
  id: string;
  name: string;
  scope: "depot" | "vehicle";
  depot: string | null;
  vehicle_id: string | null;
  imei: string | null;
  stream_url: string | null;
  snapshot_url: string | null;
  mode: "snapshot" | "mjpeg" | "hls" | "webrtc";
  poll_interval_sec: number;
  is_active: number;
  last_seen_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  client_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface CameraProbeResult {
  ok: boolean;
  status: number;
  error: string | null;
  lastSeenAt: string | null;
}

function offlineMinutes(): number {
  return Math.max(1, getBusinessRuleNumber("camera_offline_minutes", undefined, 15));
}

function offlineCooldownMinutes(): number {
  return Math.max(1, getBusinessRuleNumber("camera_offline_cooldown_minutes", undefined, 360));
}

export function isCameraOnline(lastSeenAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const iso = lastSeenAt.includes("T") ? lastSeenAt : `${lastSeenAt.replace(" ", "T")}Z`;
  const time = Date.parse(iso);
  return !Number.isNaN(time) && now - time <= offlineMinutes() * 60 * 1000;
}

function loadFeed(id: string): CameraFeedRow {
  const feed = db.prepare("SELECT * FROM camera_feeds WHERE id = ?").get(id) as CameraFeedRow | undefined;
  if (!feed) throw new ApiError(404, "Camera feed not found");
  return feed;
}

function setProbeResult(id: string, ok: boolean, error: string | null): void {
  const now = nowSql();
  if (ok) {
    db.prepare("UPDATE camera_feeds SET last_checked_at = ?, last_seen_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(
      now,
      now,
      now,
      id
    );
  } else {
    db.prepare("UPDATE camera_feeds SET last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(now, error, now, id);
  }
}

/**
 * Checks one feed without throwing on an unreachable camera. A failed probe is
 * reported in the response and stored on the feed; it is never surfaced as a
 * 401, so an offline camera cannot clear the operator's session.
 */
export async function probeCameraFeed(id: string): Promise<CameraProbeResult> {
  const feed = loadFeed(id);
  const url = feed.snapshot_url?.trim() || feed.stream_url?.trim();
  if (!url) {
    const error = "No snapshot or stream URL configured";
    setProbeResult(id, false, error);
    return { ok: false, status: 0, error, lastSeenAt: feed.last_seen_at };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    const error = "Camera URL must be a valid http:// or https:// address";
    setProbeResult(id, false, error);
    return { ok: false, status: 0, error, lastSeenAt: feed.last_seen_at };
  }

  const timeout = Math.max(1000, Number(process.env.CAMERA_PROBE_TIMEOUT_MS) || 5000);
  try {
    const res = await fetch(parsed.toString(), {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });
    await res.body?.cancel().catch(() => undefined);
    const ok = res.ok || res.status === 206;
    const error = ok ? null : `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    setProbeResult(id, ok, error);
    const updated = db.prepare("SELECT last_seen_at FROM camera_feeds WHERE id = ?").get(id) as { last_seen_at: string | null };
    return { ok, status: res.status, error, lastSeenAt: updated.last_seen_at };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setProbeResult(id, false, `Unreachable: ${message}`);
    return { ok: false, status: 0, error: `Unreachable: ${message}`, lastSeenAt: feed.last_seen_at };
  }
}

/**
 * Probes active feeds that are due and raises a deduplicated camera_offline
 * alert when the last successful contact is older than the configured window.
 */
export async function checkCameraFeeds(now = new Date()): Promise<number> {
  const alertsEnabled = getBusinessRuleBoolean("alert_camera_offline_enabled", undefined, true);

  const feeds = db
    .prepare("SELECT * FROM camera_feeds WHERE is_active = 1")
    .all() as CameraFeedRow[];
  const nowMs = now.getTime();
  const nowIso = nowSql(now);
  let alerts = 0;

  for (const feed of feeds) {
    const pollMs = Math.max(15, Number(feed.poll_interval_sec) || 60) * 1000;
    const lastChecked = feed.last_checked_at
      ? Date.parse(feed.last_checked_at.includes("T") ? feed.last_checked_at : `${feed.last_checked_at.replace(" ", "T")}Z`)
      : 0;
    if (Number.isFinite(lastChecked) && nowMs - lastChecked < pollMs) continue;

    try {
      await probeCameraFeed(feed.id);
    } catch {
      // A missing feed or bad URL is recorded by probeCameraFeed; keep scanning.
    }

    const current = db.prepare("SELECT * FROM camera_feeds WHERE id = ?").get(feed.id) as CameraFeedRow | undefined;
    if (!current) continue;
    const reference = current.last_seen_at ?? current.created_at;
    const referenceMs = reference
      ? Date.parse(reference.includes("T") ? reference : `${reference.replace(" ", "T")}Z`)
      : nowMs;
    if (Number.isFinite(referenceMs) && nowMs - referenceMs <= offlineMinutes() * 60 * 1000) continue;

    if (!alertsEnabled) continue;
    const label = current.scope === "depot" ? `depot ${current.depot ?? current.name}` : current.name;
    const inserted = persistFleetAlerts(
      [
        {
          alertType: "camera_offline",
          ruleCode: "RULE_CAMERA_OFFLINE",
          severity: "warning",
          message: `Camera "${current.name}" (${label}) is offline/unreachable${current.last_error ? `: ${current.last_error}` : "."}`,
          dedupeKey: `camera:${current.id}:offline`,
          cooldownSeconds: offlineCooldownMinutes() * 60,
        },
      ],
      {
        imei: current.imei ?? `camera:${current.id}`,
        vehicleId: current.vehicle_id,
        lat: null,
        lon: null,
        speed: null,
        voltage: null,
        createdAt: nowIso,
      }
    );
    alerts += inserted.length;
  }

  return alerts;
}

let monitorTimer: NodeJS.Timeout | null = null;
let monitorRunning = false;

/** Starts the camera watchdog. Safe to call more than once. */
export function startCameraMonitor(): void {
  if (process.env.NODE_ENV === "test" || process.env.DISABLE_CAMERA_MONITOR === "true") return;
  if (monitorTimer) return;
  monitorTimer = setInterval(() => {
    if (monitorRunning) return;
    monitorRunning = true;
    void checkCameraFeeds()
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("Camera monitor failed", error);
      })
      .finally(() => {
        monitorRunning = false;
      });
  }, 60_000);
  monitorTimer.unref?.();
}
