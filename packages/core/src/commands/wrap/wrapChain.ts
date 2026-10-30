/**
 * wrap_to_face across a chain of adjacent faces (03 WRP M5, VC-WRP-36): the sketch curves are placed on the unfolded chart of the chain (`chainCharts.ts`), cut at the straight
 * lines the shared edges develop to, and every kept run becomes a curve on its own face, so a curve that crosses an edge continues on the next face with the same length.
 * @invariant develop is an isometry on every face and across every edge: the 3D lengths of the pieces of a curve add up to its chart length (data.curves[].length3d, strain 0); sharp
 *   edges are crossed too (wrapping needs no walls)
 * @failure the refusals of `chainCharts.ts`, a piece leaving its face, a clip that does not close -> coded no-op
 */

import type { BaseEntity, CadDocument, Entity, NurbsCurveEntity, Vec2 } from '../../model/types';
import { nextId } from '../../lib/id';
import { withEntity } from '../entity/entityOps';
import { newEntity } from '../entity/newEntity';
import type { CommandResult, ExecutionContext } from '../types';
import { sampleSegment } from '../../geometry/planeSegments';
import { buildChain } from './chainCharts';
import { clipChains } from './clipRegions';
import { wrapRejection } from './codes';
import { DEFAULT_MAX_LENGTH_STRAIN, MAX_LENGTH_STRAIN_SOURCE, namedDefault, wrapData } from './conventions';
import type { FaceRefInput, FaceSession, PlacementInput, ResolvedChart } from './faceSession';
import type { SketchOutline } from './sketchProfiles';
import { checkOnFace, checkWrapAround, isMappingFailure, mapOutlineCurves, probePoints, type MappedCurve } from './wrapMapping';

const MAX_PROBES = 48;

/** Sample polylines of sketch chains (chain coordinates), one per chain. */
const sketchPoints = (chains: ReadonlyArray<ReadonlyArray<Parameters<typeof sampleSegment>[0]>>): Vec2[][] =>
  chains.map((chain) => chain.flatMap((piece, k) => sampleSegment(piece, 5).slice(k === 0 ? 0 : 1)));

export interface ChainWrap {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext | undefined;
  readonly params: {
    readonly id: string;
    readonly entityIds: readonly string[];
    readonly placement?: PlacementInput | undefined;
    readonly fitTolerance?: number | undefined;
    readonly maxLengthStrain?: number | undefined;
    readonly chain: readonly FaceRefInput[];
  };
  readonly session: FaceSession;
  readonly resolved: ResolvedChart;
  readonly outlines: readonly SketchOutline[];
  readonly tolerance: number;
}

