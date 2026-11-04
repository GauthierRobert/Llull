/**
 * Shapes of the straight and closing fittings (plant 01 PSC, CAT-FU): caps, couplings, unions, swages (as concentric reducers) and eccentric reducers.
 * Dimensions come from the catalogue row only (`length`, `bodyOd`, the pipe outside diameters); nothing is guessed, a missing one is a coded refusal.
 *  - cap / coupling / union: axis +Z from 0 to the length; a cap has one port (open end at z = 0).
 *  - eccentric reducer: axis +Z, large end centred on the axis at z = 0, small end at z = length with its centre shifted by (D - d) / 2 toward +X
 *    (the flat side is +X); the body is a ruled loft of two circles, so the exact volume is that of an oblique frustum within the polygon error.
 * @invariant pure
 */

import type { LoftEntity, ShapeRecipe } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { SECTION_RING_POINTS } from '@core/geometry/sectionRing';
import type { EndType } from '../types';
import { CUT_OVERSHOOT_MM, profileDiscs, revolved, subtract, tube, type Disc, type Section } from './geometry';
import { dim, finish, missing, need, refusal, type ShapeOutcome, type ShapeSource } from './shared';

/** End type of a forged fitting row: socket depth = socket weld, thread length = threaded, else unknown (null). */
const forgedEnd = (source: ShapeSource): EndType | null =>
  source.dims['socketDepth'] !== undefined ? 'SW' : source.dims['threadLength'] !== undefined ? 'THD' : null;

/** Cap: a closed-end cylinder of the row length (the dome profile is not tabulated, so the closed end is drawn flat). */
export function capShape(source: ShapeSource): ShapeOutcome {
  const lacking = need(source, 'length');
  if (lacking !== null) return lacking;
  const length = dim(source, 'length');
  const od = source.dims['outsideDiameter'] ?? source.dims['bodyOd'] ?? source.pipeOdMm;
  if (od === undefined)
    return refusal(
      'PSC_SHAPE_UNSUPPORTED',
      'a cap shape needs an outside diameter (row outsideDiameter / bodyOd, or the pipe at the size)',
    );
  const wall = source.wallMm;
  const hollow = wall !== undefined && wall > 0 && wall < od / 2 && wall < length;
  const profile: Section = hollow
    ? [
        [od / 2 - (wall as number), 0],
        [od / 2, 0],
        [od / 2, length],
        [0, length],
        [0, length - (wall as number)],
        [od / 2 - (wall as number), length - (wall as number)],
      ]
    : [
        [0, 0],
        [od / 2, 0],
        [od / 2, length],
        [0, length],
      ];
  return finish({
    recipe: revolved('cap', profile),
    discs: profileDiscs(profile),
    ports: [
      {
        id: 'A',
        position: [0, 0, 0],
        direction: [0, 0, -1],
        outsideDiameterMm: od,
        endType: source.dims['socketDepth'] === undefined ? 'BW' : 'SW',
      },
    ],
    hollow,
    notes: [
      'closed end drawn flat: the dome profile is not tabulated',
      ...(hollow ? ['end wall assumed equal to the pipe wall'] : ['no wall: drawn solid']),
    ],
    frame: 'axis +Z from 0 to the length; the open end is at z = 0',
  });
}

/** Coupling and union: a body of the row `bodyOd` and `length`, drawn solid (the socket or thread bore is not modelled). */
export function straightFittingShape(source: ShapeSource): ShapeOutcome {
  const lacking = need(source, 'length', 'bodyOd');
  if (lacking !== null) return lacking;
  const [length, body] = [dim(source, 'length'), dim(source, 'bodyOd')];
  const end = forgedEnd(source);
  return finish({
    recipe: tube(source.type, [0, 0, 0], [0, 0, 1], length, body / 2),
    discs: profileDiscs([
      [0, 0],
      [body / 2, 0],
      [body / 2, length],
      [0, length],
    ]),
    ports: [
      { id: 'A', position: [0, 0, 0], direction: [0, 0, -1], outsideDiameterMm: source.pipeOdMm ?? body, endType: end },
      { id: 'B', position: [0, 0, length], direction: [0, 0, 1], outsideDiameterMm: source.pipeOdMm ?? body, endType: end },
    ],
    hollow: false,
    notes: [`${source.type} drawn solid: the ${end === 'THD' ? 'thread' : 'socket'} bore is not modelled`],
    frame: 'axis +Z from 0 to the length',
  });
}

const ring = (centre: Vec3, radius: number): Vec3[] =>
  Array.from({ length: SECTION_RING_POINTS }, (_, k): Vec3 => {
    const angle = (2 * Math.PI * k) / SECTION_RING_POINTS;
    return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle), centre[2]];
  });

/** Ruled loft of the oblique frustum with end radii `large` / `small`; `overshoot` extends both ends along the same slope (bores that must pass through). */
const loft = (id: string, large: number, small: number, length: number, offset: number, overshoot = 0): ShapeRecipe => {
  const at = (z: number): { radius: number; shift: number } => ({
    radius: large + ((small - large) * z) / length,
    shift: (offset * z) / length,
  });
  const [first, last] = [at(-overshoot), at(length + overshoot)];
  const entity: LoftEntity = {
    id,
    kind: 'loft',
    layerId: '0',
    color: '#8f98a3',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    rings: [ring([first.shift, 0, -overshoot], first.radius), ring([last.shift, 0, length + overshoot], last.radius)],
    ruled: true,
  };
  return { op: 'solid', entity };
};

/** Eccentric reducer: ruled loft between the large end circle and the small end circle shifted toward +X (the flat side). */
export function eccentricReducerShape(source: ShapeSource): ShapeOutcome {
  const lacking = need(source, 'length');
  if (lacking !== null) return lacking;
  const length = dim(source, 'length');
  const od = source.dims['outsideDiameter'] ?? source.pipeOdMm;
  const small = source.smallPipeOdMm ?? source.dims['smallOutsideDiameter'];
  if (od === undefined || small === undefined)
    return refusal('PSC_SHAPE_UNSUPPORTED', 'a reducer shape needs the large and small end outside diameters');
  if (!(od > small)) return missing(source, 'a small end smaller than the large end');
  const offset = (od - small) / 2;
  const wall = source.wallMm;
  const hollow = wall !== undefined && wall > 0 && wall < small / 2;
  const outer = loft('reducer-ecc', od / 2, small / 2, length, offset);
  const discs: Disc[] = [
    { centre: [0, 0, 0], normal: [0, 0, 1], radius: od / 2 },
    { centre: [offset, 0, length], normal: [0, 0, 1], radius: small / 2 },
  ];
  return finish({
    recipe: hollow
      ? subtract(outer, loft('reducer-ecc-bore', od / 2 - (wall as number), small / 2 - (wall as number), length, offset, CUT_OVERSHOOT_MM))
      : outer,
    discs,
    ports: [
      { id: 'A', position: [0, 0, 0], direction: [0, 0, -1], outsideDiameterMm: od, endType: 'BW' },
      { id: 'B', position: [offset, 0, length], direction: [0, 0, 1], outsideDiameterMm: small, endType: 'BW' },
    ],
    hollow,
    notes: [
      `small end axis offset ${offset.toFixed(3)} mm toward +X (the flat side)`,
      'ruled loft of two circles (24 points each): the surface is a polygonal approximation of the oblique frustum',
      ...(hollow ? ['same wall at both ends assumed'] : ['no wall: drawn solid']),
    ],
    frame: 'axis +Z, large end centred at z = 0, small end at z = length shifted toward +X; the flat side is +X',
  });
}
