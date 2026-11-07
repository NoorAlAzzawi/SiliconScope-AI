import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

// Simple sliding-window rate limiter using a Map<ip, timestamps[]>.
// For MVP: in-memory only. Disable with SSCOPE_DISABLE_RATE_LIMIT=true.

export function createRateLimit(maxRequests: number, windowMs: number) {
  const store = new Map<string, number[]>();
  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (process.env.SSCOPE_DISABLE_RATE_LIMIT === 'true') { next(); return; }
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim()
               ?? req.socket.remoteAddress
               ?? 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (store.get(ip) ?? []).filter(t => t > windowStart);
    if (timestamps.length >= maxRequests) {
      logger.warn({ endpoint: req.path, ip }, 'Rate limit exceeded');
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } });
      return;
    }
    timestamps.push(now);
    store.set(ip, timestamps);
    next();
  };
}

export const generalRateLimit  = createRateLimit(100, 60_000);  // 100/min
export const registerRateLimit = createRateLimit(10,  60_000);  // 10/min
export const loginRateLimit    = createRateLimit(60,  60_000);  // 60/min
