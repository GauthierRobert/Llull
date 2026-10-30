/** wrap_to_face — carry 2D sketch curves (and font text outlines) onto a plane, cylinder or cone face as exact-length curves on the face (03 WRP M2). */

import type { BaseEntity, CadDocument, Entity, NurbsCurveEntity } from '../../model/types';
import { nextId } from '../../lib/id';
import { withEntity } from '../entity/entityOps';
import { defineCommand, z } from '../schema';
import { newEntity } from '../entity/newEntity';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { DEFAULT_MAX_LENGTH_STRAIN, MAX_LENGTH_STRAIN_SOURCE, namedDefault, wrapData } from './conventions';
import { distortionData, distortionMessage, distortionOf } from './distortion';
import { defaultFitTolerance, isRejection, openFace, resolveChart } from './faceSession';
import { faceRefField, placementField } from './schemas';
import { runWrapChain } from './wrapChain';
import { isSketchFailure, sketchOutline, type SketchOutline } from './sketchProfiles';
import { checkOnFace, checkWrapAround, isMappingFailure, mapOutlineCurves, probePoints, type MappedCurve } from './wrapMapping';

/** Most sketch entities one call wraps (each loop becomes a curve entity). */
const MAX_ENTITIES = 500;
const MAX_PROBES = 48;

/**
 * @affects creates one \`nurbs_curve\` per closed loop and per open chain of the given entities (a text: one per glyph contour), each with \`onFace\`
 * @invariant develop is an isometry: chart length = 3D length (data.curves[i].maxLengthStrain 0, data.distortion.areaRatio 1); geodesic and parametric charts on a sphere or
 *   torus stretch, and the stretch is measured (data.distortion) and held to maxLengthStrain; plane curves are exact, the others are fitted within fitTolerance (reported
 *   per curve); ids are step-scoped
 * @failure unknown ids / not a solid / no face / sphere, torus or freeform face with develop / freeform face without a kernel B-spline / fold of a freeform geodesic chart / region leaving the face / wrap beyond one turn / stretch above the limit /
 *   anchor off the face -> coded no-op
 */
