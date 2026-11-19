/**
 * Eigenvalues of a linearised flight and their mode labels (13 FLT M5, M5b).
 *   fixed wing: each eigenvalue of the full A is labelled from the PARTICIPATION of the states in its mode (modeVectors.ts; scale-free):
 *     longitudinal (u, w, q, pitch share >= 80 %): an oscillatory mode dominated by speed and attitude (u + pitch) is the phugoid, by
 *     incidence and rate (w + q) the short period; real roots are `longitudinal_real`.
 *     lateral (share <= 20 %): an oscillatory mode dominated by sideslip and yaw rate (v + r) is the Dutch roll (else `lateral_oscillatory`);
 *     a real root dominated by the roll rate p is the roll subsidence, by the roll angle the spiral (else `lateral_real`); a neutral real or
 *     defective lateral root is `lateral_neutral` (the lateral modes of an aero vehicle whose tables carry no sideslip or rate dependence).
 *     between the two: `coupled`. A defective root has no participation: its right eigenvector groups it; a repeated root (no unique eigenvector)
 *     is grouped by the decoupled block(s) that have it (`coupled` when both do).
 *   hover (multirotor; every root a defective zero of the integrator chains, so participation is undefined): HEURISTICS on the decoupled
 *     longitudinal (u, w, q, pitch) and lateral (v, p, r, roll) blocks of A; each eigenvalue of the full matrix takes the label of the nearest
 *     unused block eigenvalue and is `coupled` when none lies within 10 %: the real longitudinal root nearest A[w][w] is `heave`, the real
 *     lateral root nearest A[r][r] is `yaw`, the rest of the longitudinal block `pitch_translation`, of the lateral block `roll_translation`.
 */

import { elementAt } from '@lib/elementAt';
import { eigenvalues, type ComplexValue } from './eigenvalues';
import { maxOf } from '@lib/arrayExtrema';
import { modeParticipation } from './modeVectors';
import { STATE_NAMES } from './trimModel';

export type ModeSet = 'fixed_wing' | 'hover';

interface FlightMode {
  readonly label: string;
  readonly kind: 'oscillatory' | 'real';
  readonly re: number;
  /** Imaginary part of the pair, >= 0 (the conjugate is implied). */
  readonly im: number;
  /** -re / |λ| of an oscillatory mode, null for a real one. */
  readonly dampingRatio: number | null;
  /** |λ| of an oscillatory mode, rad/s, null for a real one. */
  readonly naturalFrequencyRadS: number | null;
  /** 2π / im, s; null for a real mode. */
  readonly periodS: number | null;
  /** -1 / re of a convergent real mode, s. */
  readonly timeConstantS: number | null;
  /** ln 2 / re of a divergent mode (oscillatory: of the envelope), s. */
  readonly timeToDoubleS: number | null;
  readonly stability: 'stable' | 'neutral' | 'unstable';
  /** Participation of each state (u, v, w, p, q, r, roll, pitch) in the mode, sums to 1; null for a defective mode. */
  readonly participation: Readonly<Record<(typeof STATE_NAMES)[number], number>> | null;
  /**
   * Share of the longitudinal states (u, w, q, pitch) in the mode: participation, else right-eigenvector energy; for a repeated root (no unique
   * eigenvector) 1 / 0 when only the longitudinal / lateral block has it, null when both do.
   */
  readonly longitudinalShare: number | null;
  /** What the label was read from: the participation factors, the right eigenvector (defective), or the block heuristic (hover). */
  readonly labelBasis: 'participation' | 'eigenvector' | 'block';
}

const LONGITUDINAL = [0, 2, 4, 7];
const LATERAL = [1, 3, 5, 6];
/** |Re λ| below which a root is neutral, 1/s. */
const NEUTRAL_RATE = 1e-3;
/** A full eigenvalue matches a block eigenvalue when closer than this share of its magnitude (plus a floor). */
const MATCH_SHARE = 0.1;
const MATCH_FLOOR = 1e-3;
/** Eigenvalues closer than this share of their magnitude (floor 1) are one repeated root. */
const REPEATED = 1e-9;
/** Imaginary parts below this share of the magnitude are round-off of a real (repeated) root. */
const REAL_SNAP = 1e-6;

