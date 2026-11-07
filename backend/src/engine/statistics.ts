/**
 * statistics.ts — Pure statistical functions. No I/O, no Express.
 */

// ── Lanczos lgamma approximation (g=7, n=9) ───────────────────────────────────

function lgamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// ── Lentz continued-fraction expansion for the incomplete beta function ────────

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-7;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1.0;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function betai(a: number, b: number, x: number): number {
  if (x < 0 || x > 1) throw new RangeError(`betai: x=${x} out of [0,1]`);
  if (x === 0 || x === 1) return x;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  // bt = x^a * (1-x)^b / B(a,b)  (unnormalized leading term)
  const bt = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  const flip = x > (a + 1) / (a + b + 2);
  // Numerical Recipes §6.4: divide by a in the direct case, by b in the flipped case.
  if (flip) return 1 - (bt / b) * betacf(b, a, 1 - x);
  return (bt / a) * betacf(a, b, x);
}

// ── Exported statistical functions ────────────────────────────────────────────

/**
 * Survival function (upper-tail probability) of Student's t-distribution.
 * Returns P(T > |t|) where T ~ t(df).  Two-tailed p-value = 2 * studentTSF(|t|, df).
 */
export function studentTSF(t: number, df: number): number {
  if (df <= 0) throw new RangeError(`studentTSF: df must be > 0, got ${df}`);
  const x = df / (df + t * t);
  if (x === 0) return 0; // |t| so large that x underflows — definitely significant
  return 0.5 * betai(df / 2, 0.5, x);
}

/**
 * Holm–Bonferroni multiple comparison correction.
 * Input: raw p-values for the M_p metrics in the family.
 * Returns corrected p-values in the same order as the input.
 */
export function holmBonferroni(pValues: number[]): number[] {
  if (pValues.length === 0) return [];
  const M = pValues.length;
  // Create sorted index array (ascending by p-value).
  const order = Array.from({ length: M }, (_, i) => i).sort(
    (a, b) => pValues[a] - pValues[b],
  );
  const adjusted = new Array<number>(M);
  let prevAdj = 0;
  for (let i = 0; i < M; i++) {
    const rank = i + 1; // 1-indexed
    const rawP = pValues[order[i]];
    const adj = Math.min(1.0, Math.max(prevAdj, (M - rank + 1) * rawP));
    adjusted[order[i]] = adj;
    prevAdj = adj;
  }
  return adjusted;
}

/**
 * Sample statistics: mean, Bessel-corrected variance, and N.
 */
export function sampleStats(xs: number[]): { mean: number; variance: number; n: number } {
  const n = xs.length;
  if (n === 0) return { mean: 0, variance: 0, n: 0 };
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { mean, variance: 0, n };
  const variance = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return { mean, variance, n };
}
