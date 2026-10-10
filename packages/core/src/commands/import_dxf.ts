/**
 * @command import_dxf
 * @pure
 * @layer core/commands
 * @affects creates the drawing's entities (lines, polylines, arcs, circles, points, texts; 3D faces
 *   as one mesh per layer) and any missing layers
 * @failure not an ASCII DXF / nothing importable -> no-op, affected:[]
 */

import {
  type CadDocument,
  type DocumentUnit,
  type Entity,
  type Layer,
  type Vec2,
  type Vec3,
  DEFAULT_LAYER_ID,
  DOCUMENT_UNITS,
} from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { noop } from './noop';
import { nextId } from '../lib/id';
import { newEntity } from './newEntity';
import { flattenDxf, parseDxf, type DxfPrimitive } from '../lib/dxfRead';
import { aciToHex, insUnitsMillimetres } from '../lib/dxfUnits';
import { MAX_IMPORT_TRIANGLES } from './limits';

const MM_PER_UNIT: Readonly<Record<DocumentUnit, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

/** Entities created by one import at most (larger drawings are truncated, and say so). */
export const MAX_DXF_ENTITIES = 20000;

interface LayerResolver {
  readonly layers: Record<string, Layer>;
  readonly layerOrder: string[];
  readonly created: string[];
  idFor(name: string, aci: number): string;
}

function layerResolver(doc: CadDocument): LayerResolver {
  const layers = { ...doc.layers };
  const layerOrder = [...doc.layerOrder];
  const created: string[] = [];
  const byName = new Map(
    Object.values(layers).map((layer) => [layer.name.toLowerCase(), layer.id]),
  );
  return {
    layers,
    layerOrder,
    created,
    idFor(name, aci) {
      if (name === '0' && layers[DEFAULT_LAYER_ID]) return DEFAULT_LAYER_ID;
      const existing = byName.get(name.toLowerCase());
      if (existing !== undefined) return existing;
      const id = nextId('layer');
      layers[id] = { id, name, visible: true, locked: false, color: aciToHex(aci) };
      layerOrder.push(id);
      byName.set(name.toLowerCase(), id);
      created.push(name);
      return id;
    },
  };
}

function isFlat(points: readonly Vec3[]): boolean {
  const z = points[0]?.[2] ?? 0;
  return points.every((point) => Math.abs(point[2] - z) < 1e-9);
}

/**
 * Converts one primitive (already in document units) to an entity; faces are collected apart.
 * @returns the entity, or null for faces / degenerate input; `flattened` when 3D data was lost
 */
function toEntity(
  primitive: DxfPrimitive,
  layerId: string,
  color: string,
): { entity: Entity | null; flattened: boolean } {
  const options = { layerId };
  switch (primitive.kind) {
    case 'line': {
      const entity = newEntity(
        'line',
        nextId('line'),
        { start: [primitive.a[0], primitive.a[1]], end: [primitive.b[0], primitive.b[1]] },
        [0, 0, primitive.a[2]],
        color,
        options,
      );
      return { entity, flattened: !isFlat([primitive.a, primitive.b]) };
    }
    case 'polyline': {
      let points = primitive.points.map((point): Vec2 => [point[0], point[1]]);
      const first = points[0] as Vec2;
      const last = points[points.length - 1] as Vec2;
      const closed =
        primitive.closed || (points.length > 3 && first[0] === last[0] && first[1] === last[1]);
      if (closed && points.length > 3 && first[0] === last[0] && first[1] === last[1]) {
        points = points.slice(0, -1);
      }
      const entity = newEntity(
        'polyline',
        nextId('polyline'),
        { points, closed },
        [0, 0, primitive.points[0]?.[2] ?? 0],
        color,
        options,
      );
      return { entity, flattened: !isFlat(primitive.points) };
    }
    case 'arc':
      return {
        entity: newEntity(
          'arc',
          nextId('arc'),
          {
            center: [primitive.center[0], primitive.center[1]],
            radius: primitive.radius,
            startAngle: primitive.start,
            endAngle: primitive.end,
          },
          [0, 0, primitive.center[2]],
          color,
          options,
        ),
        flattened: false,
      };
    case 'circle':
      return {
        entity: newEntity(
          'circle',
          nextId('circle'),
          { center: [primitive.center[0], primitive.center[1]], radius: primitive.radius },
          [0, 0, primitive.center[2]],
          color,
          options,
        ),
        flattened: false,
      };
    case 'point':
      return {
        entity: newEntity('point', nextId('point'), {}, primitive.at, color, options),
        flattened: false,
      };
    case 'text':
      return {
        entity: newEntity(
          'text',
          nextId('text'),
          { content: primitive.content, height: primitive.height, anchor: 'left' },
          primitive.at,
          color,
          { ...options, rotation: [0, 0, primitive.rotation] },
        ),
        flattened: false,
      };
    case 'face':
      return { entity: null, flattened: false };
  }
}

