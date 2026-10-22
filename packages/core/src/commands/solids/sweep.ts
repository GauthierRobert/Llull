import { idOrNext } from '../../lib/explicitId';
import type { CurveSegment } from '../../model/curve';
import type { CadDocument, SweepEntity, SweepSection, SweepStation, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, untypedArray, z } from '../schema';
import { failer } from '../noop';
import { isVec3, sub3 } from '../../lib/vec3';
import { polygonArea } from '../../lib/polygon';
import { polylineLength } from '../../lib/polyline';
import { newEntity } from '../entity/newEntity';
import { DEFAULT_SOLID_COLOR, commitSolid, existingLayerOrDefault, solidStyleFields, explicitIdTaken } from './shared';
import { MAX_PROFILE_POINTS } from '../limits';
import { sketchPath } from './sketchCurves';
import { type SectionSpec, sectionLoop, sectionSpecFields, specRing } from './sectionSpecs';
import { alignRing } from '../../geometry/sectionRing';
import { nurbsPath } from '../../geometry/nurbsChain';
import type { HelixDefinition } from '../../lib/helix/types';
import { add3 } from '../../lib/vec3';
import { designedFields, lawField, refuseSweep, sweepDesign } from './sweepLaws';
import { orientationField, sectionFrameField } from './sweepOrientation';
import {
  catmullRomBeziers,
  chainIssue,
  closesSmoothly,
  filletClosedPolygon,
  isClosedChain,
  filletPolyline,
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

/** World path from points (bends or smooth spline) or a 2D sketch entity, or an error message. */
function resolvePath(
  doc: Parameters<typeof sketchPath>[0],
  path: ReadonlyArray<unknown> | undefined,
  pathId: string | undefined,
  smooth: boolean,
  bendRadius: number,
  closed: boolean,
): CurveSegment<Vec3>[] | string {
  if ((path === undefined) === (pathId === undefined)) return 'give exactly one of path or pathId';
  if (path !== undefined) {
    const bad = path.findIndex((point) => !isVec3(point));
    if (bad >= 0) return `path point ${bad} must be a finite [x, y, z] triple`;
    const points = path as Vec3[];
    if (points.length < 2 || points.length > MAX_PROFILE_POINTS) return `path needs 2..${MAX_PROFILE_POINTS} points (got ${points.length})`;
    return bentOrSmooth(points, closed, smooth, bendRadius);
  }
  const entity = doc.entities[pathId as string];
  if (entity?.kind === 'nurbs_curve') return nurbsPath(entity);
  const world = sketchPath(doc, pathId as string);
  if (typeof world === 'string' || (entity?.kind !== 'polyline' && entity?.kind !== 'rectangle')) return world;
  const loop = entity.kind === 'rectangle' || entity.closed;
  const corners = world.map((segment) => segment.points[0] as Vec3);
  if (!loop) corners.push(world[world.length - 1]?.points[1] as Vec3);
  return bentOrSmooth(corners, loop, smooth, bendRadius);
}

/** The exact helix of a `nurbs_curve` path (`add_helix`), moved to the sweep's local frame; undefined for any other path or a rotated curve. */
function pathHelix(doc: CadDocument, pathId: string | undefined, start: Vec3): HelixDefinition | undefined {
  const curve = pathId === undefined ? undefined : doc.entities[pathId];
  if (curve?.kind !== 'nurbs_curve' || curve.analytic === undefined || curve.rotation.some((angle) => angle !== 0)) return undefined;
  return { ...curve.analytic, origin: sub3(add3(curve.position, curve.analytic.origin), start) };
}

/** Corner points joined by bends (or a smooth spline through them), open or closed. */
function bentOrSmooth(points: readonly Vec3[], closed: boolean, smooth: boolean, bendRadius: number): CurveSegment<Vec3>[] | string {
  if (smooth) return catmullRomBeziers(points, closed);
  return closed ? filletClosedPolygon(points, bendRadius) : filletPolyline(points, bendRadius);
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
    'Refusals carry stable SWG_* codes (SWG_LAW_NONPOSITIVE, SWG_CLOSED_TWIST_NOT_PERIODIC on a closed path whose total twist is not a whole number of ' +
    'turns, SWG_FRAME_DEGENERATE, SWG_SELF_INTERSECTION_LOCAL). Next: inspect_sweep for the frames, check_sweep_loft for the checks, mass_properties for the volume. ' +
    'Booleans with other solids work like any primitive (e.g. boolean op union to weld pipes to a flange).',
  params: z.object({
    path: untypedArray(
      'World-space [x, y, z] points the section follows (>= 2). Without smooth, consecutive points are ' +
        'joined by straight runs and every corner gets a circular bend of bendRadius.',
    ).optional(),
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
    ...solidStyleFields(),
  }),
  run: (
    doc,
    {
      path: rawPath,
      pathId,
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
    const path = resolvePath(doc, rawPath, pathId, smooth, bendRadius, closed);
    if (typeof path === 'string') return refuseSweep(doc, 'sweep_profile', 'SWG_PATH_INVALID', path, [], ['path']);
    const loop = isClosedChain(path);
    if (loop && stations !== undefined) return fail('stations need an open path');
    const issue = chainIssue(path, loop);
    if (issue !== null) return refuseSweep(doc, 'sweep_profile', 'SWG_PATH_INVALID', `path invalid — ${issue}`, [], ['path']);
    const corner = firstCorner(path);
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
      orientationContext: { start, helix, sectionFrame },
      stationBlend,
      stations,
    });
    if ('refusal' in designed)
      return refuseSweep(doc, 'sweep_profile', designed.refusal.code, designed.refusal.message, [], [designed.refusal.path]);
    const local = path.map((segment) => mapSegment(segment, (p: Vec3): Vec3 => sub3(p, start)));
    const id = idOrNext(explicitId, 'swp');
    const geometry = {
      path: local,
      section,
      ...(stations === undefined ? {} : { stations }),
      ...(helix === undefined ? {} : { helix }),
      ...designed.fields,
    };
    const entity = newEntity('sweep', id, geometry, start, color, { layerId: existingLayerOrDefault(doc, layerId) });
    const sweepEntity = entity as SweepEntity;
    const design = sweepDesign(doc, sweepEntity, loop);
    if ('document' in design) return design;
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
