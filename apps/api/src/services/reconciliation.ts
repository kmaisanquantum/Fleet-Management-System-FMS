import { db } from "../db";
import { v4 as uuid } from "uuid";

export interface FuelTransactionInput {
  id?: string;
  vehicle_id: string;
  driver_id?: string;
  fuel_card_id?: string;
  station_id?: string;
  station?: string;
  date: string;
  time?: string;
  fuel_type: string;
  litres: number;
  cost_per_litre: number;
  total_cost: number;
  odometer_reading: number;
  payment_method?: string;
  receipt_ref?: string;
  source?: "card" | "depot" | "manual";
}

export interface ReconciliationConfig {
  maxStationDistanceKm: number; // default 1.0 km
  timeWindowMinutes: number;   // default 30 mins
  duplicateWindowMinutes: number; // default 15 mins
  afterHoursStartHour: number; // e.g. 22 (10 PM)
  afterHoursEndHour: number;   // e.g. 5 (5 AM)
  consumptionTolerancePct: number; // e.g. 0.35 (35%)
}

const DEFAULT_CONFIG: ReconciliationConfig = {
  maxStationDistanceKm: 2.0,
  timeWindowMinutes: 60,
  duplicateWindowMinutes: 15,
  afterHoursStartHour: 22,
  afterHoursEndHour: 5,
  consumptionTolerancePct: 0.35,
};

// Calculate Haversine distance in KM
export function calculateHaversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export interface RuleViolation {
  rule_code: string;
  severity: "critical" | "warning" | "info";
  category: "fuel" | "gps" | "driver" | "vehicle" | "maintenance" | "route" | "security" | "compliance";
  description: string;
  gps_position_id?: string;
}

