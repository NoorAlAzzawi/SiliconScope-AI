import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAnyAuth, dbPool } from '../middleware/auth';
import { runComparison, MetricInput } from '../engine/comparison';
import { generateExplanation } from '../engine/explanation';

const MANDATORY_DISCLAIMER =
  '**Warning:** One or more confounding factors were detected. Results may not reflect a clean ' +
  'performance comparison. Review confounding details before drawing conclusions. This comparison ' +
  'is not eligible for use as a CI gate without explicit opt-in.';

export const comparisonsRouter = Router();

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Array<{ field: string; issue: string }>,
): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

function isDebugBuild(t: string | null | undefined): boolean {
  return typeof t === 'string' && t.toLowerCase() === 'debug';
}

// ── POST /api/v1/comparisons ──────────────────────────────────────────────────

comparisonsRouter.post('/', requireAnyAuth, async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const { session_a_id, session_b_id } = body;

  // Validate both IDs are present and are UUID v4 strings.
  if (typeof session_a_id !== 'string' || !UUID_V4_RE.test(session_a_id)) {
    errorResponse(res, 400, 'VALIDATION_ERROR', 'session_a_id must be a UUID v4');
    return;
  }
  if (typeof session_b_id !== 'string' || !UUID_V4_RE.test(session_b_id)) {
    errorResponse(res, 400, 'VALIDATION_ERROR', 'session_b_id must be a UUID v4');
    return;
  }
  if (session_a_id === session_b_id) {
    errorResponse(res, 400, 'VALIDATION_ERROR', 'session_a_id and session_b_id must be different');
    return;
  }

  const callerDeviceId = req.deviceId!;
  const isAgentAuth = !req.sessionId; // sessionId is only set for dashboard sessions

  // Idempotency: return existing comparison if the same pair was already computed.
  let existingComparison: Record<string, unknown> | undefined;
  try {
    const r = await dbPool.query<Record<string, unknown>>(
      `SELECT comparison_id, session_a_id, session_b_id, result, computed_at
       FROM comparisons WHERE session_a_id = $1 AND session_b_id = $2
       LIMIT 1`,
      [session_a_id, session_b_id]
    );
    existingComparison = r.rows[0];
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Database error during idempotency check.');
    return;
  }

  if (existingComparison) {
    res.status(200).json(existingComparison.result);
    return;
  }

  // Fetch both sessions with hardware/build metadata.
  let sessionA: Record<string, unknown> | undefined;
  let sessionB: Record<string, unknown> | undefined;
  try {
    const [rA, rB] = await Promise.all([
      dbPool.query<Record<string, unknown>>(
        `SELECT session_id, device_id, isa, os_name, os_version, cpu_name, build_type, build_config, source
         FROM sessions WHERE session_id = $1`,
        [session_a_id]
      ),
      dbPool.query<Record<string, unknown>>(
        `SELECT session_id, device_id, isa, os_name, os_version, cpu_name, build_type, build_config, source
         FROM sessions WHERE session_id = $1`,
        [session_b_id]
      ),
    ]);
    sessionA = rA.rows[0];
    sessionB = rB.rows[0];
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Database error fetching sessions.');
    return;
  }

  if (!sessionA) {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Session not found.`,
        details: [{ field: 'session_a_id', issue: 'Session does not exist.' }],
      },
    });
    return;
  }
  if (!sessionB) {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Session not found.`,
        details: [{ field: 'session_b_id', issue: 'Session does not exist.' }],
      },
    });
    return;
  }

  // For agent auth: enforce that both sessions belong to the caller's device.
  if (isAgentAuth) {
    if (sessionA.device_id !== callerDeviceId) {
      errorResponse(res, 403, 'FORBIDDEN', 'Session A belongs to a different device.');
      return;
    }
    if (sessionB.device_id !== callerDeviceId) {
      errorResponse(res, 403, 'FORBIDDEN', 'Session B belongs to a different device.');
      return;
    }
  }

  // §7.1 Blocking checks: ISA unavailable, ISA mismatch, OS family mismatch, Debug mix.
  const isaA = sessionA.isa as string | null | undefined;
  const isaB = sessionB.isa as string | null | undefined;
  const osNameA = sessionA.os_name as string | null | undefined;
  const osNameB = sessionB.os_name as string | null | undefined;
  const buildTypeA = sessionA.build_type as string | null | undefined;
  const buildTypeB = sessionB.build_type as string | null | undefined;
  const buildConfigA = sessionA.build_config as string | null | undefined;
  const buildConfigB = sessionB.build_config as string | null | undefined;
  const osVersionA = sessionA.os_version as string | null | undefined;
  const osVersionB = sessionB.os_version as string | null | undefined;
  const sourceA = (sessionA.source as string | null | undefined) ?? 'synthetic';
  const sourceB = (sessionB.source as string | null | undefined) ?? 'synthetic';

  if (isaA === 'unavailable' || isaB === 'unavailable') {
    errorResponse(
      res, 422, 'COMPARISON_INELIGIBLE',
      'Hardware metadata unavailable: ISA is "unavailable" on one or both runs. Cannot verify compatibility.',
      [{ field: 'isa', issue: 'ISA is "unavailable" on one or both runs.' }],
    );
    return;
  }

  if (isaA !== undefined && isaB !== undefined && isaA !== null && isaB !== null && isaA !== isaB) {
    errorResponse(
      res, 422, 'COMPARISON_INELIGIBLE',
      'ISA mismatch: runs used different instruction set architectures and cannot be compared.',
      [{ field: 'isa', issue: `ISA mismatch: "${isaA}" vs "${isaB}".` }],
    );
    return;
  }

  if (osNameA !== undefined && osNameB !== undefined && osNameA !== null && osNameB !== null && osNameA !== osNameB) {
    errorResponse(
      res, 422, 'COMPARISON_INELIGIBLE',
      'OS family mismatch: runs recorded on different operating system families and cannot be compared.',
      [{ field: 'os_name', issue: `OS family mismatch: "${osNameA}" vs "${osNameB}".` }],
    );
    return;
  }

  if (isDebugBuild(buildTypeA) !== isDebugBuild(buildTypeB)) {
    errorResponse(
      res, 422, 'COMPARISON_INELIGIBLE',
      'Debug vs. non-Debug comparison is not permitted. Optimize and rebuild before comparing.',
      [{ field: 'build_type', issue: 'Debug vs non-Debug comparison is not permitted.' }],
    );
    return;
  }

  // §7.2 Confounding flags (MVP set: OS version and build_config).
  const confoundingFlags: Array<{ flag: string; severity: string; value_a: string; value_b: string }> = [];

  // OS version mismatch (same family already confirmed above).
  if (osVersionA && osVersionB && osVersionA !== osVersionB) {
    const majorA = osVersionA.split('.')[0];
    const majorB = osVersionB.split('.')[0];
    if (majorA !== majorB) {
      confoundingFlags.push({ flag: '(os_version: major_mismatch)', severity: 'High', value_a: osVersionA ?? '', value_b: osVersionB ?? '' });
    } else {
      confoundingFlags.push({ flag: '(os_version: minor_mismatch)', severity: 'Low', value_a: osVersionA ?? '', value_b: osVersionB ?? '' });
    }
  }

  // build_config checks.
  const bcA = buildConfigA ?? null;
  const bcB = buildConfigB ?? null;
  if (bcA === null || bcB === null) {
    confoundingFlags.push({ flag: '(build_config: unverified)', severity: 'Medium', value_a: bcA ?? '(none)', value_b: bcB ?? '(none)' });
  } else if (!isDebugBuild(buildTypeA) && !isDebugBuild(buildTypeB) && bcA !== bcB) {
    confoundingFlags.push({ flag: '(build_config: mismatch)', severity: 'Medium', value_a: bcA ?? '', value_b: bcB ?? '' });
  }

  // Fetch benchmark cases for both sessions (include data_type for Tier filtering).
  let casesA: Array<Record<string, unknown>>;
  let casesB: Array<Record<string, unknown>>;
  try {
    const [rA, rB] = await Promise.all([
      dbPool.query<Record<string, unknown>>(
        'SELECT project_name, canonical_name, data_type, measurements FROM benchmark_cases WHERE session_id = $1',
        [session_a_id]
      ),
      dbPool.query<Record<string, unknown>>(
        'SELECT project_name, canonical_name, data_type, measurements FROM benchmark_cases WHERE session_id = $1',
        [session_b_id]
      ),
    ]);
    casesA = rA.rows;
    casesB = rB.rows;
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Database error fetching benchmark cases.');
    return;
  }

  // Build lookup map for session B cases by (project_name, canonical_name).
  const bMap = new Map<string, Record<string, unknown>>();
  for (const c of casesB) {
    bMap.set(`${c.project_name as string}\x00${c.canonical_name as string}`, c);
  }

  // Build MetricInput[] for matched raw_samples_available cases.
  const metricInputs: MetricInput[] = [];
  const metricMeta: Array<{ project_name: string; canonical_name: string }> = [];
  for (const cA of casesA) {
    if (cA.data_type !== 'raw_samples_available') continue;

    const key = `${cA.project_name as string}\x00${cA.canonical_name as string}`;
    const cB = bMap.get(key);
    if (!cB) continue;
    if (cB.data_type !== 'raw_samples_available') continue;

    const mA = typeof cA.measurements === 'string'
      ? JSON.parse(cA.measurements) as Record<string, unknown>
      : cA.measurements as Record<string, unknown>;
    const mB = typeof cB.measurements === 'string'
      ? JSON.parse(cB.measurements) as Record<string, unknown>
      : cB.measurements as Record<string, unknown>;

    const rawRowsA = (mA.raw_rows ?? []) as Array<{ real_time_ns: number }>;
    const rawRowsB = (mB.raw_rows ?? []) as Array<{ real_time_ns: number }>;

    const pName = cA.project_name as string;
    const cName = cA.canonical_name as string;
    metricInputs.push({
      name: `${pName}/${cName}`,
      baseline: rawRowsA.map((r) => r.real_time_ns as number),
      candidate: rawRowsB.map((r) => r.real_time_ns as number),
      polarity: 'LIB',
    });
    metricMeta.push({ project_name: pName, canonical_name: cName });
  }

  const comparisonOutput = runComparison(metricInputs, confoundingFlags);

  // Build per_metric_results (flat API shape per §4.6).
  const perMetricResults = comparisonOutput.metrics.map((m, i) => {
    const meta = metricMeta[i] ?? { project_name: '', canonical_name: m.name };
    return {
      project_name:     meta.project_name,
      canonical_name:   meta.canonical_name,
      metric:           'real_time_ns',
      polarity:         'LIB',
      classification:   m.label ?? m.subLabel ?? 'Inconclusive',
      flags:            m.flags,
      delta_pct:        m.deltaPct,
      regression_effect: m.regressionEffect,
      t_statistic:      m.tStat,
      p_raw:            m.pRaw,
      p_adjusted:       m.pAdj,
      reason_code:      m.subLabel,
      n_baseline:        m.n_baseline,
      n_candidate:       m.n_candidate,
      mean_baseline_ns:  m.mean_baseline_ns,
      mean_candidate_ns: m.mean_candidate_ns,
      cv_baseline_pct:   m.cvBaselinePct,
      cv_candidate_pct:  m.cvCandidatePct,
      caveats:           m.caveats,
    };
  });

  // Build mandatory_disclaimer (verbatim from BENCHMARK_SPEC.md §4.3 when confounding present).
  const mandatoryDisclaimer = confoundingFlags.length > 0 ? MANDATORY_DISCLAIMER : null;

  // Generate rule-based explanation (FR-R-008).
  const ruleBasedExplanation = generateExplanation({
    sessionASource: sourceA,
    sessionBSource: sourceB,
    output: comparisonOutput,
  });

  const comparisonId = uuidv4();
  const computedAt = new Date().toISOString();

  // Build flat response body per API_CONTRACTS.md §4.6.
  const responseBody = {
    comparison_id:        comparisonId,
    session_a_id,
    session_b_id,
    computed_at:          computedAt,
    confounding_factors:  confoundingFlags,
    mandatory_disclaimer: mandatoryDisclaimer,
    per_metric_results:   perMetricResults,
    overall_summary: {
      label: comparisonOutput.overall.label,
      k1:    comparisonOutput.overall.k1,
      k2:    comparisonOutput.overall.k2,
      k3:    comparisonOutput.overall.k3,
      k4:    comparisonOutput.overall.k4,
      m:     comparisonOutput.overall.m,
    },
    rule_based_explanation: ruleBasedExplanation,
  };

  // Persist the comparison (store full flat body as the result).
  try {
    await dbPool.query(
      `INSERT INTO comparisons (comparison_id, session_a_id, session_b_id, result)
       VALUES ($1, $2, $3, $4)`,
      [comparisonId, session_a_id, session_b_id, JSON.stringify(responseBody)]
    );
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Failed to persist comparison.');
    return;
  }

  res.status(201).json(responseBody);
});

// ── GET /api/v1/comparisons/:id ───────────────────────────────────────────────

comparisonsRouter.get('/:id', requireAnyAuth, async (req: Request, res: Response): Promise<void> => {
  const comparisonId = req.params.id;

  let comparison: { result: unknown } | undefined;
  try {
    const r = await dbPool.query<{ result: unknown }>(
      `SELECT result FROM comparisons WHERE comparison_id = $1`,
      [comparisonId]
    );
    comparison = r.rows[0];
  } catch {
    errorResponse(res, 503, 'DB_ERROR', 'Failed to retrieve comparison.');
    return;
  }

  if (!comparison) {
    errorResponse(res, 404, 'NOT_FOUND', 'Comparison not found.');
    return;
  }

  res.json(comparison.result);
});
