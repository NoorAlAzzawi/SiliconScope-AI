/**
 * runs.test.ts — Integration tests for POST/GET /api/v1/runs.
 *
 * The DB pool is fully mocked. bcrypt.compare is stubbed to avoid slow
 * hashing in tests. The json-canonicalize module is mocked via
 * src/__mocks__/json-canonicalize.ts so no npm install is required.
 */
import request from 'supertest';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import app from '../app';
import { setPool } from '../middleware/auth';
import { buildCanonicalObject } from './runs';

// ── Mock bcrypt ───────────────────────────────────────────────────────────────
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
}));
import bcrypt from 'bcryptjs';
const mockBcryptCompare = bcrypt.compare as unknown as jest.Mock;

// ── Mock DB pool ──────────────────────────────────────────────────────────────
// Sessions stored in memory for idempotency tests.
const sessionStore: Record<string, { content_fingerprint: string; device_id: string }> = {};
const casesStore: Array<Record<string, unknown>> = [];

const mockPool = {
  query: jest.fn(),
  ...EventEmitter.prototype,
  on: jest.fn(),
} as unknown as import('pg').Pool;

// ── canonicalize helper (mirrors src/__mocks__/json-canonicalize.ts) ─────────
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + (value as unknown[]).map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function computeFingerprint(body: Record<string, unknown>): string {
  const cases = (body.benchmarks as Array<Record<string, unknown>>)
    .map((c) => ({
      canonical_name: c.canonical_name,
      data_type: c.data_type,
      measurements: c.measurements,
      project_name: c.project_name,
    }))
    .sort((a, b) => {
      const keyA = `${a.project_name as string}\x00${a.canonical_name as string}`;
      const keyB = `${b.project_name as string}\x00${b.canonical_name as string}`;
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });

  const obj = {
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
  return crypto.createHash('sha256').update(canonicalize(obj), 'utf8').digest('hex');
}

// ── Test fixtures ─────────────────────────────────────────────────────────────
const DEVICE_ID = 'dddddddd-dddd-4ddd-addd-dddddddddddd';
const DEVICE_HASH = '$2b$12$FAKE_HASH'; // never used; bcrypt.compare is stubbed

const VALID_CASE = {
  canonical_name: 'BM_sort',
  project_name: 'default',
  data_type: 'raw_samples_available' as const,
  measurements: { raw_rows: [], aggregate_rows: [] },
};

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    session_id:          '550e8400-e29b-41d4-a716-446655440001',
    run_name:            'test_run',
    os_name:             'macOS',
    os_version:          '14.0',
    cpu_name:            'Apple M2',
    isa:                 'arm64',
    build_type:          'Release',
    source:              'synthetic',
    import_timestamp:    '2026-11-03T00:00:00Z',
    benchmarks:          [VALID_CASE],
    ...overrides,
  };
  // Always (re)compute the fingerprint from whatever is in base,
  // unless the caller explicitly provides one.
  if (!('submitted_fingerprint' in overrides)) {
    base.submitted_fingerprint = computeFingerprint(base);
  }
  return base;
}

