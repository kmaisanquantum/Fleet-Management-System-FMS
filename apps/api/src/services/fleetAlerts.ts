import { v4 as uuid } from "uuid";
import { db } from "../db";
import { getBusinessRuleBoolean, getBusinessRuleNumber } from "../routes/settings";
import { nowSql } from "../utils/deviceStatus";
import { sendAlertEmail } from "./email";

export interface FleetAlertCandidate {
  alertType: string;
  ruleCode: string;
  severity: "critical" | "warning" | "info";
  message: string;
  dedupeKey?: string;
  cooldownSeconds?: number;
}

export interface PreviousTelemetry {
  ignition: number | null;
  extVoltageV: number | null;
  lat: number | null;
  lon: number | null;
  io: Record<string, number>;
}

export interface TelemetryAlertContext {
  imei: string;
  vehicleId: string;
  vehicleNumber: string;
  registrationNumber: string;
  clientId: string | null;
  lat: number;
  lon: number;
  speed: number | null;
  ignition: number;
  voltage: number | null;
  recordedAt: string;
  io: Record<string, number>;
  previous: PreviousTelemetry | null;
}

export interface FleetAlertRow {
  id: string;
  imei: string;
  vehicle_id: string | null;
  alert_type: string;
  severity: string;
  message: string;
  lat: number | null;
  lon: number | null;
  speed: number | null;
  voltage: number | null;
  email_sent: number;
  email_sent_at: string | null;
  acknowledged: number;
  created_at: string;
  rule_code: string | null;
  dedupe_key: string | null;
  email_error: string | null;
}

export function alertCooldownSeconds(): number {
  return Math.max(0, getBusinessRuleNumber("alert_cooldown_seconds", undefined, 300));
}

export function alertOfflineMinutes(): number {
  return Math.max(1, getBusinessRuleNumber("alert_offline_minutes", "DEVICE_OFFLINE_MINUTES", 15));
}

export function alertOfflineCooldownMinutes(): number {
  return Math.max(1, getBusinessRuleNumber("alert_offline_cooldown_minutes", undefined, 360));
}

function ioValue(io: Record<string, number>, id: number): number | undefined {
  const value = io[String(id)];
  return value === undefined || value === null ? undefined : Number(value);
}

function truthy(io: Record<string, number>, id: number): boolean {
  const value = ioValue(io, id);
  return value !== undefined && Number(value) !== 0;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface GeofenceRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius_meters: number;
}

function activeGeofences(clientId: string | null): GeofenceRow[] {
  if (clientId) {
    return db
      .prepare("SELECT id, name, lat, lon, radius_meters FROM geofences WHERE status = 'active' AND (client_id IS NULL OR client_id = ?)")
      .all(clientId) as GeofenceRow[];
  }
  return db.prepare("SELECT id, name, lat, lon, radius_meters FROM geofences WHERE status = 'active'").all() as GeofenceRow[];
}

/**
 * Evaluates one incoming AVL record against the configurable alert rules.
 * Returns candidates; persistence/cooldown is handled separately.
 */
