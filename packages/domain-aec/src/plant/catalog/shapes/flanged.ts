/**
 * Bolted-joint component shapes (plant 01 PSC M4): flanges (disc, raised face, optional hub, bolt holes), gaskets (annulus) and valves (envelope box).
 * @invariant pure; see `build.ts` for the frames; a missing dimension is a coded refusal
 */

import type { BoxEntity, ShapeRecipe } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { ASSUMED_GASKET_MM, raisedFaceHeightMm } from '../bolting';
import { CUT_OVERSHOOT_MM, frustumDiscs, profileDiscs, revolved, subtract, tube, unionAll, type Section } from './geometry';
import { ENDS, dim, finish, need, refusal, type ShapeOutcome, type ShapeSource } from './shared';

/** Most bolt holes drawn in a flange (B16.47 NPS 60 has 60): a hostile row cannot make the recipe grow without bound. */
const MAX_BOLT_HOLES = 128;

export function flangeShape(source: ShapeSource): ShapeOutcome {
  const lacking = need(source, 'outsideDiameter', 'thickness');
  if (lacking !== null) return lacking;
  const outer = dim(source, 'outsideDiameter') / 2;
  const thickness = dim(source, 'thickness');
  const pipeOd = source.pipeOdMm;
  const blind = source.type === 'flangeBlind';
  if (!blind && pipeOd === undefined)
    return refusal('PSC_SHAPE_UNSUPPORTED', 'a flange shape needs the pipe outside diameter at the size (its bore)');
  const bore = blind || pipeOd === undefined ? 0 : (pipeOd - 2 * (source.wallMm ?? 0)) / 2;
  const raisedFace = raisedFaceHeightMm(source.standard, source.ratingClass, source.facing) ?? 0;
  const faceRadius = (source.dims['raisedFaceDiameter'] ?? 0) / 2;
  const hubOd = source.dims['hubOd'];
  const hubTotal = source.dims['lengthThroughHub'];
  const inconsistent =
    (!blind && !(bore > 0)) ||
    bore >= outer ||
    faceRadius > outer ||
    (source.type === 'flangeWeldNeck' && hubOd !== undefined && (hubOd / 2 <= bore || hubOd / 2 > outer));
  if (inconsistent)
    return refusal(
      'PSC_CATALOG_DIM_MISMATCH',
      'the flange dimensions are inconsistent: need 0 < bore < flange radius, raised face and hub within the flange radius and the hub outside the bore (check outsideDiameter, hubOd, raisedFaceDiameter and the pipe wall)',
    );
  const hasHub =
    source.type === 'flangeWeldNeck' &&
    hubOd !== undefined &&
    hubTotal !== undefined &&
    hubTotal > thickness &&
    pipeOd !== undefined &&
    bore < pipeOd / 2;
  const hubExtension = hasHub ? (hubTotal as number) - thickness : 0;
  const notes: string[] = [];
  const drawFace = raisedFace > 0 && faceRadius > bore;
  if (raisedFace > 0 && !drawFace) notes.push('raised face not drawn: the row has no raisedFaceDiameter');
  if (source.type === 'flangeWeldNeck' && !hasHub) notes.push('hub not drawn: hubOd, lengthThroughHub or the pipe wall is missing');
  if (!blind && source.wallMm === undefined) notes.push('no pipe wall: bore taken as the pipe outside diameter');
  const profile: Section = [
    ...(drawFace
      ? ([
          [bore, -raisedFace],
          [faceRadius, -raisedFace],
          [faceRadius, 0],
        ] as Section)
      : ([[bore, 0]] as Section)),
    [outer, 0],
    [outer, thickness],
    ...(hasHub
      ? ([
          [(hubOd as number) / 2, thickness],
          [(pipeOd as number) / 2, thickness + hubExtension],
          [bore, thickness + hubExtension],
        ] as Section)
      : ([[bore, thickness]] as Section)),
  ];
  const body = revolved('flange', profile);
  const count = source.dims['boltCount'];
  const circle = source.dims['boltCircle'];
  const hole = source.dims['boltHole'];
  const circleRadius = (source.dims['boltCircle'] ?? 0) / 2;
  const holeRadius = (source.dims['boltHole'] ?? 0) / 2;
  if (circleRadius + holeRadius > outer || (circleRadius > 0 && circleRadius - holeRadius <= bore))
    return refusal(
      'PSC_CATALOG_DIM_MISMATCH',
      'the bolt holes do not fit between the bore and the flange outside diameter (check boltCircle and the bolt hole)',
    );
  const canDrill =
    count !== undefined &&
    circle !== undefined &&
    hole !== undefined &&
    Number.isInteger(count) &&
    count >= 1 &&
    count <= MAX_BOLT_HOLES &&
    hole > 0;
  if (!canDrill) notes.push(`bolt holes not drawn: the row lacks boltCount (1 to ${MAX_BOLT_HOLES}) / boltCircle / bolt hole`);
  const holes: ShapeRecipe[] = canDrill
    ? Array.from({ length: count }, (_, k) => {
        const angle = (2 * Math.PI * (k + 0.5)) / count;
        const at: Vec3 = [(circle / 2) * Math.cos(angle), (circle / 2) * Math.sin(angle), -raisedFace - CUT_OVERSHOOT_MM];
        return tube(`flange-hole-${k}`, at, [0, 0, 1], raisedFace + thickness + 2 * CUT_OVERSHOOT_MM, hole / 2);
      })
    : [];
  const recipe = holes.length === 0 ? body : subtract(body, unionAll(holes as [ShapeRecipe, ...ShapeRecipe[]]));
  const pipeSide = thickness + hubExtension;
  const portOd = pipeOd ?? 2 * outer;
  return finish({
    recipe,
    discs: profileDiscs(profile),
    ports: [
      { id: 'face', position: [0, 0, -raisedFace], direction: [0, 0, -1], outsideDiameterMm: portOd, endType: 'FL' },
      ...(blind
        ? []
        : [
            {
              id: 'pipe',
              position: [0, 0, pipeSide] as Vec3,
              direction: [0, 0, 1] as Vec3,
              outsideDiameterMm: portOd,
              endType: ENDS[source.type] ?? null,
            },
          ]),
    ],
    hollow: !blind,
    notes,
    frame: 'axis +Z; mating face at z = -raised face, back of the plate at z = thickness; holes straddle the X and Y axes',
  });
}

