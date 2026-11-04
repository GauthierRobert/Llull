/**
 * Component shapes (TR-PSC-16, spec 5.8): a shape recipe, analytic bounds and ports per component type, in the component's local frame (millimetres).
 *  - pipe: axis +Z from 0 to the length.
 *  - elbow: bend centre at the origin, sweep in the XY plane from +X; end faces at the bend ends (VC-PSC-19: 90 degrees, extent R + OD/2 in x and y, OD in z).
 *  - tee / olet: run along X centred at the origin, branch along +Y.
 *  - reducer, flange, gasket, valve: axis +Z; flange mating face at z = -raised face, back of the plate at z = thickness.
 * @invariant pure; a dimension a shape needs but the row lacks is a coded refusal (never a guess); a guess-free simplification (hub omitted, same wall at both ends) is named in `notes`
 */

import type { ShapeRecipe } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { MM_PER_INCH } from '../bolting';
import type { BendRadius, EndType } from '../types';
import { capShape, eccentricReducerShape, straightFittingShape } from './fittings';
import { flangeShape, gasketShape, valveShape } from './flanged';
import {
  CUT_OVERSHOOT_MM,
  bendDiscs,
  bendSolid,
  frustumDiscs,
  profileDiscs,
  revolved,
  subtract,
  tube,
  unionAll,
  type Disc,
  type Section,
} from './geometry';
import { ENDS, dim, finish, missing, need, refusal, type ShapeOutcome, type ShapeSource } from './shared';

const BEND_FACTOR: Readonly<Record<BendRadius, number>> = { LR: 1.5, SR: 1, '3D': 3, '5D': 5 };
/** A tangent shorter than this is zero (the 90 degree case, R tan 45 = R, differs by rounding only). */
const TANGENT_EPSILON_MM = 1e-6;
/** The tabulated centre-to-end may be this much shorter than R tan(theta/2) (rounded tables) before the row is called inconsistent. */
const TANGENT_TOLERANCE_MM = 0.5;

function pipeShape(source: ShapeSource): ShapeOutcome {
  const od = source.pipeOdMm ?? source.dims['outsideDiameter'];
  if (od === undefined || source.lengthMm === undefined || !(source.lengthMm > 0))
    return refusal('PSC_SHAPE_UNSUPPORTED', 'a pipe shape needs an outside diameter and lengthMm > 0');
  const inner = source.wallMm === undefined ? 0 : od / 2 - source.wallMm;
  const length = source.lengthMm;
  return finish({
    recipe: tube('pipe', [0, 0, 0], [0, 0, 1], length, od / 2, Math.max(inner, 0)),
    discs: frustumDiscs([0, 0, 0], [0, 0, 1], length, od / 2, od / 2),
    ports: [
      { id: 'A', position: [0, 0, 0], direction: [0, 0, -1], outsideDiameterMm: od, endType: 'PE' },
      { id: 'B', position: [0, 0, length], direction: [0, 0, 1], outsideDiameterMm: od, endType: 'PE' },
    ],
    hollow: inner > 0,
    notes: source.wallMm === undefined ? ['no wall: drawn solid'] : [],
    frame: 'axis +Z from 0 to the length',
  });
}

