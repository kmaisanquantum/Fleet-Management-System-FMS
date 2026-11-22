import { AuthUser } from "../middleware/auth";

/**
 * Roles with fleet/national visibility that may see every client's data.
 * Client-role users (any user mapped to a client via `user_clients`) are
 * restricted to their own clients unless they hold one of these roles.
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
 * Resolves the clients (tenants) a user is restricted to, based on the
 * `user_clients` join table (carried on the token). Returns `null` when the
 * user may see all clients: users with no client mapping, or users holding a
 * fleet-wide role. Client users are limited to their own client ids, which are
 * then used to filter `vehicles.client_id`.
 */
export function resolveClientScopes(user?: AuthUser | null): string[] | null {
  if (!user) return null;
  if (ALL_CLIENT_ACCESS_ROLES.has(user.roleName)) return null;
  const ids = user.clientIds ?? [];
  if (ids.length === 0) return null;
  return ids;
}
