import bcrypt from "bcryptjs";
import { db } from "../db";
import { ApiError } from "../middleware/errorHandler";
import { signAccessToken, signRefreshToken, verifyRefreshToken, AuthUser } from "../middleware/auth";
import { writeAudit } from "../utils/audit";

export function login(email: string, password: string, ip?: string) {
  const row = db
    .prepare(`
      SELECT u.id, u.email, u.password_hash, u.full_name, u.airport_id, u.client_id, u.status, r.name as role_name
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

  const user: AuthUser = { id: row.id, email: row.email, roleName: row.role_name, airportId: row.airport_id, clientId: row.client_id ?? null };
  writeAudit({ userId: row.id, role: row.role_name, action: "LOGIN_SUCCESS", entity: "users", entityId: row.id, ipAddress: ip });

  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
    user: { id: row.id, email: row.email, fullName: row.full_name, role: row.role_name, airportId: row.airport_id, clientId: row.client_id ?? null },
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
      SELECT u.id, u.email, u.airport_id, u.client_id, r.name as role_name
      FROM users u JOIN roles r ON u.role_id = r.id
      WHERE u.id = ? AND u.status = 'active'
    `)
    .get(payload.id) as any;
  if (!row) throw new ApiError(401, "User not found or inactive");

  const user: AuthUser = { id: row.id, email: row.email, roleName: row.role_name, airportId: row.airport_id, clientId: row.client_id ?? null };
  return { accessToken: signAccessToken(user) };
}