function elbowShape(source: ShapeSource, sweepDeg: number): ShapeOutcome {
  const lacking = need(source, 'centreToEnd');
  if (lacking !== null) return lacking;
  const od = source.dims['outsideDiameter'] ?? source.dims['bodyOd'] ?? source.pipeOdMm;
  if (od === undefined)
    return refusal(
      'PSC_SHAPE_UNSUPPORTED',
      'an elbow shape needs an outside diameter (row outsideDiameter / bodyOd, or the pipe at the size)',
    );
  const centreToEnd = dim(source, 'centreToEnd');
  const sweep = (sweepDeg * Math.PI) / 180;
  const half = Math.tan(sweep / 2);
  const factor = source.radius === undefined ? undefined : BEND_FACTOR[source.radius];
  const radius =
    sweepDeg === 90
      ? centreToEnd
      : factor !== undefined && source.npsValue !== null
        ? factor * source.npsValue * MM_PER_INCH
        : centreToEnd / half;
  const notes: string[] = [];
  if (!(radius > od / 2))
    return refusal('PSC_CATALOG_DIM_MISMATCH', `bend radius ${radius.toFixed(2)} mm is not larger than the pipe radius ${od / 2} mm`);
  let tangent = centreToEnd - radius * half;
  if (tangent < -TANGENT_TOLERANCE_MM)
    return refusal(
      'PSC_CATALOG_DIM_MISMATCH',
      `centre-to-end ${centreToEnd} mm is shorter than the bend allows (R tan(theta/2) = ${(radius * half).toFixed(2)} mm)`,
    );
  if (tangent < TANGENT_EPSILON_MM) {
    if (tangent < 0 && Math.abs(tangent) > 0.01)
      notes.push(`tabulated centre-to-end is ${(-tangent).toFixed(2)} mm short of R tan(theta/2): no straight ends`);
    tangent = 0;
  } else if (tangent > 3 * od)
    return refusal('PSC_CATALOG_DIM_MISMATCH', `tangent length ${tangent.toFixed(2)} mm exceeds three pipe diameters`);
  else notes.push(`straight ends of ${tangent.toFixed(2)} mm: tabulated centre-to-end exceeds R tan(theta/2)`);
  const wall = source.wallMm;
  const hollow = wall !== undefined && wall > 0 && wall < od / 2;
  const endAt = (angle: number, extra: number): Vec3 => [
    radius * Math.cos(angle) - extra * Math.sin(angle),
    radius * Math.sin(angle) + extra * Math.cos(angle),
    0,
  ];
  const startDir: Vec3 = [0, 1, 0];
  const endDir: Vec3 = [-Math.sin(sweep), Math.cos(sweep), 0];
  const solids = (r: number, tag: string): ShapeRecipe =>
    tangent === 0
      ? bendSolid(`elbow-${tag}`, radius, r, sweep)
      : unionAll([
          bendSolid(`elbow-${tag}`, radius, r, sweep),
          tube(`elbow-in-${tag}`, [radius, -tangent, 0], startDir, tangent, r),
          tube(`elbow-out-${tag}`, endAt(sweep, 0), endDir, tangent, r),
        ]);
  const cut = (r: number): ShapeRecipe =>
    unionAll([
      bendSolid('elbow-bore', radius, r, sweep),
      tube('elbow-in-bore', [radius, -tangent - CUT_OVERSHOOT_MM, 0], startDir, tangent + 2 * CUT_OVERSHOOT_MM, r),
      tube('elbow-out-bore', endAt(sweep, -CUT_OVERSHOOT_MM), endDir, tangent + 2 * CUT_OVERSHOOT_MM, r),
    ]);
  const outer = solids(od / 2, 'outer');
  const end: EndType = source.dims['socketDepth'] === undefined ? 'BW' : 'SW';
  const discs: Disc[] = [
    ...bendDiscs(radius, od / 2, sweep),
    ...(tangent === 0
      ? []
      : [
          ...frustumDiscs([radius, -tangent, 0], startDir, tangent, od / 2, od / 2),
          ...frustumDiscs(endAt(sweep, 0), endDir, tangent, od / 2, od / 2),
        ]),
  ];
  return finish({
    recipe: hollow ? subtract(outer, cut(od / 2 - (wall as number))) : outer,
    discs,
    ports: [
      { id: 'A', position: [radius, 0 - tangent, 0], direction: [0, -1, 0], outsideDiameterMm: od, endType: end },
      { id: 'B', position: endAt(sweep, tangent), direction: endDir, outsideDiameterMm: od, endType: end },
    ],
    hollow,
    notes: [...notes, ...(hollow ? [] : ['no wall: drawn solid'])],
    frame: `bend centre at the origin, ${sweepDeg} degrees in the XY plane from +X, bend radius ${radius.toFixed(3)} mm`,
  });
}

