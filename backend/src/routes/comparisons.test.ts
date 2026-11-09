import request from 'supertest';
import { EventEmitter } from 'events';
import app from '../app';
import { setPool, createSession } from '../middleware/auth';

// ── Mock bcrypt ───────────────────────────────────────────────────────────────
jest.mock('bcryptjs', () => ({ compare: jest.fn() }));
import bcrypt from 'bcryptjs';
const mockBcryptCompare = bcrypt.compare as unknown as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const DEVICE_HASH = '$2b$12$FAKE_HASH';

const SESSION_A = '11111111-1111-4111-a111-111111111111';
const SESSION_B = '22222222-2222-4222-a222-222222222222';

const COMPARISON_ID = 'cccccccc-cccc-4ccc-accc-cccccccccccc';

// Two rows with non-zero variance: mean_b=100, mean_c=200 → 100% delta → Regression Detected.
// Using [98,102] and [198,202] so variance≠0 (standard path, not G4).
const MEASUREMENT_A = {
  raw_rows: [{ real_time_ns: 98 }, { real_time_ns: 102 }],
  aggregate_rows: [],
};
const MEASUREMENT_B = {
  raw_rows: [{ real_time_ns: 198 }, { real_time_ns: 202 }],
  aggregate_rows: [],
};

// ── In-memory stores ──────────────────────────────────────────────────────────
interface SessionRow {
  device_id: string;
  isa?: string;
  os_name?: string;
  os_version?: string;
  build_type?: string;
  build_config?: string | null;
  source?: string;
}
const sessionsStore: Record<string, SessionRow> = {};
const casesStore: Record<
  string,
  Array<{ project_name: string; canonical_name: string; data_type: string; measurements: string }>
> = {};
const comparisonsStore: Record<
  string,
  { comparison_id: string; session_a_id: string; session_b_id: string; result: unknown; computed_at?: string }
> = {};

const mockPool = {
  query: jest.fn(),
  ...EventEmitter.prototype,
  on: jest.fn(),
} as unknown as import('pg').Pool;

// ── beforeEach ────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();

  Object.keys(sessionsStore).forEach((k) => delete sessionsStore[k]);
  Object.keys(casesStore).forEach((k) => delete casesStore[k]);
  Object.keys(comparisonsStore).forEach((k) => delete comparisonsStore[k]);

  mockBcryptCompare.mockImplementation(async () => true);

  (mockPool.query as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = sql.trim().replace(/\s+/g, ' ').toLowerCase();

    // Auth: fetch devices.
    if (s.startsWith('select device_id, api_key_hash from devices')) {
      return { rows: [{ device_id: DEVICE_A, api_key_hash: DEVICE_HASH }] };
    }

    // Idempotency check: existing comparison.
    if (s.includes('from comparisons where session_a_id')) {
      const aId = (params as string[])[0];
      const bId = (params as string[])[1];
      const key = `${aId}:${bId}`;
      const existing = comparisonsStore[key];
      return { rows: existing ? [existing] : [] };
    }

    // Fetch session by ID.
    if (s.includes('from sessions where session_id')) {
      const id = (params as string[])[0];
      const row = sessionsStore[id];
      if (!row) return { rows: [] };
      return {
        rows: [{
          session_id: id,
          device_id: row.device_id,
          isa: row.isa ?? null,
          os_name: row.os_name ?? null,
          os_version: row.os_version ?? null,
          build_type: row.build_type ?? null,
          build_config: row.build_config ?? null,
          source: row.source ?? 'synthetic',
        }],
      };
    }

    // Fetch benchmark cases.
    if (s.includes('from benchmark_cases where session_id')) {
      const id = (params as string[])[0];
      return { rows: casesStore[id] ?? [] };
    }

    // Insert comparison.
    if (s.startsWith('insert into comparisons')) {
      const p = params as [string, string, string, string];
      const [cId, aId, bId, resultJson] = p;
      const key = `${aId}:${bId}`;
      const result = JSON.parse(resultJson) as unknown;
      comparisonsStore[key] = {
        comparison_id: cId,
        session_a_id: aId,
        session_b_id: bId,
        result,
        computed_at: new Date().toISOString(),
      };
      return { rows: [] };
    }

    // Fetch comparison by ID.
    if (s.includes('from comparisons where comparison_id')) {
      const id = (params as string[])[0];
      const row = Object.values(comparisonsStore).find((r) => r.comparison_id === id);
      return { rows: row ? [row] : [] };
    }

    return { rows: [] };
  });

  setPool(mockPool);

  // Seed sessions with ISA/OS/build metadata so blocking checks pass.
  const baseSession: SessionRow = {
    device_id: DEVICE_A,
    isa: 'arm64',
    os_name: 'macOS',
    os_version: '14.0.0',
    build_type: 'release',
    build_config: 'release',
    source: 'synthetic',
  };
  sessionsStore[SESSION_A] = { ...baseSession };
  sessionsStore[SESSION_B] = { ...baseSession };

  // Seed benchmark cases with data_type.
  casesStore[SESSION_A] = [
    {
      project_name: 'proj',
      canonical_name: 'BM_sort',
      data_type: 'raw_samples_available',
      measurements: JSON.stringify(MEASUREMENT_A),
    },
  ];
  casesStore[SESSION_B] = [
    {
      project_name: 'proj',
      canonical_name: 'BM_sort',
      data_type: 'raw_samples_available',
      measurements: JSON.stringify(MEASUREMENT_B),
    },
  ];
});

