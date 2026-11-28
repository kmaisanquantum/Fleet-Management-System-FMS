import { v4 as uuid } from "uuid";
import { db } from "../db";
import { ApiError } from "../middleware/errorHandler";
import { getBusinessRuleBoolean, getBusinessRuleNumber } from "../routes/settings";
import { persistFleetAlerts } from "./fleetAlerts";
import { nowSql } from "../utils/deviceStatus";

export interface FuelCardRow {
  id: string;
  card_number: string;
  provider: string | null;
  vehicle_id: string | null;
  authorised_driver_id: string | null;
  assigned_vehicle_id: string | null;
  assigned_imei: string | null;
  assigned_driver_id: string | null;
  status: "active" | "suspended" | "blocked" | "cancelled" | "lost";
  daily_limit_liters: number | null;
  monthly_limit_amount: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface FuelCardTransactionInput {
  cardId?: string;
  cardNumber?: string;
  vehicleId?: string;
  imei?: string;
  transactionAt?: string;
  stationName?: string;
  stationLat?: number;
  stationLon?: number;
  liters: number;
  amount?: number;
  currency?: string;
  gpsLat?: number;
  gpsLon?: number;
}

interface VehicleRow {
  id: string;
  vehicle_number: string;
  registration_number: string;
  tank_capacity_litres: number | null;
  client_id: string | null;
}

interface GpsFix {
  lat: number;
  lon: number;
  recorded_at: string;
}

interface FlagReason {
  code: string;
  message: string;
  severity: "critical" | "warning" | "info";
}

export interface FuelCardTransactionResult {
  transaction: Record<string, unknown>;
  alertsCreated: number;
  duplicate: boolean;
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

const PGT_OFFSET = "+10:00";

export function normalizeTransactionTimestamp(value?: string): string {
  if (!value) return nowSql();
  const raw = value.trim();
  if (!raw) return nowSql();
  let iso = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    iso = `${raw}T00:00:00${PGT_OFFSET}`;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) {
    const normalized = raw.replace(" ", "T");
    iso = `${normalized.length === 16 ? `${normalized}:00` : normalized}${PGT_OFFSET}`;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, `Invalid transaction timestamp: ${value}`);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function loadCard(input: FuelCardTransactionInput): FuelCardRow | undefined {
  if (input.cardId) {
    return db.prepare("SELECT * FROM fuel_cards WHERE id = ?").get(input.cardId) as FuelCardRow | undefined;
  }
  if (input.cardNumber) {
    return db.prepare("SELECT * FROM fuel_cards WHERE card_number = ?").get(input.cardNumber) as FuelCardRow | undefined;
  }
  return undefined;
}

function loadVehicle(vehicleId?: string): VehicleRow | undefined {
  if (!vehicleId) return undefined;
  return db
    .prepare("SELECT id, vehicle_number, registration_number, tank_capacity_litres, client_id FROM vehicles WHERE id = ?")
    .get(vehicleId) as VehicleRow | undefined;
}

function loadVehicleByReference(value?: string): VehicleRow | undefined {
  if (!value) return undefined;
  return db
    .prepare(
      `SELECT id, vehicle_number, registration_number, tank_capacity_litres, client_id
       FROM vehicles WHERE id = ? OR vehicle_number = ? OR registration_number = ? LIMIT 1`
    )
    .get(value, value, value) as VehicleRow | undefined;
}

function nearestGps(vehicleId: string, transactionAt: string, windowMinutes: number): GpsFix | undefined {
  const query = (table: "telemetry_records" | "gps_positions") => {
    const recordedColumn = table === "telemetry_records" ? "recorded_at" : "recorded_at";
    return db
      .prepare(
        `SELECT lat, lon, ${recordedColumn} AS recorded_at,
                ABS(strftime('%s', ${recordedColumn}) - strftime('%s', ?)) AS diff_seconds
         FROM ${table}
         WHERE vehicle_id = ? AND lat IS NOT NULL AND lon IS NOT NULL
           AND datetime(${recordedColumn}) BETWEEN datetime(?, ?) AND datetime(?, ?)
         ORDER BY diff_seconds ASC
         LIMIT 1`
      )
      .get(transactionAt, vehicleId, transactionAt, `-${windowMinutes} minutes`, transactionAt, `+${windowMinutes} minutes`) as
      | GpsFix
      | undefined;
  };

  return query("telemetry_records") ?? query("gps_positions");
}

function dailyLitres(card: FuelCardRow, transactionAt: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(liters), 0) AS total
       FROM fuel_card_transactions
       WHERE fuel_card_id = ? AND date(transaction_at, '+10 hours') = date(?, '+10 hours')`
    )
    .get(card.id, transactionAt) as { total: number };
  return Number(row.total ?? 0);
}

function monthlyAmount(card: FuelCardRow, transactionAt: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM fuel_card_transactions
       WHERE fuel_card_id = ? AND strftime('%Y-%m', transaction_at, '+10 hours') = strftime('%Y-%m', ?, '+10 hours')`
    )
    .get(card.id, transactionAt) as { total: number };
  return Number(row.total ?? 0);
}

