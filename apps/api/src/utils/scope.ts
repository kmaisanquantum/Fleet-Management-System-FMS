import { AuthUser } from "../middleware/auth";

/**
 * Roles with fleet/national visibility that may see every client's data.
 * Client-role users (any user carrying a `client_id`) are restricted to their
 * own client unless they hold one of these roles.
 */
export const ALL_CLIENT_ACCESS_ROLES = new Set([
  "admin",
  "fleet_admin",
  "fleet_manager",
  "national_fuel_manager",
  "executive",
  "auditor",
  "finance_officer",
  "procurement_officer",
]);

/**
 * Resolves the client (tenant) a user is restricted to, or `null` when the user
 * may see all clients. Users with no `client_id`, or with a fleet-wide role,
 * are unrestricted; client users are limited to their own `client_id`.
 */
export function resolveClientScope(user?: AuthUser | null): string | null {
  if (!user) return null;
  if (!user.clientId) return null;
  if (ALL_CLIENT_ACCESS_ROLES.has(user.roleName)) return null;
  return user.clientId;
}
