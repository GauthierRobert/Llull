import { idOrNext } from '../../lib/explicitId';
import type { CadDocument, SweepEntity, Vec3 } from '../../model/types';
import type { SweepSection, SweepStation } from '../../model/sweepOrientation';
import type { CommandResult } from '../types';
import { defineCommand, untypedArray, z } from '../schema';
import { failer } from '../noop';
import { dot3, sub3 } from '../../lib/vec3';
import type { CurveSegment } from '../../model/curve';
import { MITER_MAX_TURN, sharpJoints } from '../../geometry/sweepEval/miter';
import { polygonArea } from '../../lib/polygon';
import { polylineLength } from '../../lib/polyline';
import { newEntity } from '../entity/newEntity';
import { DEFAULT_SOLID_COLOR, commitSolid, existingLayerOrDefault, solidStyleFields, explicitIdTaken } from './shared';
import { type SectionSpec, sectionLoop, sectionSpecFields, specRing } from './sectionSpecs';
import { alignRing } from '../../geometry/sectionRing';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { designedFields, lawField, refuseSweep, sweepDesign } from './sweepLaws';
import { orientationField, sectionFrameField } from './sweepOrientation';
import { localSurface, pathHelix, resolvePath } from './sweepPath';
import { localRails, midlineSpine, railCurves, railDesign, railFields } from './sweepRails';
import { sectionOutline } from '../../geometry/sweepEval/rails';
import { pathLength } from '../../geometry/sweepEval/evaluate';
import { fitSweepFaces } from '../../geometry/sweepEval/fitted';
import { needsFittedFaces } from '../../geometry/sweepEval/realisation';
import {
  chainIssue,
  chainLength,
  segmentTangent,
  closesSmoothly,
  isClosedChain,
  firstCorner,
  mapSegment,
  minCurvatureRadius,
  sampleChain,
} from '../../geometry/curveSegments';

/** Default bend radius as a multiple of the section half-size (a long-radius pipe elbow). */
const DEFAULT_BEND_FACTOR = 3;

/** Section and its half-size (largest distance from the path), or an error message. */
function resolveSection(
  doc: CadDocument,
  radius: number | undefined,
  innerRadius: number | undefined,
  section: ReadonlyArray<unknown> | undefined,
  sectionId: string | undefined,
): { section: SweepSection; halfSize: number } | string {
  const given = [radius, section, sectionId].filter((v) => v !== undefined).length;
  if (given !== 1) return 'give exactly one of radius, section or sectionId';
  if (radius !== undefined) {
    if (!(radius > 0)) return `radius must be > 0 (got ${radius})`;
    if (innerRadius !== undefined && !(innerRadius > 0 && innerRadius < radius))
      return `innerRadius must be > 0 and < radius ${radius} (got ${innerRadius})`;
    return { section: { shape: 'circle', radius, ...(innerRadius !== undefined ? { innerRadius } : {}) }, halfSize: radius };
  }
  if (innerRadius !== undefined) return 'innerRadius only applies to a circular section (radius)';
  const loop = sectionLoop(doc, section, sectionId);
  if (typeof loop === 'string') return loop;
  const { profile, curves } = loop;
  if (polygonArea(profile) <= 1e-12) return 'section encloses no area';
  const exact = curves.some((segment) => segment.type !== 'line');
  return {
    section: { shape: 'profile', profile, ...(exact ? { curves } : {}) },
    halfSize: Math.max(...profile.map(([x, y]) => Math.hypot(x, y))),
  };
}