/** See the module comment. */
export function runWrapChain(input: ChainWrap): CommandResult {
  const { doc, ctx, params, session, resolved, outlines, tolerance } = input;
  const fail = (code: string, message: string, ids: readonly string[] = [params.id]): CommandResult =>
    wrapRejection(doc, 'wrap_to_face', code, message, [...ids], ['entityIds']);
  const limit = params.maxLengthStrain ?? DEFAULT_MAX_LENGTH_STRAIN;
  const chain = buildChain(
    doc,
    ctx,
    'wrap_to_face',
    { session, resolved, mirror: params.placement?.mirror ?? false },
    params.chain,
    tolerance,
    limit,
    sketchPoints(outlines.flatMap((outline) => [...outline.regions.flatMap((region) => [region.outer, ...region.holes]), ...outline.open])),
  );
  if ('summary' in chain) return chain;
  let next: CadDocument = doc;
  const created: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const parts: Array<{ face: number; kind: string; curves: number; length3d: number }> = [];
  for (const face of chain.faces) {
    const mapped: MappedCurve[] = [];
    for (const outline of outlines) {
      const pieces = [
        ...outline.regions.flatMap((region) => [
          { segments: region.outer, closed: true, role: 'outer' as const },
          ...region.holes.map((segments) => ({ segments, closed: true, role: 'hole' as const })),
        ]),
        ...outline.open.map((segments) => ({ segments, closed: false, role: 'open' as const })),
      ];
      let kept = pieces;
      for (const plane of face.clips) kept = clipChains(kept, plane);
      if (kept.length === 0) continue;
      const clipped: SketchOutline = {
        ...outline,
        regions: kept.filter((piece) => piece.closed).map((piece) => ({ outer: piece.segments, holes: [] })),
        open: kept.filter((piece) => !piece.closed).map((piece) => piece.segments),
      };
      const curves = mapOutlineCurves(face.session, face.chart, clipped, tolerance);
      if (isMappingFailure(curves)) return fail(curves.code, `face ${face.session.face}: ${curves.message}`, curves.ids);
      // mapOutlineCurves lists the regions, then the open chains: the roles of the source loops (a hole stays a hole) are put back in that order
      const roles = [
        ...kept.filter((piece) => piece.closed).map((piece) => piece.role),
        ...kept.filter((piece) => !piece.closed).map(() => 'open' as const),
      ];
      mapped.push(...curves.map((curve, index) => ({ ...curve, role: roles[index] ?? curve.role })));
    }
    if (mapped.length === 0) continue;
    const pieces = mapped.map((curve) => curve.pieces);
    const overlap = checkWrapAround(face.chart, pieces, params.entityIds);
    if (overlap !== null) return fail(overlap.code, `face ${face.session.face}: ${overlap.message}`, overlap.ids);
    const outside = checkOnFace(face.session, probePoints(face.chart, pieces, MAX_PROBES), params.entityIds, face.slack);
    if (outside !== null) return fail(outside.code, `face ${face.session.face}: ${outside.message}`, outside.ids);
    let length = 0;
    for (const curve of mapped) {
      const source = doc.entities[curve.sourceId] as Entity;
      const id = nextId('curve');
      const entity: Entity = newEntity(
        'nurbs_curve',
        id,
        {
          curve: curve.curve,
          onFace: {
            entityId: params.id,
            faceIndex: face.session.face,
            ...(face.session.faceName !== undefined ? { faceName: face.session.faceName } : {}),
            pcurve: curve.pcurve,
            fitTolerance: curve.fitTolerance,
            chartLength: curve.chartLength,
          },
        } satisfies Omit<NurbsCurveEntity, keyof BaseEntity>,
        [0, 0, 0],
        source.color,
        { layerId: source.layerId },
      );
      next = withEntity(next, entity);
      created.push(id);
      length += curve.length3d;
      records.push({
        id,
        sourceId: curve.sourceId,
        face: face.session.face,
        role: curve.role,
        closed: curve.closed,
        chartLength: curve.chartLength,
        length3d: curve.length3d,
        maxLengthStrain: Math.abs(curve.length3d / curve.chartLength - 1),
        fitTolerance: curve.fitTolerance,
        exact: curve.fitTolerance === 0,
      });
    }
    parts.push({ face: face.session.face, kind: face.session.surface.type, curves: mapped.length, length3d: length });
  }
  if (created.length === 0) return fail('WRP_OUTSIDE_FACE', 'the sketch lies on none of the chain faces', params.entityIds);
  const curveStrain = Math.max(0, ...records.map((record) => record['maxLengthStrain'] as number));
  const joinStrain = Math.max(0, ...chain.edges.map((edge) => edge.mismatch));
  const strain = Math.max(curveStrain, joinStrain);
  if (!chain.developable && curveStrain > limit)
    return {
      ...fail(
        'WRP_DISTORTION_EXCEEDED',
        `the geodesic charts of the chain stretch a curve by ${(100 * curveStrain).toPrecision(4)} % (limit ${(100 * limit).toPrecision(4)} %); use a smaller sketch or a larger maxLengthStrain`,
        params.entityIds,
      ),
      data: { distortion: { maxLengthStrain: curveStrain, joinMismatch: joinStrain, limit, method: chain.method } },
    };
  const unverified = outlines.some((outline) => outline.unverified);
  const data = wrapData(
    doc,
    {
      curves: records,
      faces: parts,
      chain: chain.faces.map((face) => face.session.face),
      edges: chain.edges.map((edge) => ({
        edge: edge.edge,
        faces: edge.faces,
        length: edge.length,
        convexity: edge.convexity,
        mismatch: edge.mismatch,
        windowLength: edge.windowLength,
        cutGap: edge.cutGap,
      })),
      distortion: {
        maxLengthStrain: strain,
        curveStrain,
        joinMismatch: joinStrain,
        meanLengthStrain: 0,
        areaRatio: 1,
        method: chain.method,
        limit,
        limitDefaulted: params.maxLengthStrain === undefined,
      },
      method: chain.method,
      exact: records.every((record) => record['exact'] === true),
      anchor: { chart: resolved.anchorChart, on: resolved.anchorOn },
    },
    {
      unverified,
      provenance: {
        method: chain.developable
          ? 'develop across a chain of faces (length-preserving unfolding across the shared edges)'
          : 'geodesic charts of the chain faces anchored on the shared edges (frame matched there; the stretch of every curve and the mismatch of every join are measured)',
        inputs: {
          id: params.id,
          face: session.face,
          chain: params.chain,
          entityIds: params.entityIds,
          placement: params.placement ?? { method: 'develop' },
        },
      },
      defaults: [
        ...(params.fitTolerance === undefined
          ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull WRP default (D-WRP-4): 1e-6 x the solid diagonal')]
          : []),
        ...(params.maxLengthStrain === undefined && !chain.developable
          ? [namedDefault('maxLengthStrain', DEFAULT_MAX_LENGTH_STRAIN, '1', MAX_LENGTH_STRAIN_SOURCE)]
          : []),
      ],
    },
  );
  return {
    document: next,
    affected: created,
    summary: `wrap_to_face: wrapped ${params.entityIds.length} entit${params.entityIds.length === 1 ? 'y' : 'ies'} across ${parts.length} faces of '${params.id}' (${parts.map((part) => `${part.kind} ${part.face}`).join(', ')}; ${chain.developable ? 'develop, lengths kept' : `${chain.method}, max stretch ${(100 * strain).toPrecision(4)} %`}): ${created.length} curve(s) ${created.join(', ')}${unverified ? '; unverified font' : ''}.`,
    data,
    ...(session.faceName !== undefined ? { recordExtras: { face: { faceName: session.faceName } } } : {}),
  };
}