export function gasketShape(source: ShapeSource): ShapeOutcome {
  if (source.type === 'gasketRing')
    return refusal('PSC_SHAPE_UNSUPPORTED', 'ring-joint gaskets (octagonal / oval section) are not modelled');
  const inner = (source.dims['innerRingId'] ?? (source.pipeOdMm === undefined ? undefined : source.pipeOdMm - 2 * (source.wallMm ?? 0))) as
    | number
    | undefined;
  const outer = source.dims['centeringRingOd'] ?? source.dims['sealingElementOd'] ?? source.dims['outsideDiameter'];
  if (inner === undefined || outer === undefined || !(outer > inner))
    return refusal(
      'PSC_SHAPE_UNSUPPORTED',
      'a gasket shape needs an inner ring ID and an outer ring OD (innerRingId, centeringRingOd or sealingElementOd)',
    );
  if (!(inner > 0))
    return refusal(
      'PSC_CATALOG_DIM_MISMATCH',
      'the gasket inner diameter is not positive (innerRingId, or pipe outside diameter less twice the wall)',
    );
  const assumed = source.dims['thickness'] === undefined;
  const thickness = source.dims['thickness'] ?? ASSUMED_GASKET_MM[source.type];
  if (thickness === undefined) return refusal('PSC_CATALOG_ROW_MISSING', `the ${source.type} row has no thickness`);
  const profile: Section = [
    [inner / 2, 0],
    [outer / 2, 0],
    [outer / 2, thickness],
    [inner / 2, thickness],
  ];
  return finish({
    recipe: revolved('gasket', profile),
    discs: profileDiscs(profile),
    ports: [
      { id: 'A', position: [0, 0, 0], direction: [0, 0, -1], outsideDiameterMm: outer, endType: 'FL' },
      { id: 'B', position: [0, 0, thickness], direction: [0, 0, 1], outsideDiameterMm: outer, endType: 'FL' },
    ],
    hollow: true,
    notes: assumed ? [`thickness ${thickness} mm ASSUMED (no thickness in the row)`] : [],
    frame: 'axis +Z; annulus from z = 0 to z = thickness',
  });
}

export function valveShape(source: ShapeSource): ShapeOutcome {
  const lacking = need(source, 'faceToFace');
  if (lacking !== null) return lacking;
  const length = dim(source, 'faceToFace');
  const width = source.flangeOdMm ?? source.dims['flangeOutsideDiameter'];
  if (width === undefined)
    return refusal(
      'PSC_SHAPE_UNSUPPORTED',
      'a valve envelope needs the flange outside diameter at the size and class (no flange row found)',
    );
  const entity: BoxEntity = {
    id: 'valve',
    kind: 'box',
    layerId: '0',
    color: '#c0504d',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    size: [width, width, length],
  };
  const port = source.pipeOdMm ?? width;
  return finish({
    recipe: { op: 'solid', entity },
    discs: frustumDiscs([0, 0, -length / 2], [0, 0, 1], length, width / 2, width / 2),
    ports: [
      { id: 'A', position: [0, 0, -length / 2], direction: [0, 0, -1], outsideDiameterMm: port, endType: 'FL' },
      { id: 'B', position: [0, 0, length / 2], direction: [0, 0, 1], outsideDiameterMm: port, endType: 'FL' },
    ],
    hollow: false,
    notes: ['envelope box (face-to-face by flange diameter squared), not a valve body'],
    frame: 'box centred at the origin; flow along Z',
  });
}