function scalePrimitive(primitive: DxfPrimitive, factor: number): DxfPrimitive {
  const s = (point: Vec3): Vec3 => [point[0] * factor, point[1] * factor, point[2] * factor];
  switch (primitive.kind) {
    case 'line':
      return { ...primitive, a: s(primitive.a), b: s(primitive.b) };
    case 'polyline':
      return { ...primitive, points: primitive.points.map(s) };
    case 'arc':
    case 'circle':
      return { ...primitive, center: s(primitive.center), radius: primitive.radius * factor };
    case 'point':
      return { ...primitive, at: s(primitive.at) };
    case 'text':
      return { ...primitive, at: s(primitive.at), height: primitive.height * factor };
    case 'face':
      return { ...primitive, corners: primitive.corners.map(s) };
  }
}

export const importDxf = defineCommand({
  name: 'import_dxf',
  description:
    'Import an ASCII DXF drawing (AutoCAD, Civil 3D, BricsCAD, QCAD, survey software exports) as ' +
    'editable 2D entities on their DXF layers: LINE, LWPOLYLINE (bulges as arcs), POLYLINE, ARC, ' +
    'CIRCLE, POINT, TEXT, MTEXT, block INSERTs (exploded) and 3DFACE (one mesh per layer). Elevations ' +
    'are kept as the entity plane height. Units come from $INSUNITS unless `sourceUnit` is given. ' +
    'Binary DXF and DWG are not supported (save as ASCII DXF). For terrain from survey DXFs use ' +
    'import_survey_dxf.',
  params: z.object({
    text: z.string().describe('DXF file content (ASCII).'),
    sourceUnit: z
      .enum(DOCUMENT_UNITS)
      .optional()
      .describe(
        'Drawing unit when $INSUNITS is missing or wrong. Default: $INSUNITS, else the document unit.',
      ),
    layers: z
      .array(z.string())
      .optional()
      .describe('Only import these DXF layers (case-insensitive). Default: every layer.'),
  }),
  run: (doc, { text, sourceUnit, layers: layerFilter }): CommandResult => {
    const drawing = parseDxf(text);
    if (drawing === null) {
      return noop(
        doc,
        'import_dxf failed: not an ASCII DXF with an ENTITIES section (binary DXF / DWG: re-save as ASCII DXF).',
      );
    }
    const headerMm = insUnitsMillimetres(drawing.insUnits);
    const sourceMm =
      sourceUnit !== undefined ? MM_PER_UNIT[sourceUnit] : (headerMm ?? MM_PER_UNIT[doc.units]);
    const factor = sourceMm / MM_PER_UNIT[doc.units];
    const wanted = layerFilter?.map((name) => name.toLowerCase());
    const { primitives, skipped } = flattenDxf(drawing);
    const selected = primitives.filter(
      (primitive) => wanted === undefined || wanted.includes(primitive.layer.toLowerCase()),
    );
    const resolver = layerResolver(doc);
    const entities = { ...doc.entities };
    const order = [...doc.order];
    const affected: string[] = [];
    const counts = new Map<string, number>();
    const faces = new Map<string, { positions: number[]; indices: number[]; color: string }>();
    let flattened = 0;
    let truncated = 0;
    let faceTriangles = 0;
    for (const raw of selected) {
      const primitive = scalePrimitive(raw, factor);
      const layerAci = drawing.layers.get(primitive.layer) ?? 7;
      const layerId = resolver.idFor(primitive.layer, layerAci);
      const color = aciToHex(
        primitive.color === 256 || primitive.color === 0 ? layerAci : primitive.color,
      );
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
      const converted = toEntity(primitive, layerId, color);
      if (converted.entity === null) continue;
      if (converted.flattened) flattened += 1;
      entities[converted.entity.id] = converted.entity;
      order.push(converted.entity.id);
      affected.push(converted.entity.id);
      counts.set(primitive.kind, (counts.get(primitive.kind) ?? 0) + 1);
    }
    for (const [layerId, mesh] of faces) {
      const id = nextId('mesh');
      entities[id] = newEntity('mesh', id, { mesh }, [0, 0, 0], mesh.color, { layerId });
      order.push(id);
      affected.push(id);
      counts.set('3D face mesh', (counts.get('3D face mesh') ?? 0) + 1);
    }
    if (affected.length === 0) {
      return noop(
        doc,
        `import_dxf: nothing importable${wanted ? ` on layers ${layerFilter?.join(', ')}` : ''}` +
          (skipped.size > 0 ? ` (skipped ${[...skipped.keys()].join(', ')}).` : '.'),
      );
    }
    const unitLabel =
      sourceUnit ??
      (headerMm !== null ? `$INSUNITS ${drawing.insUnits}` : `${doc.units} (assumed)`);
    const notes = [
      resolver.created.length > 0 ? `new layers: ${resolver.created.join(', ')}` : '',
      skipped.size > 0
        ? `skipped ${[...skipped].map(([type, count]) => `${count} ${type}`).join(', ')}`
        : '',
      flattened > 0 ? `${flattened} 3D line(s)/polyline(s) flattened to their first elevation` : '',
      truncated > 0
        ? `${truncated} entities beyond the ${MAX_DXF_ENTITIES} limit not imported`
        : '',
    ].filter((note) => note !== '');
    return {
      document: {
        ...doc,
        entities,
        order,
        layers: resolver.layers,
        layerOrder: resolver.layerOrder,
      },
      summary:
        `Imported DXF (${unitLabel}): ${[...counts].map(([kind, count]) => `${count} ${kind}`).join(', ')}.` +
        (notes.length > 0 ? ` ${notes.join('; ')}.` : ''),
      affected,
    };
  },
});