function findDuplicate(cardNumber: string, transactionAt: string, liters: number, amount: number | null): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id FROM fuel_card_transactions
       WHERE card_number = ? AND transaction_at = ? AND ABS(liters - ?) < 0.001
         AND COALESCE(amount, 0) = COALESCE(?, 0)
       LIMIT 1`
    )
    .get(cardNumber, transactionAt, liters, amount) as { id: string } | undefined;
}

/**
 * Records a card transaction and reconciles it against the card assignment,
 * limits and the vehicle's nearest GPS fix. Anomalies create deduplicated
 * fleet_alerts rows, which the existing SMTP pipeline emails to fleet@dspng.tech.
 */
export function createFuelCardTransaction(input: FuelCardTransactionInput): FuelCardTransactionResult {
  const liters = Number(input.liters);
  if (!Number.isFinite(liters) || liters <= 0) throw new ApiError(400, "litres must be greater than zero");

  const card = loadCard(input);
  const cardNumber = card?.card_number ?? input.cardNumber?.trim();
  if (!cardNumber) throw new ApiError(400, "card number or fuel card id is required");

  const transactionAt = normalizeTransactionTimestamp(input.transactionAt);
  const amount = input.amount == null ? null : Number(input.amount);
  if (amount != null && (!Number.isFinite(amount) || amount < 0)) throw new ApiError(400, "amount must be a positive number");

  const duplicate = findDuplicate(cardNumber, transactionAt, liters, amount);
  if (duplicate) {
    return {
      transaction: db.prepare("SELECT * FROM fuel_card_transactions WHERE id = ?").get(duplicate.id) as Record<string, unknown>,
      alertsCreated: 0,
      duplicate: true,
    };
  }

  const assignedVehicleId = card?.assigned_vehicle_id ?? card?.vehicle_id ?? undefined;
  const vehicle = loadVehicle(input.vehicleId ?? assignedVehicleId);
  const assignedImei =
    card?.assigned_imei ??
    (vehicle
      ? (db.prepare("SELECT device_identifier FROM gps_devices WHERE vehicle_id = ? LIMIT 1").get(vehicle.id) as
          | { device_identifier: string }
          | undefined)?.device_identifier
      : undefined);
  const imei = input.imei?.trim() || assignedImei || null;
  const windowMinutes = Math.max(1, getBusinessRuleNumber("fuel_card_reconcile_window_minutes", undefined, 20));
  const distanceThreshold = Math.max(0, getBusinessRuleNumber("fuel_card_distance_threshold_km", undefined, 2));

  const reasons: FlagReason[] = [];
  if (!card) {
    reasons.push({ code: "unknown_card", message: `Card ${cardNumber} is not registered in the fuel card register.`, severity: "warning" });
  }
  if (card && ["lost", "suspended", "blocked", "cancelled"].includes(card.status)) {
    reasons.push({
      code: `card_${card.status}`,
      message: `Card ${card.card_number} is ${card.status}.`,
      severity: card.status === "lost" ? "critical" : "warning",
    });
  }
  if (!vehicle) {
    reasons.push({ code: "unassigned_vehicle", message: "No vehicle is assigned to this card/transaction.", severity: "warning" });
  } else if (input.vehicleId && assignedVehicleId && input.vehicleId !== assignedVehicleId) {
    reasons.push({
      code: "vehicle_mismatch",
      message: `Transaction vehicle ${vehicle.vehicle_number} does not match the card assignment.`,
      severity: "critical",
    });
  }
  if (input.imei && assignedImei && input.imei !== assignedImei) {
    reasons.push({
      code: "imei_mismatch",
      message: `Transaction IMEI ${input.imei} does not match the assigned tracker ${assignedImei}.`,
      severity: "warning",
    });
  }
  if (vehicle?.tank_capacity_litres && liters > Number(vehicle.tank_capacity_litres)) {
    reasons.push({
      code: "tank_capacity_exceeded",
      message: `${liters.toFixed(2)} L exceeds the vehicle tank capacity of ${Number(vehicle.tank_capacity_litres).toFixed(2)} L.`,
      severity: "critical",
    });
  }
  if (card?.daily_limit_liters && card.daily_limit_liters > 0) {
    const total = dailyLitres(card, transactionAt) + liters;
    if (total > Number(card.daily_limit_liters)) {
      reasons.push({
        code: "daily_limit_exceeded",
        message: `Daily total ${total.toFixed(2)} L exceeds the card limit of ${Number(card.daily_limit_liters).toFixed(2)} L.`,
        severity: "warning",
      });
    }
  }
  if (card?.monthly_limit_amount && card.monthly_limit_amount > 0 && amount != null) {
    const total = monthlyAmount(card, transactionAt) + amount;
    if (total > Number(card.monthly_limit_amount)) {
      reasons.push({
        code: "monthly_limit_exceeded",
        message: `Monthly total PGK ${total.toFixed(2)} exceeds the card limit of PGK ${Number(card.monthly_limit_amount).toFixed(2)}.`,
        severity: "warning",
      });
    }
  }

  let gpsLat = input.gpsLat ?? null;
  let gpsLon = input.gpsLon ?? null;
  if ((gpsLat == null || gpsLon == null) && vehicle) {
    const fix = nearestGps(vehicle.id, transactionAt, windowMinutes);
    if (fix) {
      gpsLat = Number(fix.lat);
      gpsLon = Number(fix.lon);
    }
  }

  let distanceKm: number | null = null;
  if (gpsLat == null || gpsLon == null) {
    reasons.push({
      code: "gps_missing",
      message: "No vehicle GPS fix was available near the transaction time.",
      severity: "warning",
    });
  } else if (input.stationLat != null && input.stationLon != null) {
    distanceKm = Number(haversineKm(Number(gpsLat), Number(gpsLon), Number(input.stationLat), Number(input.stationLon)).toFixed(3));
    if (distanceKm > distanceThreshold) {
      reasons.push({
        code: "gps_distance_exceeded",
        message: `Vehicle GPS is ${distanceKm.toFixed(2)} km from the station (threshold ${distanceThreshold.toFixed(2)} km).`,
        severity: "warning",
      });
    }
  }

  const status = reasons.length > 0 ? "flagged" : "matched";
  const id = uuid();
  db.prepare(
    `INSERT INTO fuel_card_transactions (
       id, fuel_card_id, card_number, vehicle_id, imei, transaction_at, station_name,
       station_lat, station_lon, liters, amount, currency, gps_lat, gps_lon, distance_km,
       status, flag_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    card?.id ?? null,
    cardNumber,
    vehicle?.id ?? input.vehicleId ?? null,
    imei,
    transactionAt,
    input.stationName ?? null,
    input.stationLat ?? null,
    input.stationLon ?? null,
    liters,
    amount,
    input.currency?.trim() || "PGK",
    gpsLat,
    gpsLon,
    distanceKm,
    status,
    reasons.length > 0 ? reasons.map((reason) => reason.message).join(" ") : null
  );

  let alertsCreated = 0;
  if (reasons.length > 0 && getBusinessRuleBoolean("alert_fuel_card_enabled", undefined, true)) {
    const vehicleLabel = vehicle ? `${vehicle.vehicle_number} (${vehicle.registration_number})` : "Unassigned vehicle";
    const stationLabel = input.stationName ? ` at ${input.stationName}` : "";
    for (const reason of reasons) {
      const inserted = persistFleetAlerts(
        [
          {
            alertType: "fuel_card_anomaly",
            ruleCode: `RULE_FUEL_CARD_${reason.code.toUpperCase()}`,
            severity: reason.severity,
            message: `Fuel card ${cardNumber} on ${vehicleLabel}${stationLabel}: ${reason.message}`,
            dedupeKey: `fuelcard:${cardNumber}:${transactionAt}:${reason.code}`,
          },
        ],
        {
          imei: imei ?? `fuelcard:${cardNumber}`,
          vehicleId: vehicle?.id ?? null,
          lat: gpsLat,
          lon: gpsLon,
          speed: null,
          voltage: null,
          createdAt: nowSql(),
        }
      );
      alertsCreated += inserted.length;
    }
  }

  return {
    transaction: db.prepare("SELECT * FROM fuel_card_transactions WHERE id = ?").get(id) as Record<string, unknown>,
    alertsCreated,
    duplicate: false,
  };
}

