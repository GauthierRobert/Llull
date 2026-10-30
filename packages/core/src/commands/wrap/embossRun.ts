/**
 * The body of emboss_on_face and pattern_on_face (03 WRP M3 - M5): open the face, chart the sketch, check it (profile closed, no self-crossing, one turn at most, on the face, within the
 * distortion limit), build the `emboss` recipe, evaluate it on the exact kernel and report.
 * Modes: emboss / deboss / scribe on closed profiles; engrave sweeps a flat tool of `toolWidth` along the outline paths (open strokes, single-line text, contours) and cuts that area
 * as a deboss; a `grid` repeats the seed profiles on a rectangular lattice of the sketch.
 */

import type { EmbossParams } from '../../model/wrap';
import type { ShapeRecipe, Vec2, Vec3 } from '../../model/types';
import { selfIntersects } from '../../lib/polygon';
import { dot3, len3, normalize3, scale3 } from '../../lib/vec3';
import { embossClosedForm, regionsAreas } from '../../geometry/embossVolume';
import { mapSegment2, sampleSegment, segmentArea, segmentLength, type PlaneSegment } from '../../geometry/planeSegments';
import { strokeRegions } from '../../geometry/strokeRegions';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import type { CommandResult, ExecutionContext } from '../types';
import type { CadDocument } from '../../model/types';
import { wrapRejection } from './codes';
import { DEFAULT_MAX_LENGTH_STRAIN, MAX_LENGTH_STRAIN_SOURCE, namedDefault, wrapData } from './conventions';
import { runEmbossChain } from './embossChain';
import { buildPullRecipe, isPullFailure, type PullBuild } from './embossPull';
import { distortionData, distortionMessage, distortionOf } from './distortion';
import { SEWING_RATIO, MIN_FIT_TOLERANCE } from './constants';
import {
  defaultFitTolerance,
  isRejection,
  openFace,
  resolveChart,
  type FaceRefInput,
  type FaceSession,
  type PlacementInput,
} from './faceSession';
import { isSketchFailure, sketchOutline, type ChartRegion, type SketchOutline } from './sketchProfiles';
import { checkOnFace, checkWrapAround, isMappingFailure, mapOutlineRegions, probePoints } from './wrapMapping';

const MAX_PROBES = 48;
const CROSS_CHECK_SAMPLES = 12;
const MAX_INSTANCES = 2000;

export interface EmbossGrid {
  readonly countX: number;
  readonly countY: number;
  readonly pitchX: number;
  readonly pitchY: number;
}

export interface EmbossRequest {
  readonly id: string;
  readonly face: FaceRefInput;
  readonly profileIds: readonly string[];
  readonly mode: 'emboss' | 'deboss' | 'scribe' | 'engrave';
  readonly depth?: number | undefined;
  readonly placement?: PlacementInput | undefined;
  readonly maxLengthStrain?: number | undefined;
  readonly fitTolerance?: number | undefined;
  readonly toolWidth?: number | undefined;
  readonly grid?: EmbossGrid | undefined;
  /** `pull`: walls parallel to `pullDirection` (the mould-friendly form), optionally tilted by `draftDeg`; default `normal` (walls normal to the face). */
  readonly walls?: 'normal' | 'pull' | undefined;
  readonly pullDirection?: Vec3 | undefined;
  readonly draftDeg?: number | undefined;
  /** More faces of the chain the sketch runs over (adjacent plane / cylinder faces, unfolded across their shared edges). */
  readonly chain?: readonly FaceRefInput[] | undefined;
}

/** Volume of the exact solid and of its source: the kernel's exact mass properties, else its analysis. */
export function kernelVolume(
  session: Pick<FaceSession, 'kernel'>,
  shape: Parameters<NonNullable<FaceSession['kernel']['massProperties']>>[0],
): number | null {
  const mass = session.kernel.massProperties?.(shape) ?? null;
  if (mass !== null) return mass.volume;
  return session.kernel.analyze?.(shape)?.volume ?? null;
}

