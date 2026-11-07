/**
 * comparison.ts — Orchestrates the full comparison per BENCHMARK_SPEC.md §6.
 */

import { studentTSF, holmBonferroni, sampleStats } from './statistics';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Polarity = 'LIB' | 'HIB';

export interface MetricInput {
  name: string;
  baseline: number[];
  candidate: number[];
  polarity: Polarity;
}

export type MetricLabel =
  | 'Regression Detected'
  | 'Possible Regression'
  | 'Inconclusive'
  | 'No Regression Detected';

export interface MetricResult {
  name: string;
  label: MetricLabel | null;
  flags: string[];
  subLabel: string | null;
  regressionEffect: number | null;
  deltaPct: number | null;
  tStat: number | null;
  df: number | null;
  pRaw: number | null;
  pAdj: number | null;
  n_baseline: number;
  n_candidate: number;
  caveats: string[];
  cvBaselinePct: number | null;
  cvCandidatePct: number | null;
}

export interface OverallSummary {
  label: string;
  k1: number;
  k2: number;
  k3: number;
  k4: number;
  m: number;
  ciEligible: boolean;
  ciRefusalReasons: string[];
}

export interface ComparisonOutput {
  metrics: MetricResult[];
  overall: OverallSummary;
  confoundingFlags: Array<{ flag: string; severity: string; value_a?: string; value_b?: string }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PRACTICAL_THRESHOLD = 2.0;
const LARGE_THRESHOLD = 5.0;
const ALPHA = 0.05;

// ── Helpers ───────────────────────────────────────────────────────────────────

function regressionEffect(meanB: number, meanC: number, polarity: Polarity): number {
  if (polarity === 'LIB') {
    return (meanC - meanB) / Math.abs(meanB) * 100;
  }
  return (meanB - meanC) / Math.abs(meanB) * 100;
}

function deltaPct(meanB: number, meanC: number): number {
  return (meanC - meanB) / Math.abs(meanB) * 100;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function runComparison(
  metrics: MetricInput[],
  confoundingFlags: Array<{ flag: string; severity: string; value_a?: string; value_b?: string }> = [],
): ComparisonOutput {
  // Indices of metrics that go through the standard Welch path (need Holm–Bonferroni).
  const standardPathIndices: number[] = [];
  const rawPValues: number[] = [];

  const results: MetricResult[] = metrics.map((m) => {
    const statB = sampleStats(m.baseline);
    const statC = sampleStats(m.candidate);
    const { mean: meanB, variance: varB, n: nB } = statB;
    const { mean: meanC, variance: varC, n: nC } = statC;
    const sigmaB = Math.sqrt(varB);
    const sigmaC = Math.sqrt(varC);

    // CV computed before guard clauses so all early returns carry consistent values.
    // Guard: n >= 2 (sampleStats returns variance:0 for N=1, which would give a
    // spurious CV=0 rather than unknown variance) AND |mean| > 0 (avoid division by zero).
    const cvBaselinePct = (nB >= 2 && Math.abs(meanB) > 0)
      ? (sigmaB / Math.abs(meanB)) * 100
      : null;
    const cvCandidatePct = (nC >= 2 && Math.abs(meanC) > 0)
      ? (sigmaC / Math.abs(meanC)) * 100
      : null;

    const result: MetricResult = {
      name: m.name,
      label: null,
      flags: [],
      subLabel: null,
      regressionEffect: null,
      deltaPct: null,
      tStat: null,
      df: null,
      pRaw: null,
      pAdj: null,
      n_baseline: nB,
      n_candidate: nC,
      caveats: [],
      cvBaselinePct,
      cvCandidatePct,
    };

    // G1: insufficient samples
    if (nB < 2 || nC < 2) {
      result.label = 'Inconclusive';
      result.subLabel = 'insufficient_samples';
      result.flags.push('insufficient_samples');
      return result;
    }

    // G2: zero baseline mean
    if (meanB === 0) {
      result.label = 'Inconclusive';
      result.subLabel = 'zero_baseline';
      result.flags.push('zero_baseline');
      return result;
    }

    const dp = deltaPct(meanB, meanC);
    const re = regressionEffect(meanB, meanC, m.polarity);
    result.deltaPct = dp;
    result.regressionEffect = re;

    // G3: both zero variance, same mean
    if (sigmaB === 0 && sigmaC === 0 && meanB === meanC) {
      result.label = 'No Regression Detected';
      result.subLabel = 'identical';
      result.flags.push('constant_samples');
      return result;
    }

    // G4: both zero variance, different means — Constant-Samples Path
    if (sigmaB === 0 && sigmaC === 0 && meanB !== meanC) {
      result.flags.push('constant_samples');
      if (Math.abs(re) < PRACTICAL_THRESHOLD) {
        result.label = 'No Regression Detected';
        result.subLabel = 'negligible_change';
        result.flags.push('negligible_change');
      } else if (re <= -PRACTICAL_THRESHOLD) {
        result.label = 'No Regression Detected';
        result.subLabel = 'improvement';
        result.flags.push('improvement');
      } else {
        // re >= PRACTICAL_THRESHOLD
        result.label = 'Possible Regression';
        result.subLabel = 'constant_samples';
        result.caveats.push(
          'Zero observed variance detected in both samples. No statistical test was conducted. ' +
          'The measured difference may reflect quantization at the timer resolution floor rather than a true performance change. ' +
          'Collect additional samples with a longer iteration duration to confirm.',
        );
      }
      return result;
    }

    // G5: one side zero variance — standard path with df override
    let dfOverride: number | null = null;
    if ((sigmaB === 0) !== (sigmaC === 0)) {
      result.flags.push('one_side_zero_variance');
      // N_nonzero = sample count of the side with nonzero variance
      const nNonzero = sigmaB !== 0 ? nB : nC;
      dfOverride = nNonzero - 1;
    }

    // Standard Welch's path
    const sb2 = varB;
    const sc2 = varC;
    const se2 = sb2 / nB + sc2 / nC;
    const se = Math.sqrt(se2);
    const tStat = se === 0 ? 0 : (meanC - meanB) / se;
    let df: number;
    if (dfOverride !== null) {
      df = dfOverride;
    } else {
      const num = se2 * se2;
      const den = ((sb2 / nB) ** 2) / (nB - 1) + ((sc2 / nC) ** 2) / (nC - 1);
      df = den === 0 ? nB + nC - 2 : num / den;
    }

    const pRaw = 2 * studentTSF(Math.abs(tStat), df);

    // G6: invalid p-value
    if (isNaN(pRaw) || !isFinite(pRaw) || pRaw < 0) {
      result.label = 'Inconclusive';
      result.subLabel = 'undefined_statistic';
      result.tStat = tStat;
      result.df = df;
      result.pRaw = null;
      result.pAdj = null;
      return result;
    }

    result.tStat = tStat;
    result.df = df;
    result.pRaw = pRaw;

    // Low sample count flag (§6.7): 2 <= min(N) < 10
    const minN = Math.min(nB, nC);
    if (minN < 10) {
      result.flags.push('low_confidence');
      result.flags.push(`N=${minN}`);
    }

    // CV warning (§6.8)
    if (Math.abs(meanB) > 0 && (sigmaB / Math.abs(meanB) > 0.05 || (Math.abs(meanC) > 0 && sigmaC / Math.abs(meanC) > 0.05))) {
      result.flags.push('high_cv');
      const cvParts: string[] = [];
      if (cvBaselinePct !== null) cvParts.push(`baseline CV=${cvBaselinePct.toFixed(1)}%`);
      if (cvCandidatePct !== null) cvParts.push(`candidate CV=${cvCandidatePct.toFixed(1)}%`);
      const cvDetail = cvParts.length > 0 ? ` (${cvParts.join(', ')})` : ' (CV > 5%)';
      result.caveats.push(`High variance detected${cvDetail}. Detection sensitivity is reduced.`);
    }

    // Mark for Holm–Bonferroni
    standardPathIndices.push(metrics.indexOf(m));
    rawPValues.push(pRaw);

    return result;
  });

  // Apply Holm–Bonferroni across standard-path metrics
  if (rawPValues.length > 0) {
    const adjusted = holmBonferroni(rawPValues);
    for (let i = 0; i < standardPathIndices.length; i++) {
      results[standardPathIndices[i]].pAdj = adjusted[i];
    }
  }

  // Classification C1–C5 for standard-path metrics
  for (const idx of standardPathIndices) {
    const r = results[idx];
    if (r.regressionEffect === null || r.pAdj === null) continue;
    const effect = r.regressionEffect;
    const pAdj = r.pAdj;

    if (Math.abs(effect) < PRACTICAL_THRESHOLD) {
      r.label = 'No Regression Detected';
      r.subLabel = 'negligible_change';
    } else if (effect <= -PRACTICAL_THRESHOLD) {
      r.label = 'No Regression Detected';
      r.subLabel = 'improvement';
    } else if (effect >= PRACTICAL_THRESHOLD && pAdj < ALPHA) {
      // C3
      r.label = 'Regression Detected';
    } else if (effect >= LARGE_THRESHOLD && pAdj >= ALPHA) {
      // C4
      r.label = 'Possible Regression';
      r.subLabel = 'large_unconfirmed';
    } else if (effect >= PRACTICAL_THRESHOLD && effect < LARGE_THRESHOLD && pAdj >= ALPHA) {
      // C5
      r.label = 'Inconclusive';
    } else {
      // Fallback — shouldn't reach here
      r.label = 'Inconclusive';
    }
  }

  // Overall summary (§6.9)
  let k1 = 0, k2 = 0, k3 = 0, k4 = 0;
  for (const r of results) {
    if (r.label === 'Regression Detected') k1++;
    else if (r.label === 'Possible Regression') k2++;
    else if (r.label === 'Inconclusive') k3++;
    else if (r.label === 'No Regression Detected') k4++;
  }
  const M = k1 + k2 + k3 + k4;

  let overallLabel: string;
  if (M === 0) {
    overallLabel = 'Not Evaluated';
  } else if (k1 > 0) {
    overallLabel = 'Regression Detected';
  } else if (k2 > 0) {
    overallLabel = 'Possible Regression';
  } else if (k3 > 0 && k4 > 0) {
    overallLabel = 'Inconclusive (Incomplete assessment)';
  } else if (k3 > 0 && k4 === 0) {
    overallLabel = 'Inconclusive';
  } else {
    overallLabel = 'No Regression Detected';
  }

  // CI eligibility (§6.10)
  const ciRefusalReasons: string[] = [];

  // Condition 1: constant-samples path (not identical)
  const hasConstantNonIdentical = results.some(
    (r) =>
      r.flags.includes('constant_samples') &&
      r.subLabel !== 'identical',
  );
  if (hasConstantNonIdentical) {
    ciRefusalReasons.push('Constant-samples path result present. No statistical test was conducted.');
  }

  // Condition 2: low_confidence without operator opt-in
  const hasLowConfidence = results.some((r) => r.flags.includes('low_confidence'));
  if (hasLowConfidence) {
    ciRefusalReasons.push('Low sample count detected (N<10). Operator opt-in required.');
  }

  // Condition 3: M_c = 0 (no standard-path C1-C5 classifications)
  const mc = standardPathIndices.filter((idx) => results[idx].label !== null).length;
  if (mc === 0) {
    ciRefusalReasons.push('No completed statistical comparisons (M_c=0).');
  }

  // Condition 4: overall = Not Evaluated
  if (overallLabel === 'Not Evaluated') {
    ciRefusalReasons.push('No eligible metrics (Not Evaluated).');
  }

  // Confounding flags → CI refusal
  if (confoundingFlags.length > 0) {
    ciRefusalReasons.push('Confounding factors detected. Operator opt-in required.');
  }

  const ciEligible = ciRefusalReasons.length === 0;

  const overall: OverallSummary = {
    label: overallLabel,
    k1,
    k2,
    k3,
    k4,
    m: M,
    ciEligible,
    ciRefusalReasons,
  };

  return { metrics: results, overall, confoundingFlags };
}
