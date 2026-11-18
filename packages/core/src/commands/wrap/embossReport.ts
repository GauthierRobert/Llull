import { dot3, normalize3 } from '../../lib/vec3';
import type { Vec3 } from '../../model/types';
import { regionsAreas } from '../../geometry/embossVolume';
import { sampleSegment } from '../../geometry/planeSegments';
import { commitKernelResult, type evaluateRecipe } from '../kernelShape';
import type { CommandResult } from '../types';
import { DEFAULT_MAX_LENGTH_STRAIN, MAX_LENGTH_STRAIN_SOURCE, namedDefault, wrapData } from './conventions';
import { distortionData } from './distortion';
import type { MappedEmboss } from './embossMapping';
import { embossPreviewResult } from './embossPreview';
import type { EmbossRecipe } from './embossRecipe';
import type { EmbossCall } from './embossRequest';
import type { SketchOutline } from './sketchProfiles';

export interface EmbossReportInput {
  readonly mapped: MappedEmboss;
  readonly recipe: EmbossRecipe;
  readonly outlines: SketchOutline[];
  readonly unverified: boolean;
  readonly font: SketchOutline['font'];
  readonly strokeLength: number | null;
  readonly built: Exclude<ReturnType<typeof evaluateRecipe>, string>;
  readonly volumeDelta: number | null;
}

const instancesOf = (call: EmbossCall): number => (call.params.grid === undefined ? 1 : call.params.grid.countX * call.params.grid.countY);

export function previewEmboss(
  call: EmbossCall,
  { mapped, distortion, limit, holeFlags }: MappedEmboss,
  recipe: EmbossRecipe,
): CommandResult {
  const { doc, command, params, session, resolved, pulled, depth } = call;
  const { closed, recipeParams } = recipe;
  return embossPreviewResult(doc, command, {
    chart: resolved.chart,
    pieces: mapped.pieces,
    holeFlags,
    mode: params.mode,
    depth,
    distortion,
    requestedMethod: resolved.method,
    limit,
    limitDefaulted: params.maxLengthStrain === undefined,
    expectedVolumeDelta: closed?.delta ?? null,
    regionArea: closed?.area ?? null,
    faceKind: session.surface.type,
    face: session.face,
    anchor: resolved.anchorOn,
    normal: recipeParams.direction,
    draftNotBuilt: pulled && (params.draftDeg ?? 0) > 0,
    instances: instancesOf(call),
  });
}

const spanOf = (mapped: MappedEmboss['mapped']): number =>
  Math.max(...mapped.pieces.flat().flatMap((piece) => sampleSegment(piece, 9).map((p) => p[0]))) -
  Math.min(...mapped.pieces.flat().flatMap((piece) => sampleSegment(piece, 9).map((p) => p[0])));

function chartFields(call: EmbossCall, spanU: number): Record<string, unknown> {
  const { session, resolved } = call;
  const { chart } = resolved;
  return chart.kind === 'plane'
    ? {}
    : {
        angularSpanRad: spanU,
        ...(chart.kind === 'cone'
          ? { developedSectorRad: spanU * Math.sin((session.surface as { semiAngle?: number }).semiAngle ?? 1) }
          : {}),
      };
}

function pullFields(call: EmbossCall, pull: EmbossRecipe['pull']): Record<string, unknown> {
  const { params, resolved, depth } = call;
  return pull === null
    ? {}
    : {
        pullDirection: params.pullDirection,
        draftDeg: params.draftDeg ?? 0,
        obliqueShift: depth * Math.tan(Math.acos(Math.min(1, Math.abs(dot3(normalize3(params.pullDirection as Vec3), resolved.outward))))),
        footprintSize: pull.footprintSize,
        footprintDeviation: pull.footprintDeviation,
        draftedWalls: pull.draftFaces,
        ...(pull.baseGrowth > 0 ? { draftBaseGrowth: pull.baseGrowth } : {}),
      };
}

function freeformFields(freeform: EmbossRecipe['freeform']): Record<string, unknown> {
  return freeform === null
    ? {}
    : {
        freeform: {
          walls: 'pull',
          pullDirection: freeform.pull,
          footprintDeviation: freeform.footprintDeviation,
          footprintSegments: freeform.footprintSegments,
          note: 'walls run along the outward normal at the anchor; the top is the exact offset of the face by the depth; the footprint is the exact image fitted by Bezier segments to footprintDeviation',
        },
      };
}

