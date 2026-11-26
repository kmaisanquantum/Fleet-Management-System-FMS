import React, { createContext, useContext, useEffect, useState } from "react";
import { api, getToken, isTokenExpiring, refreshAccessToken, setToken, subscribeToken } from "../api/client";
import { AuthUser } from "../types";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      const stored = localStorage.getItem("fms_user");
      if (!stored) {
        if (!cancelled) setLoading(false);
        return;
      }

      let token = getToken();
      if (isTokenExpiring(token)) token = await refreshAccessToken();

      if (cancelled) return;
      if (token) {
        setUser(JSON.parse(stored));
      } else {
        localStorage.removeItem("fms_user");
        setToken(null);
      }
      setLoading(false);
    }

    void restoreSession();

    // A failed refresh clears the token; drop the cached user so the router
    // sends the session back to the login screen instead of showing stale pages.
    const unsubscribe = subscribeToken((token) => {
      if (!token) {
        localStorage.removeItem("fms_user");
        setUser(null);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  async function login(email: string, password: string) {
    const result = await api.post<{ accessToken: string; refreshToken: string; user: AuthUser }>("/auth/login", { email, password });
    localStorage.setItem("fms_refresh_token", result.refreshToken);
    setToken(result.accessToken);
    localStorage.setItem("fms_user", JSON.stringify(result.user));
    setUser(result.user);
  }

  function logout() {
    setToken(null);
    localStorage.removeItem("fms_user");
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