// ── POST /api/v1/comparisons ──────────────────────────────────────────────────
describe('POST /api/v1/comparisons', () => {
  it('201 creates a new comparison with engine result', async () => {
    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(201);
    expect(res.body.session_a_id).toBe(SESSION_A);
    expect(res.body.session_b_id).toBe(SESSION_B);
    expect(res.body.comparison_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.computed_at).toBeDefined();

    expect(res.body.per_metric_results).toBeDefined();
    expect(res.body.overall_summary).toBeDefined();
    expect(res.body.confounding_factors).toBeDefined();
    expect(res.body.rule_based_explanation).toBeDefined();

    // With mean_b=100 and mean_c=200, +100% → Regression Detected (G5 or standard path).
    // N=2 each so low_confidence applies, but Regression Detected expected.
    expect(res.body.per_metric_results[0].canonical_name).toBe('BM_sort');
    expect(res.body.per_metric_results[0].classification).toBe('Regression Detected');
    expect(res.body.overall_summary.label).toBe('Regression Detected');
  });

  it('200 returns existing comparison on idempotent retry', async () => {
    // First request.
    const first = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });
    expect(first.status).toBe(201);
    const firstId = first.body.comparison_id as string;

    // Idempotent retry.
    const second = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });
    expect(second.status).toBe(200);
    expect(second.body.comparison_id).toBe(firstId);
    expect(second.body.computed_at).toBeDefined();
  });

  it('400 on invalid session_a_id', async () => {
    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: 'not-a-uuid', session_b_id: SESSION_B });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 on invalid session_b_id', async () => {
    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 when session_a_id equals session_b_id', async () => {
    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_A });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('404 when session_a does not exist', async () => {
    delete sessionsStore[SESSION_A];

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('404 when session_b does not exist', async () => {
    delete sessionsStore[SESSION_B];

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('403 when session_a belongs to a different device (agent auth)', async () => {
    sessionsStore[SESSION_A] = { ...sessionsStore[SESSION_A], device_id: DEVICE_B };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('403 when session_b belongs to a different device (agent auth)', async () => {
    sessionsStore[SESSION_B] = { ...sessionsStore[SESSION_B], device_id: DEVICE_B };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('201 with dashboard auth skips device ownership check', async () => {
    sessionsStore[SESSION_B] = { ...sessionsStore[SESSION_B], device_id: DEVICE_B };
    createSession('dash-token', DEVICE_A, 3_600_000);

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Cookie', 'sscope_session=dash-token')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(201);
  });

  it('201 with empty overlap (no matching canonical_names)', async () => {
    casesStore[SESSION_B] = [
      {
        project_name: 'proj',
        canonical_name: 'BM_different',
        data_type: 'raw_samples_available',
        measurements: JSON.stringify(MEASUREMENT_B),
      },
    ];

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(201);
    expect(res.body.per_metric_results).toHaveLength(0);
    expect(res.body.overall_summary.label).toBe('Not Evaluated');
  });

  it('401 with no auth', async () => {
    const res = await request(app)
      .post('/api/v1/comparisons')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(401);
  });

  it('422 when ISA is unavailable on session A', async () => {
    sessionsStore[SESSION_A] = { ...sessionsStore[SESSION_A], isa: 'unavailable' };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COMPARISON_INELIGIBLE');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    expect(res.body.error.details[0]).toHaveProperty('field');
  });

  it('422 when ISA is unavailable on session B', async () => {
    sessionsStore[SESSION_B] = { ...sessionsStore[SESSION_B], isa: 'unavailable' };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COMPARISON_INELIGIBLE');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    expect(res.body.error.details[0]).toHaveProperty('field');
  });

  it('422 on ISA mismatch', async () => {
    sessionsStore[SESSION_B] = { ...sessionsStore[SESSION_B], isa: 'x86_64' };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COMPARISON_INELIGIBLE');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    expect(res.body.error.details[0]).toHaveProperty('field', 'isa');
  });

  it('422 on OS family mismatch', async () => {
    sessionsStore[SESSION_B] = { ...sessionsStore[SESSION_B], os_name: 'Linux' };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COMPARISON_INELIGIBLE');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    expect(res.body.error.details[0]).toHaveProperty('field', 'os_name');
  });

  it('422 on Debug vs non-Debug build', async () => {
    sessionsStore[SESSION_B] = { ...sessionsStore[SESSION_B], build_type: 'debug' };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COMPARISON_INELIGIBLE');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    expect(res.body.error.details[0]).toHaveProperty('field', 'build_type');
  });

  it('201 includes confounding flag for OS minor version mismatch', async () => {
    sessionsStore[SESSION_B] = { ...sessionsStore[SESSION_B], os_version: '14.1.0' };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(201);
    const flags = res.body.confounding_factors as Array<{ flag: string; severity: string }>;
    expect(flags.some((f) => f.flag === '(os_version: minor_mismatch)')).toBe(true);
    expect(res.body.mandatory_disclaimer).toBe(
      '**Warning:** One or more confounding factors were detected. Results may not reflect a clean ' +
      'performance comparison. Review confounding details before drawing conclusions. This comparison ' +
      'is not eligible for use as a CI gate without explicit opt-in.'
    );
  });

  it('201 includes confounding flag for build_config unverified when null', async () => {
    sessionsStore[SESSION_A] = { ...sessionsStore[SESSION_A], build_config: null };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(201);
    const flags = res.body.confounding_factors as Array<{ flag: string; severity: string }>;
    expect(flags.some((f) => f.flag === '(build_config: unverified)')).toBe(true);
    expect(res.body.mandatory_disclaimer).not.toBeNull();
  });

  it('201 flat response shape matches API_CONTRACTS.md §4.6', async () => {
    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('comparison_id');
    expect(res.body).toHaveProperty('session_a_id', SESSION_A);
    expect(res.body).toHaveProperty('session_b_id', SESSION_B);
    expect(res.body).toHaveProperty('computed_at');
    expect(res.body).toHaveProperty('confounding_factors');
    expect(res.body).toHaveProperty('mandatory_disclaimer');
    expect(res.body).toHaveProperty('per_metric_results');
    expect(res.body).toHaveProperty('overall_summary');
    expect(res.body).toHaveProperty('rule_based_explanation');
    expect(typeof res.body.rule_based_explanation).toBe('string');
    expect(res.body.mandatory_disclaimer).toBeNull();
    const pmr = res.body.per_metric_results[0];
    expect(pmr).toHaveProperty('project_name', 'proj');
    expect(pmr).toHaveProperty('canonical_name', 'BM_sort');
    expect(pmr).toHaveProperty('polarity', 'LIB');
    expect(pmr).toHaveProperty('classification');
    expect(pmr).toHaveProperty('n_baseline');
    expect(pmr).toHaveProperty('n_candidate');
    expect(typeof pmr.n_baseline).toBe('number');
    expect(typeof pmr.n_candidate).toBe('number');
    expect(typeof pmr.mean_baseline_ns).toBe('number');
    expect(typeof pmr.mean_candidate_ns).toBe('number');
    expect(Array.isArray(pmr.caveats)).toBe(true);
  });

  it('201 per_metric_results includes non-null cv fields and high_cv flag for high-variance fixture', async () => {
    // Replace measurements with high-variance data: [100, 200] for baseline (CV=47%), [150, 250] for candidate
    casesStore[SESSION_A] = [{
      project_name: 'proj', canonical_name: 'BM_sort', data_type: 'raw_samples_available',
      measurements: JSON.stringify({ raw_rows: [{ real_time_ns: 100 }, { real_time_ns: 200 }], aggregate_rows: [] }),
    }];
    casesStore[SESSION_B] = [{
      project_name: 'proj', canonical_name: 'BM_sort', data_type: 'raw_samples_available',
      measurements: JSON.stringify({ raw_rows: [{ real_time_ns: 150 }, { real_time_ns: 250 }], aggregate_rows: [] }),
    }];

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(201);
    const pmr = res.body.per_metric_results[0];
    expect(pmr.cv_baseline_pct).not.toBeNull();
    expect(pmr.cv_candidate_pct).not.toBeNull();
    expect(typeof pmr.cv_baseline_pct).toBe('number');
    expect(typeof pmr.cv_candidate_pct).toBe('number');
    expect(pmr.cv_baseline_pct).toBeGreaterThan(5);
    expect(pmr.flags).toContain('high_cv');
  });

  it('201 build_config unverified uses (none) not "null" string', async () => {
    sessionsStore[SESSION_A] = { ...sessionsStore[SESSION_A], build_config: null };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(201);
    const unverified = (res.body.confounding_factors as Array<{ flag: string; value_a: string }>)
      .find((f) => f.flag === '(build_config: unverified)');
    expect(unverified).toBeDefined();
    expect(unverified!.value_a).toBe('(none)');
    expect(unverified!.value_a).not.toBe('null');
  });

  it('201 includes provenance in explanation when session source is user-supplied import', async () => {
    sessionsStore[SESSION_A] = { ...sessionsStore[SESSION_A], source: 'user-supplied import' };

    const res = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });

    expect(res.status).toBe(201);
    expect(res.body.rule_based_explanation).toContain('Provenance note (baseline)');
    expect(res.body.rule_based_explanation).not.toContain('Provenance note (candidate)');
  });
});

// ── GET /api/v1/comparisons/:id ───────────────────────────────────────────────
describe('GET /api/v1/comparisons/:id', () => {
  it('200 returns existing comparison', async () => {
    const post = await request(app)
      .post('/api/v1/comparisons')
      .set('Authorization', 'Bearer test-key')
      .send({ session_a_id: SESSION_A, session_b_id: SESSION_B });
    expect(post.status).toBe(201);
    const { comparison_id } = post.body as { comparison_id: string };

    const res = await request(app)
      .get(`/api/v1/comparisons/${comparison_id}`)
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body.comparison_id).toBe(comparison_id);
  });

  it('404 for unknown comparison_id', async () => {
    const res = await request(app)
      .get(`/api/v1/comparisons/${COMPARISON_ID}`)
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('401 with no auth', async () => {
    const res = await request(app).get(`/api/v1/comparisons/${COMPARISON_ID}`);
    expect(res.status).toBe(401);
  });
});
