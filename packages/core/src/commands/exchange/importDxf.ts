/**
 * @affects creates the drawing's entities (lines, polylines, rectangles, arcs, circles, ellipses, splines, points, texts, hatch regions; 3D faces
 *   as one mesh per layer) and any missing layers (name, colour, hidden / locked state)
 * @failure not an ASCII DXF / nothing importable -> no-op, affected:[]
 */

import { type CadDocument, type Entity, type Layer, type Vec2, type Vec3, DEFAULT_LAYER_ID, DOCUMENT_UNITS } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { noop } from '../noop';
import { nextId } from '../../lib/id';
import { newEntity } from '../entity/newEntity';
import { flattenDxf, parseDxf, type DxfLayerStyle } from '../../lib/dxfRead';
import { isFinitePrimitive, makeRegion, regionGeometry, scalePrimitive, toEntities } from './dxfToEntities';
import { aciToHex, insUnitsMillimetres } from '../../lib/dxfUnits';
import { MAX_IMPORT_TRIANGLES } from '../limits';
import { MM_PER_UNIT } from '../../model/units';

/** Entities created by one import at most (larger drawings are truncated, and say so). */
export const MAX_DXF_ENTITIES = 20000;

interface LayerResolver {
  readonly layers: Record<string, Layer>;
  readonly layerOrder: string[];
  readonly created: string[];
  idFor(name: string, aci: number, style: DxfLayerStyle | undefined): string;
}

function layerResolver(doc: CadDocument): LayerResolver {
  const layers = { ...doc.layers };
  const layerOrder = [...doc.layerOrder];
  const created: string[] = [];
  const byName = new Map(Object.values(layers).map((layer) => [layer.name.toLowerCase(), layer.id]));
  return {
    layers,
    layerOrder,
    created,
    idFor(name, aci, style) {
      if (name === '0' && layers[DEFAULT_LAYER_ID]) return DEFAULT_LAYER_ID;
      const existing = byName.get(name.toLowerCase());
      if (existing !== undefined) return existing;
      const id = nextId('layer');
      layers[id] = { id, name, visible: style?.hidden !== true, locked: style?.locked === true, color: style?.trueColor ?? aciToHex(aci) };
      layerOrder.push(id);
      byName.set(name.toLowerCase(), id);
      created.push(name);
      return id;
    },
  };
}