function teeShape(source: ShapeSource): ShapeOutcome {
  const run = source.dims['centreToEndRun'] ?? source.dims['centreToEnd'];
  const reducing = source.type === 'reducingTee';
  const branchLength = source.dims['centreToEndBranch'] ?? (reducing ? undefined : run);
  const od = source.dims['outsideDiameter'] ?? source.dims['bodyOd'] ?? source.pipeOdMm;
  const branchOd = reducing ? (source.smallPipeOdMm ?? source.dims['smallOutsideDiameter']) : od;
  if (run === undefined || branchLength === undefined) return missing(source, run === undefined ? 'centreToEndRun' : 'centreToEndBranch');
  if (od === undefined || branchOd === undefined)
    return refusal('PSC_SHAPE_UNSUPPORTED', 'a tee shape needs the run and branch outside diameters');
  const wall = source.wallMm;
  const hollow = wall !== undefined && wall > 0 && wall < branchOd / 2 && wall < od / 2;
  const outer = unionAll([
    tube('tee-run', [-run, 0, 0], [1, 0, 0], 2 * run, od / 2),
    tube('tee-branch', [0, 0, 0], [0, 1, 0], branchLength, branchOd / 2),
  ]);
  const bore = (): ShapeRecipe =>
    unionAll([
      tube('tee-run-bore', [-run - CUT_OVERSHOOT_MM, 0, 0], [1, 0, 0], 2 * run + 2 * CUT_OVERSHOOT_MM, od / 2 - (wall as number)),
      tube('tee-branch-bore', [0, 0, 0], [0, 1, 0], branchLength + CUT_OVERSHOOT_MM, branchOd / 2 - (wall as number)),
    ]);
  return finish({
    recipe: hollow ? subtract(outer, bore()) : outer,
    discs: [
      ...frustumDiscs([-run, 0, 0], [1, 0, 0], 2 * run, od / 2, od / 2),
      ...frustumDiscs([0, 0, 0], [0, 1, 0], branchLength, branchOd / 2, branchOd / 2),
    ],
    ports: [
      { id: 'A', position: [-run, 0, 0], direction: [-1, 0, 0], outsideDiameterMm: od, endType: 'BW' },
      { id: 'B', position: [run, 0, 0], direction: [1, 0, 0], outsideDiameterMm: od, endType: 'BW' },
      { id: 'C', position: [0, branchLength, 0], direction: [0, 1, 0], outsideDiameterMm: branchOd, endType: 'BW' },
    ],
    hollow,
    notes: [
      ...(hollow ? [] : ['no wall: drawn solid']),
      ...(hollow && reducing ? ['branch wall assumed equal to the run wall'] : []),
      ...(source.type === 'tee' && source.dims['centreToEndBranch'] === undefined
        ? ['equal tee: branch centre-to-end equals the run value']
        : []),
    ],
    frame: 'run along X centred at the origin, branch along +Y',
  });
}

