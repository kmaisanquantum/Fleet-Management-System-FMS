import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, getToken, isTokenExpiring, refreshAccessToken, setToken, subscribeToken } from "../api/client";
import { AuthUser } from "../types";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: (reason?: "manual" | "idle") => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const USER_KEY = "fms_user";
const LAST_ACTIVITY_KEY = "fms_last_activity";
const LOGOUT_REASON_KEY = "fms_logout_reason";
const ACTIVITY_WRITE_INTERVAL_MS = 15_000;

/** Inactivity window before the SPA clears the session. Defaults to 30 minutes. */
function idleTimeoutMs(): number {
  const minutes = Number(import.meta.env.VITE_IDLE_TIMEOUT_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const lastActivityWriteRef = useRef(0);

  const logout = useCallback((reason: "manual" | "idle" = "manual") => {
    if (reason === "idle") sessionStorage.setItem(LOGOUT_REASON_KEY, "idle");
    else sessionStorage.removeItem(LOGOUT_REASON_KEY);

    localStorage.removeItem(LAST_ACTIVITY_KEY);
    setToken(null);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      const stored = localStorage.getItem(USER_KEY);
      if (!stored) {
        if (!cancelled) setLoading(false);
        return;
      }

      // A tab that was left idle past the window should not silently resume.
      const lastActivity = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
      if (lastActivity > 0 && Date.now() - lastActivity >= idleTimeoutMs()) {
        logout("idle");
        if (!cancelled) setLoading(false);
        return;
      }

      let token = getToken();
      if (isTokenExpiring(token)) token = await refreshAccessToken();

      if (cancelled) return;
      if (token) {
        try {
          setUser(JSON.parse(stored));
        } catch {
          localStorage.removeItem(USER_KEY);
          setToken(null);
        }
        if (!localStorage.getItem(LAST_ACTIVITY_KEY)) {
          localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
        }
      } else {
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(LAST_ACTIVITY_KEY);
        setToken(null);
      }
      setLoading(false);
    }

    void restoreSession();

    // A failed refresh clears the token; drop the cached user so the router
    // sends the session back to the login screen instead of showing stale pages.
    const unsubscribe = subscribeToken((token) => {
      if (!token) {
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(LAST_ACTIVITY_KEY);
        setUser(null);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [logout]);

  // Keep tabs in sync: logging out (or in) in one tab updates the others.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== USER_KEY) return;
      if (!event.newValue) {
        setUser(null);
        return;
      }
      try {
        setUser(JSON.parse(event.newValue) as AuthUser);
      } catch {
        setUser(null);
      }
    }

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!user) return;

    const timeout = idleTimeoutMs();
    const checkInterval = Math.min(30_000, Math.max(1_000, Math.floor(timeout / 4)));
    const stored = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
    if (!Number.isFinite(stored) || stored <= 0) {
      localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
      lastActivityWriteRef.current = Date.now();
    }

    function markActivity() {
      const now = Date.now();
      if (now - lastActivityWriteRef.current < ACTIVITY_WRITE_INTERVAL_MS) return;
      lastActivityWriteRef.current = now;
      localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
    }

    function isIdle(): boolean {
      const last = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
      return Number.isFinite(last) && last > 0 && Date.now() - last >= timeout;
    }

    function checkIdle() {
      if (isIdle()) logout("idle");
    }

    // Returning to the tab counts as activity, unless the window already expired.
    function onResume() {
      if (isIdle()) {
        logout("idle");
        return;
      }
      markActivity();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") onResume();
    }

    const activityEvents: (keyof WindowEventMap)[] = ["mousemove", "mousedown", "keydown", "touchstart", "wheel"];
    for (const event of activityEvents) window.addEventListener(event, markActivity, { passive: true });
    document.addEventListener("scroll", markActivity, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onResume);
    const interval = window.setInterval(checkIdle, checkInterval);
    checkIdle();

    return () => {
      for (const event of activityEvents) window.removeEventListener(event, markActivity);
      document.removeEventListener("scroll", markActivity, { capture: true });
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onResume);
      window.clearInterval(interval);
    };
  }, [user, logout]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.post<{ accessToken: string; refreshToken: string; user: AuthUser }>("/auth/login", { email, password });
    localStorage.setItem("fms_refresh_token", result.refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
    sessionStorage.removeItem(LOGOUT_REASON_KEY);
    lastActivityWriteRef.current = Date.now();
    setToken(result.accessToken);
    setUser(result.user);
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