export function evaluateTelemetryAlerts(ctx: TelemetryAlertContext): FleetAlertCandidate[] {
  const candidates: FleetAlertCandidate[] = [];
  const previous = ctx.previous;
  const vehicle = `${ctx.vehicleNumber} (${ctx.registrationNumber})`;

  const overspeedEnabled = getBusinessRuleBoolean("alert_overspeed_enabled", undefined, true);
  const ignitionEnabled = getBusinessRuleBoolean("alert_ignition_enabled", undefined, true);
  const powerEnabled = getBusinessRuleBoolean("alert_power_enabled", undefined, true);
  const geofenceEnabled = getBusinessRuleBoolean("alert_geofence_enabled", undefined, true);
  const securityEnabled = getBusinessRuleBoolean("alert_security_enabled", undefined, true);
  const overspeedKmh = getBusinessRuleNumber("alert_overspeed_kmh", undefined, 80);
  const lowVoltageV = getBusinessRuleNumber("alert_low_voltage_v", undefined, 11.5);

  if (overspeedEnabled && ctx.speed != null && ctx.speed > overspeedKmh) {
    candidates.push({
      alertType: "overspeed",
      ruleCode: "RULE_OVERSPEED",
      severity: "warning",
      message: `${vehicle} exceeded the ${overspeedKmh} km/h threshold at ${ctx.speed.toFixed(1)} km/h.`,
      dedupeKey: `${ctx.imei}:overspeed`,
    });
  } else if (overspeedEnabled && truthy(ctx.io, 255)) {
    candidates.push({
      alertType: "overspeed",
      ruleCode: "RULE_OVERSPEED_IO",
      severity: "warning",
      message: `${vehicle} reported an overspeeding IO event (IO 255).`,
      dedupeKey: `${ctx.imei}:overspeed`,
    });
  }

  if (ignitionEnabled && previous && previous.ignition != null && previous.ignition !== ctx.ignition) {
    const on = ctx.ignition === 1;
    candidates.push({
      alertType: on ? "ignition_on" : "ignition_off",
      ruleCode: on ? "RULE_IGNITION_ON" : "RULE_IGNITION_OFF",
      severity: "info",
      message: `${vehicle} ignition ${on ? "ON" : "OFF"}.`,
      dedupeKey: `${ctx.imei}:${on ? "ignition_on" : "ignition_off"}`,
    });
  }

  if (powerEnabled) {
    const voltage = ctx.voltage;
    if (voltage != null && voltage < 1) {
      candidates.push({
        alertType: "power_cut",
        ruleCode: "RULE_MAIN_POWER_CUT",
        severity: "critical",
        message: `${vehicle} lost external power (${voltage.toFixed(2)} V).`,
        dedupeKey: `${ctx.imei}:power_cut`,
      });
    } else if (voltage != null && voltage > 0 && voltage < lowVoltageV) {
      candidates.push({
        alertType: "low_voltage",
        ruleCode: "RULE_LOW_VOLTAGE",
        severity: "warning",
        message: `${vehicle} external voltage is low (${voltage.toFixed(2)} V; threshold ${lowVoltageV} V).`,
        dedupeKey: `${ctx.imei}:low_voltage`,
      });
    }
    if (truthy(ctx.io, 252)) {
      candidates.push({
        alertType: "power_cut",
        ruleCode: "RULE_DEVICE_UNPLUG",
        severity: "critical",
        message: `${vehicle} reported a device unplug / tamper event (IO 252).`,
        dedupeKey: `${ctx.imei}:power_cut`,
      });
    }
  }

  if (geofenceEnabled) {
    const fences = activeGeofences(ctx.clientId);
    if (fences.length > 0 && previous?.lat != null && previous?.lon != null) {
      for (const fence of fences) {
        const wasInside = haversineKm(previous.lat, previous.lon, fence.lat, fence.lon) * 1000 <= fence.radius_meters;
        const isInside = haversineKm(ctx.lat, ctx.lon, fence.lat, fence.lon) * 1000 <= fence.radius_meters;
        if (wasInside !== isInside) {
          candidates.push({
            alertType: isInside ? "geofence_entry" : "geofence_exit",
            ruleCode: isInside ? "RULE_GEOFENCE_ENTER" : "RULE_GEOFENCE_EXIT",
            severity: "warning",
            message: `${vehicle} ${isInside ? "entered" : "exited"} geofence "${fence.name}".`,
            dedupeKey: `${ctx.imei}:${isInside ? "geofence_entry" : "geofence_exit"}:${fence.id}`,
          });
        }
      }
    } else if (fences.length === 0) {
      if (truthy(ctx.io, 175)) {
        candidates.push({
          alertType: "geofence_entry",
          ruleCode: "RULE_GEOFENCE_IO",
          severity: "warning",
          message: `${vehicle} reported a geofence event (IO 175).`,
          dedupeKey: `${ctx.imei}:geofence_entry:io175`,
        });
      }
      for (let id = 155; id <= 174; id++) {
        if (!truthy(ctx.io, id)) continue;
        candidates.push({
          alertType: "geofence_entry",
          ruleCode: "RULE_GEOFENCE_ZONE",
          severity: "warning",
          message: `${vehicle} reported geofence zone ${id} (IO ${id}).`,
          dedupeKey: `${ctx.imei}:geofence_entry:zone${id}`,
        });
      }
    }
  }

  if (securityEnabled) {
    if (truthy(ctx.io, 249)) {
      candidates.push({
        alertType: "jamming",
        ruleCode: "RULE_JAMMING",
        severity: "critical",
        message: `${vehicle} reported network jamming (IO 249).`,
        dedupeKey: `${ctx.imei}:jamming`,
      });
    }
    if (truthy(ctx.io, 179)) {
      candidates.push({
        alertType: "immobilizer",
        ruleCode: "RULE_IMMOBILIZER",
        severity: "warning",
        message: `${vehicle} immobilizer / DOUT state is active (IO 179).`,
        dedupeKey: `${ctx.imei}:immobilizer`,
      });
    }
    if (truthy(ctx.io, 300)) {
      candidates.push({
        alertType: "sos",
        ruleCode: "RULE_SOS",
        severity: "critical",
        message: `${vehicle} reported an SOS trigger (IO 300).`,
        dedupeKey: `${ctx.imei}:sos`,
      });
    }
    if (truthy(ctx.io, 246)) {
      candidates.push({
        alertType: "towing",
        ruleCode: "RULE_TOWING",
        severity: "critical",
        message: `${vehicle} reported a towing event (IO 246).`,
        dedupeKey: `${ctx.imei}:towing`,
      });
    }
    if (truthy(ctx.io, 247)) {
      candidates.push({
        alertType: "crash",
        ruleCode: "RULE_CRASH",
        severity: "critical",
        message: `${vehicle} reported a crash event (IO 247).`,
        dedupeKey: `${ctx.imei}:crash`,
      });
    }
    for (const din of [1, 2, 3, 4]) {
      const current = ioValue(ctx.io, din);
      const before = previous?.io[String(din)];
      if (current !== undefined && current !== 0 && before !== current) {
        candidates.push({
          alertType: "din_trigger",
          ruleCode: `RULE_DIN${din}`,
          severity: "warning",
          message: `${vehicle} digital input DIN${din} triggered.`,
          dedupeKey: `${ctx.imei}:din_trigger:${din}`,
        });
      }
    }
  }

  if (truthy(ctx.io, 251)) {
    candidates.push({
      alertType: "excessive_idling",
      ruleCode: "RULE_EXCESSIVE_IDLING",
      severity: "warning",
      message: `${vehicle} reported excessive idling (IO 251).`,
      dedupeKey: `${ctx.imei}:excessive_idling`,
    });
  }
  if (truthy(ctx.io, 253)) {
    candidates.push({
      alertType: "harsh_acceleration",
      ruleCode: "RULE_HARSH_ACCELERATION",
      severity: "info",
      message: `${vehicle} reported harsh acceleration (IO 253).`,
      dedupeKey: `${ctx.imei}:harsh_acceleration`,
    });
  }
  if (truthy(ctx.io, 254)) {
    candidates.push({
      alertType: "harsh_braking",
      ruleCode: "RULE_HARSH_BRAKING",
      severity: "info",
      message: `${vehicle} reported harsh braking (IO 254).`,
      dedupeKey: `${ctx.imei}:harsh_braking`,
    });
  }

  return candidates;
}

