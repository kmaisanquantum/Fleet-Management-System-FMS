import { db } from "../db";
import { isDeviceOnline, nowSql, offlineWindowMinutes } from "../utils/deviceStatus";
import { isCameraOnline } from "./cameras";

const DAY_MS = 24 * 60 * 60 * 1000;
const PGT_OFFSET_MS = 10 * 60 * 60 * 1000;

export type InsightSeverity = "critical" | "warning" | "info";
export type InsightCategory =
  | "telemetry"
  | "exceptions"
  | "maintenance"
  | "compliance"
  | "safety"
  | "fuel"
  | "operations";

export interface FleetInsight {
  id: string;
  severity: InsightSeverity;
  category: InsightCategory;
  title: string;
  detail: string;
  recommendation: string;
  actionLabel: string;
  actionHref: string;
  entityType?: "vehicle" | "driver" | "camera" | "fuel_card" | "exception";
  entityId?: string;
  dueAt?: string;
  metric?: number;
}

export interface FleetHealthComponent {
  key: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
}

export interface FleetIntelligence {
  generatedAt: string;
  health: {
    score: number;
    grade: "excellent" | "good" | "attention" | "critical";
    label: string;
    components: FleetHealthComponent[];
  };
  summary: {
    total: number;
    critical: number;
    warning: number;
    info: number;
  };
  coverage: {
    vehicles: number;
    onlineVehicles: number;
    drivers: number;
    cameras: number;
    onlineCameras: number;
  };
  insights: FleetInsight[];
}

interface VehicleRow {
  id: string;
  vehicle_number: string;
  registration_number: string;
  status: string;
  department: string | null;
  client_id: string | null;
  last_seen_at: string | null;
  registration_expiry: string | null;
  insurance_expiry: string | null;
  expected_km_per_l: number | null;
}

interface DriverRow {
  id: string;
  employee_number: string;
  name: string;
  department: string | null;
  licence_expiry: string | null;
  authorisation_status: string;
}

interface MaintenanceRow {
  id: string;
  vehicle_id: string;
  vehicle_number: string;
  description: string;
  scheduled_date: string | null;
  status: string;
}

interface ScheduleRow {
  id: string;
  vehicle_id: string;
  vehicle_number: string;
  interval_type: string;
  interval_value: number;
  next_due: string;
}

interface ExceptionCounts {
  critical: number;
  warning: number;
  info: number;
}

interface FuelStatRow {
  vehicle_id: string;
  samples: number;
  avg_kml: number;
  last_date: string | null;
}

interface CameraRow {
  id: string;
  name: string;
  last_seen_at: string | null;
  scope: string;
  vehicle_id: string | null;
  vehicle_number: string | null;
}

interface DriverEventRow {
  driver_id: string;
  event_type: string;
  count: number;
}

interface BuildOptions {
  scopes?: string[] | null;
  now?: Date;
  limit?: number;
}

function pgtDate(now: Date): string {
  return new Date(now.getTime() + PGT_OFFSET_MS).toISOString().slice(0, 10);
}

function daysUntil(date: string | null | undefined, today: string): number | null {
  if (!date) return null;
  const dateOnly = date.slice(0, 10);
  const due = Date.parse(`${dateOnly}T00:00:00Z`);
  const base = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(base)) return null;
  return Math.round((due - base) / DAY_MS);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

/** Adds an `AND <alias>.client_id IN (...)` fragment for client-role users. */
function vehicleScope(scopes: string[] | null, alias = "v"): { sql: string; params: string[] } {
  if (!scopes || scopes.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND ${alias}.client_id IN (${scopes.map(() => "?").join(", ")})`,
    params: scopes,
  };
}

/** Cameras inherit their client from the feed or their vehicle. */
function cameraScope(scopes: string[] | null): { sql: string; params: string[] } {
  if (!scopes || scopes.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND COALESCE(cf.client_id, v.client_id) IN (${scopes.map(() => "?").join(", ")})`,
    params: scopes,
  };
}

