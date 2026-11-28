import { Router, type Request } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { resolveClientScopes } from "../utils/scope";
import { writeAudit } from "../utils/audit";
import { isCameraOnline, probeCameraFeed, type CameraFeedRow } from "../services/cameras";

const router = Router();
router.use(requireAuth);

const CAMERA_WRITE_ROLES = ["admin", "fleet_admin", "fleet_manager"];
const SCOPES = ["depot", "vehicle"] as const;
const MODES = ["snapshot", "mjpeg", "hls", "webrtc"] as const;

const CAMERA_SELECT = `
  SELECT cf.*, v.vehicle_number, v.registration_number, v.department,
         COALESCE(cf.client_id, v.client_id) AS resolved_client_id,
         c.name AS client_name
  FROM camera_feeds cf
  LEFT JOIN vehicles v ON v.id = cf.vehicle_id
  LEFT JOIN clients c ON c.id = COALESCE(cf.client_id, v.client_id)
`;

function scopeClause(req: Request): { sql: string; params: unknown[] } {
  const scopes = resolveClientScopes(req.user);
  if (!scopes || scopes.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND COALESCE(cf.client_id, v.client_id) IN (${scopes.map(() => "?").join(", ")})`,
    params: scopes,
  };
}

function decorate(row: CameraFeedRow & { last_seen_at: string | null }) {
  const online = isCameraOnline(row.last_seen_at);
  return {
    ...row,
    is_active: Boolean(row.is_active),
    online,
    status: online ? "online" : row.last_seen_at ? "offline" : "unknown",
  };
}

function loadFeed(id: string) {
  return db.prepare(`${CAMERA_SELECT} WHERE cf.id = ?`).get(id) as (CameraFeedRow & { last_seen_at: string | null }) | undefined;
}

/** GET /api/v1/cameras/options — vehicle and depot choices. */
router.get("/options", (req, res, next) => {
  try {
    const scopes = resolveClientScopes(req.user);
    const params: unknown[] = [];
    let where = "v.status != 'disposed'";
    if (scopes && scopes.length > 0) {
      where += ` AND v.client_id IN (${scopes.map(() => "?").join(", ")})`;
      params.push(...scopes);
    }
    const vehicles = db
      .prepare(
        `SELECT v.id, v.vehicle_number, v.registration_number, v.department, v.client_id,
                (SELECT g.device_identifier FROM gps_devices g
                 WHERE g.vehicle_id = v.id
                 ORDER BY CASE WHEN g.status = 'active' THEN 0 ELSE 1 END, g.last_seen_at DESC
                 LIMIT 1) AS imei
         FROM vehicles v
         WHERE ${where}
         ORDER BY v.vehicle_number ASC`
      )
      .all(...params) as { department: string | null }[];
    const depots = [...new Set(vehicles.map((v) => v.department).filter(Boolean))].sort();
    res.json({ data: { vehicles, depots } });
  } catch (e) {
    next(e);
  }
});

/** GET /api/v1/cameras/summary — feed health counts. */
router.get("/summary", (req, res, next) => {
  try {
    const scope = scopeClause(req);
    const rows = db
      .prepare(
        `SELECT cf.*, v.department, COALESCE(cf.client_id, v.client_id) AS resolved_client_id
         FROM camera_feeds cf
         LEFT JOIN vehicles v ON v.id = cf.vehicle_id
         WHERE 1=1${scope.sql}`
      )
      .all(...scope.params) as CameraFeedRow[];
    const activeRows = rows.filter((row) => Boolean(row.is_active));
    const online = activeRows.filter((row) => isCameraOnline(row.last_seen_at)).length;
    res.json({
      data: {
        total: rows.length,
        active: activeRows.length,
        inactive: rows.length - activeRows.length,
        online,
        offline: activeRows.length - online,
        with_errors: rows.filter((row) => row.last_error).length,
      },
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/v1/cameras — feed register with computed status. */
router.get("/", (req, res, next) => {
  try {
    const scope = scopeClause(req);
    const clauses = ["1=1"];
    const params: unknown[] = [];
    if (typeof req.query.scope === "string" && req.query.scope) {
      clauses.push("cf.scope = ?");
      params.push(req.query.scope);
    }
    if (typeof req.query.vehicleId === "string" && req.query.vehicleId) {
      clauses.push("cf.vehicle_id = ?");
      params.push(req.query.vehicleId);
    }
    if (typeof req.query.depot === "string" && req.query.depot) {
      clauses.push("(cf.depot = ? OR v.department = ?)");
      params.push(req.query.depot, req.query.depot);
    }
    if (typeof req.query.active === "string" && req.query.active) {
      clauses.push("cf.is_active = ?");
      params.push(req.query.active === "true" || req.query.active === "1" ? 1 : 0);
    }
    if (typeof req.query.search === "string" && req.query.search.trim()) {
      clauses.push("(cf.name LIKE ? OR cf.depot LIKE ? OR v.vehicle_number LIKE ?)");
      const term = `%${req.query.search.trim()}%`;
      params.push(term, term, term);
    }
    params.push(...scope.params);
    const rows = db
      .prepare(`${CAMERA_SELECT} WHERE ${clauses.join(" AND ")}${scope.sql} ORDER BY cf.name ASC`)
      .all(...params) as (CameraFeedRow & { last_seen_at: string | null })[];
    res.json({ data: rows.map(decorate) });
  } catch (e) {
    next(e);
  }
});

const cameraBaseSchema = z.object({
  name: z.string().trim().min(1),
  scope: z.enum(SCOPES),
  depot: z.string().trim().optional().nullable(),
  vehicleId: z.string().uuid().optional().nullable(),
  imei: z.string().trim().optional().nullable(),
  streamUrl: z.string().trim().optional().nullable(),
  snapshotUrl: z.string().trim().optional().nullable(),
  mode: z.enum(MODES),
  pollIntervalSec: z.number().int().min(15).max(86400).optional(),
  isActive: z.boolean().optional(),
});

const cameraSchema = cameraBaseSchema.extend({
  scope: z.enum(SCOPES).default("vehicle"),
  mode: z.enum(MODES).default("snapshot"),
});

function validateCameraInput(input: z.infer<typeof cameraSchema>, existing?: CameraFeedRow) {
  const streamUrl = input.streamUrl === undefined ? existing?.stream_url : input.streamUrl;
  const snapshotUrl = input.snapshotUrl === undefined ? existing?.snapshot_url : input.snapshotUrl;
  if (!streamUrl?.trim() && !snapshotUrl?.trim()) return "At least one stream or snapshot URL is required";
  if (input.scope === "vehicle" && !(input.vehicleId ?? existing?.vehicle_id)) return "Vehicle is required for vehicle-scoped feeds";
  return null;
}

function resolveClientId(vehicleId: string | null | undefined, requested?: string | null): string | null {
  if (requested) return requested;
  if (!vehicleId) return null;
  const vehicle = db.prepare("SELECT client_id FROM vehicles WHERE id = ?").get(vehicleId) as { client_id: string | null } | undefined;
  return vehicle?.client_id ?? null;
}

/** POST /api/v1/cameras — add a camera feed. */
router.post("/", requireRole(...CAMERA_WRITE_ROLES), (req, res, next) => {
  try {
    const input = cameraSchema.parse(req.body);
    const invalid = validateCameraInput(input);
    if (invalid) return res.status(400).json({ error: invalid });
    if (input.vehicleId) {
      const vehicle = db.prepare("SELECT id FROM vehicles WHERE id = ?").get(input.vehicleId);
      if (!vehicle) return res.status(400).json({ error: "Vehicle not found" });
    }
    const id = uuid();
    const vehicleId = input.vehicleId ?? null;
    const imei =
      input.imei?.trim() ||
      (vehicleId
        ? (db.prepare("SELECT device_identifier FROM gps_devices WHERE vehicle_id = ? LIMIT 1").get(vehicleId) as
            | { device_identifier: string }
            | undefined)?.device_identifier ?? null
        : null);
    db.prepare(
      `INSERT INTO camera_feeds (
         id, name, scope, depot, vehicle_id, imei, stream_url, snapshot_url, mode,
         poll_interval_sec, is_active, client_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      id,
      input.name,
      input.scope,
      input.depot ?? null,
      vehicleId,
      imei,
      input.streamUrl ?? null,
      input.snapshotUrl ?? null,
      input.mode,
      input.pollIntervalSec ?? 60,
      input.isActive === false ? 0 : 1,
      resolveClientId(vehicleId, null)
    );
    writeAudit({ userId: req.user!.id, action: "CAMERA_FEED_CREATED", entity: "camera_feeds", entityId: id, newValue: { ...input, imei } });
    const row = loadFeed(id);
    res.status(201).json({ data: row ? decorate(row) : row });
  } catch (e) {
    next(e);
  }
});

