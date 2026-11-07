/**
 * api.integration.test.ts — End-to-end integration tests for the SiliconScope AI backend.
 *
 * These tests run against a real PostgreSQL instance. The target database must be
 * a dedicated, disposable test database — never the application or development database.
 * No mocking of DB, bcrypt, or HTTP layers.
 *
 * Prerequisites:
 *   - A dedicated PostgreSQL test database with schema applied (all three migrations).
 *     Recommended: a disposable Docker PostgreSQL container.
 *   - SSCOPE_TEST_DB_URL set to the connection string of that database.
 *     The database name must end in '_test' (e.g. 'sscope_test').
 *   - SSCOPE_TEST_DB_AUTHORIZED=1 set to explicitly confirm this database is
 *     a dedicated, disposable instance safe for destructive operations.
 *
 * Run with:
 *   SSCOPE_TEST_DB_URL=postgres://.../<name>_test \
 *   SSCOPE_TEST_DB_AUTHORIZED=1 \
 *   npm run test:integration
 */

// ── Layer 1 safety: validate configuration before any import ──────────────────
//
// These checks execute before the import statements below. ts-jest compiles
// TypeScript imports to CommonJS require() calls that run sequentially after this
// block. Throwing here aborts the file — no pool is opened, no test runs.

// Guard 1: SSCOPE_TEST_DB_URL must be explicitly set.
const _testDbUrl = process.env.SSCOPE_TEST_DB_URL;
if (!_testDbUrl) {
  throw new Error(
    'SSCOPE_TEST_DB_URL is not set.\n' +
    'Set it to a dedicated isolated test database and run:\n' +
    '  SSCOPE_TEST_DB_URL=postgres://.../<name>_test SSCOPE_TEST_DB_AUTHORIZED=1 npm run test:integration',
  );
}