/** Refusal of a mitre path: only straight runs may meet at a sharp joint, the turn is below 150 degrees and the mitre reaches at the two ends of every leg fit inside it. */
function miterRefusal(path: ReadonlyArray<CurveSegment<Vec3>>, reach: number): { code: string; message: string } | null {
  const needs = new Map<number, number>();
  for (const joint of sharpJoints(path)) {
    const [a, b] = [path[joint] as CurveSegment<Vec3>, path[joint + 1] as CurveSegment<Vec3>];
    if (a.type !== 'line' || b.type !== 'line')
      return { code: 'SWG_PATH_NOT_G1', message: `joint ${joint} is sharp but a leg is not straight: a mitre joins straight runs only` };
    const turn = Math.acos(Math.min(1, dot3(segmentTangent(a, 1), segmentTangent(b, 0))));
    if (turn > MITER_MAX_TURN)
      return {
        code: 'SWG_PATH_NOT_G1',
        message: `joint ${joint} turns ${((turn * 180) / Math.PI).toFixed(0)} degrees: more than 150 cannot be mitred`,
      };
    needs.set(joint, reach * Math.tan(turn / 2));
  }
  // a leg carries the mitre reach of the joint at each of its ends: together they must fit inside it (a short middle leg inverts the solid)
  for (const [i, leg] of path.entries()) {
    const [atStart, atEnd] = [needs.get(i - 1) ?? 0, needs.get(i) ?? 0];
    const length = chainLength([leg]);
    if (atStart + atEnd >= length)
      return {
        code: 'SWG_SELF_INTERSECTION_LOCAL',
        message: `the mitres at the ends of leg ${i} reach ${(atStart + atEnd).toFixed(3)} along it, the leg is ${length.toFixed(3)} long`,
      };
  }
  return null;
}

/** Station rings (aligned to their predecessor) and the largest half-size, or an error message. */
function resolveStations(
  doc: CadDocument,
  raw: ReadonlyArray<SectionSpec & { at: number }>,
): { section: SweepSection; halfSize: number; stations: SweepStation[] } | string {
  if (raw.length < 2) return `stations needs >= 2 entries (got ${raw.length})`;
  const stations: SweepStation[] = [];
  let halfSize = 0;
  for (let i = 0; i < raw.length; i++) {
    const spec = raw[i] as SectionSpec & { at: number };
    const previous = stations[i - 1];
    if (!(spec.at >= 0 && spec.at <= 1)) return `station ${i}: at must be in [0, 1] (got ${spec.at})`;
    if (previous !== undefined && !(spec.at > previous.at))
      return `station ${i}: at must be greater than the previous station (${previous.at})`;
    const resolved = specRing(doc, spec);
    if (typeof resolved === 'string') return `station ${i}: ${resolved}`;
    halfSize = Math.max(halfSize, resolved.halfSize);
    const ring = previous === undefined ? resolved.ring : alignRing(resolved.ring, previous.ring);
    stations.push({ at: spec.at, ring });
  }
  const first = stations[0] as SweepStation;
  const last = stations[stations.length - 1] as SweepStation;
  if (first.at !== 0 || last.at !== 1) return 'the first station must be at 0 and the last at 1';
  return { section: { shape: 'profile', profile: first.ring }, halfSize, stations };
}

/**
 * @affects creates 1 sweep entity positioned at the path start
 * @invariant path is open, connected and tangent-continuous (G1); bends are wider than the (scaled) section; no law / orientation / blend param -> the entity of before
 * @failure bad / ambiguous section or path -> SWG_PATH_INVALID; sharp corner -> SWG_PATH_NOT_G1; bend tighter than the section -> SWG_SELF_INTERSECTION_LOCAL;
 *   bad law -> SWG_LAW_INVALID / SWG_LAW_NONPOSITIVE / SWG_LAW_EXCLUSIVE; closed path with a non-periodic twist -> SWG_CLOSED_TWIST_NOT_PERIODIC;
 *   frame mode cannot follow the path -> SWG_FRAME_DEGENERATE; duplicate explicit id -> no-op, affected:[]
 */
