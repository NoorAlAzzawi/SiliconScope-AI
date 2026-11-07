import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { logger } from './logger';

// Exported so tests can inject a mock pool.
export let dbPool: Pool;

export function setPool(p: Pool): void {
  dbPool = p;
}

// In-memory session store: sessionToken → {deviceId, expiresAt}.
// A future iteration should move this to Redis or a DB-backed store.
const sessionStore = new Map<string, { deviceId: string; expiresAt: Date }>();

export function createSession(token: string, deviceId: string, ttlMs = 86_400_000): void {
  sessionStore.set(token, { deviceId, expiresAt: new Date(Date.now() + ttlMs) });
}

export function invalidateSession(token: string): void {
  sessionStore.delete(token);
}

// Augment Express Request with sscope-specific fields.
declare global {
  namespace Express {
    interface Request {
      deviceId?: string;
      sessionId?: string;
      isDashboardSession?: boolean;
    }
  }
}

function errorResponse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

// A pre-computed bcrypt hash of a random sentinel value.  Used to run a dummy
// bcrypt.compare when no device rows exist, preventing a timing side-channel
// that would reveal whether any devices are registered (F-2).
const DUMMY_HASH = '$2a$12$x8Qz1fK9vR3mL0pT6uN2eOJ5yW8dA4cB7hG1iE0nS3kM2oP9qF6v';

async function dummyBcryptCompare(rawKey: string): Promise<void> {
  // Result is always false; purpose is constant-time work to thwart timing attacks.
  await bcrypt.compare(rawKey, DUMMY_HASH).catch(() => { /* ignore */ });
}

/**
 * requireAgentAuth — verifies Bearer API key.
 *
 * Hard rule (SECURITY.md §5.3): if a valid session cookie is also present,
 * the request is rejected with 403 FORBIDDEN regardless of the API key.
 */
export async function requireAgentAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Reject immediately if a dashboard session cookie is also present.
  const sessionToken = req.cookies?.sscope_session as string | undefined;
  if (sessionToken) {
    const session = sessionStore.get(sessionToken);
    if (session && session.expiresAt > new Date()) {
      errorResponse(res, 403, 'FORBIDDEN',
        'Dashboard session must not be used for agent writes.');
      return;
    }
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn({ reason: 'MISSING_AUTH', ip: req.socket.remoteAddress ?? 'unknown' }, 'Authentication failure');
    errorResponse(res, 401, 'MISSING_AUTH', 'Authorization: Bearer <key> header is required.');
    return;
  }

  const rawKey = authHeader.slice('Bearer '.length);

  let devices: Array<{ device_id: string; api_key_hash: string }>;
  try {
    const result = await dbPool.query<{ device_id: string; api_key_hash: string }>(
      'SELECT device_id, api_key_hash FROM devices'
    );
    devices = result.rows;
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Unable to verify credentials.');
    return;
  }

  if (devices.length === 0) {
    // No devices registered — run dummy work to prevent timing side-channel.
    await dummyBcryptCompare(rawKey);
    logger.warn({ reason: 'INVALID_AUTH', ip: req.socket.remoteAddress ?? 'unknown' }, 'Authentication failure');
    errorResponse(res, 401, 'INVALID_AUTH', 'Invalid API key.');
    return;
  }

  for (const device of devices) {
    let match = false;
    try {
      match = await bcrypt.compare(rawKey, device.api_key_hash);
    } catch {
      continue;
    }
    if (match) {
      req.deviceId = device.device_id;
      next();
      return;
    }
  }

  logger.warn({ reason: 'INVALID_AUTH', ip: req.socket.remoteAddress ?? 'unknown' }, 'Authentication failure');
  errorResponse(res, 401, 'INVALID_AUTH', 'Invalid API key.');
}

/**
 * requireDashboardAuth — verifies sscope_session cookie.
 */
export function requireDashboardAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = req.cookies?.sscope_session as string | undefined;
  if (!token) {
    errorResponse(res, 401, 'MISSING_AUTH', 'sscope_session cookie is required.');
    return;
  }

  const session = sessionStore.get(token);
  if (!session || session.expiresAt <= new Date()) {
    sessionStore.delete(token);
    errorResponse(res, 401, 'INVALID_AUTH', 'Session expired or invalid.');
    return;
  }

  req.deviceId = session.deviceId;
  req.sessionId = token;
  req.isDashboardSession = true;
  next();
}

/**
 * requireAnyAuth — agent API key OR dashboard session.
 * Used by GET endpoints that both callers may access.
 */
export async function requireAnyAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Try session cookie first (non-async).
  const token = req.cookies?.sscope_session as string | undefined;
  if (token) {
    const session = sessionStore.get(token);
    if (session && session.expiresAt > new Date()) {
      req.deviceId = session.deviceId;
      req.sessionId = token;
      req.isDashboardSession = true;
      next();
      return;
    }
  }

  // Fall back to Bearer key.
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn({ reason: 'MISSING_AUTH', ip: req.socket.remoteAddress ?? 'unknown' }, 'Authentication failure');
    errorResponse(res, 401, 'MISSING_AUTH',
      'Authorization: Bearer <key> header or sscope_session cookie is required.');
    return;
  }

  const rawKey = authHeader.slice('Bearer '.length);

  let devices: Array<{ device_id: string; api_key_hash: string }>;
  try {
    const result = await dbPool.query<{ device_id: string; api_key_hash: string }>(
      'SELECT device_id, api_key_hash FROM devices'
    );
    devices = result.rows;
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Unable to verify credentials.');
    return;
  }

  if (devices.length === 0) {
    await dummyBcryptCompare(rawKey);
    logger.warn({ reason: 'INVALID_AUTH', ip: req.socket.remoteAddress ?? 'unknown' }, 'Authentication failure');
    errorResponse(res, 401, 'INVALID_AUTH', 'Invalid credentials.');
    return;
  }

  for (const device of devices) {
    let match = false;
    try {
      match = await bcrypt.compare(rawKey, device.api_key_hash);
    } catch {
      continue;
    }
    if (match) {
      req.deviceId = device.device_id;
      next();
      return;
    }
  }

  logger.warn({ reason: 'INVALID_AUTH', ip: req.socket.remoteAddress ?? 'unknown' }, 'Authentication failure');
  errorResponse(res, 401, 'INVALID_AUTH', 'Invalid credentials.');
}
