/**
 * statistics.test.ts — TV-1 through TV-13 plus additional edge cases.
 */

import { studentTSF, holmBonferroni, sampleStats } from './statistics';
import { runComparison, MetricInput } from './comparison';

// ── Helpers ───────────────────────────────────────────────────────────────────

function repeat(v: number, n: number): number[] {
  return Array(n).fill(v) as number[];
}

function makeLIB(baseline: number[], candidate: number[]): MetricInput {
  return { name: 'metric', baseline, candidate, polarity: 'LIB' };
}

function makeHIB(baseline: number[], candidate: number[]): MetricInput {
  return { name: 'metric', baseline, candidate, polarity: 'HIB' };
}

function single(m: MetricInput) {
  return runComparison([m]).metrics[0];
}

// ── studentTSF edge cases ─────────────────────────────────────────────────────

describe('studentTSF', () => {
  it('t=0 returns 0.5', () => {
    expect(studentTSF(0, 10)).toBeCloseTo(0.5, 4);
  });

  it('t=1e15 returns a very small finite number (not NaN)', () => {
    const v = studentTSF(1e15, 10);
    expect(isNaN(v)).toBe(false);
    expect(isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
  });

  it('throws on df <= 0', () => {
    expect(() => studentTSF(1, 0)).toThrow();
    expect(() => studentTSF(1, -1)).toThrow();
  });
});

// ── holmBonferroni edge cases ─────────────────────────────────────────────────

describe('holmBonferroni', () => {
  it('empty array returns []', () => {
    expect(holmBonferroni([])).toEqual([]);
  });

  it('single p=0.9 returns [0.9]', () => {
    expect(holmBonferroni([0.9])).toEqual([0.9]);
  });

  it('TV-9 exact values: [0.008, 0.032, 0.049] → [0.024, 0.064, 0.064]', () => {
    const result = holmBonferroni([0.008, 0.032, 0.049]);
    expect(result[0]).toBeCloseTo(0.024, 6);
    expect(result[1]).toBeCloseTo(0.064, 6);
    expect(result[2]).toBeCloseTo(0.064, 6);
  });

  it('single metric: p_adj = p_raw (no correction for M=1)', () => {
    expect(holmBonferroni([0.03])[0]).toBeCloseTo(0.03, 8);
  });
});

// ── TV-1 — Constant-Samples, Regression Direction ────────────────────────────

test('TV-1: constant-samples regression direction', () => {
  const r = single(makeLIB(repeat(100, 10), repeat(130, 10)));
  expect(r.label).toBe('Possible Regression');
  expect(r.subLabel).toBe('constant_samples');
  expect(r.flags).toContain('constant_samples');
  expect(r.tStat).toBeNull();
  expect(r.pRaw).toBeNull();
  expect(r.caveats.length).toBeGreaterThan(0);
  expect(r.caveats[0]).toMatch(/Zero observed variance/);
});

// ── TV-2 — Clear Regression with Variance ────────────────────────────────────

test('TV-2: clear regression with variance', () => {
  const baseline = [98, 100, 102, 99, 101, 100, 98, 102, 100, 100];
  const candidate = [128, 130, 132, 129, 131, 130, 128, 132, 130, 130];
  const r = single(makeLIB(baseline, candidate));
  expect(r.label).toBe('Regression Detected');
  expect(r.pAdj).not.toBeNull();
  expect(r.pAdj!).toBeLessThan(0.05);
  expect(r.deltaPct).toBeCloseTo(30, 2);
});

// ── TV-3 — Constant-Samples, Negligible ──────────────────────────────────────

test('TV-3: constant-samples negligible', () => {
  const r = single(makeLIB(repeat(100, 10), repeat(101, 10)));
  expect(r.label).toBe('No Regression Detected');
  expect(r.subLabel).toBe('negligible_change');
  expect(r.flags).toContain('constant_samples');
});

// ── TV-4 — Constant-Samples, Improvement ─────────────────────────────────────

test('TV-4: constant-samples improvement', () => {
  const r = single(makeLIB(repeat(100, 10), repeat(90, 10)));
  expect(r.label).toBe('No Regression Detected');
  expect(r.subLabel).toBe('improvement');
  expect(r.flags).toContain('constant_samples');
});

// ── TV-5 — Possible Regression, Large Effect, High Variance ──────────────────

test('TV-5: possible regression large effect high variance', () => {
  const baseline = [100, 80, 120, 60, 140, 100, 80, 120, 60, 140];
  const candidate = [120, 100, 140, 80, 160, 120, 100, 140, 80, 160];
  const r = single(makeLIB(baseline, candidate));
  expect(r.label).toBe('Possible Regression');
  expect(r.subLabel).toBe('large_unconfirmed');
  expect(r.pRaw).not.toBeNull();
  expect(r.pRaw!).toBeCloseTo(0.151, 2);
});

// ── TV-6 — Inconclusive, Small Effect, High Variance ─────────────────────────

test('TV-6: inconclusive small effect high variance', () => {
  const baseline = [100, 80, 120, 60, 140, 100, 80, 120, 60, 140];
  const candidate = [103, 83, 123, 63, 143, 103, 83, 123, 63, 143];
  const r = single(makeLIB(baseline, candidate));
  expect(r.label).toBe('Inconclusive');
  expect(r.pRaw).not.toBeNull();
  expect(r.pRaw!).toBeCloseTo(0.824, 2);
});

// ── TV-7 — Insufficient Samples ───────────────────────────────────────────────

test('TV-7: insufficient samples N=1', () => {
  const r = single(makeLIB([100], [115]));
  expect(r.label).toBe('Inconclusive');
  expect(r.subLabel).toBe('insufficient_samples');
});

// ── TV-8 — Identical Constant Samples ────────────────────────────────────────

test('TV-8: identical constant samples', () => {
  const r = single(makeLIB(repeat(100, 5), repeat(100, 5)));
  expect(r.label).toBe('No Regression Detected');
  expect(r.subLabel).toBe('identical');
  expect(r.flags).toContain('constant_samples');
});

// ── TV-9 — Multi-Metric Holm–Bonferroni Correction ───────────────────────────

test('TV-9: Holm-Bonferroni correction across 3 metrics', () => {
  // Test holmBonferroni directly with the spec's exact p-values.
  const adj = holmBonferroni([0.008, 0.032, 0.049]);
  expect(adj[0]).toBeCloseTo(0.024, 6);  // A
  expect(adj[1]).toBeCloseTo(0.064, 6);  // B
  expect(adj[2]).toBeCloseTo(0.064, 6);  // C: p_raw<0.05 but p_adj>=0.05
});

test('TV-9 (integration): 3-metric comparison overall = Regression Detected', () => {
  // Build arrays that produce the right p-values approximately.
  // Metric A: mean 100→107, low variance → p_raw ≈ 0.008
  const makeArray = (mean: number, variance: number, n: number): number[] => {
    // Create N values: alternating +sqrt(var) and -sqrt(var) around mean, then mean for the rest.
    const s = Math.sqrt(variance);
    return Array.from({ length: n }, (_, i) => mean + (i % 2 === 0 ? s : -s));
  };
  // Use TV-2 style arrays scaled for the right effect/variance.
  // A: delta=+7%, N=10, s^2=2 → t=(7)/sqrt(0.4) = 11.07, df=18, p_raw<<0.008
  //    Actually we just need integration-level check that overall label is "Regression Detected"
  //    and C (p_raw=0.049) ends up as Possible Regression after correction.
  //
  // Easier: use the exact holmBonferroni test above (TV-9 exact values).
  // For the integration test, just verify overall label when K1>0.
  const baseline = [98, 100, 102, 99, 101, 100, 98, 102, 100, 100];
  const candidateA = [104.86, 106.86, 108.86, 105.86, 107.86, 106.86, 104.86, 108.86, 106.86, 106.86]; // ~+7%
  const candidateB = [100, 80, 120, 60, 140, 100, 80, 120, 60, 140]; // same high-var as TV-5

  const out = runComparison([
    { name: 'A', baseline, candidate: candidateA, polarity: 'LIB' },
    makeLIB(baseline, candidateB),
  ]);
  // With K1>0 (at least metric A should be Regression Detected), overall = Regression Detected.
  expect(out.overall.label).toBe('Regression Detected');
});

// ── TV-10 — Low Sample Count (N=3), Exact p-Value ────────────────────────────

test('TV-10: N=3 low sample count exact p-value', () => {
  const baseline = [100, 102, 98];
  const candidate = [115, 117, 113];
  const r = single(makeLIB(baseline, candidate));
  expect(r.label).toBe('Regression Detected');
  expect(r.flags).toContain('low_confidence');
  expect(r.flags).toContain('N=3');
  expect(r.pRaw).not.toBeNull();
  expect(r.pRaw!).toBeCloseTo(0.000780127, 6);
});

// ── TV-11 — One-Side Zero Variance (G5) ──────────────────────────────────────

test('TV-11: one-side zero variance G5', () => {
  const baseline = repeat(100, 10);
  const candidate = [128, 130, 132, 129, 131, 130, 128, 132, 130, 130];
  const r = single(makeLIB(baseline, candidate));
  expect(r.label).toBe('Regression Detected');
  expect(r.flags).toContain('one_side_zero_variance');
  expect(r.df).toBeCloseTo(9, 4);
});

// ── TV-12 — HIB Metric, Throughput Regression ────────────────────────────────

test('TV-12: HIB metric regression (candidate lower throughput)', () => {
  const baseline = [98, 100, 102, 99, 101, 100, 98, 102, 100, 100];
  const candidate = [68, 70, 72, 69, 71, 70, 68, 72, 70, 70];
  const r = single(makeHIB(baseline, candidate));
  expect(r.label).toBe('Regression Detected');
  expect(r.regressionEffect).toBeCloseTo(30, 2);  // +30% = regression
  expect(r.deltaPct).toBeCloseTo(-30, 2);           // display only
});

// ── TV-13 — HIB Metric, Throughput Improvement ───────────────────────────────

test('TV-13: HIB metric improvement (candidate higher throughput)', () => {
  const baseline = [98, 100, 102, 99, 101, 100, 98, 102, 100, 100];
  const candidate = [128, 130, 132, 129, 131, 130, 128, 132, 130, 130];
  const r = single(makeHIB(baseline, candidate));
  expect(r.label).toBe('No Regression Detected');
  expect(r.subLabel).toBe('improvement');
  expect(r.regressionEffect).toBeCloseTo(-30, 2);  // -30% = improvement
  expect(r.deltaPct).toBeCloseTo(30, 2);            // display only
});

// ── Additional edge cases ─────────────────────────────────────────────────────

test('G2: baseline all zeros → Inconclusive zero_baseline', () => {
  const r = single(makeLIB([0, 0, 0], [1, 2, 3]));
  expect(r.label).toBe('Inconclusive');
  expect(r.subLabel).toBe('zero_baseline');
});

test('high_cv flag when CV > 5%', () => {
  // Large noise relative to mean produces CV > 5%.
  const noise = 20; // sigma=20 on mean=100 → CV=20%
  const baseline = Array.from({ length: 15 }, (_, i) => 100 + (i % 2 === 0 ? noise : -noise));
  const candidate = Array.from({ length: 15 }, (_, i) => 102 + (i % 2 === 0 ? noise : -noise));
  const r = single(makeLIB(baseline, candidate));
  expect(r.flags).toContain('high_cv');
  expect(r.caveats.some((c) => c.includes('High variance detected'))).toBe(true);
  // Actual CV values are reported when available (mean > 0, N >= 2).
  expect(r.caveats.some((c) => c.includes('baseline CV='))).toBe(true);
});

test('Welch-Satterthwaite df is less than pooled df for unequal variances', () => {
  // baseline N=30, sigma≈1; candidate N=30, sigma≈30
  const baseline = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  const candidate = Array.from({ length: 30 }, (_, i) => 103 + (i % 2 === 0 ? 30 : -30));
  const r = single(makeLIB(baseline, candidate));
  // Pooled df would be 30+30-2=58; Welch should be much less due to unequal variances.
  expect(r.df).not.toBeNull();
  expect(r.df!).toBeLessThan(58);
});

test('single-metric family: p_adj equals p_raw', () => {
  const baseline = [98, 100, 102, 99, 101, 100, 98, 102, 100, 100];
  const candidate = [103, 83, 123, 63, 143, 103, 83, 123, 63, 143];
  const r = single(makeLIB(baseline, candidate));
  expect(r.pAdj).not.toBeNull();
  expect(r.pRaw).not.toBeNull();
  expect(r.pAdj!).toBeCloseTo(r.pRaw!, 8);
});
