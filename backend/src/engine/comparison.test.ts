import { runComparison, MetricInput } from './comparison';

function makeInput(
  baseline: number[],
  candidate: number[],
  name = 'test/BM_test',
  polarity: 'LIB' | 'HIB' = 'LIB',
): MetricInput {
  return { name, baseline, candidate, polarity };
}

// 15 values at lo, 15 at hi → mean=(lo+hi)/2, sigma=sqrt(30*(hi-lo)^2/4/29)
function bimodalSamples(lo: number, hi: number): number[] {
  return [...Array(15).fill(lo), ...Array(15).fill(hi)];
}

describe('runComparison — cvBaselinePct / cvCandidatePct', () => {

  it('1. standard path: CV computed correctly for both sides', () => {
    // baseline: mean=1_000_000, [850_000 ×15, 1_150_000 ×15] → sigma≈152_575, CV≈15.26%
    // candidate: mean=1_020_000, [870_000 ×15, 1_170_000 ×15] → sigma≈152_575, CV≈14.96%
    const baseline = bimodalSamples(850_000, 1_150_000);
    const candidate = bimodalSamples(870_000, 1_170_000);
    const output = runComparison([makeInput(baseline, candidate)]);
    const m = output.metrics[0];

    expect(m.cvBaselinePct).not.toBeNull();
    expect(m.cvCandidatePct).not.toBeNull();
    expect(m.cvBaselinePct!).toBeCloseTo(15.26, 1);
    expect(m.cvCandidatePct!).toBeCloseTo(14.96, 1);
  });

  it('2. G1 guard (N=1 baseline): cvBaselinePct is null, cvCandidatePct is 0 (constant)', () => {
    // sampleStats returns variance:0 for N=1; guard nB>=2 excludes it.
    const baseline = [1_000_000];
    const candidate = Array(30).fill(1_050_000);
    const output = runComparison([makeInput(baseline, candidate)]);
    const m = output.metrics[0];

    expect(m.cvBaselinePct).toBeNull();
    expect(m.cvCandidatePct).toBe(0);
  });

  it('3. G2 guard (zero baseline mean): cvBaselinePct is null', () => {
    const baseline = Array(30).fill(0);
    const candidate = Array(30).fill(1_000_000);
    const output = runComparison([makeInput(baseline, candidate)]);
    const m = output.metrics[0];

    expect(m.cvBaselinePct).toBeNull();     // Math.abs(0) = 0 → guard
    expect(m.cvCandidatePct).toBe(0);       // constant candidate, nonzero mean
  });

  it('4. G3 guard (identical constants): both CVs are 0', () => {
    const baseline = Array(30).fill(1_000_000);
    const candidate = Array(30).fill(1_000_000);
    const output = runComparison([makeInput(baseline, candidate)]);
    const m = output.metrics[0];

    expect(m.cvBaselinePct).toBe(0);
    expect(m.cvCandidatePct).toBe(0);
  });

  it('5. G4 guard (constants, different means): both CVs are 0', () => {
    const baseline = Array(30).fill(1_000_000);
    const candidate = Array(30).fill(1_060_000);
    const output = runComparison([makeInput(baseline, candidate)]);
    const m = output.metrics[0];

    expect(m.cvBaselinePct).toBe(0);
    expect(m.cvCandidatePct).toBe(0);
  });

  it('6. high_cv flag set when CV > 5%; CV values in caveats', () => {
    // CV≈15% on both sides → flag fires
    const baseline = bimodalSamples(850_000, 1_150_000);
    const candidate = bimodalSamples(870_000, 1_170_000);
    const output = runComparison([makeInput(baseline, candidate)]);
    const m = output.metrics[0];

    expect(m.flags).toContain('high_cv');
    expect(m.cvBaselinePct!).toBeGreaterThan(5);
    expect(m.cvCandidatePct!).toBeGreaterThan(5);
    // caveat text should include actual CV values
    const caveat = m.caveats.find((c) => c.includes('High variance detected'));
    expect(caveat).toBeDefined();
    expect(caveat).toContain('baseline CV=');
    expect(caveat).toContain('candidate CV=');
  });

  it('7. low CV does not set high_cv flag', () => {
    // baseline: 15 at 999_000, 15 at 1_001_000 → sigma≈1017, CV≈0.10%
    const baseline = bimodalSamples(999_000, 1_001_000);
    const candidate = bimodalSamples(1_049_000, 1_051_000);
    const output = runComparison([makeInput(baseline, candidate)]);
    const m = output.metrics[0];

    expect(m.flags).not.toContain('high_cv');
    expect(m.cvBaselinePct!).toBeLessThan(5);
    expect(m.cvCandidatePct!).toBeLessThan(5);
  });

  it('8. CV fields preserved under Holm–Bonferroni (multiple metrics)', () => {
    // Two metrics — Holm pass must not disturb CV values.
    const b1 = bimodalSamples(850_000, 1_150_000);
    const c1 = bimodalSamples(870_000, 1_170_000);
    const b2 = bimodalSamples(999_000, 1_001_000);
    const c2 = bimodalSamples(1_049_000, 1_051_000);
    const output = runComparison([
      makeInput(b1, c1, 'test/high_cv'),
      makeInput(b2, c2, 'test/low_cv'),
    ]);

    const high = output.metrics[0];
    const low  = output.metrics[1];

    expect(high.cvBaselinePct!).toBeGreaterThan(5);
    expect(low.cvBaselinePct!).toBeLessThan(5);
  });

});
