/** wrap_to_face — carry 2D sketch curves (and font text outlines) onto a plane, cylinder or cone face as exact-length curves on the face (03 WRP M2). */

import type { BaseEntity, CadDocument, Entity, NurbsCurveEntity } from '../../model/types';
import { nextId } from '../../lib/id';
import { withEntity } from '../entity/entityOps';
import { defineCommand, z } from '../schema';
import { newEntity } from '../entity/newEntity';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { namedDefault, wrapData } from './conventions';
import { defaultFitTolerance, isRejection, openFace, resolveChart } from './faceSession';
import { faceRefField, placementField } from './schemas';
import { isSketchFailure, sketchOutline, type SketchOutline } from './sketchProfiles';
import { checkOnFace, checkWrapAround, isMappingFailure, mapOutlineCurves, probePoints, type MappedCurve } from './wrapMapping';

/** Most sketch entities one call wraps (each loop becomes a curve entity). */
const MAX_ENTITIES = 500;
const MAX_PROBES = 48;

/**
 * @affects creates one \`nurbs_curve\` per closed loop and per open chain of the given entities (a text: one per glyph contour), each with \`onFace\`
 * @invariant develop is an isometry: chart length = 3D length (data.curves[i].maxLengthStrain 0, data.distortion.areaRatio 1); plane curves are exact, cylinder
 *   and cone curves are fitted within fitTolerance (reported per curve); ids are step-scoped
 * @failure unknown ids / not a solid / no face / sphere or freeform face with develop / region leaving the face / wrap beyond one turn / anchor off the face -> coded no-op
 */
export const wrapToFace = defineCommand({
  name: 'wrap_to_face',
  description:
    'Wrap 2D sketch entities onto a face of a solid as curves lying on that face, keeping every length (method develop: the face is unrolled like paper). ' +
    'Works on plane, cylinder and cone faces; a sphere or freeform face refuses with WRP_FACE_NOT_DEVELOPABLE. `entityIds` are sketch curves (line, arc, circle, ' +
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
    fitTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest deviation of a fitted 3D curve from its exact image, document units. Default: 1e-6 x the solid diagonal (named default).',
      ),
  }),
  annotations: { requiresKernel: true },
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
        distortion: {
          maxLengthStrain: 0,
          meanLengthStrain: 0,
          areaRatio: 1,
          method: 'develop',
          note: 'plane, cylinder and cone develop without stretch',
        },
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
          method: 'develop (length-preserving chart)',
          ...(fontOutline?.font != null ? { font: fontOutline.font } : {}),
          inputs: { id: params.id, face: session.face, entityIds: params.entityIds, placement: params.placement ?? { method: 'develop' } },
        },
        defaults:
          params.fitTolerance === undefined
            ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull WRP default (D-WRP-4): 1e-6 x the solid diagonal')]
            : [],
      },
    );
    const lengths = records.map((record) => (record['length3d'] as number).toPrecision(8)).join(', ');
    const result: CommandResult = {
      document: next,
      affected: created,
      summary: `wrap_to_face: wrapped ${params.entityIds.length} entit${params.entityIds.length === 1 ? 'y' : 'ies'} onto ${session.surface.type} face ${session.face} of '${params.id}' (develop, lengths kept): ${created.length} curve(s) ${created.join(', ')}, 3D lengths ${lengths} ${doc.units}${unverified ? '; unverified font' : ''}.${session.note}`,
      data,
      ...(session.faceName !== undefined ? { recordExtras: { face: { faceName: session.faceName } } } : {}),
    };
    return result;
  },
});