export const importDxf = defineCommand({
  name: 'import_dxf',
  description:
    'Import an ASCII DXF drawing (AutoCAD, Civil 3D, BricsCAD, QCAD, survey software exports) as ' +
    'editable 2D entities on their DXF layers: LINE, LWPOLYLINE (bulges as arcs), POLYLINE, ARC, ' +
    'CIRCLE, ELLIPSE (a full one; an elliptical arc becomes a polyline), SPLINE (its fit points, else the NURBS sampled), HATCH (a region with ' +
    'its pattern), POINT, TEXT, MTEXT, block INSERTs (exploded) and 3DFACE (one mesh per layer). Reads back what export_dxf writes: ' +
    'rectangles, splines and unhatched regions are restored from its LLULL extended data, true colours and layer visibility / lock are kept. ' +
    'Elevations are kept as the entity plane height. Units come from $INSUNITS unless `sourceUnit` is given. ' +
    'Binary DXF and DWG are not supported (save as ASCII DXF). For terrain from survey DXFs use import_survey_dxf.',
  params: z.object({
    text: z.string().describe('DXF file content (ASCII).'),
    sourceUnit: z
      .enum(DOCUMENT_UNITS)
      .optional()
      .describe('Drawing unit when $INSUNITS is missing or wrong. Default: $INSUNITS, else the document unit.'),
    layers: z.array(z.string()).optional().describe('Only import these DXF layers (case-insensitive). Default: every layer.'),
  }),
  run: (doc, { text, sourceUnit, layers: layerFilter }): CommandResult => {
    const drawing = parseDxf(text);
    if (drawing === null)
      return noop(doc, 'import_dxf failed: not an ASCII DXF with an ENTITIES section (binary DXF / DWG: re-save as ASCII DXF).');
    const headerMm = insUnitsMillimetres(drawing.insUnits);
    const sourceMm = sourceUnit !== undefined ? MM_PER_UNIT[sourceUnit] : (headerMm ?? MM_PER_UNIT[doc.units]);
    const factor = sourceMm / MM_PER_UNIT[doc.units];
    const wanted = layerFilter?.map((name) => name.toLowerCase());
    const { primitives, skipped } = flattenDxf(drawing);
    const selected = primitives.filter((primitive) => wanted === undefined || wanted.includes(primitive.layer.toLowerCase()));
    const resolver = layerResolver(doc);
    const entities = { ...doc.entities };
    const order = [...doc.order];
    const affected: string[] = [];
    const counts = new Map<string, number>();
    const regionLoops = new Map<number, { loops: Vec2[][]; z: number; layerId: string; color: string }>();
    const faces = new Map<string, { positions: number[]; indices: number[]; color: string }>();
    let flattened = 0;
    let truncated = 0;
    let nonFinite = 0;
    let faceTriangles = 0;
    for (const raw of selected) {
      const primitive = scalePrimitive(raw, factor);
      if (!isFinitePrimitive(primitive)) {
        nonFinite += 1;
        continue;
      }
      const layerAci = drawing.layers.get(primitive.layer) ?? 7;
      const layerStyle = drawing.layerStyles.get(primitive.layer);
      const layerId = resolver.idFor(primitive.layer, layerAci, layerStyle);
      const byLayer = primitive.color === 256 || primitive.color === 0;
      const color = primitive.trueColor ?? (byLayer ? (layerStyle?.trueColor ?? aciToHex(layerAci)) : aciToHex(primitive.color));
      if (primitive.kind === 'face') {
        const triangles = primitive.corners.length === 4 ? 2 : 1;
        if (faceTriangles + triangles > MAX_IMPORT_TRIANGLES) {
          truncated += 1;
          continue;
        }
        faceTriangles += triangles;
        const mesh = faces.get(layerId) ?? { positions: [], indices: [], color };
        const base = mesh.positions.length / 3;
        for (const corner of primitive.corners) mesh.positions.push(...corner);
        mesh.indices.push(base, base + 1, base + 2);
        if (primitive.corners.length === 4) mesh.indices.push(base, base + 2, base + 3);
        faces.set(layerId, mesh);
        continue;
      }
      if (affected.length >= MAX_DXF_ENTITIES) {
        truncated += 1;
        continue;
      }
      if (primitive.kind === 'polyline' && primitive.mark?.kind === 'region') {
        const group = regionLoops.get(primitive.mark.ordinal) ?? { loops: [], z: (primitive.points[0] as Vec3)[2], layerId, color };
        group.loops.push(primitive.points.map((point): Vec2 => [point[0], point[1]]));
        regionLoops.set(primitive.mark.ordinal, group);
        continue;
      }
      const converted = toEntities(primitive, layerId, color);
      if (converted.flattened) flattened += 1;
      converted.entities.forEach((entity, index) => {
        entities[entity.id] = entity;
        order.push(entity.id);
        affected.push(entity.id);
        const label = converted.labels[index] ?? entity.kind;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      });
    }
    for (const { loops, z, layerId, color } of regionLoops.values()) {
      const region = regionGeometry(loops);
      const made: Entity[] =
        region === null
          ? loops.map((points) => newEntity('polyline', nextId('polyline'), { points, closed: true }, [0, 0, z], color, { layerId }))
          : [makeRegion(region, z, layerId, color, null)];
      for (const entity of made) {
        entities[entity.id] = entity;
        order.push(entity.id);
        affected.push(entity.id);
        const label = region === null ? 'polyline (region loop)' : 'region';
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    for (const [layerId, mesh] of faces) {
      const id = nextId('mesh');
      entities[id] = newEntity('mesh', id, { mesh }, [0, 0, 0], mesh.color, { layerId });
      order.push(id);
      affected.push(id);
      counts.set('3D face mesh', (counts.get('3D face mesh') ?? 0) + 1);
    }
    if (affected.length === 0)
      return noop(
        doc,
        `import_dxf: nothing importable${wanted ? ` on layers ${layerFilter?.join(', ')}` : ''}` +
          (skipped.size > 0 ? ` (skipped ${[...skipped.keys()].join(', ')}).` : '.'),
      );
    const unitLabel = sourceUnit ?? (headerMm !== null ? `$INSUNITS ${drawing.insUnits}` : `${doc.units} (assumed)`);
    const notes = [
      resolver.created.length > 0 ? `new layers: ${resolver.created.join(', ')}` : '',
      skipped.size > 0 ? `skipped ${[...skipped].map(([type, count]) => `${count} ${type}`).join(', ')}` : '',
      flattened > 0 ? `${flattened} 3D line(s)/polyline(s) flattened to their first elevation` : '',
      nonFinite > 0 ? `${nonFinite} entities with non-finite coordinates (after unit scaling) not imported` : '',
      truncated > 0 ? `${truncated} entities beyond the ${MAX_DXF_ENTITIES} limit not imported` : '',
    ].filter((note) => note !== '');
    return {
      document: { ...doc, entities, order, layers: resolver.layers, layerOrder: resolver.layerOrder },
      summary:
        `Imported DXF (${unitLabel}): ${[...counts].map(([kind, count]) => `${count} ${kind}`).join(', ')}.` +
        (notes.length > 0 ? ` ${notes.join('; ')}.` : ''),
      affected,
    };
  },
});
