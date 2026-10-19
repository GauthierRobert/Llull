/**
 * Shock response spectrum (PHY-09 §5.5, TR-DYN-50/51): Smallwood ramp-invariant recursive filter for the absolute acceleration of an
 * SDOF base-excited by a(t), coefficients as pyYeti `absacce` (BSD-3): zeta = 1/(2Q), wd = wn sqrt(1 - zeta^2), E = exp(-zeta wn dt),
 * B = wd dt, C = E cos B, S = E sin B, b = [1 - S/B, 2(S/B - C), E^2 - S/B], a = [1, -2C, E^2]. Pure, deterministic.
 */

export interface SrsValue {
  readonly maximax: number;
  readonly positive: number;
  /** Magnitude of the most negative response. */
  readonly negative: number;
}

/** Response of one SDOF to `samples(i)` (i = 0 .. count - 1) at step dt; maxima over every sample. */
function filterPeaks(fnHz: number, q: number, dtS: number, count: number, sample: (index: number) => number): SrsValue {
  const zeta = 1 / (2 * q);
  const wn = 2 * Math.PI * fnHz;
  const wd = wn * Math.sqrt(1 - zeta * zeta);
  const e = Math.exp(-zeta * wn * dtS);
  const e2 = e * e;
  const b = dtS * wd;
  const c = e * Math.cos(b);
  const sb = (e * Math.sin(b)) / b;
  const [b0, b1, b2, a1, a2] = [1 - sb, 2 * (sb - c), e2 - sb, -2 * c, e2];
  let [x1, x2, y1, y2, positive, negative] = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < count; i += 1) {
    const x = sample(i);
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    positive = Math.max(positive, y);
    negative = Math.max(negative, -y);
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return { maximax: Math.max(positive, negative), positive, negative };
}

/** Residual tail after the input: 1.5 periods of fn (TR-DYN-51). */
const tailS = (fnHz: number): number => 1.5 / fnHz;

/**
 * SRS of a half-sine pulse a(t) = peak sin(pi t / T) at fn, sampled per frequency at dt = min(T / 2000, 1 / (400 fn)) (the generator of
 * VC-DYN-13 / 14), with the 1.5-period tail.
 */
export function halfSineSrs(fnHz: number, q: number, peak: number, durationS: number): SrsValue {
  const dt = Math.min(durationS / 2000, 1 / (fnHz * 400));
  const count = Math.ceil((durationS + tailS(fnHz)) / dt) + 1;
  return filterPeaks(fnHz, q, dt, count, (i) => (i * dt <= durationS ? peak * Math.sin((Math.PI * i * dt) / durationS) : 0));
}

/** SRS of a uniformly sampled history (values at dt), followed by zeros over the 1.5-period tail. */
export function historySrs(fnHz: number, q: number, values: readonly number[], dtS: number): SrsValue {
  const count = values.length + Math.ceil(tailS(fnHz) / dtS);
  return filterPeaks(fnHz, q, dtS, count, (i) => values[i] ?? 0);
}

/** Frequencies fMin * 2^(k / octaveFraction) up to fMax (inclusive within 1e-9). */
export function octaveFrequencies(fMinHz: number, fMaxHz: number, octaveFraction: number): number[] {
  const out: number[] = [];
  for (let k = 0; ; k += 1) {
    const f = fMinHz * 2 ** (k / octaveFraction);
    if (f > fMaxHz * (1 + 1e-9)) return out;
    out.push(f);
  }
}