const cameraUpdateSchema = cameraBaseSchema.partial();

/** PUT /api/v1/cameras/:id — edit a feed. */
router.put("/:id", requireRole(...CAMERA_WRITE_ROLES), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM camera_feeds WHERE id = ?").get(req.params.id) as CameraFeedRow | undefined;
    if (!existing) return res.status(404).json({ error: "Camera feed not found" });
    const input = cameraUpdateSchema.parse(req.body);
    const merged = { ...existing, ...input } as z.infer<typeof cameraSchema>;
    const invalid = validateCameraInput(merged, existing);
    if (invalid) return res.status(400).json({ error: invalid });
    if (input.vehicleId) {
      const vehicle = db.prepare("SELECT id FROM vehicles WHERE id = ?").get(input.vehicleId);
      if (!vehicle) return res.status(400).json({ error: "Vehicle not found" });
    }
    const vehicleId = input.vehicleId === undefined ? existing.vehicle_id : input.vehicleId;
    const imei =
      input.imei === undefined
        ? existing.imei
        : input.imei?.trim() ||
          (vehicleId
            ? (db.prepare("SELECT device_identifier FROM gps_devices WHERE vehicle_id = ? LIMIT 1").get(vehicleId) as
                | { device_identifier: string }
                | undefined)?.device_identifier ?? null
            : null);
    db.prepare(
      `UPDATE camera_feeds
       SET name = ?, scope = ?, depot = ?, vehicle_id = ?, imei = ?, stream_url = ?, snapshot_url = ?,
           mode = ?, poll_interval_sec = ?, is_active = ?, client_id = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      input.name ?? existing.name,
      input.scope ?? existing.scope,
      input.depot === undefined ? existing.depot : input.depot,
      vehicleId,
      imei,
      input.streamUrl === undefined ? existing.stream_url : input.streamUrl,
      input.snapshotUrl === undefined ? existing.snapshot_url : input.snapshotUrl,
      input.mode ?? existing.mode,
      input.pollIntervalSec ?? existing.poll_interval_sec,
      input.isActive === undefined ? existing.is_active : input.isActive ? 1 : 0,
      resolveClientId(vehicleId, null),
      req.params.id
    );
    writeAudit({
      userId: req.user!.id,
      action: "CAMERA_FEED_UPDATED",
      entity: "camera_feeds",
      entityId: req.params.id,
      previousValue: existing,
      newValue: input,
    });
    const row = loadFeed(req.params.id);
    res.json({ data: row ? decorate(row) : row });
  } catch (e) {
    next(e);
  }
});

/** DELETE /api/v1/cameras/:id */
router.delete("/:id", requireRole(...CAMERA_WRITE_ROLES), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT id FROM camera_feeds WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Camera feed not found" });
    db.prepare("DELETE FROM camera_feeds WHERE id = ?").run(req.params.id);
    writeAudit({ userId: req.user!.id, action: "CAMERA_FEED_DELETED", entity: "camera_feeds", entityId: req.params.id });
    res.json({ message: "Camera feed deleted" });
  } catch (e) {
    next(e);
  }
});

/** POST /api/v1/cameras/:id/probe — connection check; failures are 200, never 401. */
router.post("/:id/probe", requireRole(...CAMERA_WRITE_ROLES), async (req, res, next) => {
  try {
    const existing = db.prepare("SELECT id FROM camera_feeds WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Camera feed not found" });
    const result = await probeCameraFeed(req.params.id);
    writeAudit({
      userId: req.user!.id,
      action: "CAMERA_FEED_PROBED",
      entity: "camera_feeds",
      entityId: req.params.id,
      newValue: result,
    });
    const row = loadFeed(req.params.id);
    res.json({ data: { ...result, feed: row ? decorate(row) : row } });
  } catch (e) {
    next(e);
  }
});

export default router;