const magnitude = (value: ComplexValue): number => Math.hypot(value.re, value.im);

/** Eigenvalues with the round-off imaginary parts of real roots removed (a defective zero comes out as a pair of 1e-15 i). */
const tidy = (values: readonly ComplexValue[] | null): ComplexValue[] | null =>
  values === null
    ? null
    : values.map((value) => (Math.abs(value.im) <= REAL_SNAP * Math.max(1, magnitude(value)) ? { re: value.re, im: 0 } : value));

const block = (a: readonly (readonly number[])[], indices: readonly number[]): number[][] =>
  indices.map((i) => indices.map((j) => elementAt(elementAt(a, i), j)));

/** Hover labels of the eigenvalues of one block (the same length, same order); `nearest` is the diagonal term the heave / yaw root is nearest to. */
function labelHoverBlock(values: readonly ComplexValue[], longitudinal: boolean, nearest: number): string[] {
  const reals = values.flatMap((value, i) => (value.im === 0 ? [i] : []));
  const gap = (i: number): number => Math.abs(elementAt(values, i).re - nearest);
  const heave =
    reals.length === 0
      ? -1
      : elementAt(
          [...reals].sort((first, second) => gap(first) - gap(second)),
          0,
        );
  return values.map((_, i) => (i === heave ? (longitudinal ? 'heave' : 'yaw') : longitudinal ? 'pitch_translation' : 'roll_translation'));
}

/** Share of the longitudinal states at and above which a mode is longitudinal (lateral at and below 1 − it). */
const GROUP_SHARE = 0.8;

const shareOf = (weights: readonly number[], indices: readonly number[]): number =>
  indices.reduce((sum, i) => sum + elementAt(weights, i), 0);

/**
 * Fixed-wing label of the mode of `value` from its state weights (u, v, w, p, q, r, roll, pitch) and longitudinal share (null: both groups);
 * `defective` when it has no participation.
 */
function fixedWingLabel(value: ComplexValue, weights: readonly number[], longitudinal: number | null, defective: boolean): string {
  if (longitudinal === null) return 'coupled';
  const at = (i: number): number => elementAt(weights, i);
  const [u, v, w, p, q, r, roll, pitch] = [at(0), at(1), at(2), at(3), at(4), at(5), at(6), at(7)];
  if (longitudinal >= GROUP_SHARE) {
    if (value.im === 0) return 'longitudinal_real';
    return u + pitch >= w + q ? 'phugoid' : 'short_period';
  }
  if (longitudinal > 1 - GROUP_SHARE) return 'coupled';
  const neutral = Math.abs(value.re) <= NEUTRAL_RATE;
  if (neutral && (value.im === 0 || defective)) return 'lateral_neutral';
  if (value.im !== 0) return v + r >= p + roll ? 'dutch_roll' : 'lateral_oscillatory';
  const dominant = Math.max(v, p, r, roll);
  return p === dominant ? 'roll_subsidence' : roll === dominant ? 'spiral' : 'lateral_real';
}

interface Labelled {
  readonly label: string;
  readonly participation: number[] | null;
  readonly longitudinalShare: number | null;
  readonly labelBasis: FlightMode['labelBasis'];
}

function modeOf(value: ComplexValue, labelled: Labelled): FlightMode {
  const { label, participation } = labelled;
  const oscillatory = value.im > 0;
  const rate = value.re;
  return {
    label,
    kind: oscillatory ? 'oscillatory' : 'real',
    re: rate,
    im: value.im,
    dampingRatio: oscillatory ? -rate / magnitude(value) : null,
    naturalFrequencyRadS: oscillatory ? magnitude(value) : null,
    periodS: oscillatory ? (2 * Math.PI) / value.im : null,
    timeConstantS: !oscillatory && rate < -NEUTRAL_RATE ? -1 / rate : null,
    timeToDoubleS: rate > NEUTRAL_RATE ? Math.LN2 / rate : null,
    stability: rate > NEUTRAL_RATE ? 'unstable' : rate < -NEUTRAL_RATE ? 'stable' : 'neutral',
    participation:
      participation === null
        ? null
        : (Object.fromEntries(STATE_NAMES.map((name, i) => [name, elementAt(participation, i)])) as FlightMode['participation']),
    longitudinalShare: labelled.longitudinalShare,
    labelBasis: labelled.labelBasis,
  };
}

