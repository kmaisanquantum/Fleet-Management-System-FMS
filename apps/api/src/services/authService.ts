import bcrypt from "bcryptjs";
import { db } from "../db";
import { ApiError } from "../middleware/errorHandler";
import { signAccessToken, signRefreshToken, verifyRefreshToken, AuthUser } from "../middleware/auth";
import { writeAudit } from "../utils/audit";

/** Client ids a user is mapped to via the user_clients join table. */
function clientIdsFor(userId: string): string[] {
  const rows = db
    .prepare("SELECT client_id FROM user_clients WHERE user_id = ?")
    .all(userId) as { client_id: string }[];
  return rows.map((r) => r.client_id);
}

export function login(email: string, password: string, ip?: string) {
  const row = db
    .prepare(`
      SELECT u.id, u.email, u.password_hash, u.full_name, u.airport_id, u.status, r.name as role_name
      FROM users u JOIN roles r ON u.role_id = r.id
      WHERE u.email = ?
    `)
    .get(email) as any;

  if (!row || row.status !== "active") throw new ApiError(401, "Invalid credentials");

  const valid = bcrypt.compareSync(password, row.password_hash);
  if (!valid) {
    writeAudit({ action: "LOGIN_FAILED", entity: "users", entityId: row.id, ipAddress: ip });
    throw new ApiError(401, "Invalid credentials");
  }

  const clientIds = clientIdsFor(row.id);
  const user: AuthUser = { id: row.id, email: row.email, roleName: row.role_name, airportId: row.airport_id, clientIds };
  writeAudit({ userId: row.id, role: row.role_name, action: "LOGIN_SUCCESS", entity: "users", entityId: row.id, ipAddress: ip });

  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
    user: { id: row.id, email: row.email, fullName: row.full_name, role: row.role_name, airportId: row.airport_id, clientIds },
  };
}

export function refresh(refreshToken: string) {
  let payload: { id: string };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new ApiError(401, "Invalid refresh token");
  }
  const row = db
    .prepare(`
      SELECT u.id, u.email, u.airport_id, r.name as role_name
      FROM users u JOIN roles r ON u.role_id = r.id
      WHERE u.id = ? AND u.status = 'active'
    `)
    .get(payload.id) as any;
  if (!row) throw new ApiError(401, "User not found or inactive");

  const user: AuthUser = { id: row.id, email: row.email, roleName: row.role_name, airportId: row.airport_id, clientIds: clientIdsFor(row.id) };
  return { accessToken: signAccessToken(user) };
}
