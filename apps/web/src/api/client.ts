const BASE_URL = "/api/v1";
const ACCESS_TOKEN_KEY = "fms_access_token";
const REFRESH_TOKEN_KEY = "fms_refresh_token";

type TokenListener = (token: string | null) => void;
const tokenListeners = new Set<TokenListener>();

export function getToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

function notifyToken(token: string | null) {
  for (const listener of [...tokenListeners]) {
    try {
      listener(token);
    } catch {
      // A listener must never break token handling.
    }
  }
}

/** Subscribe to access-token changes (login, logout, refresh). Returns an unsubscribe fn. */
export function subscribeToken(listener: TokenListener): () => void {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

/** Decode a JWT payload without verifying it (only used to read `exp`). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/** True when the token is missing, malformed, or expires within `skewMs`. */
export function isTokenExpiring(token: string | null, skewMs = 30_000): boolean {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== "number") return false;
  return Date.now() >= exp * 1000 - skewMs;
}

let refreshInFlight: Promise<string | null> | null = null;

/** Exchange the stored refresh token for a new access token. De-duplicates concurrent calls. */
export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) return Promise.resolve(null);

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          sessionStorage.setItem("fms_logout_reason", "expired");
          setToken(null);
        }
        return null;
      }
      const data = (await res.json()) as { accessToken?: string };
      if (!data.accessToken) return null;
      setToken(data.accessToken);
      return data.accessToken;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export class ApiClientError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
  const canRefresh = !path.startsWith("/auth/login") && !path.startsWith("/auth/refresh");
  let token = getToken();

  // Refresh proactively so a page left open does not fire a request with a token
  // that is about to expire.
  if (canRefresh && token && isTokenExpiring(token)) {
    token = await refreshAccessToken();
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  // The access token can still be rejected (clock skew, revocation, a token that
  // expired in flight). Refresh once and replay the request.
  if (res.status === 401 && canRefresh) {
    if (!retried) {
      const refreshed = await refreshAccessToken();
      if (refreshed) return request<T>(path, options, true);
    }
    sessionStorage.setItem("fms_logout_reason", "expired");
    setToken(null);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiClientError(res.status, body.error || "Request failed");
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T,>(path: string) => request<T>(path, { method: "GET" }),
  post: <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T,>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T,>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
};

export const apiGet = api.get;
export const apiPost = api.post;
export const apiPut = api.put;
export const apiPatch = api.patch;
export const apiDel = api.del;

export function setToken(token: string | null) {
  if (token) {
    localStorage.setItem(ACCESS_TOKEN_KEY, token);
  } else {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
  notifyToken(token);
}
