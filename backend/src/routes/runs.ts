import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { canonicalize } from 'json-canonicalize';
import { requireAgentAuth, requireAnyAuth, dbPool } from '../middleware/auth';
import { logger } from '../middleware/logger';

export const runsRouter = Router();

// ── Validation helpers ────────────────────────────────────────────────────────

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO8601_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function errorResponse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

// ── Canonical object F construction ──────────────────────────────────────────

interface CaseInput {
  canonical_name: string;
  data_type: string;
  measurements: unknown;
  project_name: string;
}

export function buildCanonicalObject(body: Record<string, unknown>): Record<string, unknown> {
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

function computeFingerprint(canonicalObj: Record<string, unknown>): string {
  const canonical = canonicalize(canonicalObj);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ── POST /api/v1/runs ─────────────────────────────────────────────────────────

runsRouter.post('/', requireAgentAuth, async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;

  // Step 4: Required fields.
  const required: Array<[string, (v: unknown) => boolean, string]> = [
    ['session_id',          (v) => typeof v === 'string' && UUID_V4_RE.test(v),
                            'session_id must be a UUID v4'],
    ['run_name',            isNonEmptyString, 'run_name must be a non-empty string'],
    ['os_name',             isNonEmptyString, 'os_name must be a non-empty string'],
    ['os_version',          isNonEmptyString, 'os_version must be a non-empty string'],
    ['cpu_name',            isNonEmptyString, 'cpu_name must be a non-empty string'],
    ['isa',                 isNonEmptyString, 'isa must be a non-empty string'],
    ['build_type',          isNonEmptyString, 'build_type must be a non-empty string'],
    ['source',              (v) => v === 'synthetic' || v === 'user-supplied import',
                            'source must be "synthetic" or "user-supplied import"'],
    ['import_timestamp',    (v) => typeof v === 'string' && ISO8601_UTC_RE.test(v),
                            'import_timestamp must be ISO 8601 UTC'],
    ['submitted_fingerprint', (v) => typeof v === 'string' && HEX64_RE.test(v),
                            'submitted_fingerprint must be 64 lowercase hex chars'],
    ['benchmarks',           (v) => Array.isArray(v) && (v as unknown[]).length > 0,
                            'benchmarks must be a non-empty array'],
  ];

  for (const [field, validate, msg] of required) {
    if (!validate(body[field])) {
      // §14.2 Import rejection: field name is a known constant, never a user-supplied value.
      logger.warn({ reason: 'MISSING_REQUIRED_FIELD', field, http_status: 422 }, 'Run submission rejected');
      errorResponse(res, 422, 'MISSING_REQUIRED_FIELD', msg);
      return;
    }
  }

  const sessionId = body.session_id as string;

  // Step 6: Idempotency check — must precede per-case validation (Step 8) per spec.
  let existingRow: { content_fingerprint: string } | undefined;
  try {
    const result = await dbPool.query<{ content_fingerprint: string }>(
      'SELECT content_fingerprint FROM sessions WHERE session_id = $1',
      [sessionId]
    );
    existingRow = result.rows[0];
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Database error during idempotency check.');
    return;
  }

  if (existingRow) {
    if (existingRow.content_fingerprint === (body.submitted_fingerprint as string)) {
      res.status(200).json({
        session_id: sessionId,
        content_fingerprint: existingRow.content_fingerprint,
      });
      return;
    }
    errorResponse(res, 409, 'FINGERPRINT_CONFLICT',
      'session_id already exists with a different content_fingerprint.');
    return;
  }

  // Step 8: Validate each case.
  const cases = body.benchmarks as Array<Record<string, unknown>>;
  for (const c of cases) {
    if (!isNonEmptyString(c.canonical_name)) {
      // §14.2: case_count is a count, never benchmark content or user-supplied value.
      logger.warn({ reason: 'INVALID_CASE', case_count: cases.length, http_status: 422 }, 'Run submission rejected');
      errorResponse(res, 422, 'INVALID_CASE', 'Each case must have a non-empty canonical_name');
      return;
    }
    if (!isNonEmptyString(c.project_name)) {
      logger.warn({ reason: 'INVALID_CASE', case_count: cases.length, http_status: 422 }, 'Run submission rejected');
      errorResponse(res, 422, 'INVALID_CASE', 'Each case must have a non-empty project_name');
      return;
    }
    const validDataTypes = ['raw_samples_available', 'aggregate_only', 'no_measurements'];
    if (!validDataTypes.includes(c.data_type as string)) {
      logger.warn({ reason: 'INVALID_CASE', case_count: cases.length, http_status: 422 }, 'Run submission rejected');
      errorResponse(res, 422, 'INVALID_CASE',
        'Each case data_type must be raw_samples_available, aggregate_only, or no_measurements');
      return;
    }
    if (typeof c.measurements !== 'object' || c.measurements === null) {
      logger.warn({ reason: 'INVALID_CASE', case_count: cases.length, http_status: 422 }, 'Run submission rejected');
      errorResponse(res, 422, 'INVALID_CASE', 'Each case must have a measurements object');
      return;
    }
    const m = c.measurements as Record<string, unknown>;
    if (!Array.isArray(m.raw_rows) || !Array.isArray(m.aggregate_rows)) {
      logger.warn({ reason: 'INVALID_CASE', case_count: cases.length, http_status: 422 }, 'Run submission rejected');
      errorResponse(res, 422, 'INVALID_CASE',
        'measurements must have raw_rows and aggregate_rows arrays');
      return;
    }
  }

  // Step 7: Backend independently recomputes fingerprint.
  const canonicalObj = buildCanonicalObject(body);
  const computedFingerprint = computeFingerprint(canonicalObj);
  if (computedFingerprint !== (body.submitted_fingerprint as string)) {
    logger.warn({ reason: 'FINGERPRINT_MISMATCH', http_status: 422 }, 'Run submission rejected');
    errorResponse(res, 422, 'FINGERPRINT_MISMATCH',
      'Submitted content_fingerprint does not match the server-computed fingerprint.');
    return;
  }

  // Steps 9–10: Insert session and benchmark_cases.
  const deviceId = req.deviceId!;

  try {
    await dbPool.query('BEGIN');

    await dbPool.query(
      `INSERT INTO sessions (
         session_id, device_id, run_name, os_name, os_version, cpu_name, isa,
         build_type, source, source_marker, git_sha, build_config,
         import_timestamp, import_environment, content_fingerprint
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        sessionId,
        deviceId,
        body.run_name,
        body.os_name,
        body.os_version,
        body.cpu_name,
        body.isa,
        body.build_type,
        body.source,
        body.source_marker ?? null,
        body.git_sha       ?? null,
        body.build_config  ?? null,
        body.import_timestamp,
        body.import_environment ? JSON.stringify(body.import_environment) : null,
        computedFingerprint,
      ]
    );

    for (const c of cases) {
      const caseId = uuidv4();
      await dbPool.query(
        `INSERT INTO benchmark_cases
           (case_id, session_id, project_name, canonical_name, data_type, measurements)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          caseId,
          sessionId,
          c.project_name,
          c.canonical_name,
          c.data_type,
          JSON.stringify(c.measurements),
        ]
      );
    }

    await dbPool.query('COMMIT');
  } catch (err) {
    await dbPool.query('ROLLBACK').catch(() => undefined);
    errorResponse(res, 503, 'DB_ERROR', 'Failed to persist benchmark run.');
    return;
  }

  res.status(201).json({
    session_id: sessionId,
    content_fingerprint: computedFingerprint,
  });
});