// ── beforeEach: reset mocks ───────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(sessionStore).forEach((k) => delete sessionStore[k]);
  casesStore.length = 0;

  // Default: API key matches DEVICE_ID.
  mockBcryptCompare.mockImplementation(async (_plain, _hash) => true);

  (mockPool.query as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = sql.trim().toLowerCase();

    // Auth query: fetch devices.
    if (s.startsWith('select device_id')) {
      return { rows: [{ device_id: DEVICE_ID, api_key_hash: DEVICE_HASH }] };
    }
    // Idempotency check.
    if (s.includes('select content_fingerprint from sessions')) {
      const id = (params as string[])[0];
      const row = sessionStore[id];
      return { rows: row ? [row] : [] };
    }
    // Transaction commands.
    if (s === 'begin' || s === 'commit' || s === 'rollback') {
      return { rows: [] };
    }
    // Insert session.
    if (s.startsWith('insert into sessions')) {
      const p = params as Array<unknown>;
      const id = p[0] as string;
      const fp = p[14] as string;
      sessionStore[id] = { content_fingerprint: fp, device_id: DEVICE_ID };
      return { rows: [] };
    }
    // Insert benchmark_cases.
    if (s.startsWith('insert into benchmark_cases')) {
      casesStore.push({ ...(params as unknown as Record<string, unknown>) });
      return { rows: [] };
    }
    // GET /runs list — main data rows query (uses alias s and LEFT JOIN).
    if (s.includes('from sessions') && s.includes('left join benchmark_cases')) {
      return {
        rows: Object.entries(sessionStore).map(([sid, row]) => ({
          session_id: sid,
          content_fingerprint: row.content_fingerprint,
          device_id: row.device_id,
          benchmark_count: 0,
        })),
      };
    }
    // GET /runs list — COUNT(*) query for pagination.
    if (s.startsWith('select count(*)') && s.includes('from sessions')) {
      return { rows: [{ total: String(Object.keys(sessionStore).length) }] };
    }
    // GET /runs/:id — fetch session.
    if (s.includes('from sessions where session_id')) {
      const id = (params as string[])[0];
      const row = sessionStore[id];
      return {
        rows: row ? [{ session_id: id, device_id: row.device_id,
                       content_fingerprint: row.content_fingerprint }] : [],
      };
    }
    // GET /runs/:id — fetch cases.
    if (s.includes('from benchmark_cases')) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  setPool(mockPool);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/runs', () => {
  it('201 on valid new submission', async () => {
    const body = validBody();
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe(body.session_id);
    expect(res.body.content_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('200 on identical retry (same session_id, same fingerprint)', async () => {
    const body = validBody();

    await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(body);

    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(body.session_id);
  });

  it('409 on same session_id with different fingerprint', async () => {
    const body = validBody();

    await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(body);

    // Submit again with a different fingerprint.
    const body2 = { ...body, submitted_fingerprint: 'a'.repeat(64) };
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(body2);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FINGERPRINT_CONFLICT');
  });

  it('422 on fingerprint mismatch (submitted != computed)', async () => {
    const body = validBody({ submitted_fingerprint: 'b'.repeat(64) });
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(body);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FINGERPRINT_MISMATCH');
  });

  it('401 when Authorization header is absent', async () => {
    const body = validBody();
    const res = await request(app)
      .post('/api/v1/runs')
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_AUTH');
  });

  it('403 when a valid dashboard session cookie is present', async () => {
    // Insert a valid session token into the store so requireAgentAuth sees it.
    // We reach into the auth module's createSession to set it up.
    const { createSession } = await import('../middleware/auth');
    createSession('valid-dashboard-token', DEVICE_ID, 3_600_000);

    const body = validBody();
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .set('Cookie', 'sscope_session=valid-dashboard-token')
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('422 on missing required field (run_name)', async () => {
    const body = validBody();
    const { run_name: _omit, ...bodyWithout } = body as Record<string, unknown> & { run_name: unknown };
    bodyWithout.submitted_fingerprint = computeFingerprint({ ...bodyWithout });

    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(bodyWithout);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('422 on invalid source value', async () => {
    const body = validBody({ source: 'manual', submitted_fingerprint: 'c'.repeat(64) });
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(body);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('401 on invalid API key', async () => {
    mockBcryptCompare.mockResolvedValueOnce(false);
    const body = validBody();
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer wrong-key')
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_AUTH');
  });
});

describe('GET /api/v1/runs', () => {
  it('returns empty array when no sessions', async () => {
    const res = await request(app)
      .get('/api/v1/runs')
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total_count).toBe(0);
  });

  it('returns sessions after a successful POST', async () => {
    const body = validBody();
    await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(body);

    const res = await request(app)
      .get('/api/v1/runs')
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total_count).toBe(1);
    expect(res.body.pagination.page).toBe(1);
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/v1/runs');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/runs/:id', () => {
  it('404 for unknown session_id', async () => {
    const res = await request(app)
      .get('/api/v1/runs/550e8400-e29b-41d4-a716-446655440099')
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns session with cases after POST', async () => {
    const body = validBody();
    await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(body);

    const res = await request(app)
      .get(`/api/v1/runs/${body.session_id as string}`)
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(body.session_id);
    expect(Array.isArray(res.body.benchmark_cases)).toBe(true);
  });
});

// ── Helper: override the pool mock for list queries ───────────────────────────

function mockListQuery(dataRows: unknown[], total: number): void {
  (mockPool.query as jest.Mock).mockImplementation(async (sql: string, _params?: unknown[]) => {
    const s = sql.trim().toLowerCase();
    if (s.startsWith('select device_id')) {
      return { rows: [{ device_id: DEVICE_ID, api_key_hash: DEVICE_HASH }] };
    }
    if (s.includes('from sessions') && s.includes('left join benchmark_cases')) {
      return { rows: dataRows };
    }
    if (s.startsWith('select count(*)') && s.includes('from sessions')) {
      return { rows: [{ total: String(total) }] };
    }
    return { rows: [] };
  });
}

// ── FR-D-001: primary_metric field ────────────────────────────────────────────

describe('GET /api/v1/runs — FR-D-001 primary_metric', () => {
  it('primary_metric has expected shape when raw_samples_available cases exist', async () => {
    mockListQuery([{
      session_id: '550e8400-e29b-41d4-a716-446655440010',
      run_name: 'raw_run',
      benchmark_count: 1,
      primary_metric: {
        canonical_name: 'BM_sort',
        project_name: 'default',
        mean_real_time_ns: 1_000_000,
        sample_count: 10,
      },
    }], 1);

    const res = await request(app)
      .get('/api/v1/runs')
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const pm = res.body.data[0].primary_metric;
    expect(pm).not.toBeNull();
    expect(pm.canonical_name).toBe('BM_sort');
    expect(pm.project_name).toBe('default');
    expect(typeof pm.mean_real_time_ns).toBe('number');
    expect(typeof pm.sample_count).toBe('number');
  });

  it('primary_metric is null when session has no benchmark cases', async () => {
    mockListQuery([{
      session_id: '550e8400-e29b-41d4-a716-446655440011',
      run_name: 'empty_run',
      benchmark_count: 0,
      primary_metric: null,
    }], 1);

    const res = await request(app)
      .get('/api/v1/runs')
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body.data[0].primary_metric).toBeNull();
  });

  it('primary_metric is null when session has only aggregate_only cases', async () => {
    mockListQuery([{
      session_id: '550e8400-e29b-41d4-a716-446655440012',
      run_name: 'agg_run',
      benchmark_count: 2,
      primary_metric: null,
    }], 1);

    const res = await request(app)
      .get('/api/v1/runs')
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body.data[0].primary_metric).toBeNull();
  });
});

// ── FR-D-003: free-text search ────────────────────────────────────────────────

describe('GET /api/v1/runs — FR-D-003 free-text search', () => {
  it('q matching run_name returns the session', async () => {
    mockListQuery([{
      session_id: '550e8400-e29b-41d4-a716-446655440020',
      run_name: 'my_benchmark_run',
      benchmark_count: 0,
      primary_metric: null,
    }], 1);

    const res = await request(app)
      .get('/api/v1/runs')
      .query({ q: 'benchmark' })
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].run_name).toBe('my_benchmark_run');
  });

  it('q matching canonical_name returns the session', async () => {
    mockListQuery([{
      session_id: '550e8400-e29b-41d4-a716-446655440021',
      run_name: 'any_run',
      benchmark_count: 1,
      primary_metric: null,
    }], 1);

    const res = await request(app)
      .get('/api/v1/runs')
      .query({ q: 'BM_sort' })
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('returns 400 VALIDATION_ERROR when q exceeds 200 bytes', async () => {
    const res = await request(app)
      .get('/api/v1/runs')
      .query({ q: 'a'.repeat(201) })
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns empty data array when q matches nothing', async () => {
    mockListQuery([], 0);

    const res = await request(app)
      .get('/api/v1/runs')
      .query({ q: 'nonexistent_xyz_12345' })
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total_count).toBe(0);
  });

  it('returns all sessions when q is absent', async () => {
    const body = validBody();
    await request(app)
      .post('/api/v1/runs')
      .set('Authorization', 'Bearer test-key')
      .send(body);

    const res = await request(app)
      .get('/api/v1/runs')
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

// ── Fingerprint regression — composite sort key ───────────────────────────────

describe('buildCanonicalObject — composite sort key regression', () => {
  it('sorts by project_name\\x00canonical_name, not canonical_name alone', () => {
    // With canonical_name-only sort: 'a_bench' < 'z_bench', so bbb comes first.
    // With composite sort: 'aaa\x00z_bench' < 'bbb\x00a_bench', so aaa comes first.
    const benchmarks = [
      {
        project_name: 'bbb',
        canonical_name: 'a_bench',
        data_type: 'no_measurements',
        measurements: { raw_rows: [], aggregate_rows: [] },
      },
      {
        project_name: 'aaa',
        canonical_name: 'z_bench',
        data_type: 'no_measurements',
        measurements: { raw_rows: [], aggregate_rows: [] },
      },
    ];

    const body: Record<string, unknown> = {
      session_id:       '550e8400-e29b-41d4-a716-446655440001',
      run_name:         'sort-regression',
      os_name:          'macOS',
      os_version:       '14.0',
      cpu_name:         'Apple M2',
      isa:              'arm64',
      build_type:       'Release',
      source:           'synthetic',
      import_timestamp: '2026-11-03T00:00:00Z',
      benchmarks,
    };

    const canonical = buildCanonicalObject(body);
    const sortedCases = canonical.cases as Array<{ project_name: string; canonical_name: string }>;

    // aaa\x00z_bench < bbb\x00a_bench → aaa must be first
    expect(sortedCases[0].project_name).toBe('aaa');
    expect(sortedCases[0].canonical_name).toBe('z_bench');
    expect(sortedCases[1].project_name).toBe('bbb');
    expect(sortedCases[1].canonical_name).toBe('a_bench');
  });
});
