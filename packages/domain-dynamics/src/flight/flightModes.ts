/**
 * Eigenvalues of a linearised flight and their mode labels (13 FLT M5). The labels are HEURISTICS on the decoupled longitudinal (u, w, q, pitch) and
 * lateral (v, p, r, roll) blocks of A; each eigenvalue of the full matrix takes the label of the nearest unused block eigenvalue and is `coupled`
 * when none lies within 10 % (the vehicle's longitudinal and lateral motions interact).
 *   fixed wing, longitudinal: the complex pair of lower |λ| is the phugoid, the one of higher |λ| the short period; real roots are `longitudinal_real`.
 *   fixed wing, lateral: a complex pair is the Dutch roll; of the real roots the largest |λ| is the roll subsidence, the smallest the spiral.
 *   hover (multirotor): the real longitudinal root nearest A[w][w] is `heave`, the real lateral root nearest A[r][r] is `yaw`, the rest of the
 *   longitudinal block `pitch_translation`, of the lateral block `roll_translation` (the velocity-attitude-rate chains).
 */

import { elementAt } from '@lib/elementAt';
import { eigenvalues, type ComplexValue } from './eigenvalues';

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
}

const LONGITUDINAL = [0, 2, 4, 7];
const LATERAL = [1, 3, 5, 6];
/** |Re λ| below which a root is neutral, 1/s. */
const NEUTRAL_RATE = 1e-3;
/** A full eigenvalue matches a block eigenvalue when closer than this share of its magnitude (plus a floor). */
const MATCH_SHARE = 0.1;
const MATCH_FLOOR = 1e-3;
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

/** Heuristic labels of the eigenvalues of one block (the same length, same order); `nearest` is the diagonal term the hover heave / yaw root is nearest to. */
function labelBlock(values: readonly ComplexValue[], longitudinal: boolean, modeSet: ModeSet, nearest: number): string[] {
  const labels = values.map(() => 'unclassified');
  const pairs = values.flatMap((value, i) => (value.im > 0 ? [i] : []));
  const reals = values.flatMap((value, i) => (value.im === 0 ? [i] : []));
  const byMagnitude = (first: number, second: number): number => magnitude(elementAt(values, first)) - magnitude(elementAt(values, second));
  if (modeSet === 'hover') {
    const gap = (i: number): number => Math.abs(elementAt(values, i).re - nearest);
    const heave =
      reals.length === 0
        ? -1
        : elementAt(
            [...reals].sort((first, second) => gap(first) - gap(second)),
            0,
          );
    values.forEach((_, i) => {
      labels[i] = i === heave ? (longitudinal ? 'heave' : 'yaw') : longitudinal ? 'pitch_translation' : 'roll_translation';
    });
    return labels;
  }
  const sortedPairs = [...pairs].sort(byMagnitude);
  const sortedReals = [...reals].sort(byMagnitude);
  if (longitudinal) {
    const firstReal = sortedReals[0];
    sortedPairs.forEach((index, rank) => {
      const slower = firstReal === undefined || magnitude(elementAt(values, index)) < magnitude(elementAt(values, firstReal));
      labels[index] = sortedPairs.length === 1 ? (slower ? 'phugoid' : 'short_period') : rank === 0 ? 'phugoid' : 'short_period';
    });
    sortedReals.forEach((index) => (labels[index] = 'longitudinal_real'));
  } else {
    sortedPairs.forEach((index) => (labels[index] = 'dutch_roll'));
    sortedReals.forEach((index, rank) => {
      labels[index] = rank === sortedReals.length - 1 ? 'roll_subsidence' : rank === 0 ? 'spiral' : 'lateral_real';
    });
  }
  return labels;
}

function modeOf(value: ComplexValue, label: string): FlightMode {
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

/** Eigenvalues of `a` (8 x 8) with their labelled modes, or null when the eigenvalue iteration fails. */
export function analyseModes(a: readonly (readonly number[])[], modeSet: ModeSet): ModeAnalysis | null {
  const all = tidy(eigenvalues(a));
  const longitudinal = tidy(eigenvalues(block(a, LONGITUDINAL)));
  const lateral = tidy(eigenvalues(block(a, LATERAL)));
  if (all === null || longitudinal === null || lateral === null) return null;
  const longitudinalLabels = labelBlock(longitudinal, true, modeSet, elementAt(elementAt(a, 2), 2));
  const lateralLabels = labelBlock(lateral, false, modeSet, elementAt(elementAt(a, 5), 5));
  const candidates = [
    ...longitudinal.map((value, i) => ({ value, label: elementAt(longitudinalLabels, i) })),
    ...lateral.map((value, i) => ({ value, label: elementAt(lateralLabels, i) })),
  ];
  const used = new Set<number>();
  const labelOf = (value: ComplexValue): string => {
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
  };
  const modes = all.flatMap((value) => {
    const label = labelOf(value);
    return value.im >= 0 ? [modeOf(value, label)] : [];
  });
  const cross = (rows: readonly number[], columns: readonly number[]): number =>
    Math.max(0, ...rows.flatMap((i) => columns.map((j) => Math.abs(elementAt(elementAt(a, i), j)))));
  const total = Math.max(1e-300, ...a.flatMap((row) => row.map(Math.abs)));
  return { eigenvalues: all, modes, couplingRatio: Math.max(cross(LONGITUDINAL, LATERAL), cross(LATERAL, LONGITUDINAL)) / total };
}