interface PersistBase {
  imei: string;
  vehicleId: string | null;
  lat: number | null;
  lon: number | null;
  speed: number | null;
  voltage: number | null;
  createdAt: string;
}

/** Persists candidates, suppressing duplicates inside their cooldown window. */
export function persistFleetAlerts(candidates: FleetAlertCandidate[], base: PersistBase): FleetAlertRow[] {
  const inserted: FleetAlertRow[] = [];
  const defaultCooldown = alertCooldownSeconds();
  const insert = db.prepare(`
    INSERT INTO fleet_alerts (
      id, imei, vehicle_id, alert_type, severity, message, lat, lon, speed, voltage,
      email_sent, created_at, rule_code, dedupe_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);

  for (const candidate of candidates) {
    const dedupeKey = candidate.dedupeKey ?? `${base.imei}:${candidate.alertType}`;
    const cooldown = candidate.cooldownSeconds ?? defaultCooldown;
    const recent = db
      .prepare(`
        SELECT id FROM fleet_alerts
        WHERE dedupe_key = ? AND datetime(created_at) >= datetime('now', ?)
        LIMIT 1
      `)
      .get(dedupeKey, `-${cooldown} seconds`) as { id: string } | undefined;
    if (recent) continue;

    const id = uuid();
    insert.run(
      id,
      base.imei,
      base.vehicleId,
      candidate.alertType,
      candidate.severity,
      candidate.message,
      base.lat,
      base.lon,
      base.speed,
      base.voltage,
      base.createdAt,
      candidate.ruleCode,
      dedupeKey
    );
    const row = db.prepare("SELECT * FROM fleet_alerts WHERE id = ?").get(id) as FleetAlertRow;
    inserted.push(row);
    // Fire-and-forget: ingest must not wait on an SMTP round trip. Delivery
    // status is written back to fleet_alerts by sendAlertEmail().
    void sendAlertEmail(id);
  }
  return inserted;
}

/** Checks for devices that have gone silent and raises deduplicated alerts. */
export function checkOfflineDevices(): number {
  if (!getBusinessRuleBoolean("alert_offline_enabled", undefined, true)) return 0;

  const minutes = alertOfflineMinutes();
  const cooldown = alertOfflineCooldownMinutes() * 60;
  const rows = db.prepare(`
    SELECT g.device_identifier AS imei, g.vehicle_id, g.last_seen_at,
           v.vehicle_number, v.registration_number,
           v.current_latitude AS lat, v.current_longitude AS lon
    FROM gps_devices g
    JOIN vehicles v ON v.id = g.vehicle_id
    WHERE g.status = 'active'
      AND g.last_seen_at IS NOT NULL
      AND v.status != 'disposed'
      AND datetime(g.last_seen_at) < datetime('now', ?)
  `).all(`-${minutes} minutes`) as {
    imei: string;
    vehicle_id: string;
    last_seen_at: string;
    vehicle_number: string;
    registration_number: string;
    lat: number | null;
    lon: number | null;
  }[];

  let count = 0;
  for (const row of rows) {
    const inserted = persistFleetAlerts(
      [
        {
          alertType: "device_offline",
          ruleCode: "RULE_DEVICE_OFFLINE",
          severity: "critical",
          message: `${row.vehicle_number} (${row.registration_number}) has not reported since ${row.last_seen_at} UTC.`,
          dedupeKey: `${row.imei}:device_offline`,
          cooldownSeconds: cooldown,
        },
      ],
      {
        imei: row.imei,
        vehicleId: row.vehicle_id,
        lat: row.lat,
        lon: row.lon,
        speed: null,
        voltage: null,
        createdAt: nowSql(),
      }
    );
    count += inserted.length;
  }
  return count;
}

let monitorTimer: NodeJS.Timeout | null = null;

/** Starts the offline watchdog. Safe to call more than once. */
export function startAlertMonitor(): void {
  if (process.env.NODE_ENV === "test" || process.env.DISABLE_ALERT_MONITOR === "true") return;
  if (monitorTimer) return;
  monitorTimer = setInterval(() => {
    try {
      checkOfflineDevices();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Alert monitor failed", e);
    }
  }, 60_000);
  monitorTimer.unref?.();
}