export function reconcileTransaction(
  txn: FuelTransactionInput,
  config: ReconciliationConfig = DEFAULT_CONFIG
): { status: "verified" | "exception"; violations: RuleViolation[]; gps_verified: boolean } {
  const violations: RuleViolation[] = [];
  let gpsVerified = false;

  // 1. Check Vehicle Existence & Details
  const vehicle = db
    .prepare("SELECT * FROM vehicles WHERE id = ?")
    .get(txn.vehicle_id) as any;

  if (!vehicle) {
    violations.push({
      rule_code: "RULE_VEHICLE_NOT_FOUND",
      severity: "critical",
      category: "fuel",
      description: `Transaction reference vehicle ID ${txn.vehicle_id} which does not exist in register.`,
    });
    return { status: "exception", violations, gps_verified: false };
  }

  // 2. Check Tank Capacity
  const tankCapacity = vehicle.tank_capacity_litres || 80.0;
  if (txn.litres > tankCapacity) {
    violations.push({
      rule_code: "RULE_CAPACITY_EXCEEDED",
      severity: "critical",
      category: "fuel",
      description: `Refuel quantity (${txn.litres}L) exceeds vehicle tank capacity (${tankCapacity}L).`,
    });
  }

  // 3. Check Fuel Card Assignment
  if (txn.fuel_card_id) {
    const card = db
      .prepare("SELECT * FROM fuel_cards WHERE id = ?")
      .get(txn.fuel_card_id) as any;

    if (card) {
      if (card.vehicle_id && card.vehicle_id !== txn.vehicle_id) {
        violations.push({
          rule_code: "RULE_CARD_MISMATCH",
          severity: "critical",
          category: "security",
          description: `Fuel card ${card.card_number} is assigned to vehicle ID ${card.vehicle_id}, but used for vehicle ${vehicle.vehicle_number}.`,
        });
      }
      if (txn.driver_id && card.authorised_driver_id && card.authorised_driver_id !== txn.driver_id) {
        violations.push({
          rule_code: "RULE_DRIVER_CARD_MISMATCH",
          severity: "warning",
          category: "driver",
          description: `Fuel card ${card.card_number} is assigned to driver ID ${card.authorised_driver_id}, but presented by driver ID ${txn.driver_id}.`,
        });
      }
    }
  }

  // 4. Check Station Proximity / GPS Verification
  let nearestGpsPos: any = null;
  if (txn.station_id) {
    const station = db
      .prepare("SELECT * FROM fuel_stations WHERE id = ?")
      .get(txn.station_id) as any;

    if (station) {
      // Find latest GPS position around transaction timestamp
      const txnTimestamp = `${txn.date} ${txn.time || "12:00:00"}`;
      const gpsPos = db
        .prepare(`
          SELECT * FROM gps_positions
          WHERE vehicle_id = ?
          ORDER BY ABS(strftime('%s', recorded_at) - strftime('%s', ?)) ASC
          LIMIT 1
        `)
        .get(txn.vehicle_id, txnTimestamp) as any;

      if (gpsPos) {
        nearestGpsPos = gpsPos;
        const distKm = calculateHaversineDistanceKm(
          gpsPos.lat,
          gpsPos.lon,
          station.lat,
          station.lon
        );

        if (distKm <= config.maxStationDistanceKm) {
          gpsVerified = true;
        } else {
          violations.push({
            rule_code: "RULE_STATION_MISMATCH",
            severity: "critical",
            category: "gps",
            description: `Vehicle GPS position was ${distKm.toFixed(1)} km away from station ${station.name} at transaction time.`,
            gps_position_id: gpsPos.id,
          });
        }
      } else {
        violations.push({
          rule_code: "RULE_NO_GPS_DATA",
          severity: "warning",
          category: "gps",
          description: `No vehicle GPS position found near transaction timestamp ${txnTimestamp}.`,
        });
      }
    }
  }

  // 5. Check Duplicate Transaction
  const txnTimestamp = `${txn.date} ${txn.time || "12:00:00"}`;
  const dup = db
    .prepare(`
      SELECT * FROM vehicle_fuel_logs
      WHERE vehicle_id = ? AND id != ?
      AND ABS(strftime('%s', date || ' ' || COALESCE(time, '12:00:00')) - strftime('%s', ?)) < ? * 60
      LIMIT 1
    `)
    .get(txn.vehicle_id, txn.id || "", txnTimestamp, config.duplicateWindowMinutes) as any;

  if (dup) {
    violations.push({
      rule_code: "RULE_DUPLICATE_TXN",
      severity: "critical",
      category: "fuel",
      description: `Potential duplicate refuel transaction detected within ${config.duplicateWindowMinutes} minutes of transaction ${dup.id}.`,
    });
  }

  // 6. Check After-Hours Refuelling
  if (txn.time) {
    const hour = parseInt(txn.time.split(":")[0], 10);
    if (!isNaN(hour) && (hour >= config.afterHoursStartHour || hour < config.afterHoursEndHour)) {
      violations.push({
        rule_code: "RULE_AFTER_HOURS",
        severity: "warning",
        category: "compliance",
        description: `Refuel recorded at ${txn.time}, which falls inside after-hours window (${config.afterHoursStartHour}:00 - 0${config.afterHoursEndHour}:00).`,
      });
    }
  }

  // 7. Check Abnormal Consumption (km/L)
  const prevFuelLog = db
    .prepare(`
      SELECT * FROM vehicle_fuel_logs
      WHERE vehicle_id = ? AND odometer_reading < ?
      ORDER BY odometer_reading DESC LIMIT 1
    `)
    .get(txn.vehicle_id, txn.odometer_reading) as any;

  if (prevFuelLog && prevFuelLog.odometer_reading) {
    const distanceTravelled = txn.odometer_reading - prevFuelLog.odometer_reading;
    if (distanceTravelled > 0 && txn.litres > 0) {
      const actualKmL = distanceTravelled / txn.litres;
      const expectedKmL = vehicle.expected_km_per_l || 8.0;
      const diffPct = Math.abs(actualKmL - expectedKmL) / expectedKmL;

      if (diffPct > config.consumptionTolerancePct) {
        violations.push({
          rule_code: "RULE_ABNORMAL_CONSUMPTION",
          severity: "warning",
          category: "fuel",
          description: `Calculated fuel efficiency (${actualKmL.toFixed(1)} km/L) deviates by ${(diffPct * 100).toFixed(0)}% from expected rating (${expectedKmL.toFixed(1)} km/L).`,
        });
      }
    }
  }

  // 8. Check Excessive Refuelling Frequency (> 2 transactions in 24 hours)
  const count24h = db
    .prepare(`
      SELECT COUNT(*) as count FROM vehicle_fuel_logs
      WHERE vehicle_id = ? AND date >= date(?, '-1 day')
    `)
    .get(txn.vehicle_id, txn.date) as any;

  if (count24h && count24h.count >= 2) {
    violations.push({
      rule_code: "RULE_HIGH_FREQUENCY",
      severity: "info",
      category: "fuel",
      description: `Vehicle has refuelled ${count24h.count + 1} times within a 24-hour window.`,
    });
  }

  const status = violations.length > 0 ? "exception" : "verified";
  return { status, violations, gps_verified: gpsVerified };
}

export function createFleetExceptionsForTransaction(
  txnId: string,
  txn: FuelTransactionInput,
  violations: RuleViolation[]
) {
  for (const v of violations) {
    const excId = uuid();
    db.prepare(`
      INSERT INTO fleet_exceptions (
        id, severity, category, rule_code, vehicle_id, driver_id, transaction_id, gps_position_id, description, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'))
    `).run(
      excId,
      v.severity,
      v.category,
      v.rule_code,
      txn.vehicle_id,
      txn.driver_id || null,
      txnId,
      v.gps_position_id || null,
      v.description
    );

    // Also write to audit_logs
    db.prepare(`
      INSERT INTO audit_logs (id, action, entity, entity_id, new_value, reason, created_at)
      VALUES (?, 'EXCEPTION_CREATED', 'fleet_exceptions', ?, ?, ?, datetime('now'))
    `).run(
      uuid(),
      excId,
      JSON.stringify({ rule_code: v.rule_code, vehicle_id: txn.vehicle_id, transaction_id: txnId }),
      `Fleet Exception triggered: ${v.rule_code}`
    );
  }
}
