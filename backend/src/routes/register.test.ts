/**
 * register.test.ts — Integration tests for POST /api/v1/register.
 *
 * The DB pool is fully mocked. bcrypt.compare and bcrypt.hash are stubbed to
 * avoid slow hashing in tests. State is reset via initRegistration in beforeEach.
 */
import request from 'supertest';
import { EventEmitter } from 'events';
import app from '../app';
import { setPool } from '../middleware/auth';
import { initRegistration } from './register';

// ── Mock bcrypt ───────────────────────────────────────────────────────────────
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));
import bcrypt from 'bcryptjs';
const mockBcryptCompare = bcrypt.compare as unknown as jest.Mock;
const mockBcryptHash = bcrypt.hash as unknown as jest.Mock;

// ── Mock DB pool ──────────────────────────────────────────────────────────────
const devicesStore: Record<string, { device_name: string; api_key_hash: string }> = {};

const mockPool = {
  query: jest.fn(),
  ...EventEmitter.prototype,
  on: jest.fn(),
} as unknown as import('pg').Pool;

// ── Test fixtures ─────────────────────────────────────────────────────────────
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const DEVICE_NAME = 'test-device';
const FAKE_TOKEN_HASH = '$2b$12$FAKE_TOKEN_HASH_PLACEHOLDER_XXXXX';
const FAKE_API_KEY_HASH = '$2b$12$FAKE_API_KEY_HASH_PLACEHOLDER_XX';
const PLAINTEXT_TOKEN = 'test-setup-token-43chars-base64url';

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_id: DEVICE_ID,
    device_name: DEVICE_NAME,
    setup_token: PLAINTEXT_TOKEN,
    ...overrides,
  };
}

// ── beforeEach: reset mocks and state ────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(devicesStore).forEach((k) => delete devicesStore[k]);

  // Reset RegistrationState for each test
  initRegistration(FAKE_TOKEN_HASH);

  mockBcryptCompare.mockResolvedValue(true);
  mockBcryptHash.mockResolvedValue(FAKE_API_KEY_HASH);

  (mockPool.query as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = sql.trim().toLowerCase();
    if (s.startsWith('insert into devices')) {
      const p = params as unknown[];
      const id = p[0] as string;
      const name = p[1] as string;
      const hash = p[2] as string;
      devicesStore[id] = { device_name: name, api_key_hash: hash };
      return { rows: [] };
    }
    return { rows: [] };
  });

  setPool(mockPool);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/register', () => {
  it('201 on valid registration — returns device_id and api_key', async () => {
    const res = await request(app)
      .post('/api/v1/register')
      .send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.device_id).toBe(DEVICE_ID);
    expect(typeof res.body.api_key).toBe('string');
    expect(res.body.api_key.length).toBeGreaterThan(0);
  });

  it('401 on invalid setup token', async () => {
    mockBcryptCompare.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/api/v1/register')
      .send(validBody({ setup_token: 'wrong-token' }));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SETUP_TOKEN_INVALID');
  });

  it('409 on second registration attempt — token consumed after first use', async () => {
    // First request consumes the token
    const first = await request(app)
      .post('/api/v1/register')
      .send(validBody());
    expect(first.status).toBe(201);

    // Second request hits consumed guard before bcrypt is even called
    const second = await request(app)
      .post('/api/v1/register')
      .send(validBody());

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SETUP_TOKEN_CONSUMED');
  });

  it('400 on missing device_id', async () => {
    const body = validBody();
    delete body.device_id;

    const res = await request(app)
      .post('/api/v1/register')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 when Authorization header is present', async () => {
    const res = await request(app)
      .post('/api/v1/register')
      .set('Authorization', 'Bearer some-existing-key')
      .send(validBody());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('500 on DB failure after token consumed — token stays consumed', async () => {
    (mockPool.query as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.trim().toLowerCase().startsWith('insert into devices')) {
        throw new Error('Simulated DB failure');
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post('/api/v1/register')
      .send(validBody());

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');

    // Confirm token is permanently consumed: subsequent attempt gets 409, not 401
    const retry = await request(app)
      .post('/api/v1/register')
      .send(validBody());
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('SETUP_TOKEN_CONSUMED');
  });
});
