import { Request, Response, NextFunction } from "express";
import { AuthRequest } from "./auth";

/**
 * Simple in-memory rate limiter for admin endpoints.
 * Limit: 10 requests per 60-second window per authenticated UID.
 *
 * NOTE: This is per-Cloud-Function-instance. Multiple warm instances each
 * maintain independent counters — the effective limit is 10 × instanceCount.
 * This is intentional: it's a deterrent against brute-force secret reads, not
 * a strict global quota. A strict global limiter would require a shared store
 * (e.g. Firestore or Redis) and is not worth the latency overhead here.
 */

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 10;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateMap = new Map<string, RateLimitEntry>();

// Prune stale entries every 2 minutes to prevent unbounded memory growth
// on long-lived instances with many distinct callers.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of rateMap) {
    if (entry.windowStart < cutoff) rateMap.delete(key);
  }
}, WINDOW_MS * 2);

export function adminRateLimit(req: Request, res: Response, next: NextFunction): void {
  const uid = (req as AuthRequest).uid;
  if (!uid) {
    next();
    return;
  }

  const now = Date.now();
  const entry = rateMap.get(uid);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    rateMap.set(uid, { count: 1, windowStart: now });
    next();
    return;
  }

  entry.count++;
  if (entry.count > MAX_REQUESTS) {
    res.status(429).json({ error: "Too many requests. Please wait a minute before retrying." });
    return;
  }

  next();
}