export const sweepProfile = defineCommand({
  name: 'sweep_profile',
  description:
    'Sweep a closed cross-section along a 3D path into a solid: pipes, tubes, hoses, handrails, ducts, ' +
    'cable runs, coils. Right-handed world frame, +Z up. ' +
    'Path: either `path`, world [x, y, z] points — joined by straight runs whose corners are rounded with ' +
    'circular bends of bendRadius (pipe elbows), or with smooth: true a smooth spline through the points — ' +
    'or `pathId`, a 2D sketch curve (line, arc, polyline, spline, circle, ellipse, rectangle) placed by its work plane. ' +
    'Paths may be open or closed loops (closed: true, or a closed sketch); a loop has no end caps. ' +
    'Section (exactly one): `radius` for a round tube (+ innerRadius for a hollow pipe), `section` as ' +
    '[x, y] polygon points, or `sectionId` of a closed 2D sketch (circle, ellipse, rectangle, closed ' +
    'polyline/spline). The section is centred on the path; its +y axis points toward world +Z (toward +Y ' +
    'when the path starts vertical) and it is carried along with a rotation-minimizing (twist-free) frame. ' +
    'Paths, bends and sketched sections stay exact for the exact kernel and STEP export. ' +
    'Laws over the path arc-length fraction t (0..1): `twist` (radians; or `twistTurns`), `scale` or `area` (exclusive; area is the section area in ' +
    'document units squared), `stretch` {x, y}, and for stations `stationBlend` (smooth | linear). Volume of a section centred on the path is the integral of its area ' +
    'along the path whatever the twist. `orientation`: minimal (default, for pipes and anything round), fixed (the section keeps its plane, normal = direction, default +Z; ' +
    'extrusion-like oblique sweeps), frenet (curvature normal; only on paths that bend everywhere), binormal (section y follows `direction`). ' +
    'Rails: `guideIds` (1 or 2 nurbs_curves) pull the section onto the rails at every station: `anchors` are the section points that follow each rail (default: the outline points nearest the rails at the start), `guideMode` scale | orient | stretch, `maintainHeight` for two rails; ' +
    'two rails without a path use their midline as the spine (handles, grips, tapered hoses). `orientation` surface (+ `surfaceId`) keeps the section y axis along the sheet normal (bands and ribs standing on a surface). ' +
    'Refusals carry stable SWG_* codes (SWG_LAW_NONPOSITIVE, SWG_CLOSED_TWIST_NOT_PERIODIC on a closed path whose total twist is not a whole number of ' +
    'turns, SWG_FRAME_DEGENERATE, SWG_SELF_INTERSECTION_LOCAL). Next: inspect_sweep for the frames, check_sweep_loft for the checks, mass_properties for the volume. ' +
    'Booleans with other solids work like any primitive (e.g. boolean op union to weld pipes to a flange).',
  params: z.object({
    path: untypedArray(
      'World-space [x, y, z] points the section follows (>= 2). Without smooth, consecutive points are ' +
        'joined by straight runs and every corner gets a circular bend of bendRadius.',
    ).optional(),
    pathIds: z
      .array(z.string())
      .describe(
        'Ids (>= 2) of curves (3D nurbs_curve, open 2D sketch curves) joined end to end into one path, in order; a curve is reversed when its far end meets the chain. Joints must be tangent (G1) or the sweep is refused with SWG_PATH_NOT_G1. Alternative to path / pathId.',
      )
      .optional(),
    pathId: z
      .string()
      .describe(
        'Id of a 2D sketch curve (line, arc, polyline, spline, circle, ellipse, rectangle; open or closed) to use as the path instead of path.',
      )
      .optional(),
    smooth: z
      .boolean()
      .describe(
        'With path points (or a polyline pathId): true = smooth spline through the points (centripetal ' +
          'Catmull-Rom), false (default) = straight runs with circular bends.',
      )
      .optional(),
    closed: z
      .boolean()
      .describe(
        'With path points: also join the last point back to the first, making a closed loop (rings, ' +
          'chains, tyre treads, gaskets); the closing corner is bent or smoothed like the others. ' +
          'A closed sketch pathId (circle, ellipse, closed spline/polyline, rectangle) is a loop already.',
      )
      .optional(),
    bendRadius: z
      .number()
      .describe(
        'Centre-line radius of the bend at each corner of a straight-run path, in document units. ' +
          'Default: 3 × the section radius (a long-radius elbow). Must exceed the section radius.',
      )
      .optional(),
    radius: z.number().describe('Round section: outer radius (> 0). Use this for pipes, rods, tubes and wires.').optional(),
    innerRadius: z.number().describe('Round section only: bore radius for a hollow pipe (0 < innerRadius < radius).').optional(),
    section: untypedArray(
      'Polygon section: closed [x, y] points in section coordinates (centred on the path; +y toward world +Z). ' +
        'Alternative to radius / sectionId.',
    ).optional(),
    sectionId: z
      .string()
      .describe(
        'Id of a closed 2D sketch (circle, ellipse, rectangle, closed polyline or spline) used as the section; ' +
          'its local coordinates (relative to its own position) become section coordinates; curves stay exact.',
      )
      .optional(),
    stations: z
      .array(z.object({ at: z.number().describe('Path fraction of this section: 0 = path start, 1 = path end.'), ...sectionSpecFields }))
      .describe(
        'Variable section: >= 2 cross-sections along the path, with `at` strictly increasing from 0 ' +
          'to 1, each a radius, radiusX+radiusY ellipse, section polygon or sectionId. The section ' +
          'blends smoothly between stations (taper, flatten, round-to-oval, any shape to any shape). ' +
          'Replaces radius / innerRadius / section / sectionId.',
      )
      .optional(),
    stationBlend: z
      .enum(['smooth', 'linear'])
      .describe(
        'With stations: how rings blend along the path — smooth (smoothstep, default) or linear (a straight taper between two radii is then an exact frustum). Evaluated at every arc-length sample, not only at path joints.',
      )
      .optional(),
    twist: lawField('Rotation of the section about the path tangent, in radians (total twist of a bar: end - start)'),
    corners: z
      .enum(['round', 'miter'])
      .describe(
        'Corners of a `path` of points: round (default) joins the straight runs with circular bends of bendRadius; miter keeps them sharp, the section ring lying in the bisector plane of each joint (square-cut duct and frame corners, volume A x total length). Mitre needs an open path of straight runs, turns below 150 degrees, legs longer than the section reach; not with smooth.',
      )
      .optional(),
    lawParameter: z
      .enum(['fraction', 'arc_length'])
      .describe(
        'What t of a `table` law is: fraction (default) = the arc-length fraction 0..1, or arc_length = the arc length in document units (the table must run from 0 to the path length). Linear / s_curve / constant laws and expressions are unaffected (expressions already see s and L).',
      )
      .optional(),
    twistTurns: z
      .number()
      .describe('Shortcut for a linear twist of this many full turns over the whole path (1 = 360 degrees). Do not combine with twist.')
      .optional(),
    scale: lawField('Uniform scale factor (> 0) of the section'),
    area: lawField('Section area (> 0, document units squared; the section scales by sqrt(area / start area))'),
    stretch: z
      .object({ x: lawField('Extra scale (> 0) of the section x axis'), y: lawField('Extra scale (> 0) of the section y axis') })
      .describe('Anisotropic scale laws of the section x / y axes, multiplied with scale.')
      .optional(),
    orientation: orientationField,
    sectionFrame: sectionFrameField,
    ...railFields,
    fitTolerance: z
      .number()
      .describe(
        'Largest distance (document units, > 0) between the exact fitted faces and the sweep evaluator. Default 1e-7 x the model size (at least 1e-9). Checked now: a tolerance the fit cannot reach is refused with SWG_FIT_TOLERANCE.',
      )
      .optional(),
    ...solidStyleFields(),
  }),
  run: (
    doc,
    {
      path: rawPath,
      pathId,
      pathIds,
      smooth = false,
      closed = false,
      bendRadius: rawBend,
      radius,
      innerRadius,
      section: rawSection,
      sectionId,
      stations: rawStations,
      stationBlend,
      twist: twistInput,
      twistTurns,
      scale: scaleInput,
      area: areaInput,
      stretch,
      orientation: orientationInput,
      sectionFrame,
      lawParameter,
      corners,
      fitTolerance,
      guideIds,
      guideMode,
      maintainHeight,
      anchors,
      railTolerance,
      layerId,
      color = DEFAULT_SOLID_COLOR,
      id: explicitId,
    },
  ): CommandResult => {
    const fail = failer(doc, 'sweep_profile');
    if (explicitIdTaken(doc, explicitId)) return fail(`entity id "${explicitId}" already exists`);
    const resolved =
      rawStations === undefined
        ? resolveSection(doc, radius, innerRadius, rawSection, sectionId)
        : [radius, innerRadius, rawSection, sectionId].some((v) => v !== undefined)
          ? 'with stations, give each section inside its station (not radius / section / sectionId)'
          : resolveStations(doc, rawStations);
    if (typeof resolved === 'string') return fail(resolved);
    const { section, halfSize } = resolved;
    const stations: SweepStation[] | undefined = 'stations' in resolved ? (resolved.stations as SweepStation[]) : undefined;
    const bendRadius = rawBend ?? DEFAULT_BEND_FACTOR * halfSize;
    if (!(bendRadius > 0)) return fail(`bendRadius must be > 0 (got ${bendRadius})`);
    const rails = guideIds === undefined ? null : railCurves(doc, 'sweep_profile', guideIds);
    if (rails !== null && !Array.isArray(rails)) return rails;
    if (
      rails !== null &&
      (stations !== undefined || [twistInput, twistTurns, scaleInput, areaInput, stretch].some((law) => law !== undefined))
    )
      return refuseSweep(
        doc,
        'sweep_profile',
        'SWG_LAW_EXCLUSIVE',
        'rails drive the section: give rails or twist / scale / area / stretch / stations, not both',
        [],
        ['guideIds'],
      );
    if (rails !== null && corners === 'miter')
      return refuseSweep(
        doc,
        'sweep_profile',
        'SWG_LAW_EXCLUSIVE',
        'rails drive the section at every station, which a mitre ring cannot follow: give rails (guideIds) or corners: miter, not both',
        [],
        ['guideIds', 'corners'],
      );
    const spine =
      rails !== null && rails.length === 2 && rawPath === undefined && pathId === undefined && pathIds === undefined
        ? midlineSpine(rails[0] as NurbsCurveData, rails[1] as NurbsCurveData)
        : null;
    const path = spine ?? resolvePath(doc, rawPath, pathId, smooth, bendRadius, closed, pathIds, corners === 'miter');
    if (typeof path === 'string') return refuseSweep(doc, 'sweep_profile', 'SWG_PATH_INVALID', path, [], ['path']);
    const loop = isClosedChain(path);
    if (loop && stations !== undefined) return fail('stations need an open path');
    const issue = chainIssue(path, loop);
    if (issue !== null) return refuseSweep(doc, 'sweep_profile', 'SWG_PATH_INVALID', `path invalid — ${issue}`, [], ['path']);
    const miter = corners === 'miter' ? miterRefusal(path, halfSize) : null;
    if (miter !== null) return refuseSweep(doc, 'sweep_profile', miter.code, miter.message, [], ['corners']);
    const corner = miter === null && corners === 'miter' ? -1 : firstCorner(path);
    if (corner >= 0)
      return refuseSweep(
        doc,
        'sweep_profile',
        'SWG_PATH_NOT_G1',
        `the path has a sharp corner at joint ${corner}; use a bendRadius or smooth: true`,
        [],
        ['path'],
      );
    if (loop && !closesSmoothly(path))
      return refuseSweep(
        doc,
        'sweep_profile',
        'SWG_PATH_NOT_G1',
        'the closed path has a sharp corner where it closes; use a bendRadius or smooth: true',
        [],
        ['path'],
      );
    const start = path[0]?.points[0] as Vec3;
    const helix = pathHelix(doc, pathId, start);
    const designed = designedFields({
      twistInput,
      twistTurns,
      scaleInput,
      areaInput,
      stretch,
      orientationInput,
      orientationContext: { start, helix, sectionFrame, surfaceOf: (surfaceId) => localSurface(doc, surfaceId, start) },
      stationBlend,
      stations,
      arcLength: lawParameter === 'arc_length' ? pathLength(helix === undefined ? { path } : { path, helix }) : undefined,
    });
    if ('refusal' in designed)
      return refuseSweep(doc, 'sweep_profile', designed.refusal.code, designed.refusal.message, [], [designed.refusal.path]);
    const local = path.map((segment) => mapSegment(segment, (p: Vec3): Vec3 => sub3(p, start)));
    let railFieldsOut: Partial<SweepEntity> = {};
    if (rails !== null) {
      const made = railDesign(
        { path: local, orientation: designed.fields.orientation, outline: sectionOutline(section) },
        localRails(rails, guideIds as string[], start),
        { guideMode, maintainHeight, anchors, railTolerance },
        rails,
      );
      if ('refusal' in made) return refuseSweep(doc, 'sweep_profile', made.refusal.code, made.refusal.message, [], [made.refusal.path]);
      railFieldsOut = made.fields;
    }
    const id = idOrNext(explicitId, 'swp');
    const geometry = {
      path: local,
      section,
      ...(stations === undefined ? {} : { stations }),
      ...(helix === undefined ? {} : { helix }),
      ...designed.fields,
      ...railFieldsOut,
      ...(fitTolerance === undefined ? {} : { fitTolerance }),
      ...(corners === 'miter' ? { corners } : {}),
    };
    const entity = newEntity('sweep', id, geometry, start, color, { layerId: existingLayerOrDefault(doc, layerId) });
    const sweepEntity = entity as SweepEntity;
    const design = sweepDesign(doc, sweepEntity, loop);
    if ('document' in design) return design;
    if (fitTolerance !== undefined) {
      if (!(fitTolerance > 0))
        return refuseSweep(
          doc,
          'sweep_profile',
          'SWG_PARAM_INVALID',
          `fitTolerance must be > 0 (got ${fitTolerance})`,
          [],
          ['fitTolerance'],
        );
      const fit = needsFittedFaces(sweepEntity) ? fitSweepFaces(sweepEntity, fitTolerance) : null;
      if (fit !== null && 'code' in fit && fit.code === 'SWG_FIT_TOLERANCE')
        return refuseSweep(doc, 'sweep_profile', 'SWG_FIT_TOLERANCE', fit.message, [], ['fitTolerance']);
    }
    const bend = Math.min(...path.map(minCurvatureRadius));
    if (sweepEntity.orientation?.mode !== 'axis_plane' && bend <= halfSize * design.maxScale)
      return refuseSweep(
        doc,
        'sweep_profile',
        'SWG_SELF_INTERSECTION_LOCAL',
        `a bend of radius ${bend.toFixed(3)} (arc or spline curvature) is not wider than the section (${(halfSize * design.maxScale).toFixed(3)}); the solid would self-intersect`,
        [],
        ['radius'],
      );
    const length = polylineLength(sampleChain(path, false));
    const shape =
      stations !== undefined
        ? `${stations.length}-station variable section`
        : section.shape === 'circle'
          ? `round section r=${section.radius}${section.innerRadius !== undefined ? ` bore ${section.innerRadius}` : ''}`
          : `${section.profile.length}-point section`;
    return commitSolid(
      doc,
      entity,
      `sweep_profile: created sweep "${id}" — ${shape} along a ${path.length}-segment path (≈${length.toFixed(3)} long)`,
    );
  },
});
