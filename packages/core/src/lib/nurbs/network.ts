/**
 * Sorting an unordered curve network (SWG M7, Rhino NetworkSrf rule [R9]): curves that cross form a bipartite graph, so a network is two families
 * (every curve of one meets every curve of the other, none meets its own family). Each family is ordered by where it crosses a curve of the other
 * and oriented consistently, ready for the Gordon surface.
 */

import { reverseCurve } from './edit';
import { meetCurves } from './meet';
import type { NurbsCurveData } from './types';

export interface NetworkIssue {
  readonly code: 'SWG_NETWORK_UNSORTABLE' | 'SWG_NETWORK_NOT_INTERSECTING';
  readonly message: string;
  /** Indices (into the input) of the curves involved. */
  readonly curves: readonly number[];
}

export interface SortedNetwork {
  /** Family of the first input curve, ordered along the other family and oriented alike. */
  readonly sections: NurbsCurveData[];
  readonly guides: NurbsCurveData[];
  /** Input index of each ordered curve. */
  readonly sectionIndices: number[];
  readonly guideIndices: number[];
  /** Largest gap between crossing curves. */
  readonly gap: number;
}

interface Crossing {
  /** Fraction (0..1 of the parameter domain) on the first / second curve of the pair. */
  readonly ta: number;
  readonly tb: number;
  readonly gap: number;
}

/** Whether the pole boxes of two curves, grown by `margin`, overlap (a cheap rejection before the closest-point search). */
function boxesOverlap(a: NurbsCurveData, b: NurbsCurveData, margin: number): boolean {
  return [0, 1, 2].every((axis) => {
    const [pa, pb] = [a.poles.map((pole) => pole[axis] as number), b.poles.map((pole) => pole[axis] as number)];
    return Math.min(...pa) - margin <= Math.max(...pb) && Math.min(...pb) - margin <= Math.max(...pa);
  });
}

/** Most curves of one network. */
export const MAX_NETWORK_CURVES = 120;

/**
 * The two ordered, oriented families of `curves`.
 * @failure fewer than 2 curves in a crossing family, a pair crossing twice, curves crossing within their own family or meeting nothing -> SWG_NETWORK_UNSORTABLE; a cross pair that does not meet within `tolerance` -> SWG_NETWORK_NOT_INTERSECTING
 */
export function sortNetwork(curves: readonly NurbsCurveData[], tolerance: number): SortedNetwork | NetworkIssue {
  const n = curves.length;
  const crossings = new Map<string, Crossing>();
  const key = (i: number, j: number): string => (i < j ? `${i},${j}` : `${j},${i}`);
  const adjacent: number[][] = Array.from({ length: n }, () => []);
  let gap = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (!boxesOverlap(curves[i] as NurbsCurveData, curves[j] as NurbsCurveData, tolerance)) continue;
      const [ta, tb, g, again] = meetCurves(curves[i] as NurbsCurveData, curves[j] as NurbsCurveData, tolerance);
      if (g > tolerance) continue;
      if (again)
        return {
          code: 'SWG_NETWORK_UNSORTABLE',
          message: `curves ${i} and ${j} cross more than once: the crossing is ambiguous`,
          curves: [i, j],
        };
      crossings.set(key(i, j), { ta, tb, gap: g });
      (adjacent[i] as number[]).push(j);
      (adjacent[j] as number[]).push(i);
      gap = Math.max(gap, g);
    }
  const colour: number[] = new Array<number>(n).fill(-1);
  colour[0] = 0;
  const queue = [0];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] as number;
    for (const j of adjacent[i] as number[]) {
      if (colour[j] === -1) {
        colour[j] = 1 - (colour[i] as number);
        queue.push(j);
      } else if (colour[j] === colour[i])
        return {
          code: 'SWG_NETWORK_UNSORTABLE',
          message: `curves ${i} and ${j} cross but would belong to the same family`,
          curves: [i, j],
        };
    }
  }
  const lost = colour.findIndex((c) => c === -1);
  if (lost >= 0)
    return {
      code: 'SWG_NETWORK_UNSORTABLE',
      message: `curve ${lost} is not connected to curve 0 through crossings within ${tolerance}`,
      curves: [lost],
    };
  const families: [number[], number[]] = [[], []];
  colour.forEach((c, i) => families[c as 0 | 1].push(i));
  for (const a of families[0])
    for (const b of families[1])
      if (!crossings.has(key(a, b)))
        return { code: 'SWG_NETWORK_NOT_INTERSECTING', message: `curves ${a} and ${b} do not meet within ${tolerance}`, curves: [a, b] };
  const [sectionFamily, guideFamily] = families;
  // one curve in a family has no order or direction to take from the others
  if (sectionFamily.length < 2 || guideFamily.length < 2)
    return {
      code: 'SWG_NETWORK_UNSORTABLE',
      message: `a network needs at least 2 curves in each family (found ${sectionFamily.length} and ${guideFamily.length})`,
      curves: [],
    };
  /** Fraction on `curve` (index `from`) where it crosses `other`. */
  const along = (from: number, other: number): number => {
    const c = crossings.get(key(from, other)) as Crossing;
    return from < other ? c.ta : c.tb;
  };
  const referenceGuide = guideFamily[0] as number;
  const sections = [...sectionFamily].sort((x, y) => along(referenceGuide, x) - along(referenceGuide, y));
  const referenceSection = sections[0] as number;
  const guides = [...guideFamily].sort((x, y) => along(referenceSection, x) - along(referenceSection, y));
  const orient = (index: number, others: readonly number[]): NurbsCurveData => {
    const first = along(index, others[0] as number);
    const last = along(index, others[others.length - 1] as number);
    const curve = curves[index] as NurbsCurveData;
    return last < first ? reverseCurve(curve) : curve;
  };
  return {
    sections: sections.map((i) => orient(i, guides)),
    guides: guides.map((i) => orient(i, sections)),
    sectionIndices: sections,
    guideIndices: guides,
    gap,
  };
}