function provenanceMethod(call: EmbossCall, freeform: EmbossRecipe['freeform']): string {
  const { params, resolved } = call;
  return freeform !== null
    ? `${params.mode} of regions charted by the ${resolved.chart.method} chart of a freeform face: intersections of the footprint prisms along the outward normal with the exact offset layer of the face, fused / cut as exact booleans`
    : `${params.mode} of regions wrapped by the ${resolved.chart.method} chart: one face-slab per region, fused / cut / split in a single exact operation`;
}

function defaultsOf(call: EmbossCall): ReturnType<typeof namedDefault>[] {
  const { doc, params, tolerance } = call;
  return [
    ...(params.fitTolerance === undefined
      ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull WRP default (D-WRP-4): 1e-6 x the solid diagonal')]
      : []),
    ...(params.maxLengthStrain === undefined
      ? [{ ...namedDefault('maxLengthStrain', DEFAULT_MAX_LENGTH_STRAIN, '1', MAX_LENGTH_STRAIN_SOURCE) }]
      : []),
  ];
}

function shownAreaOf(input: EmbossReportInput): number {
  const { recipe, mapped, outlines } = input;
  const { closed, freeform, pull } = recipe;
  const sketchArea = outlines.reduce((sum, outline) => sum + outline.area, 0);
  return (
    closed?.area ??
    (freeform !== null ? mapped.distortion.areaRatio * sketchArea : pull === null ? regionsAreas(mapped.mapped.regions).uv : sketchArea)
  );
}

function reportData(call: EmbossCall, input: EmbossReportInput, shownArea: number): Record<string, unknown> {
  const { doc, params, session, resolved, engrave, depth } = call;
  const { chart } = resolved;
  const { mapped, recipe, unverified, font, strokeLength, volumeDelta } = input;
  const { freeform, pull, closed } = recipe;
  const spanU = spanOf(mapped.mapped);
  return wrapData(
    doc,
    {
      volumeDelta,
      expectedVolumeDelta: closed?.delta ?? null,
      regionArea: shownArea,
      regions: mapped.mapped.regions.length,
      loops: mapped.mapped.pieces.length,
      mode: params.mode,
      depth,
      method: chart.method,
      exact: !engrave && freeform === null && !(pull !== null && pull.footprintDeviation > 0),
      faceKind: session.surface.type,
      face: session.face,
      ...(session.faceName !== undefined ? { faceName: session.faceName } : {}),
      ...chartFields(call, spanU),
      distortion: distortionData(mapped.distortion, chart, resolved.method, mapped.limit, params.maxLengthStrain === undefined),
      fullWrapChartWidth: chart.fullWrapWidth,
      walls: freeform !== null || pull !== null ? 'pull' : 'normal',
      ...pullFields(call, pull),
      convex: closed?.convex ?? null,
      ...freeformFields(freeform),
      ...(engrave
        ? { toolWidth: params.toolWidth, strokeLength, note: 'the groove is the union of round-ended strokes: its boundary is polygonal' }
        : {}),
      ...(params.grid === undefined ? {} : { instances: instancesOf(call), grid: params.grid }),
    },
    {
      unverified,
      provenance: {
        method: provenanceMethod(call, freeform),
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
      defaults: defaultsOf(call),
    },
  );
}

export function commitEmboss(call: EmbossCall, input: EmbossReportInput): CommandResult {
  const { doc, command, params, session, engrave, scribe, depth } = call;
  const { mapped, recipe, unverified, built, volumeDelta } = input;
  const instances = instancesOf(call);
  const shownArea = shownAreaOf(input);
  const data = reportData(call, input, shownArea);
  const committed = commitKernelResult(doc, session.kernel, built, [session.entity], (newId, triangles) => {
    const change =
      volumeDelta === null
        ? 'volume change not measured'
        : `volume ${volumeDelta >= 0 ? '+' : ''}${volumeDelta.toPrecision(9)} ${doc.units}^3`;
    return `${command}: ${params.mode} of ${params.profileIds.length} profile(s) (${instances > 1 ? `${instances} instances, ` : ''}${mapped.mapped.regions.length} region(s), area ${shownArea.toPrecision(8)} ${doc.units}^2${scribe ? '' : `, depth ${depth}`}${engrave ? `, tool ${params.toolWidth}` : ''}) on ${recipe.freeform !== null ? 'freeform' : session.surface.type} face ${session.face} of '${params.id}' → mesh '${newId}' (${triangles} triangles), ${change}${unverified ? '; unverified font' : ''}. Source solid consumed, profiles kept.${session.note}`;
  });
  return { ...committed, data, ...(session.faceName !== undefined ? { recordExtras: { face: { faceName: session.faceName } } } : {}) };
}