function reducerShape(source: ShapeSource): ShapeOutcome {
  if (source.type === 'reducerEccentric') return eccentricReducerShape(source);
  const lacking = need(source, 'length');
  if (lacking !== null) return lacking;
  const length = dim(source, 'length');
  const od = source.dims['outsideDiameter'] ?? source.pipeOdMm;
  const small = source.smallPipeOdMm ?? source.dims['smallOutsideDiameter'];
  if (od === undefined || small === undefined)
    return refusal('PSC_SHAPE_UNSUPPORTED', 'a reducer shape needs the large and small end outside diameters');
  const end: EndType | null = source.type === 'swage' ? null : 'BW';
  const wall = source.wallMm;
  const hollow = wall !== undefined && wall > 0 && wall < small / 2;
  const profile: Section = hollow
    ? [
        [od / 2 - (wall as number), 0],
        [od / 2, 0],
        [small / 2, length],
        [small / 2 - (wall as number), length],
      ]
    : [
        [0, 0],
        [od / 2, 0],
        [small / 2, length],
        [0, length],
      ];
  return finish({
    recipe: revolved('reducer', profile),
    discs: profileDiscs(profile),
    ports: [
      { id: 'A', position: [0, 0, 0], direction: [0, 0, -1], outsideDiameterMm: od, endType: end },
      { id: 'B', position: [0, 0, length], direction: [0, 0, 1], outsideDiameterMm: small, endType: end },
    ],
    hollow,
    notes: [
      ...(source.type === 'swage' ? ['swage drawn as a concentric reducer; its end types are not tabulated'] : []),
      ...(hollow ? ['same wall at both ends assumed'] : ['no wall: drawn solid']),
    ],
    frame: 'axis +Z, large end at z = 0, small end at z = length',
  });
}

function oletShape(source: ShapeSource): ShapeOutcome {
  const height = source.dims['centreToOutlet'] ?? source.dims['height'];
  if (height === undefined) return missing(source, 'centreToOutlet (or height)');
  const body = source.dims['bodyOd'] ?? source.smallPipeOdMm;
  if (body === undefined)
    return refusal('PSC_SHAPE_UNSUPPORTED', 'an olet shape needs bodyOd in the row, or the branch pipe outside diameter');
  const bore = source.dims['branchBore'];
  const hollow = bore !== undefined && bore > 0 && bore < body;
  return finish({
    recipe: tube('olet', [0, 0, 0], [0, 1, 0], height, body / 2, hollow ? (bore as number) / 2 : 0),
    discs: frustumDiscs([0, 0, 0], [0, 1, 0], height, body / 2, body / 2),
    ports: [
      {
        id: 'branch',
        position: [0, height, 0],
        direction: [0, 1, 0],
        outsideDiameterMm: source.smallPipeOdMm ?? body,
        endType: ENDS[source.type] ?? null,
      },
    ],
    hollow,
    notes: [
      'saddle on the header not modelled: the body starts at the header axis',
      ...(source.dims['bodyOd'] === undefined ? ['body drawn at the branch pipe outside diameter: the row has no bodyOd'] : []),
      ...(hollow ? [] : ['no branch bore in the row: drawn solid']),
    ],
    frame: 'header axis along X through the origin; branch along +Y from the header axis to the outlet face',
  });
}

/** The shape of `source`, or the coded reason there is none. */
export function buildShape(source: ShapeSource): ShapeOutcome {
  switch (source.type) {
    case 'pipe':
      return pipeShape(source);
    case 'elbow90':
      return elbowShape(source, 90);
    case 'elbow45':
      return elbowShape(source, 45);
    case 'tee':
    case 'reducingTee':
      return teeShape(source);
    case 'reducerConcentric':
    case 'reducerEccentric':
    case 'swage':
      return reducerShape(source);
    case 'cap':
      return capShape(source);
    case 'coupling':
    case 'union':
      return straightFittingShape(source);
    case 'flangeWeldNeck':
    case 'flangeSlipOn':
    case 'flangeBlind':
    case 'flangeSocketWeld':
    case 'flangeThreaded':
    case 'flangeLapJoint':
      return flangeShape(source);
    case 'gasketSpiralWound':
    case 'gasketSheet':
    case 'gasketRing':
      return gasketShape(source);
    case 'valveGate':
    case 'valveGlobe':
    case 'valveCheck':
    case 'valveBall':
    case 'valveButterfly':
    case 'valvePlug':
      return valveShape(source);
    case 'weldolet':
    case 'sockolet':
    case 'threadolet':
      return oletShape(source);
    default:
      return refusal('PSC_SHAPE_UNSUPPORTED', `${source.type} has no shape recipe (bolt sets are not modelled)`);
  }
}
