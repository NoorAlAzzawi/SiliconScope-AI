/**
 * explanation.ts — Rule-based explanation generator (FR-R-008).
 *
 * Deterministic plain-language summary of a ComparisonOutput. Does not speculate
 * about root causes and only references values present in the run records.
 */

import { ComparisonOutput, MetricResult } from './comparison';

export interface ExplanationContext {
  sessionASource: string;  // 'synthetic' | 'user-supplied import'
  sessionBSource: string;
  output: ComparisonOutput;
}

const PROVENANCE_TEXT =
  'The commit SHA (if any) was user-supplied and build provenance was not verified. ' +
  'The execution-time environment was extracted from the Google Benchmark JSON context ' +
  'block, not independently verified.';

function formatPct(val: number): string {
  const str = Number(val.toFixed(2)).toString();
  return (val >= 0 ? '+' : '') + str + '%';
}

function buildMetricLines(m: MetricResult): string[] {
  const classDisplay = m.label
    ? (m.subLabel ? `${m.label} [${m.subLabel}]` : m.label)
    : (m.subLabel ?? 'Inconclusive');

  const lines: string[] = [`${m.name}: ${classDisplay}`];

  if (m.deltaPct !== null && m.regressionEffect !== null) {
    lines.push(
      `  Baseline mean: ${m.n_baseline} samples. Candidate mean: ${m.n_candidate} samples. ` +
      `Change: ${formatPct(m.deltaPct)} (regression effect: ${formatPct(m.regressionEffect)}).`,
    );
  } else {
    lines.push(`  Terminated early: ${m.subLabel ?? 'unknown'}.`);
  }

  if (m.flags.includes('low_confidence')) {
    const nFlag = m.flags.find((f) => f.startsWith('N='));
    const nVal = nFlag ? nFlag.slice(2) : '?';
    lines.push(`  Note: low confidence due to small sample size (N=${nVal}).`);
  }

  if (m.flags.includes('high_cv')) {
    const cvParts: string[] = [];
    if (m.cvBaselinePct !== null) cvParts.push(`baseline CV=${m.cvBaselinePct.toFixed(1)}%`);
    if (m.cvCandidatePct !== null) cvParts.push(`candidate CV=${m.cvCandidatePct.toFixed(1)}%`);
    const cvDetail = cvParts.length > 0 ? ` (${cvParts.join(', ')})` : ' (CV > 5%)';
    lines.push(`  Note: high coefficient of variation${cvDetail}. Detection sensitivity is reduced.`);
  }

  if (m.flags.includes('constant_samples') && m.subLabel !== 'identical') {
    lines.push(
      '  Note: Zero observed variance detected in both samples. No statistical test was ' +
      'conducted. The measured difference may reflect quantization at the timer resolution ' +
      'floor rather than a true performance change. Collect additional samples with a longer ' +
      'iteration duration to confirm.',
    );
  }

  if (m.flags.includes('one_side_zero_variance')) {
    lines.push('  Note: one sample had zero observed variance; degrees of freedom adjusted.');
  }

  return lines;
}

export function generateExplanation(ctx: ExplanationContext): string {
  const { sessionASource, sessionBSource, output } = ctx;
  const { metrics, overall, confoundingFlags } = output;

  const sections: string[] = [];

  // 1. Header
  sections.push(
    'Automated comparison summary. This explanation is generated from the stored run records ' +
    'only and does not speculate about the causes of observed differences.',
  );

  // 2. Metric count
  if (metrics.length === 0) {
    sections.push('No eligible metrics were found in common between the two runs.');
  } else {
    const names = metrics.map((m) => m.name);
    if (names.length <= 5) {
      sections.push(`Evaluated ${names.length} metric(s): ${names.join(', ')}.`);
    } else {
      const extra = names.length - 5;
      sections.push(
        `Evaluated ${names.length} metric(s): ${names.slice(0, 5).join(', ')}, and ${extra} more.`,
      );
    }
  }

  // 3. Environmental differences (only when confounding flags present)
  if (confoundingFlags.length > 0) {
    const lines: string[] = [];
    for (const cf of confoundingFlags) {
      lines.push(`- ${cf.flag}: ${cf.severity} severity.`);
    }
    lines.push(
      'These differences do not establish that environment caused any observed performance change.',
    );
    sections.push(lines.join('\n'));
  }

  // 4. Per-metric results
  if (metrics.length > 0) {
    const allLines: string[] = [];
    for (const m of metrics) {
      for (const line of buildMetricLines(m)) {
        allLines.push(line);
      }
    }
    sections.push(allLines.join('\n'));
  }

  // 5. Overall summary
  sections.push(
    `Overall result: ${overall.label}. Distribution — Regression Detected: ${overall.k1}, ` +
    `Possible Regression: ${overall.k2}, Inconclusive: ${overall.k3}, ` +
    `No Regression Detected: ${overall.k4} (of ${overall.m} total).`,
  );

  // 6. CI gate eligibility
  if (overall.ciEligible) {
    sections.push('CI gate: This comparison is eligible for CI gate use.');
  } else {
    const reasons = overall.ciRefusalReasons.join('; ');
    sections.push(
      `CI gate: This comparison is not eligible for CI gate use. Reason(s): ${reasons}`,
    );
  }

  // 7. Provenance (only for imported runs)
  if (sessionASource === 'user-supplied import') {
    sections.push(`Provenance note (baseline): ${PROVENANCE_TEXT}`);
  }
  if (sessionBSource === 'user-supplied import') {
    sections.push(`Provenance note (candidate): ${PROVENANCE_TEXT}`);
  }

  return sections.join('\n\n');
}