/* ------------------------------------------------------------------ *
 * CSV import
 * ------------------------------------------------------------------ */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function headerKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function pick(row: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value != null && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function numberValue(row: Record<string, string>, keys: string[]): number | undefined {
  const raw = pick(row, keys);
  if (raw == null) return undefined;
  const num = Number(raw.replace(/,/g, ""));
  return Number.isFinite(num) ? num : undefined;
}

export interface FuelCardCsvImportResult {
  imported: number;
  duplicates: number;
  flagged: number;
  errors: { row: number; error: string }[];
  transactions: Record<string, unknown>[];
}

export function importFuelCardTransactionsCsv(csv: string): FuelCardCsvImportResult {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new ApiError(400, "CSV must contain a header row and at least one transaction");
  if (rows.length > 5001) throw new ApiError(400, "CSV is limited to 5,000 transaction rows");

  const headers = rows[0].map(headerKey);
  const result: FuelCardCsvImportResult = { imported: 0, duplicates: 0, flagged: 0, errors: [], transactions: [] };

  for (let index = 1; index < rows.length; index++) {
    const values = rows[index];
    const row: Record<string, string> = {};
    headers.forEach((header, column) => {
      row[header] = values[column] ?? "";
    });

    try {
      const cardId = pick(row, ["fuel_card_id", "card_id"]);
      const cardNumber = pick(row, ["card_number", "card_no", "card"]);
      if (!cardId && !cardNumber) throw new ApiError(400, "missing card_number");
      const vehicleRef = pick(row, ["vehicle_id", "vehicle_number", "registration_number", "vehicle", "registration"]);
      const vehicle = loadVehicleByReference(vehicleRef);
      const date = pick(row, ["transaction_at", "transaction_date", "date_time", "datetime", "date"]);
      const time = pick(row, ["transaction_time", "time"]);
      const transactionAt = date && time && !date.includes("T") && !date.includes(":") ? `${date} ${time}` : date;
      const liters = numberValue(row, ["liters", "litres", "quantity", "volume"]);
      if (liters == null) throw new ApiError(400, "missing liters");

      const created = createFuelCardTransaction({
        cardId,
        cardNumber,
        vehicleId: vehicle?.id,
        imei: pick(row, ["imei", "device_imei"]),
        transactionAt,
        stationName: pick(row, ["station_name", "station", "site"]),
        stationLat: numberValue(row, ["station_lat", "station_latitude", "lat", "latitude"]),
        stationLon: numberValue(row, ["station_lon", "station_longitude", "lon", "lng", "longitude"]),
        liters,
        amount: numberValue(row, ["amount", "total_amount", "total", "cost"]),
        currency: pick(row, ["currency"]),
        gpsLat: numberValue(row, ["gps_lat", "vehicle_lat", "telemetry_lat"]),
        gpsLon: numberValue(row, ["gps_lon", "gps_lng", "vehicle_lon", "telemetry_lon"]),
      });

      if (created.duplicate) {
        result.duplicates += 1;
      } else {
        result.imported += 1;
        if (created.transaction.status === "flagged") result.flagged += 1;
        result.transactions.push(created.transaction);
      }
    } catch (error) {
      if (result.errors.length < 50) {
        result.errors.push({ row: index + 1, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return result;
}
