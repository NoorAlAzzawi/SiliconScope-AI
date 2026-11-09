import { generateExplanation, ExplanationContext } from './explanation';
import { ComparisonOutput, MetricResult, OverallSummary } from './comparison';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMetric(overrides: Partial<MetricResult>): MetricResult {
  return {
    name: overrides.name ?? 'test/benchmark',
    label: overrides.label ?? null,
    flags: overrides.flags ?? [],
    subLabel: overrides.subLabel ?? null,
    regressionEffect: overrides.regressionEffect ?? null,
    deltaPct: overrides.deltaPct ?? null,
    tStat: overrides.tStat ?? null,
    df: overrides.df ?? null,
    pRaw: overrides.pRaw ?? null,
    pAdj: overrides.pAdj ?? null,
    n_baseline: overrides.n_baseline ?? 10,
    n_candidate: overrides.n_candidate ?? 10,
    mean_baseline_ns: overrides.mean_baseline_ns ?? null,
    mean_candidate_ns: overrides.mean_candidate_ns ?? null,
    caveats: overrides.caveats ?? [],
    cvBaselinePct: overrides.cvBaselinePct ?? null,
    cvCandidatePct: overrides.cvCandidatePct ?? null,
  };
}

function makeOutput(
  metrics: Partial<MetricResult>[],
  overall: Partial<OverallSummary>,
  confoundingFlags: Array<{ flag: string; severity: string }> = [],
): ComparisonOutput {
  const fullMetrics = metrics.map(makeMetric);
  const k1 = overall.k1 ?? 0;
  const k2 = overall.k2 ?? 0;
  const k3 = overall.k3 ?? 0;
  const k4 = overall.k4 ?? 0;
  const fullOverall: OverallSummary = {
    label: overall.label ?? 'No Regression Detected',
    k1,
    k2,
    k3,
    k4,
    m: overall.m ?? k1 + k2 + k3 + k4,
    ciEligible: overall.ciEligible ?? (overall.ciRefusalReasons?.length === 0 ? true : !(overall.ciRefusalReasons && overall.ciRefusalReasons.length > 0)),
    ciRefusalReasons: overall.ciRefusalReasons ?? [],
  };
  return { metrics: fullMetrics, overall: fullOverall, confoundingFlags };
}

function ctx(
  output: ComparisonOutput,
  aSource = 'synthetic',
  bSource = 'synthetic',
): ExplanationContext {
  return { sessionASource: aSource, sessionBSource: bSource, output };
}

const PROHIBITED = ['likely caused by', 'root cause', 'probably'];

