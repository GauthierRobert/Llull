/**
 * GVP comparison bands (aerospace 04 TECHNICAL_SPEC §5.3): green / yellow / red / not-checkable between the properties a sender embedded
 * and what llull recomputes from the geometry. The single band policy of llull; limits are data with their source.
 * @invariant pure; both sides are in the same length unit (`mmPerUnit` only converts the yellow centroid limit, given in millimetres)
 */

import type { GvpBand, GvpCheck, GvpComparison, GvpPolicy } from '../../model/exchange';
import type { Vec3 } from '../../model/types';

/** green: one order tighter than yellow, checked against NIST (01 KRN nist_gvp_vs_occt.json); yellow: CATIA STEP import default (1 %, 1 mm). */
export const DEFAULT_GVP_POLICY: GvpPolicy = { greenRel: 1e-3, yellowRel: 1e-2, greenCentroidPerDiag: 1e-3, yellowCentroidMm: 1 };

/** Where each default comes from (TR-XCH-23: named defaults with sources). */
export const GVP_POLICY_SOURCES: Readonly<Record<keyof GvpPolicy, string>> = {
  greenRel: 'llull §5.3: one order tighter than yellow; NIST sender-vs-OCCT agreement <= 9.4e-4 on the 6 consistent files',
  yellowRel: 'CATIA STEP import default (1 % volume / area), TECHNICAL_SPEC [R14]',
  greenCentroidPerDiag: 'llull §5.3: 1e-3 x bounding-box diagonal',
  yellowCentroidMm: 'CATIA STEP import default (1 mm centroid), TECHNICAL_SPEC [R14]',
};

/** One side of a comparison: any of the three properties may be missing; `diagonal` scales the green centroid limit. */
export interface GvpSample {
  readonly volume?: number | undefined;
  readonly area?: number | undefined;
  readonly centroid?: Vec3 | undefined;
}

const WORST: Readonly<Record<GvpBand, number>> = { green: 0, yellow: 1, red: 2, 'not-checkable': -1 };

/** The worst of `bands` (red > yellow > green); `not-checkable` when there is none. */
export function worstBand(bands: readonly GvpBand[]): GvpBand {
  const comparable = bands.filter((band) => band !== 'not-checkable');
  return comparable.length === 0 ? 'not-checkable' : comparable.reduce((current, band) => (WORST[band] > WORST[current] ? band : current));
}

/** Overrides of `DEFAULT_GVP_POLICY`; a non-positive or non-finite limit keeps the default. */
export function gvpPolicy(overrides: { readonly [K in keyof GvpPolicy]?: number | undefined } | undefined): GvpPolicy {
  const pick = (key: keyof GvpPolicy): number => {
    const value = overrides?.[key];
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_GVP_POLICY[key];
  };
  return {
    greenRel: pick('greenRel'),
    yellowRel: pick('yellowRel'),
    greenCentroidPerDiag: pick('greenCentroidPerDiag'),
    yellowCentroidMm: pick('yellowCentroidMm'),
  };
}

/** A sender record whose every value is zero (NIST STC-06 style placeholder): nothing to compare. */
export function isPlaceholder(sample: GvpSample): boolean {
  const zeroCentroid = sample.centroid === undefined || sample.centroid.every((value) => value === 0);
  return (sample.volume ?? 0) === 0 && (sample.area ?? 0) === 0 && zeroCentroid;
}

function relative(sender: number, receiver: number): number {
  return Math.abs(receiver - sender) / Math.max(Math.abs(sender), Number.EPSILON);
}

function bandOf(delta: number, green: number, yellow: number): GvpBand {
  return delta <= green ? 'green' : delta <= yellow ? 'yellow' : 'red';
}

/**
 * Compares `sender` (embedded, converted to the document unit) with `receiver` (recomputed). `diagonal` is the receiver's bounding-box diagonal
 * in the same unit. No comparable value, or a placeholder sender, is `not-checkable`; the overall band is the worst comparison.
 */
export function compareGvp(
  sender: GvpSample,
  receiver: GvpSample,
  diagonal: number,
  mmPerUnit: number,
  policy: GvpPolicy = DEFAULT_GVP_POLICY,
): GvpCheck {
  if (isPlaceholder(sender)) return { band: 'not-checkable', comparisons: [], policy };
  const comparisons: GvpComparison[] = [];
  for (const property of ['volume', 'area'] as const) {
    const from = sender[property];
    const to = receiver[property];
    if (from === undefined || to === undefined || from === 0) continue;
    const delta = relative(from, to);
    comparisons.push({ property, sender: from, receiver: to, delta, band: bandOf(delta, policy.greenRel, policy.yellowRel) });
  }
  if (sender.centroid !== undefined && receiver.centroid !== undefined) {
    const delta = Math.hypot(
      receiver.centroid[0] - sender.centroid[0],
      receiver.centroid[1] - sender.centroid[1],
      receiver.centroid[2] - sender.centroid[2],
    );
    const green = policy.greenCentroidPerDiag * diagonal;
    const yellow = policy.yellowCentroidMm / mmPerUnit;
    comparisons.push({
      property: 'centroid',
      sender: sender.centroid,
      receiver: receiver.centroid,
      delta,
      band: bandOf(delta, green, Math.max(yellow, green)),
    });
  }
  if (comparisons.length === 0) return { band: 'not-checkable', comparisons, policy };
  return { band: worstBand(comparisons.map((entry) => entry.band)), comparisons, policy };
}
