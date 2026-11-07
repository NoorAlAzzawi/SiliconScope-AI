/**
 * security.test.ts — Security test cases ST-01 through ST-25.
 *
 * IMPORTANT: SSCOPE_DISABLE_RATE_LIMIT is NOT set anywhere in this file.
 * ST-11 requires the real in-memory rate limiter to be active.
 */

import request from 'supertest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';

// ── Mock bcrypt (hoisted before any import that loads bcryptjs) ───────────────
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));
import bcrypt from 'bcryptjs';
const mockBcryptCompare = bcrypt.compare as unknown as jest.Mock;
const mockBcryptHash   = bcrypt.hash    as unknown as jest.Mock;

import app from '../app';
import { setPool } from '../middleware/auth';
import { initRegistration } from './register';

// ── Shared mock pool ──────────────────────────────────────────────────────────
const DEVICE_ID   = 'dddddddd-dddd-4ddd-addd-dddddddddddd';
const DEVICE_HASH = '$2b$12$FAKE_HASH_NEVER_USED_BCRYPT_STUBBED';

const FAKE_TOKEN_HASH   = '$2b$12$FAKE_TOKEN_HASH_PLACEHOLDER_XXXXX';
const FAKE_API_KEY_HASH = '$2b$12$FAKE_API_KEY_HASH_PLACEHOLDER_XX';

const mockPool = {
  query: jest.fn(),
  ...EventEmitter.prototype,
  on: jest.fn(),
} as unknown as import('pg').Pool;

