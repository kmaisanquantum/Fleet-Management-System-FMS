import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";

export interface AuthUser {
  id: string;
  email: string;
  roleName: string;
  airportId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TELEMETRY_API_KEY = process.env.TELEMETRY_API_KEY || "dev-telemetry-key-12345";

export function signAccessToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "15m" });
}

export function signRefreshToken(user: AuthUser): string {
  return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyRefreshToken(token: string): { id: string } {
  return jwt.verify(token, JWT_SECRET) as { id: string };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey) {
    return res.status(401).json({ error: "Missing x-api-key header" });
  }

  try {
    const keyBuffer = Buffer.from(apiKey);
    const expectedBuffer = Buffer.from(TELEMETRY_API_KEY);
    if (keyBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(keyBuffer, expectedBuffer)) {
      return next();
    }
  } catch {}

  return res.status(401).json({ error: "Invalid x-api-key" });
}

export function apiKeyOrAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    try {
      const keyBuffer = Buffer.from(apiKey);
      const expectedBuffer = Buffer.from(TELEMETRY_API_KEY);
      if (keyBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(keyBuffer, expectedBuffer)) {
        return next();
      }
    } catch {}
    return res.status(401).json({ error: "Invalid x-api-key" });
  }

  return requireAuth(req, res, next);
}
