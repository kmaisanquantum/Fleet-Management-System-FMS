import express, { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { resolveClientScopes } from "../utils/scope";
import { writeAudit } from "../utils/audit";
import { ApiError } from "../middleware/errorHandler";
import { createFuelCardTransaction, importFuelCardTransactionsCsv } from "../services/fuelCards";

const router = Router();
router.use(requireAuth);

const CARD_WRITE_ROLES = ["admin", "fleet_admin", "fleet_manager", "finance_officer", "fuel_operator", "national_fuel_manager"];
const CARD_STATUSES = ["active", "suspended", "blocked", "cancelled", "lost"] as const;

const CARD_SELECT = `
  SELECT fc.*,
         COALESCE(fc.assigned_vehicle_id, fc.vehicle_id) AS resolved_vehicle_id,
         v.vehicle_number, v.registration_number, v.department, v.client_id AS vehicle_client_id,
         d.name AS driver_name,
         (SELECT COUNT(*) FROM fuel_card_transactions t WHERE t.fuel_card_id = fc.id) AS transaction_count,
         (SELECT COUNT(*) FROM fuel_card_transactions t WHERE t.fuel_card_id = fc.id AND t.status = 'flagged') AS flagged_count
  FROM fuel_cards fc
  LEFT JOIN vehicles v ON v.id = COALESCE(fc.assigned_vehicle_id, fc.vehicle_id)
  LEFT JOIN drivers d ON d.id = COALESCE(fc.assigned_driver_id, fc.authorised_driver_id)
`;

function scopeClause(req: express.Request, alias = "v"): { sql: string; params: unknown[] } {
  const scopes = resolveClientScopes(req.user);
  if (!scopes || scopes.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND ${alias}.client_id IN (${scopes.map(() => "?").join(", ")})`,
    params: scopes,
  };
}

function cardRow(id: string) {
  return db.prepare(`${CARD_SELECT} WHERE fc.id = ?`).get(id);
}

/** GET /api/v1/fuel-cards/options — vehicles, drivers and depots for the forms. */
router.get("/options", (req, res, next) => {
  try {
    const scope = scopeClause(req);
    const vehicles = db
      .prepare(
        `SELECT v.id, v.vehicle_number, v.registration_number, v.department, v.client_id,
                (SELECT g.device_identifier FROM gps_devices g
                 WHERE g.vehicle_id = v.id
                 ORDER BY CASE WHEN g.status = 'active' THEN 0 ELSE 1 END, g.last_seen_at DESC
                 LIMIT 1) AS imei
         FROM vehicles v
         WHERE v.status != 'disposed'${scope.sql}
         ORDER BY v.vehicle_number ASC`
      )
      .all(...scope.params);
    const drivers = db.prepare("SELECT id, name, employee_number, department FROM drivers ORDER BY name ASC").all();
    const depots = [...new Set((vehicles as { department: string | null }[]).map((v) => v.department).filter(Boolean))].sort();
    res.json({ data: { vehicles, drivers, depots } });
  } catch (e) {
    next(e);
  }
});

/** GET /api/v1/fuel-cards/summary — reconciliation summary for dashboards. */
router.get("/summary", (req, res, next) => {
  try {
    const scope = scopeClause(req);
    const cardScope = scopeClause(req);
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    const cardRows = db
      .prepare(
        `SELECT fc.status, COUNT(*) AS count
         FROM fuel_cards fc
         LEFT JOIN vehicles v ON v.id = COALESCE(fc.assigned_vehicle_id, fc.vehicle_id)
         WHERE 1=1${cardScope.sql}
         GROUP BY fc.status`
      )
      .all(...cardScope.params) as { status: string; count: number }[];

    const txnWhere: string[] = ["1=1"];
    const txnParams: unknown[] = [];
    if (from) {
      txnWhere.push("datetime(t.transaction_at) >= datetime(?)");
      txnParams.push(from);
    }
    if (to) {
      txnWhere.push("datetime(t.transaction_at) <= datetime(?)");
      txnParams.push(to);
    }
    txnParams.push(...scope.params);
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS transactions,
                SUM(CASE WHEN t.status = 'flagged' THEN 1 ELSE 0 END) AS flagged,
                SUM(CASE WHEN t.status = 'matched' THEN 1 ELSE 0 END) AS matched,
                COALESCE(SUM(t.liters), 0) AS liters,
                COALESCE(SUM(t.amount), 0) AS amount
         FROM fuel_card_transactions t
         LEFT JOIN vehicles v ON v.id = t.vehicle_id
         WHERE ${txnWhere.join(" AND ")}${scope.sql}`
      )
      .get(...txnParams) as {
      transactions: number;
      flagged: number;
      matched: number;
      liters: number;
      amount: number;
    };

    const recentFlagged = db
      .prepare(
        `SELECT t.*, v.vehicle_number, v.registration_number
         FROM fuel_card_transactions t
         LEFT JOIN vehicles v ON v.id = t.vehicle_id
         WHERE t.status = 'flagged'${scope.sql}
         ORDER BY t.transaction_at DESC
         LIMIT 10`
      )
      .all(...scope.params);

    const statusMap = Object.fromEntries(cardRows.map((row) => [row.status, Number(row.count)]));
    res.json({
      data: {
        cards: {
          total: cardRows.reduce((sum, row) => sum + Number(row.count), 0),
          active: statusMap.active ?? 0,
          suspended: (statusMap.suspended ?? 0) + (statusMap.blocked ?? 0) + (statusMap.cancelled ?? 0),
          lost: statusMap.lost ?? 0,
          by_status: statusMap,
        },
        transactions: {
          total: Number(totals.transactions ?? 0),
          flagged: Number(totals.flagged ?? 0),
          matched: Number(totals.matched ?? 0),
          liters: Number(totals.liters ?? 0),
          amount: Number(totals.amount ?? 0),
        },
        recent_flagged: recentFlagged,
      },
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/v1/fuel-cards/transactions — reconciled card swipe log. */
router.get("/transactions", (req, res, next) => {
  try {
    const scope = scopeClause(req);
    const clauses = ["1=1"];
    const params: unknown[] = [];
    for (const [key, column] of [
      ["cardId", "t.fuel_card_id"],
      ["vehicleId", "t.vehicle_id"],
      ["status", "t.status"],
    ] as const) {
      if (typeof req.query[key] === "string" && req.query[key]) {
        clauses.push(`${column} = ?`);
        params.push(req.query[key]);
      }
    }
    if (typeof req.query.from === "string" && req.query.from) {
      clauses.push("datetime(t.transaction_at) >= datetime(?)");
      params.push(req.query.from);
    }
    if (typeof req.query.to === "string" && req.query.to) {
      clauses.push("datetime(t.transaction_at) <= datetime(?)");
      params.push(req.query.to);
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    params.push(...scope.params, limit);
    const rows = db
      .prepare(
        `SELECT t.*, fc.provider, v.vehicle_number, v.registration_number
         FROM fuel_card_transactions t
         LEFT JOIN fuel_cards fc ON fc.id = t.fuel_card_id
         LEFT JOIN vehicles v ON v.id = t.vehicle_id
         WHERE ${clauses.join(" AND ")}${scope.sql}
         ORDER BY t.transaction_at DESC
         LIMIT ?`
      )
      .all(...params);
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

/** GET /api/v1/fuel-cards — card register with usage counters. */
router.get("/", (req, res, next) => {
  try {
    const scope = scopeClause(req);
    const clauses = ["1=1"];
    const params: unknown[] = [];
    if (typeof req.query.status === "string" && req.query.status) {
      clauses.push("fc.status = ?");
      params.push(req.query.status);
    }
    if (typeof req.query.vehicleId === "string" && req.query.vehicleId) {
      clauses.push("COALESCE(fc.assigned_vehicle_id, fc.vehicle_id) = ?");
      params.push(req.query.vehicleId);
    }
    if (typeof req.query.search === "string" && req.query.search.trim()) {
      clauses.push("(fc.card_number LIKE ? OR fc.provider LIKE ? OR fc.notes LIKE ?)");
      const term = `%${req.query.search.trim()}%`;
      params.push(term, term, term);
    }
    params.push(...scope.params);
    const rows = db
      .prepare(`${CARD_SELECT} WHERE ${clauses.join(" AND ")}${scope.sql} ORDER BY fc.card_number ASC`)
      .all(...params);
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

const cardSchema = z.object({
  cardNumber: z.string().trim().min(1),
  provider: z.string().trim().optional(),
  vehicleId: z.string().uuid().optional().nullable(),
  imei: z.string().trim().optional().nullable(),
  driverId: z.string().uuid().optional().nullable(),
  status: z.enum(CARD_STATUSES).optional(),
  dailyLimitLiters: z.number().positive().optional().nullable(),
  monthlyLimitAmount: z.number().nonnegative().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
});

function syncCardAssignment(cardId: string, vehicleId: string | null, driverId: string | null, imei: string | null) {
  db.prepare("UPDATE vehicles SET fuel_card_id = NULL WHERE fuel_card_id = ?").run(cardId);
  if (vehicleId) {
    db.prepare("UPDATE vehicles SET fuel_card_id = ? WHERE id = ?").run(cardId, vehicleId);
  }
  db.prepare(
    `UPDATE fuel_cards
     SET vehicle_id = ?, assigned_vehicle_id = ?, authorised_driver_id = ?, assigned_driver_id = ?, assigned_imei = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(vehicleId, vehicleId, driverId, driverId, imei, cardId);
}

function resolveImei(vehicleId: string | null, requested?: string | null): string | null {
  if (requested?.trim()) return requested.trim();
  if (!vehicleId) return null;
  const device = db.prepare("SELECT device_identifier FROM gps_devices WHERE vehicle_id = ? LIMIT 1").get(vehicleId) as
    | { device_identifier: string }
    | undefined;
  return device?.device_identifier ?? null;
}

/** POST /api/v1/fuel-cards — register a card. */
router.post("/", requireRole(...CARD_WRITE_ROLES), (req, res, next) => {
  try {
    const input = cardSchema.parse(req.body);
    const duplicate = db.prepare("SELECT id FROM fuel_cards WHERE card_number = ?").get(input.cardNumber);
    if (duplicate) return res.status(409).json({ error: `Fuel card ${input.cardNumber} already exists` });
    if (input.vehicleId) {
      const vehicle = db.prepare("SELECT id FROM vehicles WHERE id = ?").get(input.vehicleId);
      if (!vehicle) return res.status(400).json({ error: "Assigned vehicle not found" });
    }
    if (input.driverId) {
      const driver = db.prepare("SELECT id FROM drivers WHERE id = ?").get(input.driverId);
      if (!driver) return res.status(400).json({ error: "Assigned driver not found" });
    }

    const id = uuid();
    const imei = resolveImei(input.vehicleId ?? null, input.imei);
    db.prepare(
      `INSERT INTO fuel_cards (
         id, card_number, provider, vehicle_id, authorised_driver_id, assigned_vehicle_id,
         assigned_imei, assigned_driver_id, status, daily_limit_liters, monthly_limit_amount, notes, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      id,
      input.cardNumber,
      input.provider ?? null,
      input.vehicleId ?? null,
      input.driverId ?? null,
      input.vehicleId ?? null,
      imei,
      input.driverId ?? null,
      input.status ?? "active",
      input.dailyLimitLiters ?? null,
      input.monthlyLimitAmount ?? null,
      input.notes ?? null
    );
    syncCardAssignment(id, input.vehicleId ?? null, input.driverId ?? null, imei);
    writeAudit({
      userId: req.user!.id,
      action: "FUEL_CARD_CREATED",
      entity: "fuel_cards",
      entityId: id,
      newValue: { ...input, imei },
    });
    res.status(201).json({ data: cardRow(id) });
  } catch (e) {
    next(e);
  }
});

const cardUpdateSchema = cardSchema.partial();

/** PUT /api/v1/fuel-cards/:id — edit or block a card. */
router.put("/:id", requireRole(...CARD_WRITE_ROLES), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM fuel_cards WHERE id = ?").get(req.params.id) as
      | (Record<string, any> & { id: string; vehicle_id: string | null; assigned_vehicle_id: string | null })
      | undefined;
    if (!existing) return res.status(404).json({ error: "Fuel card not found" });
    const input = cardUpdateSchema.parse(req.body);
    const vehicleId = input.vehicleId === undefined ? existing.assigned_vehicle_id ?? existing.vehicle_id : input.vehicleId;
    const driverId = input.driverId === undefined ? existing.assigned_driver_id ?? existing.authorised_driver_id : input.driverId;
    const imei = resolveImei(vehicleId, input.imei === undefined ? existing.assigned_imei : input.imei);
    const cardNumber = input.cardNumber ?? existing.card_number;

    if (input.vehicleId) {
      const vehicle = db.prepare("SELECT id FROM vehicles WHERE id = ?").get(input.vehicleId);
      if (!vehicle) return res.status(400).json({ error: "Assigned vehicle not found" });
    }
    if (input.driverId) {
      const driver = db.prepare("SELECT id FROM drivers WHERE id = ?").get(input.driverId);
      if (!driver) return res.status(400).json({ error: "Assigned driver not found" });
    }
    const duplicate = db.prepare("SELECT id FROM fuel_cards WHERE card_number = ? AND id != ?").get(cardNumber, req.params.id);
    if (duplicate) return res.status(409).json({ error: `Fuel card ${cardNumber} already exists` });

    db.prepare(
      `UPDATE fuel_cards
       SET card_number = ?, provider = ?, status = ?, daily_limit_liters = ?, monthly_limit_amount = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      cardNumber,
      input.provider === undefined ? existing.provider : input.provider,
      input.status ?? existing.status,
      input.dailyLimitLiters === undefined ? existing.daily_limit_liters : input.dailyLimitLiters,
      input.monthlyLimitAmount === undefined ? existing.monthly_limit_amount : input.monthlyLimitAmount,
      input.notes === undefined ? existing.notes : input.notes,
      req.params.id
    );
    syncCardAssignment(req.params.id, vehicleId, driverId, imei);
    writeAudit({
      userId: req.user!.id,
      action: "FUEL_CARD_UPDATED",
      entity: "fuel_cards",
      entityId: req.params.id,
      previousValue: existing,
      newValue: input,
    });
    res.json({ data: cardRow(req.params.id) });
  } catch (e) {
    next(e);
  }
});

/** DELETE /api/v1/fuel-cards/:id — only cards with no transaction history. */
router.delete("/:id", requireRole("admin"), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT id FROM fuel_cards WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Fuel card not found" });
    const usage = db.prepare("SELECT COUNT(*) AS count FROM fuel_card_transactions WHERE fuel_card_id = ?").get(req.params.id) as {
      count: number;
    };
    if (usage.count > 0) {
      return res.status(409).json({ error: "Card has transaction history. Block it instead of deleting." });
    }
    db.prepare("UPDATE vehicles SET fuel_card_id = NULL WHERE fuel_card_id = ?").run(req.params.id);
    db.prepare("DELETE FROM fuel_cards WHERE id = ?").run(req.params.id);
    writeAudit({ userId: req.user!.id, action: "FUEL_CARD_DELETED", entity: "fuel_cards", entityId: req.params.id });
    res.json({ message: "Fuel card deleted" });
  } catch (e) {
    next(e);
  }
});

const swipeSchema = z.object({
  transactionAt: z.string().optional(),
  vehicleId: z.string().uuid().optional(),
  imei: z.string().optional(),
  stationName: z.string().optional(),
  stationLat: z.number().optional(),
  stationLon: z.number().optional(),
  liters: z.number().positive(),
  amount: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  gpsLat: z.number().optional(),
  gpsLon: z.number().optional(),
});

/** POST /api/v1/fuel-cards/:id/swipe — log a manual card swipe. */
router.post("/:id/swipe", requireRole(...CARD_WRITE_ROLES), (req, res, next) => {
  try {
    const card = db.prepare("SELECT id FROM fuel_cards WHERE id = ?").get(req.params.id);
    if (!card) return res.status(404).json({ error: "Fuel card not found" });
    const input = swipeSchema.parse(req.body);
    const result = createFuelCardTransaction({ ...input, cardId: req.params.id });
    writeAudit({
      userId: req.user!.id,
      action: "FUEL_CARD_SWIPE_LOGGED",
      entity: "fuel_card_transactions",
      entityId: String(result.transaction.id),
      newValue: { ...input, status: result.transaction.status, alertsCreated: result.alertsCreated },
    });
    res.status(201).json({ data: result.transaction, reconciliation: { status: result.transaction.status, alertsCreated: result.alertsCreated } });
  } catch (e) {
    next(e);
  }
});

/** POST /api/v1/fuel-cards/import — CSV upload (JSON {csv} or text/csv body). */
router.post(
  "/import",
  requireRole(...CARD_WRITE_ROLES),
  express.text({ type: ["text/csv", "text/plain"], limit: "2mb" }),
  (req, res, next) => {
    try {
      const csv = typeof req.body === "string" ? req.body : typeof req.body?.csv === "string" ? req.body.csv : null;
      if (!csv) throw new ApiError(400, "CSV content is required");
      const result = importFuelCardTransactionsCsv(csv);
      writeAudit({
        userId: req.user!.id,
        action: "FUEL_CARD_TRANSACTIONS_IMPORTED",
        entity: "fuel_card_transactions",
        newValue: { imported: result.imported, duplicates: result.duplicates, flagged: result.flagged, errors: result.errors.length },
      });
      res.status(201).json({ data: result });
    } catch (e) {
      next(e);
    }
  }
);

export default router;
