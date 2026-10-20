/**
 * Flow domain from the body bounds in the case frame (x along the flow, z up), metres (TECHNICAL_SPEC §5.1 step 10, FR-CFD-04):
 * buildings by COST 732 / AIJ, external aerodynamics by named llull defaults (subsonic and supersonic), or the user's custom box.
 */

import type { Vec3 } from '@core/model/types';
import type { CfdCase } from '@core/model/cfd';
import type { DefaultNote } from './caseParams';

/** Blockage (frontal area / domain cross-section) above which a case is refused. */
export const MAX_BLOCKAGE = 0.03;

export interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface DomainSizing {
  readonly box: Box;
  /** Upstream / downstream / lateral / vertical margins in units of the length scale (H or L). */
  readonly rule: CfdCase['domain']['rule'];
  readonly lengthScaleM: number;
  readonly basis: string;
  readonly defaults: DefaultNote[];
}

const SOURCE_AERO = 'llull named default for external aerodynamics (checked by VC-CFD-13), not a published rule';
const SOURCE_COST = 'COST Action 732 / AIJ guidelines (grade B secondary extracts, docs/aerospace/12-cfd-gpu/validation/sources.md)';
const SOURCE_SUPERSONIC =
  'llull named default: no upstream influence in supersonic flow; the Mach cone from the nose stays inside at the outlet';

const at = (v: Vec3, axis: number): number => v[axis] ?? 0;
const note = (path: string, value: unknown, source: string): DefaultNote => ({ path, value, source });

/** The box of the margins around `bounds`; `ground` pins the bottom to the lowest point of the body. */
const margins = (bounds: Box, up: number, down: number, side: number, below: number, above: number, ground: boolean): Box => ({
  min: [bounds.min[0] - up, bounds.min[1] - side, ground ? bounds.min[2] : bounds.min[2] - below],
  max: [bounds.max[0] + down, bounds.max[1] + side, bounds.max[2] + above],
});

/**
 * @invariant bounds are the body extremes in the case frame; `symmetric` halves the lateral extent (y from 0)
 * @failure custom rule without a box -> the body bounds are returned unchanged (the case validation refuses it earlier)
 */
export function sizeDomain(cfdCase: Pick<CfdCase, 'domain' | 'ground'>, bounds: Box, machNumber: number): DomainSizing {
  const extent = [0, 1, 2].map((axis) => at(bounds.max, axis) - at(bounds.min, axis));
  const length = Math.max(...extent);
  const symmetric = cfdCase.domain.symmetryPlane === 'xz';
  const finish = (box: Box, rule: DomainSizing['rule'], scale: number, basis: string, defaults: DefaultNote[]): DomainSizing => ({
    box: symmetric ? { min: [box.min[0], 0, box.min[2]], max: [box.max[0], Math.max(box.max[1], -box.min[1]), box.max[2]] } : box,
    rule,
    lengthScaleM: scale,
    basis,
    defaults,
  });
  const { rule } = cfdCase.domain;
  if (rule === 'custom') {
    const box = cfdCase.domain.box ?? bounds;
    return finish({ min: box.min, max: box.max }, rule, length, 'custom box given in the case', []);
  }
  if (rule === 'buildings') {
    const height = extent[2] ?? 0;
    const box = margins(bounds, 5 * height, 15 * height, 5 * height, 0, 5 * height, true);
    return finish(
      box,
      rule,
      height,
      'buildings: 5H upstream, 5H each side, 5H above the tallest building, 15H downstream, ground at the lowest point (H = building height)',
      [note('domain.margins', { upstream: '5H', side: '5H', top: '5H', downstream: '15H' }, SOURCE_COST)],
    );
  }
  const ground = cfdCase.ground.enabled;
  if (machNumber > 1) {
    const outletX = bounds.max[0] + 2 * length;
    const coneRadius = (outletX - bounds.min[0]) * Math.tan(Math.asin(1 / machNumber));
    const half = (axis: 1 | 2): number => Math.max(coneRadius + 0.5 * length, (extent[axis] ?? 0) / 2 + 0.5 * length);
    const centre = (axis: 1 | 2): number => (at(bounds.min, axis) + at(bounds.max, axis)) / 2;
    const box: Box = {
      min: [bounds.min[0] - 0.5 * length, centre(1) - half(1), ground ? bounds.min[2] : centre(2) - half(2)],
      max: [outletX, centre(1) + half(1), centre(2) + half(2)],
    };
    return finish(
      box,
      rule,
      length,
      'external_aero supersonic: 0.5L upstream, 2L downstream, Mach cone from the nose plus 0.5L at the outlet',
      [note('domain.margins', { upstream: '0.5L', downstream: '2L', lateral: 'Mach cone + 0.5L' }, SOURCE_SUPERSONIC)],
    );
  }
  return finish(
    margins(bounds, 5 * length, 15 * length, 5 * length, 5 * length, 5 * length, ground),
    rule,
    length,
    'external_aero subsonic: 5L upstream, 5L to the sides, above and below, 15L downstream (L = largest body extent)',
    [note('domain.margins', { upstream: '5L', side: '5L', vertical: '5L', downstream: '15L' }, SOURCE_AERO)],
  );
}

/** Frontal area over the domain cross-section (y-z), the cross-section doubled when only half the domain is simulated. */
export function blockageRatio(frontalAreaM2: number, box: Box, halved: boolean): number {
  const section = (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]) * (halved ? 2 : 1);
  return section > 0 ? frontalAreaM2 / section : Infinity;
}

/** Whether `inner` lies inside `outer` (a small tolerance for float noise). */
export function boxContains(outer: Box, inner: Box, tolerance = 1e-9): boolean {
  return [0, 1, 2].every(
    (axis) => at(inner.min, axis) >= at(outer.min, axis) - tolerance && at(inner.max, axis) <= at(outer.max, axis) + tolerance,
  );
}