interface ModeAnalysis {
  /** Every eigenvalue of A, descending real part. */
  readonly eigenvalues: readonly ComplexValue[];
  /** One entry per mode (a complex pair once), descending real part. */
  readonly modes: readonly FlightMode[];
  /** Largest magnitude of the longitudinal-lateral coupling blocks of A over that of A (0 = decoupled). */
  readonly couplingRatio: number;
}

/** Hover labels of every eigenvalue of `all`: the nearest unused root of the decoupled blocks, `coupled` when none is within 10 %. */
function hoverLabels(
  a: readonly (readonly number[])[],
  all: readonly ComplexValue[],
  longitudinal: readonly ComplexValue[],
  lateral: readonly ComplexValue[],
): string[] {
  const longitudinalLabels = labelHoverBlock(longitudinal, true, elementAt(elementAt(a, 2), 2));
  const lateralLabels = labelHoverBlock(lateral, false, elementAt(elementAt(a, 5), 5));
  const candidates = [
    ...longitudinal.map((value, i) => ({ value, label: elementAt(longitudinalLabels, i) })),
    ...lateral.map((value, i) => ({ value, label: elementAt(lateralLabels, i) })),
  ];
  const used = new Set<number>();
  return all.map((value) => {
    let best = -1;
    let distance = Infinity;
    candidates.forEach((candidate, i) => {
      const d = Math.hypot(candidate.value.re - value.re, candidate.value.im - value.im);
      if (!used.has(i) && d < distance) {
        best = i;
        distance = d;
      }
    });
    if (best < 0 || distance > MATCH_SHARE * magnitude(value) + MATCH_FLOOR) return 'coupled';
    used.add(best);
    return elementAt(candidates, best).label;
  });
}

/** Eigenvalues of `a` (8 x 8) with their labelled modes, or null when the eigenvalue iteration fails. */
export function analyseModes(a: readonly (readonly number[])[], modeSet: ModeSet): ModeAnalysis | null {
  const all = tidy(eigenvalues(a));
  const longitudinal = tidy(eigenvalues(block(a, LONGITUDINAL)));
  const lateral = tidy(eigenvalues(block(a, LATERAL)));
  if (all === null || longitudinal === null || lateral === null) return null;
  const hover = modeSet === 'hover' ? hoverLabels(a, all, longitudinal, lateral) : null;
  const near = (value: ComplexValue, other: ComplexValue, share: number, floor: number): boolean =>
    Math.hypot(other.re - value.re, other.im - value.im) <= share * magnitude(value) + floor;
  const modes = all.flatMap((value, i) => {
    if (value.im < 0) return [];
    const repeated = all.some((other, j) => j !== i && near(value, other, REPEATED, REPEATED));
    const { participation, weights, basis } = modeParticipation(a, value, repeated);
    const inLongitudinal = longitudinal.some((other) => near(value, other, MATCH_SHARE, MATCH_FLOOR));
    const inLateral = lateral.some((other) => near(value, other, MATCH_SHARE, MATCH_FLOOR));
    const share = !repeated ? shareOf(weights, LONGITUDINAL) : inLongitudinal === inLateral ? null : inLongitudinal ? 1 : 0;
    const label = hover === null ? fixedWingLabel(value, weights, share, participation === null) : elementAt(hover, i);
    return [modeOf(value, { label, participation, longitudinalShare: share, labelBasis: hover === null ? basis : 'block' })];
  });
  const cross = (rows: readonly number[], columns: readonly number[]): number =>
    Math.max(0, maxOf(rows.flatMap((i) => columns.map((j) => Math.abs(elementAt(elementAt(a, i), j))))));
  const total = Math.max(1e-300, maxOf(a.flatMap((row) => row.map(Math.abs))));
  return { eigenvalues: all, modes, couplingRatio: Math.max(cross(LONGITUDINAL, LATERAL), cross(LATERAL, LONGITUDINAL)) / total };
}
