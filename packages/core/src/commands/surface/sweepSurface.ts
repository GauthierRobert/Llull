/** sweep_surface: the sheet swept by an open or closed section curve along a path (or between two rails), with the laws, frames and rails of sweep_profile. */

import type { CurveSegment } from '../../model/curve';
import type { CadDocument, Vec2, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { colorField, defineCommand, layerIdField, nameField, untypedArray, z } from '../schema';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { sub3 } from '../../lib/vec3';
import { clampedUniformKnots } from '../../lib/nurbs/knotVector';
import { sampleCurve } from '../../lib/nurbs/evaluate';
import { surfaceArea } from '../../lib/nurbs/ruled';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { chainIssue, closesSmoothly, firstCorner, isClosedChain, mapSegment } from '../../geometry/curveSegments';
import { evaluateSweep, type SweepShape } from '../../geometry/sweepEval/evaluate';
import { fitToleranceOf } from '../../geometry/sweepEval/fitted';
import { fitSweepSurface } from '../../geometry/sweepEval/surfaceFit';
import type { Outline } from '../../geometry/sweepEval/rails';
import { designedFields, lawField } from '../solids/sweepLaws';
import { localSurface, pathHelix, resolvePath } from '../solids/sweepPath';
import { orientationField } from '../solids/sweepOrientation';
import { localRails, midlineSpine, railCurves, railDesign, railFields } from '../solids/sweepRails';
import { commitSurface, sig } from './surfaceShared';
import { refuseSwg } from './swgRefusal';

const DEFAULT_COLOR = '#9fb4c7';

interface SectionCurve {
  readonly curve: NurbsCurveData;
  readonly outline: Outline;
  /** Largest distance of the section from its origin (for the default bend radius). */
  readonly reach: number;
}

const isPoint2 = (p: unknown): p is Vec2 => Array.isArray(p) && p.length === 2 && p.every(isFiniteNumber);

/** The section curve in section coordinates (poles [x, y, 0]), or the reason it is unusable. */
function resolveSection(
  doc: CadDocument,
  section: { line?: unknown[] | undefined; points?: unknown[] | undefined } | undefined,
  sectionId: string | undefined,
): SectionCurve | string {
  const given = [section?.line, section?.points, sectionId].filter((v) => v !== undefined).length;
  if (given !== 1) return 'give exactly one of section.line, section.points or sectionId';
  if (sectionId !== undefined) {
    const entity = doc.entities[sectionId];
    if (entity?.kind !== 'nurbs_curve') return `sectionId "${sectionId}" is not a nurbs_curve`;
    if (
      entity.curve.poles.some((p) => Math.abs(p[2]) > 1e-9 * Math.max(1, ...entity.curve.poles.map((q) => Math.abs(q[0]) + Math.abs(q[1]))))
    )
      return `the section curve "${sectionId}" must lie in its XY plane (section coordinates x, y)`;
    const samples = sampleCurve(entity.curve, 64).map((p): Vec2 => [p[0], p[1]]);
    const first = samples[0] as Vec2;
    const last = samples[samples.length - 1] as Vec2;
    const closed = Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9;
    return {
      curve: entity.curve,
      outline: { kind: 'polyline', points: samples, closed },
      reach: Math.max(...samples.map(([x, y]) => Math.hypot(x, y))),
    };
  }
  const raw = section?.line ?? section?.points ?? [];
  const points = raw.filter(isPoint2);
  if (points.length !== raw.length || points.length < 2 || (section?.line !== undefined && points.length !== 2))
    return section?.line !== undefined
      ? 'section.line needs exactly two finite [x, y] points'
      : 'section.points needs at least two finite [x, y] points';
  if (points.slice(1).some((p, i) => Math.hypot(p[0] - (points[i] as Vec2)[0], p[1] - (points[i] as Vec2)[1]) < 1e-12))
    return 'consecutive section points coincide';
  const { knots, multiplicities } = clampedUniformKnots(points.length, 1);
  return {
    curve: { degree: 1, poles: points.map(([x, y]): Vec3 => [x, y, 0]), knots, multiplicities },
    outline: { kind: 'polyline', points, closed: false },
    reach: Math.max(...points.map(([x, y]) => Math.hypot(x, y))),
  };
}

/**
 * @affects creates 1 nurbs_surface entity positioned at the path start (poles local to it)
 * @invariant the section's own basis is kept across; v is the cubic interpolation of every pole over the path stations; data.fitDeviation <= fitTolerance
 * @failure bad section / path -> SWG_SECTION_INVALID / SWG_PATH_INVALID; laws, frames, rails -> the sweep_profile SWG_* codes; fit out of tolerance -> SWG_FIT_TOLERANCE
 */
export const sweepSurface = defineCommand({
  name: 'sweep_surface',
  description:
    'Sweep an open or closed section CURVE along a path into a NURBS surface sheet (no caps): helicoids, ribbons, fins, hull skins, bands standing on a surface. ' +
    'Same path, laws, frames and rails as sweep_profile, but the section is a curve: `section` { line: [[x,y],[x,y]] } or { points: [[x,y], ...] } (section coordinates: x along the frame normal, y along the binormal, centred on the path), ' +
    'or `sectionId` of a nurbs_curve lying in its XY plane (rational conics stay exact). Path: `path` world points (straight runs with bends of bendRadius, or smooth: true), `pathId` (curve), or two rails `guideIds` whose midline is the spine. ' +
    "Laws over the arc-length fraction: twist (radians) / twistTurns, scale, stretch {x, y}; `orientation` minimal | frenet | fixed | binormal | axis_plane | surface (+ surfaceId: the section y axis follows that sheet's normal). " +
    'Rails (`guideIds`, `anchors`, `guideMode`, `maintainHeight`) pull the section anchors onto the rails at every station: with two helical rails and a diameter section this is a helicoid. ' +
    'Returns data { area (units squared), fitDeviation, cells, unit }; the sheet is within fitTolerance (default 1e-7 x size) of the exact evaluator. Next: measure_area, analyze_surface_curvature, thicken_surface, check_sweep_loft.',
  params: z.object({
    path: untypedArray(
      'World-space [x, y, z] path points (>= 2), straight runs with circular bends of bendRadius. Alternative to pathId / two rails.',
    ).optional(),
    pathId: z.string().describe('Id of a nurbs_curve (3D, degree 1..3, non-rational) or 2D sketch curve to use as the path.').optional(),
    pathIds: z.array(z.string()).describe('Ids (>= 2) of curves joined end to end into one path (G1 joints).').optional(),
    smooth: z.boolean().describe('With path points: a smooth spline through them instead of straight runs with bends.').optional(),
    closed: z
      .boolean()
      .describe('With path points: also join the last point back to the first (needs an orientation other than minimal).')
      .optional(),
    bendRadius: z
      .number()
      .describe('Bend radius at each corner of a point path, document units. Default 3 x the reach of the section.')
      .optional(),
    section: z
      .object({
        line: z.array(z.array(z.number())).describe('Two [x, y] section points: a straight section.').optional(),
        points: z.array(z.array(z.number())).describe('>= 2 [x, y] section points: a polyline section.').optional(),
      })
      .describe('Inline section curve in section coordinates. Alternative to sectionId.')
      .optional(),
    sectionId: z
      .string()
      .describe('Id of a nurbs_curve lying in its XY plane, used as the section (its local x, y are section coordinates).')
      .optional(),
    twist: lawField('Rotation of the section about the path tangent, in radians'),
    twistTurns: z
      .number()
      .describe('Shortcut for a linear twist of this many full turns over the path. Do not combine with twist.')
      .optional(),
    scale: lawField('Uniform scale factor (> 0) of the section'),
    stretch: z
      .object({ x: lawField('Extra scale (> 0) of the section x axis'), y: lawField('Extra scale (> 0) of the section y axis') })
      .describe('Anisotropic scale laws of the section x / y axes, multiplied with scale.')
      .optional(),
    orientation: orientationField,
    ...railFields,
    fitTolerance: z
      .number()
      .describe(
        'Largest distance (document units, > 0) between the sheet and the exact evaluator. Default 1e-7 x the size of path plus section (at least 1e-9).',
      )
      .optional(),
    color: colorField(DEFAULT_COLOR),
    layerId: layerIdField(),
    name: nameField(),
  }),
  run: (doc, params): CommandResult => {
    const { path: rawPath, pathId, pathIds, smooth = false, guideIds, fitTolerance } = params;
    const refuse = (code: string, message: string, ...paths: string[]): CommandResult =>
      refuseSwg(doc, 'sweep_surface', code, message, [], paths);
    const section = resolveSection(doc, params.section, params.sectionId);
    if (typeof section === 'string') return refuse('SWG_SECTION_INVALID', section, 'section');
    const rails = guideIds === undefined ? null : railCurves(doc, 'sweep_surface', guideIds);
    if (rails !== null && !Array.isArray(rails)) return rails;
    if (rails !== null && [params.twist, params.twistTurns, params.scale, params.stretch].some((law) => law !== undefined))
      return refuse('SWG_LAW_EXCLUSIVE', 'rails drive the section: give rails or twist / scale / stretch, not both', 'guideIds');
    const bendRadius = params.bendRadius ?? 3 * Math.max(section.reach, 1e-9);
    if (!(bendRadius > 0)) return refuse('SWG_PARAM_INVALID', `bendRadius must be > 0 (got ${bendRadius})`, 'bendRadius');
    const spine: CurveSegment<Vec3>[] | string | null =
      rails !== null && rails.length === 2 && rawPath === undefined && pathId === undefined && pathIds === undefined
        ? midlineSpine(rails[0] as NurbsCurveData, rails[1] as NurbsCurveData)
        : null;
    const path = spine ?? resolvePath(doc, rawPath, pathId, smooth, bendRadius, params.closed ?? false, pathIds);
    if (typeof path === 'string') return refuse('SWG_PATH_INVALID', path, 'path');
    const loop = isClosedChain(path);
    const issue = chainIssue(path, loop);
    if (issue !== null) return refuse('SWG_PATH_INVALID', `path invalid — ${issue}`, 'path');
    if (loop && (params.orientation === undefined || params.orientation.mode === 'minimal'))
      return refuse(
        'SWG_PATH_INVALID',
        'a closed path needs an orientation that closes on itself (surface, axis_plane, fixed, binormal or frenet)',
        'orientation',
      );
    const corner = firstCorner(path);
    if (corner >= 0 || (loop && !closesSmoothly(path)))
      return refuse(
        'SWG_PATH_NOT_G1',
        `the path has a sharp corner at joint ${Math.max(corner, 0)}; use a bendRadius or smooth: true`,
        'path',
      );
    const start = path[0]?.points[0] as Vec3;
    const designed = designedFields({
      twistInput: params.twist,
      twistTurns: params.twistTurns,
      scaleInput: params.scale,
      areaInput: undefined,
      stretch: params.stretch,
      orientationInput: params.orientation,
      orientationContext: {
        start,
        helix: pathHelix(doc, pathId, start),
        sectionFrame: undefined,
        surfaceOf: (id) => localSurface(doc, id, start),
      },
      stationBlend: undefined,
      stations: undefined,
    });
    if ('refusal' in designed) return refuse(designed.refusal.code, designed.refusal.message, designed.refusal.path);
    const local = path.map((segment) => mapSegment(segment, (p: Vec3): Vec3 => sub3(p, start)));
    let railFieldsOut = {};
    if (rails !== null) {
      const made = railDesign(
        { path: local, orientation: designed.fields.orientation, outline: section.outline },
        localRails(rails, guideIds as string[], start),
        params,
        rails,
      );
      if ('refusal' in made) return refuse(made.refusal.code, made.refusal.message, made.refusal.path);
      railFieldsOut = made.fields;
    }
    const profile = section.curve.poles.map((p): Vec2 => [p[0], p[1]]);
    const helix = pathHelix(doc, pathId, start);
    const shape: SweepShape = {
      path: local,
      section: { shape: 'profile', profile },
      ...(helix === undefined ? {} : { helix }),
      ...designed.fields,
      ...railFieldsOut,
    };
    const evaluation = evaluateSweep(shape);
    if (!('frames' in evaluation))
      return refuse(evaluation.code, evaluation.message, 'param' in evaluation ? evaluation.param : 'orientation');
    const tolerance = fitTolerance ?? fitToleranceOf(shape);
    if (!(tolerance > 0)) return refuse('SWG_PARAM_INVALID', `fitTolerance must be > 0 (got ${tolerance})`, 'fitTolerance');
    const fit = fitSweepSurface(shape, section.curve, tolerance);
    if ('code' in fit) return refuse(fit.code, fit.message, 'fitTolerance');
    const area = surfaceArea(fit.surface);
    const data = {
      area: sig(area),
      fitDeviation: sig(fit.deviation),
      cells: fit.cells,
      pathLength: sig(evaluation.length),
      unit: doc.units,
    };
    const result = commitSurface(
      doc,
      fit.surface,
      { position: start, color: params.color, layerId: params.layerId, name: params.name },
      (id) =>
        `sweep_surface: created sheet "${id}" (area ${data.area} ${doc.units}^2, ${fit.cells} cells, fit deviation ${data.fitDeviation} ${doc.units}) swept along a ${path.length}-segment path.`,
    );
    return { ...result, data };
  },
});