function driverSafetyScores(drivers: DriverRow[], events: DriverEventRow[]) {
  const weights: Record<string, number> = {
    speeding: 10,
    harsh_braking: 5,
    harsh_accel: 5,
    excessive_idling: 3,
    harsh_cornering: 5,
    crash: 15,
  };
  const eventCounts = new Map<string, Record<string, number>>();
  for (const event of events) {
    if (!eventCounts.has(event.driver_id)) eventCounts.set(event.driver_id, {});
    eventCounts.get(event.driver_id)![event.event_type] = Number(event.count) || 0;
  }
  return drivers.map((driver) => {
    const counts = eventCounts.get(driver.id) ?? {};
    const penalty = Object.entries(counts).reduce((sum, [type, count]) => sum + (weights[type] ?? 0) * count, 0);
    return {
      driver,
      counts,
      score: Math.max(0, 100 - penalty),
    };
  });
}

function healthGrade(score: number): { grade: FleetIntelligence["health"]["grade"]; label: string } {
  if (score >= 90) return { grade: "excellent", label: "Excellent" };
  if (score >= 80) return { grade: "good", label: "Good" };
  if (score >= 65) return { grade: "attention", label: "Needs attention" };
  return { grade: "critical", label: "Critical" };
}

/**
 * Consolidates fuel, telematics, maintenance, compliance and safety signals
 * into a health score and a ranked action list. All recommendations are
 * explainable: each one names the vehicle/driver and the underlying metric.
 */