const polygonOf = (chain: readonly PlaneSegment[]): Vec2[] =>
  chain.flatMap((piece) => sampleSegment(piece, piece.kind === 'line' ? 2 : CROSS_CHECK_SAMPLES).slice(0, -1));

/**
 * How deep a deboss can go before it passes through the material: the distance from the deepest point of the mapped profile to the axis (cylinder: its radius;
 * cone: the smallest v of the profile x sin(semi-angle); sphere: its radius; torus: the tube radius). A bore (material outside the face) and a plane have no such limit.
 */
function debossLimit(session: FaceSession, pieces: readonly (readonly PlaneSegment[])[], convex: boolean | null): number | null {
  if (convex === false) return null;
  if (session.surface.type === 'cylinder' || session.surface.type === 'sphere') return session.surface.radius;
  if (session.surface.type === 'torus') return session.surface.minor;
  if (session.surface.type !== 'cone') return null;
  const smallestV = Math.min(...pieces.flat().flatMap((piece) => sampleSegment(piece, 9).map((p) => p[1])));
  return smallestV * Math.sin(session.surface.semiAngle);
}

const shifted = (chain: readonly PlaneSegment[], dx: number, dy: number): PlaneSegment[] =>
  chain.map((piece) => mapSegment2(piece, ([x, y]): Vec2 => [x + dx, y + dy]));

/** The lattice of a seed: one copy of every region per grid node. */
function repeated(regions: readonly ChartRegion[], grid: EmbossGrid): ChartRegion[] {
  const out: ChartRegion[] = [];
  for (let j = 0; j < grid.countY; j++)
    for (let i = 0; i < grid.countX; i++) {
      const [dx, dy] = [i * grid.pitchX, j * grid.pitchY];
      out.push(
        ...regions.map((region) => ({ outer: shifted(region.outer, dx, dy), holes: region.holes.map((hole) => shifted(hole, dx, dy)) })),
      );
    }
  return out;
}

/** Polylines of every outline path of `outlines`: open chains and the contours of closed regions (a groove follows a path, it does not fill). */
function paths(outlines: readonly SketchOutline[], width: number): Vec2[][] {
  const pointsOfChain = (chain: readonly PlaneSegment[]): Vec2[] => {
    const points = chain.flatMap((piece, k) => {
      const count = piece.kind === 'line' ? 2 : Math.min(200, Math.max(8, Math.ceil(segmentLength(piece) / (width / 4)))) + 1;
      return sampleSegment(piece, count).slice(k === 0 ? 0 : 1);
    });
    return points;
  };
  return outlines.flatMap((outline) => [
    ...outline.open.map(pointsOfChain),
    ...outline.regions.flatMap((region) =>
      [region.outer, ...region.holes].map((chain) => [...pointsOfChain(chain), pointsOfChain(chain)[0] as Vec2]),
    ),
  ]);
}

const lineChain = (polygon: readonly Vec2[]): PlaneSegment[] =>
  polygon.map((from, k) => ({ kind: 'line' as const, from, to: polygon[(k + 1) % polygon.length] as Vec2 }));

/**
 * @failure see emboss_on_face and pattern_on_face: every refusal is coded, the document comes back unchanged
 */