// ── GET /api/v1/runs ──────────────────────────────────────────────────────────

runsRouter.get('/', requireAnyAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = req.deviceId!;
  const isDashboard = req.isDashboardSession === true;

  const page     = Math.max(1, parseInt((req.query.page     as string) ?? '1',  10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt((req.query.page_size as string) ?? '25', 10) || 25));
  const source   = req.query.source as string | undefined;
  const dateFrom = req.query.date_from as string | undefined;
  const dateTo   = req.query.date_to   as string | undefined;
  const q        = req.query.q as string | undefined;
  const offset   = (page - 1) * pageSize;

  // FR-D-003: validate q byte length
  if (q !== undefined && q !== '') {
    if (Buffer.byteLength(q, 'utf8') > 200) {
      errorResponse(res, 400, 'VALIDATION_ERROR', 'Search query q exceeds 200 bytes.');
      return;
    }
  }

  const conditions: string[] = [];
  const params: unknown[]    = [];
  let idx = 1;

  if (!isDashboard) {
    conditions.push(`s.device_id = $${idx++}`);
    params.push(deviceId);
  }

  if (source === 'synthetic' || source === 'user-supplied import') {
    conditions.push(`s.source = $${idx++}`);
    params.push(source);
  }
  if (dateFrom) { conditions.push(`s.import_timestamp >= $${idx++}`); params.push(dateFrom); }
  if (dateTo)   { conditions.push(`s.import_timestamp <= $${idx++}`); params.push(dateTo + 'T23:59:59Z'); }

  // FR-D-003: free-text search — ILIKE on run_name or any canonical_name
  if (q && q.trim().length > 0) {
    const pattern = `%${q}%`;
    conditions.push(
      `(s.run_name ILIKE $${idx} OR EXISTS ` +
      `(SELECT 1 FROM benchmark_cases bc2 ` +
      `WHERE bc2.session_id = s.session_id ` +
      `AND bc2.canonical_name ILIKE $${idx}))`
    );
    params.push(pattern);
    idx++;
  }

  const where = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';

  try {
    const [rows, count] = await Promise.all([
      // FR-D-001: CTE paginates first, then LEFT JOIN LATERAL computes primary_metric
      dbPool.query(
        `WITH paginated AS (
           SELECT s.session_id, s.run_name, s.source, s.import_timestamp,
                  s.submitted_at, s.os_name, s.os_version, s.cpu_name, s.isa,
                  s.build_type, s.git_sha,
                  COUNT(bc.case_id)::int AS benchmark_count
           FROM sessions s
           LEFT JOIN benchmark_cases bc USING (session_id)
           WHERE ${where}
           GROUP BY s.session_id
           ORDER BY s.import_timestamp DESC
           LIMIT $${idx} OFFSET $${idx + 1}
         )
         SELECT p.*,
                pm.primary_metric
         FROM paginated p
         LEFT JOIN LATERAL (
           SELECT json_build_object(
             'canonical_name',    bc2.canonical_name,
             'project_name',      bc2.project_name,
             'mean_real_time_ns', AVG((elem->>'real_time_ns')::float8),
             'sample_count',      COUNT(*)::int
           ) AS primary_metric
           FROM benchmark_cases bc2
           CROSS JOIN LATERAL jsonb_array_elements(bc2.measurements->'raw_rows') AS elem
           WHERE bc2.session_id = p.session_id
             AND bc2.data_type   = 'raw_samples_available'
           GROUP BY bc2.canonical_name, bc2.project_name
           ORDER BY bc2.canonical_name ASC
           LIMIT 1
         ) pm ON true`,
        [...params, pageSize, offset]
      ),
      dbPool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM sessions s WHERE ${where}`,
        params
      ),
    ]);

    const total      = parseInt(count.rows[0].total, 10);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    res.json({
      data: rows.rows,
      pagination: { page, page_size: pageSize, total_count: total, total_pages: totalPages },
    });
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Failed to retrieve sessions.');
  }
});

// ── GET /api/v1/runs/:id ──────────────────────────────────────────────────────

runsRouter.get('/:id', requireAnyAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = req.deviceId!;
  const sessionId = req.params.id;

  let session: Record<string, unknown> | undefined;
  try {
    const result = await dbPool.query(
      `SELECT session_id, device_id, run_name, os_name, os_version, cpu_name, isa,
              build_type, source, source_marker, git_sha, build_config,
              import_timestamp, import_environment, content_fingerprint, submitted_at
       FROM sessions WHERE session_id = $1`,
      [sessionId]
    );
    session = result.rows[0];
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Failed to retrieve session.');
    return;
  }

  if (!session) {
    errorResponse(res, 404, 'NOT_FOUND', 'Session not found.');
    return;
  }

  if (!req.isDashboardSession && session.device_id !== deviceId) {
    errorResponse(res, 403, 'FORBIDDEN', 'Access denied.');
    return;
  }

  let benchmarkCases: unknown[];
  try {
    const result = await dbPool.query(
      `SELECT case_id, project_name, canonical_name, data_type, measurements
       FROM benchmark_cases WHERE session_id = $1 ORDER BY canonical_name, project_name`,
      [sessionId]
    );
    benchmarkCases = result.rows;
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Failed to retrieve benchmark cases.');
    return;
  }

  const { device_id: _omit, ...sessionPublic } = session as Record<string, unknown> & { device_id: unknown };
  res.json({ ...sessionPublic, benchmark_cases: benchmarkCases });
});