function checkNoProhibited(text: string): void {
  for (const phrase of PROHIBITED) {
    expect(text.toLowerCase()).not.toContain(phrase);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateExplanation', () => {
  it('1. no eligible metrics', () => {
    const output = makeOutput(
      [],
      {
        label: 'Not Evaluated',
        k1: 0, k2: 0, k3: 0, k4: 0, m: 0,
        ciEligible: false,
        ciRefusalReasons: ['No eligible metrics (Not Evaluated).'],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('No eligible metrics were found in common between the two runs.');
    expect(result).not.toContain('This comparison is eligible for CI gate use.');
    checkNoProhibited(result);
  });

  it('2. clear regression — corrected label format (Baseline: N=, mean=)', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_sort',
        label: 'Regression Detected',
        subLabel: null,
        deltaPct: 30,
        regressionEffect: 30,
        n_baseline: 10,
        n_candidate: 10,
        mean_baseline_ns: 1_000_000,
        mean_candidate_ns: 1_300_000,
        pAdj: 0.001,
        flags: [],
      }],
      {
        label: 'Regression Detected',
        k1: 1, k2: 0, k3: 0, k4: 0, m: 1,
        ciEligible: true,
        ciRefusalReasons: [],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('Regression Detected');
    expect(result).toContain('+30%');
    expect(result).toContain('Overall result: Regression Detected');
    // New corrected label: "Baseline: N=10, mean=1.000 ms"
    expect(result).toContain('Baseline: N=10, mean=1.000 ms');
    expect(result).toContain('Candidate: N=10, mean=1.300 ms');
    // Old incorrect label must NOT appear
    expect(result).not.toContain('Baseline mean:');
    expect(result).not.toContain('Candidate mean:');
    checkNoProhibited(result);
  });

  it('3. no regression, improvement subLabel', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_fast',
        label: 'No Regression Detected',
        subLabel: 'improvement',
        deltaPct: -15,
        regressionEffect: -15,
        n_baseline: 10,
        n_candidate: 10,
        flags: [],
      }],
      {
        label: 'No Regression Detected',
        k1: 0, k2: 0, k3: 0, k4: 1, m: 1,
        ciEligible: true,
        ciRefusalReasons: [],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('improvement');
    expect(result).toContain('-15%');
    checkNoProhibited(result);
  });

  it('4. inconclusive result', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_mid',
        label: 'Inconclusive',
        subLabel: null,
        deltaPct: 3,
        regressionEffect: 3,
        n_baseline: 10,
        n_candidate: 10,
        pAdj: 0.4,
        flags: [],
      }],
      {
        label: 'Inconclusive',
        k1: 0, k2: 0, k3: 1, k4: 0, m: 1,
        ciEligible: false,
        ciRefusalReasons: ['No completed statistical comparisons (M_c=0).'],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('Inconclusive');
    checkNoProhibited(result);
  });

  it('5. low-confidence samples flag', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_small',
        label: 'Regression Detected',
        subLabel: null,
        deltaPct: 15,
        regressionEffect: 15,
        n_baseline: 3,
        n_candidate: 3,
        flags: ['low_confidence', 'N=3'],
      }],
      {
        label: 'Regression Detected',
        k1: 1, k2: 0, k3: 0, k4: 0, m: 1,
        ciEligible: false,
        ciRefusalReasons: ['Low sample count detected (N<10). Operator opt-in required.'],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('low confidence due to small sample size (N=3)');
    checkNoProhibited(result);
  });

  it('6. confounding factors', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_sort',
        label: 'No Regression Detected',
        subLabel: 'negligible_change',
        deltaPct: 0.5,
        regressionEffect: 0.5,
        n_baseline: 10,
        n_candidate: 10,
        flags: [],
      }],
      {
        label: 'No Regression Detected',
        k1: 0, k2: 0, k3: 0, k4: 1, m: 1,
        ciEligible: false,
        ciRefusalReasons: ['Confounding factors detected. Operator opt-in required.'],
      },
      [{ flag: '(os_version: major_mismatch)', severity: 'High' }],
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('(os_version: major_mismatch)');
    expect(result).toContain('High severity');
    expect(result).toContain(
      'These differences do not establish that environment caused any observed performance change.',
    );
    checkNoProhibited(result);
  });

  it('7. multiple metrics — Holm-Bonferroni case', () => {
    const output = makeOutput(
      [
        { name: 'proj/A', label: 'Regression Detected', subLabel: null, deltaPct: 7, regressionEffect: 7, n_baseline: 10, n_candidate: 10, flags: [] },
        { name: 'proj/B', label: 'Possible Regression', subLabel: 'large_unconfirmed', deltaPct: 8, regressionEffect: 8, n_baseline: 10, n_candidate: 10, flags: [] },
        { name: 'proj/C', label: 'Possible Regression', subLabel: 'large_unconfirmed', deltaPct: 6, regressionEffect: 6, n_baseline: 10, n_candidate: 10, flags: [] },
      ],
      {
        label: 'Regression Detected',
        k1: 1, k2: 2, k3: 0, k4: 0, m: 3,
        ciEligible: true,
        ciRefusalReasons: [],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('Overall result: Regression Detected');
    expect(result).toContain('proj/A');
    expect(result).toContain('proj/B');
    expect(result).toContain('proj/C');
    expect(result).toContain('Regression Detected: 1');
    expect(result).toContain('Possible Regression: 2');
    checkNoProhibited(result);
  });

  it('8. provenance — one imported (A), one synthetic (B)', () => {
    const output = makeOutput(
      [{ name: 'proj/BM_sort', label: 'No Regression Detected', subLabel: null, deltaPct: 0, regressionEffect: 0, n_baseline: 10, n_candidate: 10, flags: [] }],
      { label: 'No Regression Detected', k1: 0, k2: 0, k3: 0, k4: 1, m: 1, ciEligible: true, ciRefusalReasons: [] },
    );
    const result = generateExplanation(ctx(output, 'user-supplied import', 'synthetic'));

    expect(result).toContain('Provenance note (baseline)');
    expect(result).not.toContain('Provenance note (candidate)');
    checkNoProhibited(result);
  });

  it('9. provenance — both imported', () => {
    const output = makeOutput(
      [{ name: 'proj/BM_sort', label: 'No Regression Detected', subLabel: null, deltaPct: 0, regressionEffect: 0, n_baseline: 10, n_candidate: 10, flags: [] }],
      { label: 'No Regression Detected', k1: 0, k2: 0, k3: 0, k4: 1, m: 1, ciEligible: true, ciRefusalReasons: [] },
    );
    const result = generateExplanation(ctx(output, 'user-supplied import', 'user-supplied import'));

    expect(result).toContain('Provenance note (baseline)');
    expect(result).toContain('Provenance note (candidate)');
    checkNoProhibited(result);
  });

  it('10. provenance — both synthetic (no provenance note)', () => {
    const output = makeOutput(
      [{ name: 'proj/BM_sort', label: 'No Regression Detected', subLabel: null, deltaPct: 0, regressionEffect: 0, n_baseline: 10, n_candidate: 10, flags: [] }],
      { label: 'No Regression Detected', k1: 0, k2: 0, k3: 0, k4: 1, m: 1, ciEligible: true, ciRefusalReasons: [] },
    );
    const result = generateExplanation(ctx(output, 'synthetic', 'synthetic'));

    expect(result).not.toContain('Provenance note');
    checkNoProhibited(result);
  });

  it('11. constant-samples path — caveat text present', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_const',
        label: 'Possible Regression',
        subLabel: 'constant_samples',
        deltaPct: 30,
        regressionEffect: 30,
        tStat: null,
        pRaw: null,
        flags: ['constant_samples'],
      }],
      {
        label: 'Possible Regression',
        k1: 0, k2: 1, k3: 0, k4: 0, m: 1,
        ciEligible: false,
        ciRefusalReasons: ['Constant-samples path result present.'],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('Zero observed variance detected in both samples');
    expect(result).toContain('No statistical test was conducted');
    checkNoProhibited(result);
  });

  it('12. high CV warning includes actual CV values when provided', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_noisy',
        label: 'Regression Detected',
        subLabel: null,
        deltaPct: 10,
        regressionEffect: 10,
        n_baseline: 10,
        n_candidate: 10,
        flags: ['high_cv'],
        cvBaselinePct: 8.5,
        cvCandidatePct: 9.2,
      }],
      {
        label: 'Regression Detected',
        k1: 1, k2: 0, k3: 0, k4: 0, m: 1,
        ciEligible: true,
        ciRefusalReasons: [],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('baseline CV=8.5%');
    expect(result).toContain('candidate CV=9.2%');
    expect(result).toContain('Detection sensitivity is reduced');
    checkNoProhibited(result);
  });

  it('13. one-side zero variance (G5)', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_g5',
        label: 'Regression Detected',
        subLabel: null,
        deltaPct: 30,
        regressionEffect: 30,
        n_baseline: 10,
        n_candidate: 10,
        flags: ['one_side_zero_variance'],
      }],
      {
        label: 'Regression Detected',
        k1: 1, k2: 0, k3: 0, k4: 0, m: 1,
        ciEligible: true,
        ciRefusalReasons: [],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('one sample had zero observed variance');
    checkNoProhibited(result);
  });

  it('14. CI gate eligible', () => {
    const output = makeOutput(
      [{ name: 'proj/BM_clean', label: 'No Regression Detected', subLabel: null, deltaPct: 0.5, regressionEffect: 0.5, n_baseline: 30, n_candidate: 30, flags: [] }],
      {
        label: 'No Regression Detected',
        k1: 0, k2: 0, k3: 0, k4: 1, m: 1,
        ciEligible: true,
        ciRefusalReasons: [],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('CI gate: This comparison is eligible for CI gate use.');
    checkNoProhibited(result);
  });

  it('15. CI gate refused with multiple reasons', () => {
    const output = makeOutput(
      [{ name: 'proj/BM_bad', label: 'Regression Detected', subLabel: null, deltaPct: 15, regressionEffect: 15, n_baseline: 3, n_candidate: 3, flags: ['low_confidence', 'N=3'] }],
      {
        label: 'Regression Detected',
        k1: 1, k2: 0, k3: 0, k4: 0, m: 1,
        ciEligible: false,
        ciRefusalReasons: ['Low sample count (N=3).', 'Confounding factors detected.'],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('Low sample count (N=3).');
    expect(result).toContain('Confounding factors detected.');
    expect(result).not.toContain('CI gate: This comparison is eligible for CI gate use.');
    checkNoProhibited(result);
  });

  it('16. determinism — same inputs produce identical output', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_det',
        label: 'Regression Detected',
        subLabel: null,
        deltaPct: 25,
        regressionEffect: 25,
        n_baseline: 10,
        n_candidate: 10,
        flags: ['high_cv'],
      }],
      { label: 'Regression Detected', k1: 1, k2: 0, k3: 0, k4: 0, m: 1, ciEligible: false, ciRefusalReasons: ['Confounding factors detected.'] },
      [{ flag: '(os_version: minor_mismatch)', severity: 'Low' }],
    );
    const ctxVal = ctx(output, 'user-supplied import', 'synthetic');

    const result1 = generateExplanation(ctxVal);
    const result2 = generateExplanation(ctxVal);

    expect(result1).toBe(result2);
  });

  it('17. no prohibited phrases in all test cases', () => {
    // Build a diverse set of contexts and check all outputs.
    const cases: ComparisonOutput[] = [
      makeOutput([], { label: 'Not Evaluated', k1: 0, k2: 0, k3: 0, k4: 0, m: 0, ciEligible: false, ciRefusalReasons: ['No eligible metrics (Not Evaluated).'] }),
      makeOutput(
        [{ name: 'proj/A', label: 'Regression Detected', subLabel: null, deltaPct: 30, regressionEffect: 30, n_baseline: 10, n_candidate: 10, flags: [] }],
        { label: 'Regression Detected', k1: 1, k2: 0, k3: 0, k4: 0, m: 1, ciEligible: true, ciRefusalReasons: [] },
      ),
      makeOutput(
        [{ name: 'proj/B', label: 'Inconclusive', subLabel: null, deltaPct: 3, regressionEffect: 3, n_baseline: 10, n_candidate: 10, flags: ['high_cv'] }],
        { label: 'Inconclusive', k1: 0, k2: 0, k3: 1, k4: 0, m: 1, ciEligible: false, ciRefusalReasons: ['No completed statistical comparisons (M_c=0).'] },
        [{ flag: '(cpu_model: mismatch)', severity: 'Medium' }],
      ),
    ];
    for (const output of cases) {
      const result = generateExplanation(ctx(output, 'user-supplied import', 'synthetic'));
      checkNoProhibited(result);
    }
  });

  it('19. high CV warning falls back to generic text when CV values are null', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_noisy',
        label: 'Regression Detected',
        subLabel: null,
        deltaPct: 10,
        regressionEffect: 10,
        n_baseline: 10,
        n_candidate: 10,
        flags: ['high_cv'],
        cvBaselinePct: null,
        cvCandidatePct: null,
      }],
      {
        label: 'Regression Detected',
        k1: 1, k2: 0, k3: 0, k4: 0, m: 1,
        ciEligible: true,
        ciRefusalReasons: [],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('high coefficient of variation (CV > 5%)');
    expect(result).not.toContain('baseline CV=');
    expect(result).not.toContain('candidate CV=');
    checkNoProhibited(result);
  });

  it('20. high CV warning with only baseline CV (null candidate mean edge case)', () => {
    const output = makeOutput(
      [{
        name: 'proj/BM_noisy',
        label: 'Regression Detected',
        subLabel: null,
        deltaPct: 10,
        regressionEffect: 10,
        n_baseline: 10,
        n_candidate: 10,
        flags: ['high_cv'],
        cvBaselinePct: 12.3,
        cvCandidatePct: null,
      }],
      {
        label: 'Regression Detected',
        k1: 1, k2: 0, k3: 0, k4: 0, m: 1,
        ciEligible: true,
        ciRefusalReasons: [],
      },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('baseline CV=12.3%');
    expect(result).not.toContain('candidate CV=');
    checkNoProhibited(result);
  });

  it('18. many metrics (> 5) — truncated list with count', () => {
    const metrics = Array.from({ length: 7 }, (_, i) => ({
      name: `proj/BM_${i}`,
      label: 'No Regression Detected' as const,
      subLabel: 'negligible_change' as const,
      deltaPct: 0.5,
      regressionEffect: 0.5,
      n_baseline: 10,
      n_candidate: 10,
      flags: [] as string[],
    }));
    const output = makeOutput(
      metrics,
      { label: 'No Regression Detected', k1: 0, k2: 0, k3: 0, k4: 7, m: 7, ciEligible: true, ciRefusalReasons: [] },
    );
    const result = generateExplanation(ctx(output));

    expect(result).toContain('and 2 more');
    expect(result).toContain('Evaluated 7 metric(s)');
    checkNoProhibited(result);
  });
});