// Guard 2: database name must end in '_test' (allowlist pattern).
// Rejects 'sscope', 'sscope_dev', 'postgres', and any name that does not
// follow the dedicated-test-database naming convention.
const _testDbName = new URL(_testDbUrl).pathname.replace(/^\//, '');
if (!/^.+_test$/.test(_testDbName)) {
  throw new Error(
    `SSCOPE_TEST_DB_URL points to '${_testDbName}', which is not an authorized test database.\n` +
    "The database name must end in '_test' (e.g. 'sscope_test').\n" +
    'Use a dedicated disposable database — never the application or development database.',
  );
}

// Guard 3: explicit opt-in authorization is required in addition to naming convention.
// A '_test' suffix is a naming signal, not proof of disposability. Setting
// SSCOPE_TEST_DB_AUTHORIZED=1 is the developer's explicit confirmation that
// the target database is a dedicated, disposable instance safe for TRUNCATE.
if (process.env.SSCOPE_TEST_DB_AUTHORIZED !== '1') {
  throw new Error(
    'SSCOPE_TEST_DB_AUTHORIZED is not set to 1.\n' +
    "Set it alongside SSCOPE_TEST_DB_URL to explicitly authorize destructive operations\n" +
    'on a dedicated, disposable test database (preferably a Docker container):\n' +
    '  SSCOPE_TEST_DB_URL=postgres://.../<name>_test SSCOPE_TEST_DB_AUTHORIZED=1 npm run test:integration',
  );
}

// Forward to DATABASE_URL so pool.ts picks it up at module-load time if needed.
// In the integration-test flow, app.ts (not server.ts) is imported, so pool.ts is
// never loaded — but this assignment is kept for correctness and future-proofing.
process.env.DATABASE_URL = _testDbUrl;
process.env.SSCOPE_DISABLE_RATE_LIMIT = 'true';

import request from 'supertest';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { canonicalize } from 'json-canonicalize';

import app from '../../src/app';
import { setPool } from '../../src/middleware/auth';
import { initRegistration } from '../../src/routes/register';

// ── Real test DB pool ─────────────────────────────────────────────────────────

const testPool = new Pool({ connectionString: _testDbUrl });

// ── Shared test state (populated by earlier tests, consumed by later ones) ────

let apiKey: string;
let deviceId: string;
let sessionAId: string;
let sessionBId: string;
let comparisonId: string;

// ── Fingerprint helpers (mirror of runs.ts, not exported there) ───────────────

interface CaseInput {
  canonical_name: string;
  data_type: string;
  measurements: unknown;
  project_name: string;
}

function buildCanonicalObject(body: Record<string, unknown>): Record<string, unknown> {
  const cases = (body.benchmarks as CaseInput[])
    .map((c) => ({
      canonical_name: c.canonical_name,
      data_type: c.data_type,
      measurements: c.measurements,
      project_name: c.project_name,
    }))
    .sort((a, b) => {
      const keyA = `${a.project_name}\x00${a.canonical_name}`;
      const keyB = `${b.project_name}\x00${b.canonical_name}`;
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });

  return {
    build_config:       body.build_config       ?? null,
    build_type:         body.build_type,
    cases,
    cpu_name:           body.cpu_name,
    git_sha:            body.git_sha            ?? null,
    import_environment: body.import_environment ?? null,
    import_timestamp:   body.import_timestamp,
    isa:                body.isa,
    os_name:            body.os_name,
    os_version:         body.os_version,
    run_name:           body.run_name,
    source:             body.source,
    source_marker:      body.source_marker      ?? null,
    v:                  1,
  };
}

function computeFingerprint(body: Record<string, unknown>): string {
  const canonical = canonicalize(buildCanonicalObject(body));
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ── Shared run body factory ───────────────────────────────────────────────────

function makeRunBody(
  sessionId: string,
  realTimeNs: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    session_id:         sessionId,
    run_name:           'Integration test run',
    os_name:            'macOS',
    os_version:         '14.0.0',
    cpu_name:           'Apple M1',
    isa:                'arm64',
    build_type:         'release',
    source:             'synthetic',
    source_marker:      null,
    git_sha:            null,
    build_config:       null,
    import_timestamp:   '2026-11-03T12:00:00Z',
    import_environment: null,
    benchmarks: [
      {
        project_name:   'default',
        canonical_name: 'synthetic.cpu.integer',
        data_type:      'raw_samples_available',
        measurements: {
          raw_rows: [
            {
              real_time_ns:     realTimeNs,
              cpu_time_ns:      null,
              iterations:       1000,
              aggregate_name:   null,
              bytes_per_second: null,
              items_per_second: null,
              unknown_fields:   null,
            },
          ],
          aggregate_rows: [],
        },
      },
    ],
  };

  body.submitted_fingerprint = computeFingerprint(body);
  return body;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Wire all route handlers to the test pool.
  // In this test flow, app.ts (not server.ts) is imported, so pool.ts is never
  // loaded. testPool is the only pool in existence; setPool makes it the pool
  // used by every route handler (runs, comparisons, register, auth).
  setPool(testPool);

  // ── Layer 2 safety: verify identity and TRUNCATE on a single client connection ──
  //
  // A single client is acquired so that SELECT current_database() and TRUNCATE
  // execute on the same physical PostgreSQL connection. This guarantees that the
  // database whose identity was verified is the one being truncated — no pool
  // routing can separate the two operations.

  const client = await testPool.connect();
  try {
    // Guard 1: verify the actual connected database matches SSCOPE_TEST_DB_URL.
    // This is also the connectivity check — if the database is unreachable, this throws.
    const { rows } = await client.query<{ current_database: string }>(
      'SELECT current_database()',
    );
    const actualDb = rows[0].current_database;

    if (actualDb !== _testDbName) {
      throw new Error(
        `SAFETY: connected to '${actualDb}' but SSCOPE_TEST_DB_URL specified '${_testDbName}' — aborting.`,
      );
    }

    // Guard 2: naming allowlist — defense-in-depth against URL aliasing.
    // Re-applies the layer-1 naming rule against the actual connected identity,
    // not just the URL string. Rejects any database whose name does not end in '_test'.
    if (!/^.+_test$/.test(actualDb)) {
      throw new Error(
        `SAFETY: refusing to run destructive integration tests against '${actualDb}'. ` +
        "Database name must end in '_test'.",
      );
    }

    // Both layer-2 guards passed. TRUNCATE on the same client — not a new pool connection.
    await client.query(
      'TRUNCATE TABLE comparisons, benchmark_cases, sessions, devices RESTART IDENTITY CASCADE',
    );
  } catch (err) {
    if ((err as Error).message.startsWith('SAFETY:')) throw err;
    console.error(`Cannot connect to integration-test database '${_testDbName}' — aborting.`);
    throw err;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await testPool.end();
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe('SiliconScope API — integration', () => {

  // ── 1. Health check ─────────────────────────────────────────────────────────

  it('1. GET /health returns 200 { status: ok } with real DB', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  // ── 2. Full registration flow ────────────────────────────────────────────────

  it('2. POST /api/v1/register — 201 returns device_id and api_key', async () => {
    const setupToken = crypto.randomBytes(24).toString('base64url');
    // Use cost 4 for speed in tests; bcrypt.compare reads cost from the hash.
    const tokenHash = await bcrypt.hash(setupToken, 4);
    deviceId = uuidv4();
    initRegistration(tokenHash);

    const res = await request(app)
      .post('/api/v1/register')
      .send({
        device_id:   deviceId,
        device_name: 'integration-test-device',
        setup_token: setupToken,
      });

    expect(res.status).toBe(201);
    expect(res.body.device_id).toBe(deviceId);
    expect(typeof res.body.api_key).toBe('string');
    expect(res.body.api_key.length).toBeGreaterThan(0);

    // Store for subsequent tests.
    apiKey = res.body.api_key as string;
  });

  // ── 3. Token one-time use ────────────────────────────────────────────────────

  it('3. POST /api/v1/register — 409 on second attempt (token consumed)', async () => {
    // State from test 2 is already consumed; reuse same device_id and a new token value.
    const setupToken = crypto.randomBytes(24).toString('base64url');

    const res = await request(app)
      .post('/api/v1/register')
      .send({
        device_id:   deviceId,
        device_name: 'integration-test-device',
        setup_token: setupToken,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SETUP_TOKEN_CONSUMED');
  });

  // ── 4. Submit a run ──────────────────────────────────────────────────────────

  it('4. POST /api/v1/runs — 201 with valid payload and correct fingerprint', async () => {
    sessionAId = uuidv4();
    const body = makeRunBody(sessionAId, 1_000_000);

    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe(sessionAId);
    expect(typeof res.body.content_fingerprint).toBe('string');
    expect(res.body.content_fingerprint).toHaveLength(64);
  });

  // ── 5. Idempotent retry ──────────────────────────────────────────────────────

  it('5. POST /api/v1/runs — 200 idempotent retry returns same session_id', async () => {
    // Resubmit the exact same payload as test 4.
    const body = makeRunBody(sessionAId, 1_000_000);

    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionAId);
  });

  // ── 6. Retrieve run ──────────────────────────────────────────────────────────

  it('6. GET /api/v1/runs/:id — 200 returns correct run record', async () => {
    const res = await request(app)
      .get(`/api/v1/runs/${sessionAId}`)
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionAId);
    expect(res.body.run_name).toBe('Integration test run');
    expect(res.body.os_name).toBe('macOS');
    expect(res.body.cpu_name).toBe('Apple M1');
    expect(res.body.isa).toBe('arm64');
    expect(Array.isArray(res.body.benchmark_cases)).toBe(true);
    expect(res.body.benchmark_cases).toHaveLength(1);
    expect(res.body.benchmark_cases[0].canonical_name).toBe('synthetic.cpu.integer');
  });

  // ── 7. Submit second run (candidate — 5 % slower) ────────────────────────────

  it('7. POST /api/v1/runs — 201 second run (candidate) accepted', async () => {
    sessionBId = uuidv4();
    // 5 % regression: 1_000_000 → 1_050_000 ns.
    const body = makeRunBody(sessionBId, 1_050_000);

    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe(sessionBId);
  });

  // ── 8. Create comparison ─────────────────────────────────────────────────────

  it('8. POST /api/v1/comparisons — 201 with per_metric_results and explanation', async () => {
    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ session_a_id: sessionAId, session_b_id: sessionBId });

    expect(res.status).toBe(201);
    expect(typeof res.body.comparison_id).toBe('string');
    expect(res.body.comparison_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    expect(Array.isArray(res.body.per_metric_results)).toBe(true);
    expect(res.body.per_metric_results.length).toBeGreaterThan(0);

    expect(typeof res.body.overall_summary?.label).toBe('string');

    expect(typeof res.body.rule_based_explanation).toBe('string');
    expect(res.body.rule_based_explanation.length).toBeGreaterThan(0);
    expect(res.body.rule_based_explanation).toContain('Automated comparison summary');

    // J2: cv_baseline_pct and cv_candidate_pct are present in every per_metric_result.
    // The integration test sessions each have N=1 raw sample, so G1 fires and both are null.
    const pmr0 = res.body.per_metric_results[0];
    expect(Object.prototype.hasOwnProperty.call(pmr0, 'cv_baseline_pct')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(pmr0, 'cv_candidate_pct')).toBe(true);
    expect(pmr0.cv_baseline_pct).toBeNull();
    expect(pmr0.cv_candidate_pct).toBeNull();

    // Store for test 9.
    comparisonId = res.body.comparison_id as string;
  });

  // ── 9. Get comparison ────────────────────────────────────────────────────────

  it('9. GET /api/v1/comparisons/:id — 200 matches POST response', async () => {
    const res = await request(app)
      .get(`/api/v1/comparisons/${comparisonId}`)
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.comparison_id).toBe(comparisonId);
    expect(Array.isArray(res.body.per_metric_results)).toBe(true);
    expect(typeof res.body.rule_based_explanation).toBe('string');
    expect(res.body.rule_based_explanation).toContain('Automated comparison summary');
  });

  // ── 10. Comparison blocked — same session ─────────────────────────────────────

  it('10. POST /api/v1/comparisons — 400 VALIDATION_ERROR when session_a_id === session_b_id', async () => {
    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ session_a_id: sessionAId, session_b_id: sessionAId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── 11. Backward compat — GET comparison stored without cv fields ─────────────

  it('11. GET /api/v1/comparisons/:id — 200 for record stored without cv_baseline_pct/cv_candidate_pct', async () => {
    // Insert a comparison whose per_metric_results JSONB lacks the cv fields,
    // simulating a record stored before the J2 implementation.
    const oldId = '00000000-0000-4000-8000-000000000011';
    const oldResult = {
      comparison_id: oldId,
      session_a_id: sessionAId,
      session_b_id: sessionBId,
      computed_at: new Date().toISOString(),
      confounding_factors: [],
      mandatory_disclaimer: null,
      per_metric_results: [
        {
          project_name: 'default',
          canonical_name: 'synthetic.cpu.integer',
          metric: 'real_time_ns',
          polarity: 'LIB',
          classification: 'No Regression Detected',
          flags: [],
          delta_pct: 5.0,
          regression_effect: 5.0,
          t_statistic: null,
          p_raw: null,
          p_adjusted: null,
          reason_code: null,
          n_baseline: 1,
          n_candidate: 1,
          // cv_baseline_pct and cv_candidate_pct intentionally absent (old record)
        },
      ],
      overall_summary: { label: 'No Regression Detected', k1: 0, k2: 0, k3: 0, k4: 1, m: 1 },
      rule_based_explanation: 'Automated comparison summary.',
    };

    await testPool.query(
      `INSERT INTO comparisons (comparison_id, session_a_id, session_b_id, result)
       VALUES ($1, $2, $3, $4)`,
      [oldId, sessionAId, sessionBId, JSON.stringify(oldResult)],
    );

    const res = await request(app)
      .get(`/api/v1/comparisons/${oldId}`)
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.comparison_id).toBe(oldId);
    // cv fields absent from stored JSONB — not present in response
    const pmr0 = res.body.per_metric_results[0];
    expect(pmr0).toBeDefined();
    expect(pmr0.cv_baseline_pct).toBeUndefined();
    expect(pmr0.cv_candidate_pct).toBeUndefined();
    // Other fields present and correct
    expect(pmr0.delta_pct).toBe(5.0);
    expect(pmr0.classification).toBe('No Regression Detected');
  });

});