export function runEmboss(doc: CadDocument, ctx: ExecutionContext | undefined, command: string, params: EmbossRequest): CommandResult {
  const session = openFace(doc, ctx, command, params.id, params.face);
  if (isRejection(session)) return session;
  const fail = (code: string, message: string, paths: string[], ids: readonly string[] = [params.id]): CommandResult =>
    wrapRejection(doc, command, code, message, [...ids], paths);
  const engrave = params.mode === 'engrave';
  const scribe = params.mode === 'scribe';
  if (!scribe && !(typeof params.depth === 'number' && Number.isFinite(params.depth) && params.depth > 0))
    return fail('WRP_DEPTH_INVALID', `depth must be a finite number > 0 for ${params.mode} (got ${String(params.depth)})`, ['depth']);
  if (engrave && !(typeof params.toolWidth === 'number' && Number.isFinite(params.toolWidth) && params.toolWidth > 0))
    return fail('WRP_PARAM_INVALID', `mode engrave needs toolWidth > 0 (got ${String(params.toolWidth)})`, ['toolWidth']);
  const pulled = params.walls === 'pull';
  if (!pulled && (params.pullDirection !== undefined || params.draftDeg !== undefined))
    return fail('WRP_PARAM_INVALID', 'pullDirection and draftDeg need walls "pull"', [
      ...(params.pullDirection !== undefined ? ['pullDirection'] : []),
      ...(params.draftDeg !== undefined ? ['draftDeg'] : []),
    ]);
  if (pulled) {
    if (params.pullDirection === undefined || !(len3(params.pullDirection) > 1e-12))
      return fail('WRP_PARAM_INVALID', 'walls "pull" needs a non-zero pullDirection [x, y, z]', ['pullDirection']);
    if (engrave || scribe || params.grid !== undefined || (params.chain?.length ?? 0) > 0)
      return fail('WRP_PARAM_INVALID', 'walls "pull" works with emboss and deboss on one face (not scribe, engrave, a grid or a chain)', [
        'walls',
      ]);
    if (params.draftDeg !== undefined && !(params.draftDeg >= 0 && params.draftDeg < 45))
      return fail('WRP_PARAM_INVALID', `draftDeg must be in [0, 45) degrees (got ${params.draftDeg})`, ['draftDeg']);
  }
  const resolved = resolveChart(doc, session, params.placement, params.face.faceNear);
  if ('summary' in resolved) return resolved;
  let outlines: SketchOutline[] = [];
  for (const [index, profileId] of params.profileIds.entries()) {
    const outline = sketchOutline(doc, profileId);
    if (isSketchFailure(outline)) return fail(outline.code, outline.message, [`profileIds.${index}`], [profileId]);
    const closedOnly = !engrave && (outline.open.length > 0 || outline.regions.length === 0);
    if (closedOnly || (engrave && outline.open.length === 0 && outline.regions.length === 0))
      return fail(
        'WRP_PROFILE_OPEN',
        `profile '${profileId}' (${outline.kind}) is not a closed shape; ${scribe ? 'scribe of open curves is not built yet' : 'close it, use mode scribe, or mode engrave to cut a groove along it'}`,
        [`profileIds.${index}`],
        [profileId],
      );
    for (const region of outline.regions)
      for (const chain of [region.outer, ...region.holes])
        if (!engrave && selfIntersects(polygonOf(chain)))
          return fail('WRP_PROFILE_SELF_INTERSECT', `profile '${profileId}' crosses itself`, [`profileIds.${index}`], [profileId]);
    outlines.push(outline);
  }
  const unverified = outlines.some((outline) => outline.unverified);
  const font = outlines.find((outline) => outline.font !== null)?.font ?? null;
  let regions: ChartRegion[] = outlines.flatMap((outline) => outline.regions);
  let strokeLength: number | null = null;
  if (engrave) {
    const lines = paths(outlines, params.toolWidth as number);
    strokeLength = lines.reduce(
      (sum, line) =>
        sum +
        line.reduce(
          (inner, p, k) => (k === 0 ? 0 : inner + Math.hypot(p[0] - (line[k - 1] as Vec2)[0], p[1] - (line[k - 1] as Vec2)[1])),
          0,
        ),
      0,
    );
    const swept = strokeRegions(lines, params.toolWidth as number);
    if ('error' in swept) return fail('WRP_PROFILE_SELF_INTERSECT', swept.error, ['profileIds'], params.profileIds);
    regions = swept.map((region) => ({ outer: lineChain(region.outer), holes: region.holes.map(lineChain) }));
    outlines = [
      {
        ...(outlines[0] as SketchOutline),
        regions,
        open: [],
        area: regions.reduce((sum, r) => sum + Math.abs(r.outer.reduce((a, s) => a + segmentArea(s), 0)), 0),
      },
    ];
  }
  if (params.grid !== undefined) {
    const { grid } = params;
    if (grid.countX * grid.countY > MAX_INSTANCES)
      return fail('WRP_PARAM_INVALID', `${grid.countX * grid.countY} instances exceed the limit of ${MAX_INSTANCES}`, ['grid']);
    const points = regions.flatMap((region) => region.outer.flatMap((piece) => sampleSegment(piece, 9)));
    const extent: Vec2 = [
      Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1])),
    ];
    if ((grid.countX > 1 && grid.pitchX < extent[0] * (1 - 1e-9)) || (grid.countY > 1 && grid.pitchY < extent[1] * (1 - 1e-9)))
      return fail(
        'WRP_PATTERN_OVERLAP',
        `the seed is ${extent[0].toPrecision(6)} x ${extent[1].toPrecision(6)} ${doc.units}: a pitch of ${grid.pitchX} x ${grid.pitchY} makes instances overlap`,
        ['grid'],
      );
    regions = repeated(regions, grid);
    outlines = outlines.map((outline, k) =>
      k === 0
        ? { ...outline, regions, open: [], area: outlines.reduce((sum, o) => sum + o.area, 0) * grid.countX * grid.countY }
        : { ...outline, regions: [], open: [], area: 0 },
    );
  }
  if (params.chain !== undefined && params.chain.length > 0) {
    if (engrave || params.grid !== undefined)
      return fail('WRP_PARAM_INVALID', 'chain works with emboss, deboss and scribe, not with engrave or a grid', ['chain']);
    return runEmbossChain({
      doc,
      ctx,
      command,
      params,
      session,
      resolved,
      regions,
      unverified,
      tolerance: params.fitTolerance ?? defaultFitTolerance(session.diagonal),
      depth: scribe ? 0 : (params.depth as number),
      volumeOf: (shape) => kernelVolume(session, shape),
    });
  }
  const { chart } = resolved;
  const cutting = params.mode === 'deboss' || engrave;
  const depth = scribe ? 0 : (params.depth as number);
  const tolerance = params.fitTolerance ?? defaultFitTolerance(session.diagonal);
  const mapped = mapOutlineRegions(session, chart, regions, tolerance);
  if (isMappingFailure(mapped)) return fail(mapped.code, mapped.message, ['profileIds'], params.profileIds);
  const overlap = checkWrapAround(chart, mapped.pieces, params.profileIds);
  if (overlap !== null) {
    const result = fail(overlap.code, overlap.message, ['profileIds'], params.profileIds);
    return { ...result, data: { fullWrapChartWidth: chart.fullWrapWidth, unit: doc.units } };
  }
  const outside = checkOnFace(session, probePoints(chart, mapped.pieces, MAX_PROBES), params.profileIds);
  if (outside !== null) return fail(outside.code, outside.message, [params.grid === undefined ? 'profileIds' : 'grid'], params.profileIds);
  const limit = params.maxLengthStrain ?? DEFAULT_MAX_LENGTH_STRAIN;
  const holeFlags = regions.flatMap((region) => [false, ...region.holes.map(() => true)]);
  const distortion = distortionOf(
    chart,
    outlines,
    holeFlags.map((hole, index) => ({ pieces: mapped.pieces[index] as PlaneSegment[], hole })),
  );
  if (distortion.maxLengthStrain > limit) {
    const refused = fail('WRP_DISTORTION_EXCEEDED', distortionMessage(distortion, limit, chart.method), ['placement']);
    return {
      ...refused,
      data: { distortion: distortionData(distortion, chart, resolved.method, limit, params.maxLengthStrain === undefined) },
    };
  }
  const recipeParams: EmbossParams = {
    face: session.face,
    surface: chart.wire,
    regions: mapped.regions,
    mode: cutting ? 'deboss' : (params.mode as 'emboss' | 'scribe'),
    depth,
    direction: scale3(chart.normalAt(mapped.regions[0]?.outer.start as Vec2), resolved.orientation),
    // the construction tolerance of the recipe: sewing, and the fit of the pcurves (the kernel builds the 3D edges of a fitted pcurve to about that)
    tolerance: Math.max(SEWING_RATIO * session.diagonal, MIN_FIT_TOLERANCE, tolerance),
  };
  let pull: PullBuild | null = null;
  if (pulled) {
    const built = buildPullRecipe({
      session,
      chart,
      orientation: resolved.orientation,
      regions: mapped.regions,
      pieces: mapped.pieces,
      mode: cutting ? 'deboss' : 'emboss',
      depth,
      pull: params.pullDirection as Vec3,
      draftDeg: params.draftDeg ?? 0,
      anchorOn: resolved.anchorOn,
      tolerance,
    });
    if (isPullFailure(built)) {
      const refused = fail(built.code, built.message, [built.path ?? 'pullDirection']);
      return built.data === undefined ? refused : { ...refused, data: built.data };
    }
    pull = built;
  }
  const recipe: ShapeRecipe = pull?.recipe ?? { op: 'emboss', source: session.source, ...recipeParams };
  // walls along a pull: the closed form of the layer is known on a plane (A d); on curved faces the volume is the measured one
  const closed =
    pull === null || (session.surface.type === 'plane' && !((params.draftDeg ?? 0) > 0)) ? embossClosedForm(recipeParams) : null;
  const reach = debossLimit(session, mapped.pieces, closed?.convex ?? null);
  if (cutting && reach !== null && depth >= reach * (1 - 1e-9)) {
    const result = fail(
      'WRP_DEPTH_EXCEEDS_SOLID',
      `depth ${depth} reaches the ${reach.toPrecision(6)} ${doc.units} between the deepest point of the profile and the axis of the ${session.surface.type} face`,
      ['depth'],
    );
    return { ...result, data: { maxDepth: reach, unit: doc.units } };
  }
  const built = evaluateRecipe(session.kernel, recipe);
  if (typeof built === 'string')
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the exact kernel could not ${params.mode} ${mapped.regions.length} region(s) on face ${session.face} (${built}); try a smaller depth or profile`,
      ['profileIds'],
      params.profileIds,
    );
  const health = session.kernel.analyze?.(built.shape) ?? null;
  if (health !== null && !(health.valid && health.closed))
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the ${params.mode} is not a valid closed solid (${health.status}); refused`,
      ['profileIds'],
      params.profileIds,
    );
  const before = kernelVolume(session, session.shape);
  const after = kernelVolume(session, built.shape);
  const volumeDelta = before !== null && after !== null ? after - before : null;
  if (volumeDelta !== null && !scribe && (cutting ? volumeDelta >= 0 : volumeDelta <= 0))
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the ${params.mode} changed the volume by ${volumeDelta} ${doc.units}^3, the wrong way (${cutting ? 'a cut must remove' : 'an emboss must add'} material); refused`,
      ['profileIds'],
      params.profileIds,
    );
  const areas = regionsAreas(mapped.regions);
  const spanU =
    Math.max(...mapped.pieces.flat().flatMap((piece) => sampleSegment(piece, 9).map((p) => p[0]))) -
    Math.min(...mapped.pieces.flat().flatMap((piece) => sampleSegment(piece, 9).map((p) => p[0])));
  const shownArea = closed?.area ?? (pull === null ? areas.uv : outlines.reduce((sum, outline) => sum + outline.area, 0));
  const instances = params.grid === undefined ? 1 : params.grid.countX * params.grid.countY;
  const data = wrapData(
    doc,
    {
      volumeDelta,
      expectedVolumeDelta: closed?.delta ?? null,
      regionArea: shownArea,
      regions: mapped.regions.length,
      loops: mapped.pieces.length,
      mode: params.mode,
      depth,
      method: chart.method,
      exact: !engrave && !(pull !== null && pull.footprintDeviation > 0),
      faceKind: session.surface.type,
      face: session.face,
      ...(session.faceName !== undefined ? { faceName: session.faceName } : {}),
      ...(chart.kind === 'plane'
        ? {}
        : {
            angularSpanRad: spanU,
            ...(chart.kind === 'cone'
              ? { developedSectorRad: spanU * Math.sin((session.surface as { semiAngle?: number }).semiAngle ?? 1) }
              : {}),
          }),
      distortion: distortionData(distortion, chart, resolved.method, limit, params.maxLengthStrain === undefined),
      fullWrapChartWidth: chart.fullWrapWidth,
      walls: pull === null ? 'normal' : 'pull',
      ...(pull === null
        ? {}
        : {
            pullDirection: params.pullDirection,
            draftDeg: params.draftDeg ?? 0,
            obliqueShift:
              depth * Math.tan(Math.acos(Math.min(1, Math.abs(dot3(normalize3(params.pullDirection as Vec3), resolved.outward))))),
            footprintSize: pull.footprintSize,
            footprintDeviation: pull.footprintDeviation,
            draftedWalls: pull.draftFaces,
            ...(pull.baseGrowth > 0 ? { draftBaseGrowth: pull.baseGrowth } : {}),
          }),
      convex: closed?.convex ?? null,
      ...(engrave
        ? { toolWidth: params.toolWidth, strokeLength, note: 'the groove is the union of round-ended strokes: its boundary is polygonal' }
        : {}),
      ...(params.grid === undefined ? {} : { instances, grid: params.grid }),
    },
    {
      unverified,
      provenance: {
        method: `${params.mode} of regions wrapped by the ${chart.method} chart: one face-slab per region, fused / cut / split in a single exact operation`,
        ...(font !== null ? { font } : {}),
        inputs: {
          id: params.id,
          face: session.face,
          profileIds: params.profileIds,
          mode: params.mode,
          depth,
          placement: params.placement ?? { method: 'develop' },
        },
      },
      defaults: [
        ...(params.fitTolerance === undefined
          ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull WRP default (D-WRP-4): 1e-6 x the solid diagonal')]
          : []),
        ...(params.maxLengthStrain === undefined
          ? [{ ...namedDefault('maxLengthStrain', DEFAULT_MAX_LENGTH_STRAIN, '1', MAX_LENGTH_STRAIN_SOURCE) }]
          : []),
      ],
    },
  );
  const committed = commitKernelResult(doc, session.kernel, built, [session.entity], (newId, triangles) => {
    const change =
      volumeDelta === null
        ? 'volume change not measured'
        : `volume ${volumeDelta >= 0 ? '+' : ''}${volumeDelta.toPrecision(9)} ${doc.units}^3`;
    return `${command}: ${params.mode} of ${params.profileIds.length} profile(s) (${instances > 1 ? `${instances} instances, ` : ''}${mapped.regions.length} region(s), area ${shownArea.toPrecision(8)} ${doc.units}^2${scribe ? '' : `, depth ${depth}`}${engrave ? `, tool ${params.toolWidth}` : ''}) on ${session.surface.type} face ${session.face} of '${params.id}' → mesh '${newId}' (${triangles} triangles), ${change}${unverified ? '; unverified font' : ''}. Source solid consumed, profiles kept.${session.note}`;
  });
  return { ...committed, data, ...(session.faceName !== undefined ? { recordExtras: { face: { faceName: session.faceName } } } : {}) };
}
