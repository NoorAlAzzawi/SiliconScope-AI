import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { dbPool } from '../middleware/auth';

export const registerRouter = Router();

interface RegistrationState {
  tokenHash: string;
  consumed: boolean;
  mutex: boolean;
}

let state: RegistrationState | null = null;

export function initRegistration(tokenHash: string): void {
  state = { tokenHash, consumed: false, mutex: false };
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function errorResponse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

registerRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  if (req.headers.authorization) {
    errorResponse(res, 400, 'VALIDATION_ERROR', 'Authorization header must not be present for device registration.');
    return;
  }

  if (req.cookies?.sscope_session) {
    errorResponse(res, 400, 'VALIDATION_ERROR', 'Session cookie must not be present for device registration.');
    return;
  }

  const body = req.body as Record<string, unknown>;

  if (typeof body.device_id !== 'string' || !UUID_V4_RE.test(body.device_id)) {
    errorResponse(res, 400, 'VALIDATION_ERROR', 'device_id must be a valid UUID v4.');
    return;
  }

  if (!isNonEmptyString(body.device_name)) {
    errorResponse(res, 400, 'VALIDATION_ERROR', 'device_name must be a non-empty string.');
    return;
  }

  if (!isNonEmptyString(body.setup_token)) {
    errorResponse(res, 400, 'VALIDATION_ERROR', 'setup_token must be a non-empty string.');
    return;
  }

  if (state === null) {
    errorResponse(res, 401, 'SETUP_TOKEN_INVALID', 'Setup token is not configured.');
    return;
  }

  // Step 1: Check consumed before bcrypt work
  if (state.consumed) {
    errorResponse(res, 409, 'SETUP_TOKEN_CONSUMED', 'Setup token has already been used. Restart the server to re-register.');
    return;
  }

  // Step 2: Verify token
  let tokenValid: boolean;
  try {
    tokenValid = await bcrypt.compare(body.setup_token as string, state.tokenHash);
  } catch {
    errorResponse(res, 401, 'SETUP_TOKEN_INVALID', 'Setup token verification failed.');
    return;
  }

  // Step 3: Mismatch
  if (!tokenValid) {
    errorResponse(res, 401, 'SETUP_TOKEN_INVALID', 'Invalid setup token.');
    return;
  }

  // Step 4: Consume token before DB write
  state.consumed = true;

  const plainApiKey = crypto.randomBytes(32).toString('base64url');
  let apiKeyHash: string;
  try {
    apiKeyHash = await bcrypt.hash(plainApiKey, 12);
  } catch {
    errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to generate API key. Setup token is permanently consumed; restart required.');
    return;
  }

  const deviceId = body.device_id as string;
  const deviceName = body.device_name as string;

  // Step 5: DB write
  try {
    await dbPool.query(
      `INSERT INTO devices (device_id, device_name, api_key_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (device_id) DO UPDATE SET
         device_name = EXCLUDED.device_name,
         api_key_hash = EXCLUDED.api_key_hash`,
      [deviceId, deviceName, apiKeyHash]
    );
  } catch {
    // Step 6: DB failed after consumption — token is permanently spent
    errorResponse(res, 500, 'INTERNAL_ERROR', 'Registration failed. Setup token is permanently consumed; restart required.');
    return;
  }

  // Step 7: Return plaintext key once
  res.status(201).json({ device_id: deviceId, api_key: plainApiKey });
});
