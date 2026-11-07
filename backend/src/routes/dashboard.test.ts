/**
 * dashboard.test.ts — Integration tests for POST /dashboard/login and /dashboard/logout.
 *
 * dashboardPasswordHash is read at module init time, so each describe block uses
 * jest.resetModules() + require() to load a fresh app instance with the desired
 * env var state.
 */
import request from 'supertest';
import { EventEmitter } from 'events';

// ── Mock bcrypt (hoisted before any require()) ────────────────────────────────
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

const FAKE_HASH = '$2a$12$FAKE_HASH_PLACEHOLDER_FOR_TESTS_X';

// ── Helper: build a mock pool ─────────────────────────────────────────────────
function makeMockPool(): import('pg').Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    ...EventEmitter.prototype,
    on: jest.fn(),
  } as unknown as import('pg').Pool;
}

// ── Tests: password configured ────────────────────────────────────────────────

describe('Dashboard routes (password configured)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let mockBcryptCompare: jest.Mock;
  let mockPool: import('pg').Pool;

  beforeAll(() => {
    process.env.SSCOPE_DASHBOARD_PASSWORD = FAKE_HASH;
    jest.resetModules();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    app = require('../app').default;

    // Capture fresh mock instances created by the factory after resetModules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bcrypt = require('bcryptjs') as { compare: jest.Mock };
    mockBcryptCompare = bcrypt.compare;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setPool } = require('../middleware/auth') as { setPool: (p: import('pg').Pool) => void };
    mockPool = makeMockPool();
    setPool(mockPool);
  });

  afterAll(() => {
    jest.resetModules();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockBcryptCompare.mockResolvedValue(false);
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [] });
  });

  it('POST /dashboard/login with correct password → 200, session cookie set', async () => {
    mockBcryptCompare.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/dashboard/login')
      .type('form')
      .send({ password: 'correct-password' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const cookieHeader = res.headers['set-cookie'] as string[] | string;
    const firstCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    expect(firstCookie).toContain('sscope_session=');
    expect(firstCookie).toContain('HttpOnly');
  });

  it('POST /dashboard/login with wrong password → 401', async () => {
    mockBcryptCompare.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/dashboard/login')
      .type('form')
      .send({ password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('POST /dashboard/logout with valid session → 200', async () => {
    // Log in first to get a session cookie.
    mockBcryptCompare.mockResolvedValueOnce(true);
    const loginRes = await request(app)
      .post('/dashboard/login')
      .type('form')
      .send({ password: 'correct-password' });

    expect(loginRes.status).toBe(200);

    const cookies = loginRes.headers['set-cookie'] as string[] | string;
    const rawCookie = Array.isArray(cookies) ? cookies[0] : cookies;
    // Extract just the name=value part (before first semicolon).
    const sessionCookie = rawCookie.split(';')[0];

    const logoutRes = await request(app)
      .post('/dashboard/logout')
      .set('Cookie', sessionCookie);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.ok).toBe(true);
  });

  it('POST /dashboard/logout without cookie → 401', async () => {
    const res = await request(app).post('/dashboard/logout');

    expect(res.status).toBe(401);
  });
});

// ── Tests: password NOT configured ───────────────────────────────────────────

describe('Dashboard login when SSCOPE_DASHBOARD_PASSWORD not set', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(() => {
    delete process.env.SSCOPE_DASHBOARD_PASSWORD;
    jest.resetModules();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    app = require('../app').default;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setPool } = require('../middleware/auth') as { setPool: (p: import('pg').Pool) => void };
    setPool(makeMockPool());
  });

  afterAll(() => {
    jest.resetModules();
  });

  it('POST /dashboard/login → 503 NOT_CONFIGURED', async () => {
    const res = await request(app)
      .post('/dashboard/login')
      .type('form')
      .send({ password: 'any' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });
});
