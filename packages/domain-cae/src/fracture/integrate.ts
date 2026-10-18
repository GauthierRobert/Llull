/** Crack-growth life integration in u = ln a (PHY-08 TR-FRC-30/31/40): composite Simpson per sample segment, critical sizes by bisection. */

import { growthPerBlock, type GrowthSetup } from './setup';
import { netYieldSize, sizeLimit, stressIntensityAt } from './kSolutions';

type StopReason = 'fracture' | 'net_section_yield' | 'target' | 'geometry_limit' | 'runout' | 'arrest' | 'initial_critical';

const RUNOUT_CYCLES = 1e8;

const kAt =
  (setup: GrowthSetup) =>
  (a: number, sigma: number): number =>
    stressIntensityAt(setup.geometry, a, sigma);

/** Root of f on (lo, hi) by bisection to 1e-12 m, or null when f has the same sign at both ends. */
function bisect(f: (a: number) => number, lo: number, hi: number): number | null {
  let fLo = f(lo);
  if (fLo * f(hi) > 0) return null;
  for (let i = 0; i < 300 && hi - lo > 1e-14; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (fMid * fLo > 0) {
      lo = mid;
      fLo = fMid;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface CriticalSizes {
  /** Size where K = Kc at the residual stress [m]; null when K stays below Kc up to the solution limit. */
  readonly fracture: number | null;
  /** Net-section yield size [m]; null without Fty or for a non-through geometry. */
  readonly netYield: number | null;
  readonly limit: number;
  /** Residual stress used [MPa]. */
  readonly stress: number;
}

/** Critical crack sizes at the residual stress (explicit `residualStress` else the block's peak stress). */
export function criticalSizes(setup: GrowthSetup): CriticalSizes {
  const stress = setup.residualStress ?? setup.sigmaPeak;
  const limit = sizeLimit(setup.geometry);
  const fracture = bisect((a) => stressIntensityAt(setup.geometry, a, stress) - setup.kc, 1e-9, limit);
  const netYield = setup.fty === null ? null : netYieldSize(setup.geometry, stress, setup.fty);
  return { fracture, netYield: netYield !== null && netYield > 0 ? netYield : null, limit, stress };
}

function simpson(f: (u: number) => number, u0: number, u1: number, n: number): number {
  const h = (u1 - u0) / n;
  let sum = f(u0) + f(u1);
  for (let i = 1; i < n; i += 1) sum += f(u0 + i * h) * (i % 2 === 1 ? 4 : 2);
  return (sum * h) / 3;
}

/** Blocks needed to grow a segment [a0, a1]; Infinity when the rate vanishes (arrest). Converged Simpson in ln a. */
function segmentBlocks(setup: GrowthSetup, a0: number, a1: number): number {
  const k = kAt(setup);
  const integrand = (u: number): number => {
    const a = Math.exp(u);
    const { perBlock } = growthPerBlock(setup, a, k);
    return perBlock === 0 ? Number.POSITIVE_INFINITY : Number.isFinite(perBlock) ? a / perBlock : 0;
  };
  const [u0, u1] = [Math.log(a0), Math.log(a1)];
  let n = Math.max(2, 2 * Math.ceil((u1 - u0) / setup.maxDaOverA / 2));
  let previous = simpson(integrand, u0, u1, n);
  if (!Number.isFinite(previous)) return Number.POSITIVE_INFINITY;
  for (let i = 0; i < 8; i += 1) {
    n *= 2;
    const refined = simpson(integrand, u0, u1, n);
    if (!Number.isFinite(refined)) return Number.POSITIVE_INFINITY;
    if (Math.abs(refined - previous) <= 1e-12 * Math.abs(refined)) return refined;
    previous = refined;
  }
  return previous;
}

interface CurvePoint {
  readonly N: number;
  readonly aM: number;
  readonly KmaxMPaSqrtM: number;
}

export interface GrowthLife {
  readonly lifeBlocks: number;
  readonly lifeCycles: number;
  readonly aFinalM: number;
  readonly stopReason: StopReason;
  readonly curve: CurvePoint[];
  readonly extrapolated: boolean;
}

/**
 * Life from `aStart` to the first stop: `aTarget` (when given), K = Kc at the residual stress, net-section yield or the K-solution limit.
 * @invariant constant amplitude, Y = 1 matches N = (a0^(1-m/2) - af^(1-m/2)) / (C (m/2 - 1) (ds sqrt(pi))^m); runout caps at 1e8 cycles
 */
export function growthLife(setup: GrowthSetup, aStart: number, samples: number): GrowthLife {
  const critical = criticalSizes(setup);
  const stops: Array<{ a: number; reason: StopReason }> = [{ a: critical.limit, reason: 'geometry_limit' }];
  if (critical.fracture !== null) stops.push({ a: critical.fracture, reason: 'fracture' });
  if (critical.netYield !== null) stops.push({ a: critical.netYield, reason: 'net_section_yield' });
  if (setup.aTarget !== null) stops.push({ a: setup.aTarget, reason: 'target' });
  const stop = stops.reduce((best, candidate) => (candidate.a < best.a ? candidate : best));
  const kmax = (a: number): number => stressIntensityAt(setup.geometry, a, setup.sigmaPeak);
  if (!(aStart < stop.a))
    return {
      lifeBlocks: 0,
      lifeCycles: 0,
      aFinalM: aStart,
      stopReason: stop.reason === 'target' ? 'target' : 'initial_critical',
      curve: [{ N: 0, aM: aStart, KmaxMPaSqrtM: kmax(aStart) }],
      extrapolated: false,
    };
  const count = Math.max(2, Math.floor(samples));
  const ratio = stop.a / aStart;
  const curve: CurvePoint[] = [{ N: 0, aM: aStart, KmaxMPaSqrtM: kmax(aStart) }];
  let blocks = 0;
  let previous = aStart;
  let extrapolated = growthPerBlock(setup, aStart, kAt(setup)).extrapolated;
  for (let i = 1; i <= count; i += 1) {
    const next = i === count ? stop.a : aStart * ratio ** (i / count);
    blocks += segmentBlocks(setup, previous, next);
    if (!Number.isFinite(blocks))
      return {
        lifeBlocks: Number.POSITIVE_INFINITY,
        lifeCycles: Number.POSITIVE_INFINITY,
        aFinalM: previous,
        stopReason: 'arrest',
        curve,
        extrapolated,
      };
    const cycles = blocks * setup.cyclesPerBlock;
    if (cycles > RUNOUT_CYCLES) {
      const previousCycles = curve.at(-1)?.N ?? 0;
      const weight = (RUNOUT_CYCLES - previousCycles) / (cycles - previousCycles);
      const aRunout = Math.exp(Math.log(previous) + weight * (Math.log(next) - Math.log(previous)));
      curve.push({ N: RUNOUT_CYCLES, aM: aRunout, KmaxMPaSqrtM: kmax(aRunout) });
      return {
        lifeBlocks: RUNOUT_CYCLES / setup.cyclesPerBlock,
        lifeCycles: RUNOUT_CYCLES,
        aFinalM: aRunout,
        stopReason: 'runout',
        curve,
        extrapolated,
      };
    }
    extrapolated ||= growthPerBlock(setup, next, kAt(setup)).extrapolated;
    curve.push({ N: cycles, aM: next, KmaxMPaSqrtM: kmax(next) });
    previous = next;
  }
  return { lifeBlocks: blocks, lifeCycles: blocks * setup.cyclesPerBlock, aFinalM: stop.a, stopReason: stop.reason, curve, extrapolated };
}