export const wrapToFace = defineCommand({
  name: 'wrap_to_face',
  description:
    'Wrap 2D sketch entities onto a face of a solid as curves lying on that face. Method develop (default) keeps every length (the face is unrolled like paper) and works on ' +
    'plane, cylinder and cone faces; on a sphere or torus it refuses with WRP_FACE_NOT_DEVELOPABLE. Method geodesic wraps by the exponential map about the anchor (radial lengths ' +
    'exact, circumferential ones stretch by sin(rho / R) / (rho / R) on a sphere); method parametric scales (u, v) by the arc-length rates at the anchor; both work on sphere and ' +
    'torus faces and report data.distortion { maxLengthStrain, meanLengthStrain, areaRatio, worst } and refuse above maxLengthStrain (WRP_DISTORTION_EXCEEDED). On a freeform (B-spline) face ' +
    'only geodesic and parametric work (develop refuses with WRP_FACE_NOT_DEVELOPABLE): the geodesic chart integrates the geodesics of the exact surface (RK4) and refuses a sketch that reaches a fold of the ' +
    'exponential map with WRP_CHART_FOLD, the curves record their pcurve in the own (u, v) of the face; the geodesic chart is valid up to the first fold (conjugate point) of the exponential map, a cut-locus overlap before it is not detected; a periodic B-spline is charted as a strip (a sketch round the seam stops there with WRP_OUTSIDE_FACE); a kernel with no B-spline for the face refuses with WRP_METHOD_UNAVAILABLE. `entityIds` are sketch curves (line, arc, circle, ' +
    'rectangle, polyline, spline ...) or text created with a font (each glyph contour becomes a curve). `placement` puts a sketch point on a face point ' +
    '(anchor), turns the sketch (angleDeg) and may mirror it; the chart x axis follows the circumference (cylinder: +azimuth about the axis) and y the axis. ' +
    'Each closed loop and open chain becomes one nurbs_curve entity with its pcurve (`onFace`). The result lists per curve length3d (document units), chartLength, ' +
    'maxLengthStrain and fitTolerance, and data.distortion. A sketch wider than one turn refuses with WRP_WRAP_OVERLAP (data shows the full-turn width), a ' +
    'curve leaving the face with WRP_OUTSIDE_FACE. Needs the exact (native) kernel. Next: emboss_on_face, check_wrap, render_view.',
  params: z.object({
    id: z.string().describe('Id of the solid whose face carries the curves.'),
    face: faceRefField,
    entityIds: z.array(z.string()).min(1).max(MAX_ENTITIES).describe('Ids of the 2D sketch entities (or font texts) to wrap.'),
    placement: placementField.optional(),
    chain: z
      .array(faceRefField)
      .max(15)
      .optional()
      .describe(
        'Multi-face wrap: more faces (plane or cylinder) adjacent to `face`, each sharing an edge with the faces before it. The faces are unfolded into one chart (develop, lengths kept, also across sharp edges), the curves are cut at the shared edges and each run becomes a curve on its own face (data.faces, curves[].face). Edges must develop to straight lines (WRP_CHAIN_EDGE_CURVED otherwise); WRP_CHAIN_FACE_UNSUPPORTED for cone, sphere, torus faces; WRP_CHAIN_NOT_ADJACENT when a face shares no edge.',
      ),
    maxLengthStrain: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest accepted relative length change of a geodesic or parametric chart (1 = 100 %). Default 0.02 (named default); develop faces have none.',
      ),
    fitTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest deviation of a fitted 3D curve from its exact image, document units. Default: 1e-6 x the solid diagonal (named default).',
      ),
  }),
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  run: (doc, params, ctx): CommandResult => {
    const session = openFace(doc, ctx, 'wrap_to_face', params.id, params.face);
    if (isRejection(session)) return session;
    const resolved = resolveChart(doc, session, params.placement, params.face.faceNear);
    if ('summary' in resolved) return resolved;
    const outlines: SketchOutline[] = [];
    for (const [index, entityId] of params.entityIds.entries()) {
      const outline = sketchOutline(doc, entityId);
      if (isSketchFailure(outline))
        return wrapRejection(doc, 'wrap_to_face', outline.code, outline.message, [entityId], [`entityIds.${index}`]);
      outlines.push(outline);
    }
    const tolerance = params.fitTolerance ?? defaultFitTolerance(session.diagonal);
    if (params.chain !== undefined && params.chain.length > 0)
      return runWrapChain({ doc, ctx, params: { ...params, chain: params.chain }, session, resolved, outlines, tolerance });
    const mapped: MappedCurve[] = [];
    for (const outline of outlines) {
      const curves = mapOutlineCurves(session, resolved.chart, outline, tolerance);
      if (isMappingFailure(curves)) return wrapRejection(doc, 'wrap_to_face', curves.code, curves.message, [...curves.ids], ['entityIds']);
      mapped.push(...curves);
    }
    const pieces = mapped.map((curve) => curve.pieces);
    const overlap = checkWrapAround(resolved.chart, pieces, params.entityIds);
    if (overlap !== null) {
      const result = wrapRejection(doc, 'wrap_to_face', overlap.code, overlap.message, [...overlap.ids], ['entityIds']);
      return { ...result, data: { fullWrapChartWidth: resolved.chart.fullWrapWidth, unit: doc.units } };
    }
    const outside = checkOnFace(session, probePoints(resolved.chart, pieces, MAX_PROBES), params.entityIds);
    if (outside !== null) return wrapRejection(doc, 'wrap_to_face', outside.code, outside.message, [...outside.ids], ['entityIds']);
    const limit = params.maxLengthStrain ?? DEFAULT_MAX_LENGTH_STRAIN;
    const distortion = distortionOf(
      resolved.chart,
      outlines,
      mapped.filter((curve) => curve.closed).map((curve) => ({ pieces: curve.pieces, hole: curve.role === 'hole' })),
    );
    if (distortion.maxLengthStrain > limit) {
      const refused = wrapRejection(
        doc,
        'wrap_to_face',
        'WRP_DISTORTION_EXCEEDED',
        distortionMessage(distortion, limit, resolved.chart.method),
        [params.id],
        ['placement'],
      );
      return {
        ...refused,
        data: { distortion: distortionData(distortion, resolved.chart, resolved.method, limit, params.maxLengthStrain === undefined) },
      };
    }
    let next: CadDocument = doc;
    const records: Array<Record<string, unknown>> = [];
    const created: string[] = [];
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
            faceIndex: session.face,
            ...(session.faceName !== undefined ? { faceName: session.faceName } : {}),
            pcurve: curve.pcurve,
            ...(resolved.chart.kind === 'freeform' ? { frame: 'native' as const } : {}),
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
      records.push({
        id,
        sourceId: curve.sourceId,
        role: curve.role,
        closed: curve.closed,
        chartLength: curve.chartLength,
        length3d: curve.length3d,
        maxLengthStrain: Math.abs(curve.length3d / curve.chartLength - 1),
        fitTolerance: curve.fitTolerance,
        exact: curve.fitTolerance === 0,
      });
    }
    const unverified = outlines.some((outline) => outline.unverified);
    const fontOutline = outlines.find((outline) => outline.font !== null);
    const data = wrapData(
      doc,
      {
        curves: records,
        distortion: distortionData(distortion, resolved.chart, resolved.method, limit, params.maxLengthStrain === undefined),
        method: resolved.chart.method,
        exact: records.every((record) => record['exact'] === true),
        faceKind: session.surface.type,
        face: session.face,
        ...(session.faceName !== undefined ? { faceName: session.faceName } : {}),
        fullWrapChartWidth: resolved.chart.fullWrapWidth,
        anchor: { chart: resolved.anchorChart, on: resolved.anchorOn },
      },
      {
        unverified,
        provenance: {
          method:
            resolved.chart.method === 'develop'
              ? 'develop (length-preserving chart)'
              : `${resolved.chart.method} chart (stretch measured, see data.distortion)`,
          ...(fontOutline?.font != null ? { font: fontOutline.font } : {}),
          inputs: { id: params.id, face: session.face, entityIds: params.entityIds, placement: params.placement ?? { method: 'develop' } },
        },
        defaults: [
          ...(params.fitTolerance === undefined
            ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull WRP default (D-WRP-4): 1e-6 x the solid diagonal')]
            : []),
          ...(params.maxLengthStrain === undefined && resolved.chart.method !== 'develop'
            ? [namedDefault('maxLengthStrain', DEFAULT_MAX_LENGTH_STRAIN, '1', MAX_LENGTH_STRAIN_SOURCE)]
            : []),
        ],
      },
    );
    const lengths = records.map((record) => (record['length3d'] as number).toPrecision(8)).join(', ');
    const result: CommandResult = {
      document: next,
      affected: created,
      summary: `wrap_to_face: wrapped ${params.entityIds.length} entit${params.entityIds.length === 1 ? 'y' : 'ies'} onto ${session.surface.type} face ${session.face} of '${params.id}' (${resolved.chart.method === 'develop' ? 'develop, lengths kept' : `${resolved.chart.method}, max stretch ${(100 * distortion.maxLengthStrain).toPrecision(4)} %`}): ${created.length} curve(s) ${created.join(', ')}, 3D lengths ${lengths} ${doc.units}${unverified ? '; unverified font' : ''}.${session.note}`,
      data,
      ...(session.faceName !== undefined ? { recordExtras: { face: { faceName: session.faceName } } } : {}),
    };
    return result;
  },
});