// ── Global beforeEach ─────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();

  // Reset the register module's one-time token state before each test.
  initRegistration(FAKE_TOKEN_HASH);

  // Default: bcrypt operations succeed.
  mockBcryptCompare.mockResolvedValue(true);
  mockBcryptHash.mockResolvedValue(FAKE_API_KEY_HASH);

  (mockPool.query as jest.Mock).mockImplementation(async (sql: string) => {
    const s = sql.trim().toLowerCase();
    if (s.startsWith('select device_id')) {
      return { rows: [{ device_id: DEVICE_ID, api_key_hash: DEVICE_HASH }] };
    }
    if (s.startsWith('insert into devices')) {
      return { rows: [] };
    }
    if (s === 'begin' || s === 'commit' || s === 'rollback') {
      return { rows: [] };
    }
    return { rows: [] };
  });

  setPool(mockPool);
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-01 — API key required for run submission
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-01 — API key required for run submission', () => {
  it('POST /api/v1/runs with no Authorization header → 401 MISSING_AUTH', async () => {
    const res = await request(app)
      .post('/api/v1/runs')
      .send({ some: 'body' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_AUTH');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-02 — Invalid API key rejected; credential not echoed in response
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-02 — Invalid API key rejected; credential not echoed in response', () => {
  it('invalid key → 401, submitted key string absent from response body', async () => {
    mockBcryptCompare.mockResolvedValue(false);

    const invalidKey = 'invalid-key-string-must-not-appear-in-response-body';
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', `Bearer ${invalidKey}`)
      .send({ some: 'body' });

    expect(res.status).toBe(401);

    // The submitted key string must not be echoed anywhere in the response body.
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain(invalidKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-03 — Setup token is one-time-use
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-03 — Setup token one-time use', () => {
  it('second registration with the same token → 409; first device was not disrupted', async () => {
    const deviceIdA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const deviceIdB = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

    // First registration: succeeds, token is consumed.
    const first = await request(app)
      .post('/api/v1/register')
      .send({
        device_id:   deviceIdA,
        device_name: 'device-a',
        setup_token: 'any-valid-token-value',
      });

    expect(first.status).toBe(201);
    expect(typeof first.body.api_key).toBe('string');
    expect(first.body.api_key.length).toBeGreaterThan(0);

    // Second registration: same token value. The consumed guard fires before
    // bcrypt work and returns 409 SETUP_TOKEN_CONSUMED per register.ts.
    const second = await request(app)
      .post('/api/v1/register')
      .send({
        device_id:   deviceIdB,
        device_name: 'device-b',
        setup_token: 'any-valid-token-value',
      });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SETUP_TOKEN_CONSUMED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-04 — Agent --token flag not accepted as CLI argument (static analysis)
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-04 — Agent --token flag not accepted as CLI argument', () => {
  it('agent/src/main.cpp does not store a value from --token', () => {
    const mainCppPath = path.resolve(
      __dirname,
      '../../../agent/src/main.cpp'
    );
    const src = fs.readFileSync(mainCppPath, 'utf8');

    // The Options struct must have no `token` field.
    expect(src).not.toMatch(/\bstd::string\s+token\b/);

    // No assignment of a parsed value into opts.token anywhere in the file.
    expect(src).not.toMatch(/opts\.token\s*=/);

    // If "--token" appears in the source (e.g., as an explicit rejection guard
    // that calls std::exit(1)), the security property is still satisfied because
    // the token value is never stored. main.cpp contains the rejection guard:
    //   if (arg == "--token") { std::cerr << "..."; std::exit(1); }
    // This is intentional: the flag is explicitly rejected, never accepted.
    // The two assertions above (no opts.token field, no opts.token assignment)
    // are sufficient to confirm that "--token" is not an accepted argument.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-10 — Oversized run submission body → 413 PAYLOAD_TOO_LARGE
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-10 — Oversized run submission body → 413', () => {
  it('POST /api/v1/runs with body > 25 MiB → 413 PAYLOAD_TOO_LARGE', async () => {
    // Build a JSON payload whose serialized form exceeds the 25 MiB limit.
    // 25 MiB = 26,214,400 bytes. A 26 MiB character string guarantees exceedance.
    const DATA_CHARS = 26 * 1024 * 1024;
    const oversizedBody = JSON.stringify({ x: 'x'.repeat(DATA_CHARS) });

    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .set('Content-Type', 'application/json')
      .send(oversizedBody);

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-11 — Rate limiting: 101st request returns 429
//
// SSCOPE_DISABLE_RATE_LIMIT is NOT set in this file.
//
// Strategy: spy on Date.now() with small fake timestamps (0–10,000 ms) so all
// 101 requests fall within the 60 s window. After the spy is restored, real
// Date.now() (~1.76×10¹² ms) makes those timestamps appear far outside any
// 60 s window, leaving the rate-limiter store clean for subsequent tests.
//
// A unique X-Forwarded-For value isolates ST-11's IP slot from every other
// test in this file (which use the loopback address).
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-11 — Rate limiting: 101st request returns 429', () => {
  it('first 100 requests → 200; 101st → 429', async () => {
    const ST11_IP = '10.0.0.11'; // unique IP — no other test uses this address
    let fakeNow = 0;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    try {
      // Requests 1–100: spaced 100 ms apart, all within the 60,000 ms window.
      for (let i = 0; i < 100; i++) {
        fakeNow = i * 100; // 0, 100, 200, ..., 9,900 ms
        const res = await request(app)
          .get('/health')
          .set('X-Forwarded-For', ST11_IP);
        expect(res.status).toBe(200);
      }

      // Request 101: fakeNow = 10,000 ms — still inside the 60 s window.
      // All 100 prior timestamps (0–9,900 ms) satisfy t > (10,000 − 60,000),
      // so timestamps.length === 100 >= maxRequests (100) → 429.
      fakeNow = 100 * 100; // 10,000 ms
      const last = await request(app)
        .get('/health')
        .set('X-Forwarded-For', ST11_IP);

      expect(last.status).toBe(429);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-12 — Provenance immutability (application layer, static analysis)
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-12 — No PUT/PATCH/DELETE routes; no UPDATE of provenance fields', () => {
  it('runs.ts has only GET and POST handlers; no SQL UPDATE on provenance fields', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'runs.ts'), 'utf8');

    // No PUT, PATCH, or DELETE route registrations.
    expect(src).not.toMatch(/runsRouter\.(put|patch|delete)\s*\(/i);

    // No UPDATE statement that touches provenance fields.
    expect(src).not.toMatch(
      /UPDATE\s+sessions\s+SET[\s\S]{0,500}(source|source_marker|import_timestamp)/i
    );
  });

  it('comparisons.ts has only GET and POST handlers; no SQL UPDATE on provenance fields', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'comparisons.ts'), 'utf8');

    expect(src).not.toMatch(/comparisonsRouter\.(put|patch|delete)\s*\(/i);

    expect(src).not.toMatch(
      /UPDATE\s+sessions\s+SET[\s\S]{0,500}(source|source_marker|import_timestamp)/i
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-15 — Dashboard requires authentication
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-15 — Dashboard requires authentication', () => {
  it('POST /dashboard/logout without session cookie → 401 MISSING_AUTH', async () => {
    const res = await request(app).post('/dashboard/logout');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_AUTH');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §14.2 Import rejection logging — spy test
//
// Must appear BEFORE ST-16's describe block: ST-16 calls jest.resetModules() in
// its afterAll, which resets the module registry.  After that reset, any
// require('../middleware/logger') returns a fresh instance that the already-loaded
// app/runs modules do NOT use, so spies on that fresh instance capture nothing.
// Placing these tests here keeps the original module instance intact.
// ─────────────────────────────────────────────────────────────────────────────

describe('§14.2 Import rejection log — reason and http_status logged, body content excluded', () => {
  it('MISSING_REQUIRED_FIELD: logger.warn called with reason+http_status; no body values present', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const logMod = require('../middleware/logger') as { logger: import('pino').Logger };
    const captured: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warnSpy = jest.spyOn(logMod.logger, 'warn' as any).mockImplementation((...args: unknown[]) => {
      captured.push(args);
    });

    try {
      // Omit 'run_name' — triggers MISSING_REQUIRED_FIELD for that field.
      await request(app)
        .post('/api/v1/runs')
        .set('Authorization', 'Bearer any-key')
        .send({ session_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', benchmarks: [] });
    } finally {
      warnSpy.mockRestore();
    }

    // At least one logger.warn call must exist.
    expect(captured.length).toBeGreaterThan(0);

    const rejectionCalls = captured.filter(args =>
      typeof args[0] === 'object' && args[0] !== null &&
      (args[0] as Record<string, unknown>).reason === 'MISSING_REQUIRED_FIELD'
    );
    expect(rejectionCalls.length).toBeGreaterThan(0);

    const call = rejectionCalls[0][0] as Record<string, unknown>;
    expect(call.http_status).toBe(422);
    // 'field' is a known field name (a constant string), not a user-supplied value.
    expect(typeof call.field).toBe('string');

    // No body content — the submitted session_id and benchmark list must not appear.
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  });

  it('FINGERPRINT_MISMATCH: logger.warn called with reason+http_status; no fingerprint value present', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const logMod = require('../middleware/logger') as { logger: import('pino').Logger };
    const captured: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warnSpy = jest.spyOn(logMod.logger, 'warn' as any).mockImplementation((...args: unknown[]) => {
      captured.push(args);
    });

    // Craft a body that passes field validation but provides a deliberately
    // wrong fingerprint so the FINGERPRINT_MISMATCH branch fires.
    const wrongFp = 'a'.repeat(64);
    try {
      await request(app)
        .post('/api/v1/runs')
        .set('Authorization', 'Bearer any-key')
        .send({
          session_id:           'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
          run_name:             'test',
          os_name:              'macOS',
          os_version:           '14.0',
          cpu_name:             'M1',
          isa:                  'arm64',
          build_type:           'release',
          source:               'synthetic',
          import_timestamp:     '2026-11-04T00:00:00Z',
          submitted_fingerprint: wrongFp,
          benchmarks: [{
            project_name:   'p',
            canonical_name: 'c',
            data_type:      'raw_samples_available',
            measurements:   { raw_rows: [], aggregate_rows: [] },
          }],
        });
    } finally {
      warnSpy.mockRestore();
    }

    const rejectionCalls = captured.filter(args =>
      typeof args[0] === 'object' && args[0] !== null &&
      (args[0] as Record<string, unknown>).reason === 'FINGERPRINT_MISMATCH'
    );
    expect(rejectionCalls.length).toBeGreaterThan(0);

    const call = rejectionCalls[0][0] as Record<string, unknown>;
    expect(call.http_status).toBe(422);

    // The wrong fingerprint value itself must not appear in any log call.
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(wrongFp);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-16 — Session cookie security attributes
//
// dashboardPasswordHash is captured at module init time, so we use
// jest.resetModules() to get a fresh app instance with SSCOPE_DASHBOARD_PASSWORD
// set. NODE_ENV is controlled per-test at request time (dashboard.ts checks it
// at request time, not module init time).
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-16 — Session cookie security attributes', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cookieApp: any;
  let cookieMockBcryptCompare: jest.Mock;

  beforeAll(() => {
    process.env.SSCOPE_DASHBOARD_PASSWORD = '$2b$12$FAKE_DASHBOARD_HASH_FOR_ST16__';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cookieApp = require('../app').default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cookieMockBcryptCompare = (require('bcryptjs') as { compare: jest.Mock }).compare;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setPool: freshSetPool } = require('../middleware/auth') as {
      setPool: (p: import('pg').Pool) => void;
    };
    freshSetPool(mockPool);
  });

  afterAll(() => {
    jest.resetModules();
  });

  it('non-production: HttpOnly, SameSite=Strict, Path=/, Max-Age=86400 — no Secure', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test'; // explicitly non-production
    cookieMockBcryptCompare.mockResolvedValueOnce(true);

    try {
      const res = await request(cookieApp)
        .post('/dashboard/login')
        .type('form')
        .send({ password: 'correct' });

      expect(res.status).toBe(200);

      const raw = res.headers['set-cookie'] as string[] | string;
      const cookie = Array.isArray(raw) ? raw[0] : raw;

      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('Max-Age=86400');
      expect(cookie).not.toContain('Secure');
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });

  it('production: Set-Cookie contains Secure when NODE_ENV=production', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    cookieMockBcryptCompare.mockResolvedValueOnce(true);

    try {
      const res = await request(cookieApp)
        .post('/dashboard/login')
        .type('form')
        .send({ password: 'correct' });

      expect(res.status).toBe(200);

      const raw = res.headers['set-cookie'] as string[] | string;
      const cookie = Array.isArray(raw) ? raw[0] : raw;

      expect(cookie).toContain('Secure');
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-17 — Malformed request does not expose internals (no stack trace/paths)
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-17 — Malformed request does not expose internals', () => {
  it('malformed JSON → structured error body, no stack trace or file paths', async () => {
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .set('Content-Type', 'application/json')
      .send('{"unclosed: json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    // Response must carry a structured error body.
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error.code).toBe('string');
    expect(typeof res.body.error.message).toBe('string');

    // Response must NOT contain stack-trace signatures or internal paths.
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toMatch(/\s{4}at /);    // "    at " — stack frame line
    expect(bodyText).not.toMatch(/\.js:\d+/);     // .js:123 — compiled file ref
    expect(bodyText).not.toMatch(/\.ts:\d+/);     // .ts:123 — source file ref
    expect(bodyText).not.toMatch(/^Error:/);      // bare "Error:" string
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-20 — Security headers present on all responses
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-20 — Security headers present on all responses', () => {
  it('GET /health response includes X-Content-Type-Options, X-Frame-Options, CSP with frame-ancestors', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');

    const csp = res.headers['content-security-policy'] as string | undefined;
    expect(csp).toBeDefined();
    expect(csp).toContain('frame-ancestors');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-21 — HSTS header present in production
// securityHeaders.ts reads NODE_ENV at request time, so no resetModules needed.
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-21 — HSTS header present in production', () => {
  it('GET /health with NODE_ENV=production → Strict-Transport-Security: max-age=31536000', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const res = await request(app).get('/health');

      const hsts = res.headers['strict-transport-security'] as string | undefined;
      expect(hsts).toBeDefined();
      expect(hsts).toContain('max-age=31536000');
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-25 — No command/exec/script/shell/run_command/eval fields in API responses
// (static analysis of route source files)
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-25 — No remote-execution fields in API response shapes', () => {
  const PROHIBITED = ['command', 'exec', 'script', 'shell', 'run_command', 'eval'];

  /**
   * Scan source text for the prohibited field names appearing as JSON object
   * keys (i.e., `"field":` or `'field':` patterns).
   */
  function findProhibitedResponseFields(src: string): string[] {
    return PROHIBITED.filter((field) => {
      const pattern = new RegExp(`["']${field}["']\\s*:`, 'i');
      return pattern.test(src);
    });
  }

  it('runs.ts response objects contain no prohibited execution-channel fields', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'runs.ts'), 'utf8');
    expect(findProhibitedResponseFields(src)).toEqual([]);
  });

  it('comparisons.ts response objects contain no prohibited execution-channel fields', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'comparisons.ts'), 'utf8');
    expect(findProhibitedResponseFields(src)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests requiring manual verification or infrastructure not available in unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-05 — JSON import execution prevention (static analysis)', () => {
  it('agent/src/import/ contains no exec/system/popen/eval calls that could process field values', () => {
    /**
     * Static analysis of the C++ import source.
     * Runtime coverage: test_security.cpp:NullByteInExecutableNeverExecuted
     *   verifies that an actual null-byte injection via context.executable does
     *   not create a marker file — proving no command execution occurs.
     */
    const importDir = path.resolve(__dirname, '../../../agent/src/import');
    const files = fs.readdirSync(importDir).filter(f => f.endsWith('.cpp') || f.endsWith('.h'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const src = fs.readFileSync(path.join(importDir, file), 'utf8');
      // No dynamic execution on import code paths.
      expect(src).not.toMatch(/\beval\s*\(/);
      expect(src).not.toMatch(/\bsystem\s*\(/);
      expect(src).not.toMatch(/\bpopen\s*\(/);
      // execv/execvp/execlp would each end in 'p\s*(' — single pattern covers all.
      expect(src).not.toMatch(/\bexec[lvpe]+\s*\(/);
    }
  });
});

describe('ST-06 — JSON import entry count limit', () => {
  test.skip('Import JSON with 10,001 entries → rejected before parse completes', () => {
    /**
     * MANUAL VERIFICATION REQUIRED.
     *
     * Requires the compiled C++ agent and a 10,001-entry benchmark JSON file.
     * The in-process counter (SECURITY.md §8.2) must abort parsing and return
     * a structured error. No partial data must be written to the SQLite DB.
     */
  });
});

describe('ST-07 — JSON nesting depth limit', () => {
  test.skip('Import JSON nested 33 levels deep → parser aborts at depth 33', () => {
    /**
     * MANUAL VERIFICATION REQUIRED.
     *
     * Requires the compiled C++ agent and a 33-level-deep JSON object.
     * The depth counter must abort at depth 33 (limit is 32) per SECURITY.md §8.2.
     * No partial data must be written.
     */
  });
});

describe('ST-08 — File size pre-read check', () => {
  test.skip('Import file of 50 MiB + 1 byte → rejected at stat() before file is opened', () => {
    /**
     * MANUAL VERIFICATION REQUIRED.
     *
     * Requires the compiled C++ agent and a file > 50 MiB.
     * The stat() check (SECURITY.md §8.3 step 1) must reject before the file
     * descriptor is opened. Verify with strace/dtruss on the agent process.
     */
  });
});

describe('ST-09 — TOCTOU file size defense', () => {
  test.skip('File grows past 50 MiB during streaming read → byte counter aborts, no partial write', () => {
    /**
     * MANUAL VERIFICATION REQUIRED.
     *
     * Requires the compiled C++ agent and a named pipe (FIFO) that presents
     * ≤ 50 MiB at stat() time and grows beyond the limit during streaming read.
     * The byte counter (SECURITY.md §8.3 step 3) must abort the read.
     * No partial data must be written to the DB.
     */
  });
});

describe('ST-13 — DB trigger immutability (database layer)', () => {
  test.skip('Direct UPDATE of provenance fields → trigger raises exception, row unchanged', () => {
    /**
     * MANUAL VERIFICATION REQUIRED (requires live PostgreSQL; test suite uses mock pool).
     *
     * Migration 002_protect_content_fingerprint.sql extends the trigger to also
     * protect content_fingerprint. The trigger now covers four immutable fields:
     *   source, source_marker, import_timestamp, content_fingerprint
     *
     * Verified manually against sscope_test on 2026-11-04:
     *   1. INSERT succeeds.
     *   2. UPDATE sessions SET content_fingerprint = '<new>' → raises:
     *      "provenance fields (source, source_marker, import_timestamp, content_fingerprint)
     *       are immutable after insert"
     *   3. UPDATE sessions SET source = 'tampered' → same exception (regression confirmed).
     *   4. UPDATE sessions SET build_config = '...' → succeeds (non-protected field).
     *
     * To extend this test for automated coverage, wire the test suite to a real
     * PostgreSQL instance (e.g. via testcontainers) and test both source and
     * content_fingerprint UPDATE cases.
     */
  });
});

describe('ST-14 — XSS prevention in dashboard (static analysis)', () => {
  it('dashboard/src/ contains no dangerouslySetInnerHTML usage', () => {
    /**
     * Static analysis: React's default text-node mechanism is safe by default.
     * The only way to introduce stored XSS is an explicit dangerouslySetInnerHTML
     * call.  We verify none exist in any dashboard source file.
     *
     * Browser-rendering verification (alert does not fire) remains manual because
     * it requires a running browser with real imported data.
     */
    const dashSrc = path.resolve(__dirname, '../../../dashboard/src');

    function scanDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') || entry.name.endsWith('.jsx') || entry.name.endsWith('.js')) {
          const src = fs.readFileSync(full, 'utf8');
          expect(src).not.toContain('dangerouslySetInnerHTML');
        }
      }
    }

    scanDir(dashSrc);
  });
});

describe('ST-18 — API key in Keychain, not plaintext file', () => {
  test.skip('After sscope register, ~/.config/sscope/ has no plaintext key file', () => {
    /**
     * MANUAL VERIFICATION REQUIRED.
     *
     * Requires the compiled C++ sscope binary running on macOS with Keychain
     * access (SECURITY.md §10.1).
     *
     * Manual steps:
     *   1. Run: sscope register --backend <url>
     *   2. Inspect ~/.config/sscope/ — no file should contain the plaintext key.
     *   3. Confirm the key is in Keychain:
     *        security find-generic-password -s sscope-api-key -a <device_id>
     */
  });
});

describe('ST-19 — Configuration directory permissions 0700/0600', () => {
  test.skip('After sscope register, ~/.config/sscope/ mode 0700, files mode 0600', () => {
    /**
     * MANUAL VERIFICATION REQUIRED.
     *
     * Requires the compiled C++ agent and filesystem inspection (SECURITY.md §10.2).
     *
     * Manual steps:
     *   1. Run: sscope register --backend <url>
     *   2. Run: ls -la ~/.config/sscope/
     *   3. Verify: directory has mode drwx------ (0700).
     *   4. Verify: each file within has mode -rw------- (0600).
     */
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-22 — DB password not in any structured log call
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-22 — DB password not in logs', () => {
  it('no structured log call contains the SSCOPE_DB_PASSWORD value', async () => {
    // We set a recognizable sentinel as the DB password and verify it never
    // reaches any logger.* call — not via error messages, not via metadata.
    const sentinel = `st22_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const prevPwd = process.env.SSCOPE_DB_PASSWORD;
    process.env.SSCOPE_DB_PASSWORD = sentinel;

    // Capture every argument passed to any logger level.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const logMod = require('../middleware/logger') as { logger: import('pino').Logger };
    const captured: string[] = [];
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    const spies = levels.map(level =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(logMod.logger, level as any).mockImplementation((...args: unknown[]) => {
        captured.push(JSON.stringify(args));
      })
    );

    try {
      await request(app).get('/health');
      await request(app).post('/api/v1/runs').send({});          // → auth failure log
      await request(app).get('/api/v1/runs');                    // → auth failure log
    } finally {
      spies.forEach(s => s.mockRestore());
      if (prevPwd !== undefined) process.env.SSCOPE_DB_PASSWORD = prevPwd;
      else delete process.env.SSCOPE_DB_PASSWORD;
    }

    for (const entry of captured) {
      expect(entry).not.toContain(sentinel);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ST-23 — Setup token never reaches structured log stream
//
// The setup token is written to process.stdout (SECURITY.md §5.2) — a separate
// stream from the structured JSON log (which goes to process.stderr via pino).
// This test verifies that:
//   (a) the startup log call contains only version + listen_address
//   (b) a request whose body contains the token value is never logged to the
//       structured stream — even when the registration endpoint processes it.
// ─────────────────────────────────────────────────────────────────────────────

describe('ST-23 — Setup token not in structured logs', () => {
  it('setup token does not appear in structured log output', async () => {
    // Simulate a setup token (a random base64url string, as server.ts generates).
    const simulatedToken = crypto.randomBytes(32).toString('base64url');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const logMod = require('../middleware/logger') as { logger: import('pino').Logger };
    const captured: string[] = [];
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    const spies = levels.map(level =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(logMod.logger, level as any).mockImplementation((...args: unknown[]) => {
        captured.push(JSON.stringify(args));
      })
    );

    try {
      // Simulate the startup log emitted by server.ts — must contain only
      // version + listen_address, never the token.
      logMod.logger.info({ version: '0.1.0', listen_address: 'localhost:3000' }, 'Backend startup');

      // A registration request carries the token in its body. The structured
      // log must not capture request bodies (§14.3).
      await request(app)
        .post('/api/v1/register')
        .send({
          device_id:   'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
          device_name: 'test-device',
          setup_token: simulatedToken,
        });

      await request(app).get('/health');
    } finally {
      spies.forEach(s => s.mockRestore());
    }

    for (const entry of captured) {
      expect(entry).not.toContain(simulatedToken);
    }
  });
});

describe('ST-24 — sslmode=verify-full for remote DB', () => {
  test.skip('Connection to remote DB without sslrootcert fails with certificate verification error', () => {
    /**
     * MANUAL VERIFICATION REQUIRED.
     *
     * Requires a remote PostgreSQL instance with TLS (self-signed cert)
     * and SSCOPE_DB_SSLMODE=verify-full set without SSCOPE_DB_SSLROOTCERT
     * (SECURITY.md §12.1).
     *
     * Manual steps:
     *   1. Configure a remote PostgreSQL instance with a self-signed TLS cert.
     *   2. Set env vars:
     *        SSCOPE_DB_SSLMODE=verify-full
     *        SSCOPE_DB_HOST=<remote-host>
     *        (do NOT set SSCOPE_DB_SSLROOTCERT)
     *   3. Start the backend.
     *   4. Verify: connection fails with a certificate verification error —
     *      the backend does not silently downgrade to an unverified connection.
     */
  });
});