export function buildFleetIntelligence(options: BuildOptions = {}): FleetIntelligence {
  const now = options.now ?? new Date();
  const today = pgtDate(now);
  const limit = Math.min(50, Math.max(1, options.limit ?? 12));
  const scopes = options.scopes ?? null;
  const vehicleFilter = vehicleScope(scopes);
  const cameraFilter = cameraScope(scopes);
  const insights: FleetInsight[] = [];

  const add = (insight: Omit<FleetInsight, "id"> & { id?: string }) => {
    insights.push({ ...insight, id: insight.id ?? `${insight.category}:${insights.length + 1}` });
  };

  const vehicles = db
    .prepare(
      `SELECT v.id, v.vehicle_number, v.registration_number, v.status, v.department,
              v.client_id, v.last_seen_at, v.registration_expiry, v.insurance_expiry,
              v.expected_km_per_l
       FROM vehicles v
       WHERE v.status != 'disposed'${vehicleFilter.sql}`
    )
    .all(...vehicleFilter.params) as VehicleRow[];

  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const onlineVehicles = vehicles.filter((vehicle) => isDeviceOnline(vehicle.last_seen_at, now.getTime())).length;
  const offlineVehicles = vehicles.length - onlineVehicles;

  // Client users only see drivers who have been allocated one of their vehicles.
  const driverFilter =
    scopes && scopes.length > 0
      ? {
          sql: ` WHERE d.id IN (
            SELECT va.driver_id FROM vehicle_allocations va
            JOIN vehicles v ON v.id = va.vehicle_id
            WHERE va.driver_id IS NOT NULL AND v.client_id IN (${scopes.map(() => "?").join(", ")})
          )`,
          params: scopes as unknown[],
        }
      : { sql: "", params: [] as unknown[] };
  const drivers = db
    .prepare(
      `SELECT d.id, d.employee_number, d.name, d.department, d.licence_expiry, d.authorisation_status
       FROM drivers d${driverFilter.sql}`
    )
    .all(...driverFilter.params) as DriverRow[];

  const exceptionRows = db
    .prepare(
      `SELECT fe.severity, COUNT(*) AS count
       FROM fleet_exceptions fe
       LEFT JOIN vehicles v ON v.id = fe.vehicle_id
       WHERE fe.status IN ('open', 'investigating')${scopes ? vehicleFilter.sql : ""}
       GROUP BY fe.severity`
    )
    .all(...(scopes ? vehicleFilter.params : [])) as { severity: string; count: number }[];
  const exceptionCounts: ExceptionCounts = { critical: 0, warning: 0, info: 0 };
  for (const row of exceptionRows) {
    if (row.severity in exceptionCounts) exceptionCounts[row.severity as keyof ExceptionCounts] = Number(row.count);
  }

  const recentCritical = db
    .prepare(
      `SELECT fe.id, fe.rule_code, fe.description, v.vehicle_number
       FROM fleet_exceptions fe
       LEFT JOIN vehicles v ON v.id = fe.vehicle_id
       WHERE fe.status IN ('open', 'investigating') AND fe.severity = 'critical'${scopes ? vehicleFilter.sql : ""}
       ORDER BY fe.created_at DESC
       LIMIT 3`
    )
    .all(...(scopes ? vehicleFilter.params : [])) as {
    id: string;
    rule_code: string;
    description: string;
    vehicle_number: string | null;
  }[];

  const maintenanceRows = db
    .prepare(
      `SELECT vm.id, vm.vehicle_id, v.vehicle_number, vm.description, vm.scheduled_date, vm.status
       FROM vehicle_maintenance vm
       JOIN vehicles v ON v.id = vm.vehicle_id
       WHERE vm.status IN ('scheduled', 'in_progress') AND vm.scheduled_date IS NOT NULL${vehicleFilter.sql}
       ORDER BY date(vm.scheduled_date) ASC`
    )
    .all(...vehicleFilter.params) as MaintenanceRow[];

  const scheduleRows = db
    .prepare(
      `SELECT ms.id, ms.vehicle_id, v.vehicle_number, ms.interval_type, ms.interval_value, ms.next_due
       FROM maintenance_schedules ms
       JOIN vehicles v ON v.id = ms.vehicle_id
       WHERE ms.next_due IS NOT NULL${vehicleFilter.sql}
       ORDER BY date(ms.next_due) ASC`
    )
    .all(...vehicleFilter.params) as ScheduleRow[];

  const fuelStats = db
    .prepare(
      `SELECT fl.vehicle_id, COUNT(*) AS samples, AVG(fl.km_per_l) AS avg_kml, MAX(fl.date) AS last_date
       FROM vehicle_fuel_logs fl
       JOIN vehicles v ON v.id = fl.vehicle_id
       WHERE fl.km_per_l IS NOT NULL AND fl.km_per_l > 0${vehicleFilter.sql}
       GROUP BY fl.vehicle_id`
    )
    .all(...vehicleFilter.params) as FuelStatRow[];

  const flaggedFuelCards = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM fuel_card_transactions fct
         JOIN vehicles v ON v.id = fct.vehicle_id
         WHERE fct.status = 'flagged'${vehicleFilter.sql}`
      )
      .get(...vehicleFilter.params) as { count: number }
  ).count;

  const cameraRows = db
    .prepare(
      `SELECT cf.id, cf.name, cf.last_seen_at, cf.scope, cf.vehicle_id, v.vehicle_number
       FROM camera_feeds cf
       LEFT JOIN vehicles v ON v.id = cf.vehicle_id
       WHERE cf.is_active = 1${cameraFilter.sql}`
    )
    .all(...cameraFilter.params) as CameraRow[];
  const onlineCameras = cameraRows.filter((camera) => isCameraOnline(camera.last_seen_at, now.getTime())).length;
  const offlineCameras = cameraRows.length - onlineCameras;

  const openBreakdowns = (
    db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(vb.towing_required), 0) AS towing
         FROM vehicle_breakdowns vb
         JOIN vehicles v ON v.id = vb.vehicle_id
         WHERE vb.status != 'resolved'${vehicleFilter.sql}`
      )
      .get(...vehicleFilter.params) as { count: number; towing: number }
  );

  const failedInspections = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM vehicle_inspections vi
         JOIN vehicles v ON v.id = vi.vehicle_id
         WHERE vi.result IN ('fail', 'requires_attention')
           AND date(vi.inspection_date) >= date(?)
           ${vehicleFilter.sql}`
      )
      .get(new Date(now.getTime() - 30 * DAY_MS).toISOString().slice(0, 10), ...vehicleFilter.params) as {
      count: number;
    }
  ).count;

  const driverEvents = db
    .prepare(
      `SELECT driver_id, event_type, COUNT(*) AS count
       FROM driver_events
       WHERE datetime(recorded_at) >= datetime(?)
       GROUP BY driver_id, event_type`
    )
    .all(nowSql(new Date(now.getTime() - 30 * DAY_MS))) as DriverEventRow[];

  const driverScores = driverSafetyScores(drivers, driverEvents);
  const activeDriverScores = driverScores.filter((driver) => Object.keys(driver.counts).length > 0);
  const averageSafetyScore =
    activeDriverScores.length === 0
      ? 100
      : Math.round(activeDriverScores.reduce((sum, driver) => sum + driver.score, 0) / activeDriverScores.length);

  let maintenanceOverdue = 0;
  let maintenanceDueSoon = 0;
  let complianceExpired = 0;
  let complianceExpiring = 0;
  let suspendedDrivers = 0;
  let fuelOutliers = 0;

  const maintenanceDeadline = (label: string, due: string | null, vehicleNumber: string, entityId: string) => {
    const days = daysUntil(due, today);
    if (days === null) return;
    if (days < 0) {
      maintenanceOverdue += 1;
      add({
        id: `maintenance:overdue:${entityId}:${due}`,
        severity: days <= -7 ? "critical" : "warning",
        category: "maintenance",
        title: `Service overdue for ${vehicleNumber}`,
        detail: `${label} was due ${due} (${plural(Math.abs(days), "day")} overdue).`,
        recommendation: "Book the service to protect warranty, safety and fuel efficiency.",
        actionLabel: "Open maintenance",
        actionHref: "/fleet-maintenance",
        entityType: "vehicle",
        entityId,
        dueAt: due ?? undefined,
        metric: Math.abs(days),
      });
    } else if (days <= 14) {
      maintenanceDueSoon += 1;
      add({
        id: `maintenance:due-soon:${entityId}:${due}`,
        severity: days <= 3 ? "warning" : "info",
        category: "maintenance",
        title: `Service due soon for ${vehicleNumber}`,
        detail: `${label} is due ${due} (${plural(days, "day")} remaining).`,
        recommendation: "Schedule the service before the due date to avoid downtime.",
        actionLabel: "Schedule service",
        actionHref: "/fleet-maintenance",
        entityType: "vehicle",
        entityId,
        dueAt: due ?? undefined,
        metric: days,
      });
    }
  };

  for (const row of maintenanceRows) {
    maintenanceDeadline(row.description, row.scheduled_date, row.vehicle_number, row.vehicle_id);
  }
  for (const row of scheduleRows) {
    maintenanceDeadline(
      `${row.interval_type.replace(/_/g, " ")} service`,
      row.next_due,
      row.vehicle_number,
      row.vehicle_id
    );
  }

  for (const vehicle of vehicles) {
    const expired: string[] = [];
    const expiring: string[] = [];
    const registrationDays = daysUntil(vehicle.registration_expiry, today);
    const insuranceDays = daysUntil(vehicle.insurance_expiry, today);
    if (registrationDays !== null) {
      if (registrationDays < 0) expired.push(`registration expired ${vehicle.registration_expiry}`);
      else if (registrationDays <= 30) expiring.push(`registration expires ${vehicle.registration_expiry}`);
    }
    if (insuranceDays !== null) {
      if (insuranceDays < 0) expired.push(`insurance expired ${vehicle.insurance_expiry}`);
      else if (insuranceDays <= 30) expiring.push(`insurance expires ${vehicle.insurance_expiry}`);
    }
    complianceExpired += expired.length;
    complianceExpiring += expiring.length;
    if (expired.length > 0) {
      add({
        id: `compliance:vehicle-expired:${vehicle.id}`,
        severity: "critical",
        category: "compliance",
        title: `Vehicle compliance expired: ${vehicle.vehicle_number}`,
        detail: `${vehicle.vehicle_number} has ${expired.join(" and ")}.`,
        recommendation: "Renew the documents before the vehicle is dispatched.",
        actionLabel: "Open vehicle",
        actionHref: `/vehicles/${vehicle.id}`,
        entityType: "vehicle",
        entityId: vehicle.id,
      });
    } else if (expiring.length > 0) {
      add({
        id: `compliance:vehicle-expiring:${vehicle.id}`,
        severity: "warning",
        category: "compliance",
        title: `Vehicle compliance expiring: ${vehicle.vehicle_number}`,
        detail: `${vehicle.vehicle_number} has ${expiring.join(" and ")} within 30 days.`,
        recommendation: "Start the renewal process now to avoid a last-minute grounding.",
        actionLabel: "Open vehicle",
        actionHref: `/vehicles/${vehicle.id}`,
        entityType: "vehicle",
        entityId: vehicle.id,
      });
    }
  }

  for (const driver of drivers) {
    const days = daysUntil(driver.licence_expiry, today);
    if (driver.authorisation_status === "suspended" || driver.authorisation_status === "revoked") {
      suspendedDrivers += 1;
      add({
        id: `compliance:driver-status:${driver.id}`,
        severity: "critical",
        category: "compliance",
        title: `Driver not authorised: ${driver.name}`,
        detail: `${driver.name} is ${driver.authorisation_status} and must not be dispatched.`,
        recommendation: "Reassign the driver and review the authorisation record.",
        actionLabel: "Open driver",
        actionHref: `/drivers/${driver.id}`,
        entityType: "driver",
        entityId: driver.id,
      });
    }
    if (days === null) continue;
    if (days < 0) {
      complianceExpired += 1;
      add({
        id: `compliance:driver-licence-expired:${driver.id}`,
        severity: "critical",
        category: "compliance",
        title: `Driver licence expired: ${driver.name}`,
        detail: `${driver.name}'s licence expired ${driver.licence_expiry}.`,
        recommendation: "Suspend dispatch until the licence is renewed.",
        actionLabel: "Open driver",
        actionHref: `/drivers/${driver.id}`,
        entityType: "driver",
        entityId: driver.id,
        dueAt: driver.licence_expiry ?? undefined,
      });
    } else if (days <= 30) {
      complianceExpiring += 1;
      add({
        id: `compliance:driver-licence-expiring:${driver.id}`,
        severity: "warning",
        category: "compliance",
        title: `Driver licence expiring: ${driver.name}`,
        detail: `${driver.name}'s licence expires ${driver.licence_expiry} (${plural(days, "day")} remaining).`,
        recommendation: "Book the renewal and keep a copy on file.",
        actionLabel: "Open driver",
        actionHref: `/drivers/${driver.id}`,
        entityType: "driver",
        entityId: driver.id,
        dueAt: driver.licence_expiry ?? undefined,
      });
    }
  }

  const riskyDrivers = activeDriverScores
    .filter((driver) => driver.score < 90)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);
  for (const driver of riskyDrivers) {
    const events = Object.entries(driver.counts)
      .map(([type, count]) => `${count} ${type.replace(/_/g, " ")}`)
      .join(", ");
    add({
      id: `safety:driver:${driver.driver.id}`,
      severity: driver.score < 60 ? "critical" : "warning",
      category: "safety",
      title: `${driver.score < 60 ? "High-risk" : "Coaching needed"}: ${driver.driver.name}`,
      detail: `Safety score ${driver.score}/100${events ? ` — ${events}` : ""}.`,
      recommendation: "Review the recent events with the driver and schedule coaching.",
      actionLabel: "Open driver",
      actionHref: `/drivers/${driver.driver.id}`,
      entityType: "driver",
      entityId: driver.driver.id,
      metric: driver.score,
    });
  }

  for (const stat of fuelStats) {
    const vehicle = vehicleById.get(stat.vehicle_id);
    if (!vehicle?.expected_km_per_l || vehicle.expected_km_per_l <= 0) continue;
    const average = Number(stat.avg_kml);
    const deviation = (average - vehicle.expected_km_per_l) / vehicle.expected_km_per_l;
    if (deviation > -0.2) continue;
    fuelOutliers += 1;
    add({
      id: `fuel:efficiency:${vehicle.id}`,
      severity: deviation <= -0.35 ? "warning" : "info",
      category: "fuel",
      title: `Fuel efficiency below target: ${vehicle.vehicle_number}`,
      detail: `${average.toFixed(1)} km/L vs ${vehicle.expected_km_per_l.toFixed(1)} expected (${Math.round(
        deviation * 100
      )}%) across ${plural(stat.samples, "refuel")}${stat.last_date ? `, latest ${stat.last_date}` : ""}.`,
      recommendation: "Check tyre pressure, load, idling and driver behaviour; inspect for leaks if it persists.",
      actionLabel: "Open vehicle",
      actionHref: `/vehicles/${vehicle.id}`,
      entityType: "vehicle",
      entityId: vehicle.id,
      metric: Number(deviation.toFixed(2)),
    });
  }

  if (flaggedFuelCards > 0) {
    add({
      id: "fuel:flagged-cards",
      severity: "warning",
      category: "fuel",
      title: `${plural(flaggedFuelCards, "flagged card transaction")} awaiting review`,
      detail: "Card swipes were flagged by distance, limit or assignment rules.",
      recommendation: "Reconcile the flagged swipes before the next fuel-card cycle.",
      actionLabel: "Review fuel cards",
      actionHref: "/fuel-cards",
      entityType: "fuel_card",
      metric: flaggedFuelCards,
    });
  }

  if (offlineVehicles > 0 && vehicles.length > 0) {
    const critical = onlineVehicles === 0;
    add({
      id: "telemetry:offline",
      severity: critical ? "critical" : offlineVehicles >= vehicles.length / 2 ? "warning" : "info",
      category: "telemetry",
      title: `${plural(offlineVehicles, "vehicle")} offline`,
      detail: `${offlineVehicles} of ${vehicles.length} vehicles have not reported within the ${offlineWindowMinutes()}-minute alert window.`,
      recommendation: "Check tracker power, SIM coverage and installation before dispatching.",
      actionLabel: "Open live map",
      actionHref: "/live-map",
      metric: offlineVehicles,
    });
  }

  if (exceptionCounts.critical > 0) {
    add({
      id: "exceptions:critical",
      severity: "critical",
      category: "exceptions",
      title: `${plural(exceptionCounts.critical, "critical exception")} open`,
      detail:
        recentCritical.length > 0
          ? `Latest: ${recentCritical
              .map((row) => `${row.vehicle_number ?? "Fleet"} — ${row.description}`)
              .join("; ")}`
          : "Critical exceptions require investigation.",
      recommendation: "Investigate and resolve critical exceptions before closing the shift.",
      actionLabel: "Open Exception Centre",
      actionHref: "/exceptions",
      entityType: "exception",
      metric: exceptionCounts.critical,
    });
  } else if (exceptionCounts.warning > 0) {
    add({
      id: "exceptions:warning",
      severity: "warning",
      category: "exceptions",
      title: `${plural(exceptionCounts.warning, "warning exception")} open`,
      detail: "Open warnings are reducing the fleet health score.",
      recommendation: "Review the queue and dismiss or resolve items with no further action.",
      actionLabel: "Open Exception Centre",
      actionHref: "/exceptions",
      entityType: "exception",
      metric: exceptionCounts.warning,
    });
  }

  if (openBreakdowns.count > 0) {
    add({
      id: "operations:breakdowns",
      severity: openBreakdowns.towing > 0 ? "critical" : "warning",
      category: "operations",
      title: `${plural(openBreakdowns.count, "open breakdown")}`,
      detail: `${openBreakdowns.count} vehicle${openBreakdowns.count === 1 ? "" : "s"} are unavailable${
        openBreakdowns.towing > 0 ? `; ${openBreakdowns.towing} need towing` : ""
      }.`,
      recommendation: "Confirm repair status and update availability for dispatch.",
      actionLabel: "Open maintenance",
      actionHref: "/fleet-maintenance",
      metric: openBreakdowns.count,
    });
  }

  if (failedInspections > 0) {
    add({
      id: "operations:inspections",
      severity: "warning",
      category: "operations",
      title: `${plural(failedInspections, "failed inspection")} in the last 30 days`,
      detail: "Vehicles inspected as failed or requiring attention may still be in service.",
      recommendation: "Verify the defects were repaired before the next trip.",
      actionLabel: "Open inspections",
      actionHref: "/fleet-inspections",
      metric: failedInspections,
    });
  }

  if (offlineCameras > 0) {
    add({
      id: "operations:cameras",
      severity: offlineCameras >= cameraRows.length / 2 ? "warning" : "info",
      category: "operations",
      title: `${plural(offlineCameras, "camera")} offline`,
      detail: `${offlineCameras} of ${cameraRows.length} active camera feeds have no recent heartbeat.`,
      recommendation: "Check the vehicle power and network before relying on the footage.",
      actionLabel: "Open cameras",
      actionHref: "/cameras",
      entityType: "camera",
      metric: offlineCameras,
    });
  }

  if (vehicles.length === 0) {
    add({
      id: "operations:empty-fleet",
      severity: "warning",
      category: "operations",
      title: "Fleet register is empty",
      detail: "No vehicles are registered, so telemetry, fuel and utilisation intelligence cannot run.",
      recommendation: "Add vehicles and bind their GPS trackers to activate the live map and alerts.",
      actionLabel: "Add vehicles",
      actionHref: "/vehicles",
    });
  }

  const severityRank: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };
  insights.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.title.localeCompare(b.title));

  const summary = {
    total: insights.length,
    critical: insights.filter((insight) => insight.severity === "critical").length,
    warning: insights.filter((insight) => insight.severity === "warning").length,
    info: insights.filter((insight) => insight.severity === "info").length,
  };

  const components: FleetHealthComponent[] = [
    {
      key: "telemetry",
      label: "Telemetry",
      weight: 20,
      score: vehicles.length === 0 ? 0 : clamp((onlineVehicles / vehicles.length) * 100),
      detail: vehicles.length === 0 ? "No vehicles registered" : `${onlineVehicles} of ${vehicles.length} reporting`,
    },
    {
      key: "exceptions",
      label: "Exceptions",
      weight: 20,
      score: clamp(100 - exceptionCounts.critical * 15 - exceptionCounts.warning * 5 - exceptionCounts.info),
      detail:
        exceptionCounts.critical + exceptionCounts.warning + exceptionCounts.info === 0
          ? "No open exceptions"
          : `${exceptionCounts.critical} critical, ${exceptionCounts.warning} warning open`,
    },
    {
      key: "maintenance",
      label: "Maintenance",
      weight: 20,
      score: clamp(100 - maintenanceOverdue * 15 - maintenanceDueSoon * 5),
      detail:
        maintenanceOverdue + maintenanceDueSoon === 0
          ? "No services due"
          : `${maintenanceOverdue} overdue, ${maintenanceDueSoon} due soon`,
    },
    {
      key: "compliance",
      label: "Compliance",
      weight: 15,
      score: clamp(100 - complianceExpired * 25 - complianceExpiring * 5 - suspendedDrivers * 20),
      detail:
        complianceExpired + complianceExpiring + suspendedDrivers === 0
          ? "All documents valid"
          : `${complianceExpired} expired, ${complianceExpiring} expiring, ${suspendedDrivers} suspended`,
    },
    {
      key: "safety",
      label: "Driver safety",
      weight: 15,
      score: clamp(averageSafetyScore),
      detail:
        activeDriverScores.length === 0
          ? "No recent driver events"
          : `Average score ${averageSafetyScore}/100 across ${plural(activeDriverScores.length, "active driver")}`,
    },
    {
      key: "assets",
      label: "Fuel & assets",
      weight: 10,
      score: clamp(
        100 -
          fuelOutliers * 8 -
          flaggedFuelCards * 5 -
          offlineCameras * 5 -
          openBreakdowns.count * 10 -
          failedInspections * 5
      ),
      detail: `${fuelOutliers} fuel outlier${fuelOutliers === 1 ? "" : "s"}, ${flaggedFuelCards} flagged swipe${
        flaggedFuelCards === 1 ? "" : "s"
      }`,
    },
  ];

  const weightedScore =
    vehicles.length === 0
      ? 0
      : Math.round(components.reduce((sum, component) => sum + component.score * component.weight, 0) / 100);
  const { grade, label } = healthGrade(weightedScore);

  return {
    generatedAt: now.toISOString(),
    health: {
      score: weightedScore,
      grade,
      label,
      components,
    },
    summary,
    coverage: {
      vehicles: vehicles.length,
      onlineVehicles,
      drivers: drivers.length,
      cameras: cameraRows.length,
      onlineCameras,
    },
    insights: insights.slice(0, limit),
  };
}
