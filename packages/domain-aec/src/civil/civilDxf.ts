/**
 * DXF (R12) of every civil-generated entity on its C-* layer: survey points (POINT), contours and
 * plan linework (POLYLINE / LINE at their elevation), labels (TEXT) and meshes (one 3DFACE per
 * triangle, so the TIN opens as faces in Civil 3D / BricsCAD).
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument, Entity, Vec2, Vec3 } from '@core/model/types';
import { DxfWriter } from '../dxfWriter';
import type { SiteCalibration } from '@core/model/civil';
import { assembleDxf } from '../dxfExport';
import { localToGrid, resolveFrame, type CoordinateFrame } from './crs';

export interface CivilDxf {
  readonly text: string;
  readonly entityCount: number;
  readonly layers: string[];
}

type Frame = (point: Vec2) => Vec2;

function planWorld(entity: Entity, [x, y]: Vec2, frame: Frame): Vec2 {
  const cos = Math.cos(entity.rotation[2]);
  const sin = Math.sin(entity.rotation[2]);
  return frame([entity.position[0] + x * cos - y * sin, entity.position[1] + x * sin + y * cos]);
}

function writeMesh(
  writer: DxfWriter,
  layer: string,
  entity: Entity & { kind: 'mesh' },
  frame: Frame,
): void {
  const { positions, indices } = entity.mesh;
  const vertex = (index: number): Vec3 => {
    const [x, y] = frame([
      entity.position[0] + (positions[index * 3] ?? 0),
      entity.position[1] + (positions[index * 3 + 1] ?? 0),
    ]);
    return [x, y, entity.position[2] + (positions[index * 3 + 2] ?? 0)];
  };
  for (let k = 0; k + 2 < indices.length; k += 3) {
    writer.face3d(
      layer,
      vertex(indices[k] ?? 0),
      vertex(indices[k + 1] ?? 0),
      vertex(indices[k + 2] ?? 0),
    );
  }
}

function writeEntity(
  writer: DxfWriter,
  layer: string,
  entity: Entity,
  frame: Frame,
  rotationDeg: number,
): void {
  const z = entity.position[2];
  switch (entity.kind) {
    case 'point':
      writer.point2(layer, frame([entity.position[0], entity.position[1]]), z);
      return;
    case 'line':
      writer.line(
        layer,
        planWorld(entity, entity.start, frame),
        planWorld(entity, entity.end, frame),
        z,
      );
      return;
    case 'polyline':
      writer.polyline(
        layer,
        entity.points.map((point) => planWorld(entity, point, frame)),
        entity.closed,
        z,
      );
      return;
    case 'text':
      writer.text(
        layer,
        frame([entity.position[0], entity.position[1]]),
        entity.height,
        entity.content,
        entity.anchor ?? 'left',
        entity.rotation[2] + (rotationDeg * Math.PI) / 180,
        z,
      );
      return;
    case 'mesh':
      writeMesh(writer, layer, entity, frame);
      return;
    default:
      return;
  }
}

/**
 * The civil DXF of `doc` (entities tagged "civil", in document order).
 * @param coordinates plan frame; default grid when the site is calibrated
 */
export function buildCivilDxf(doc: CadDocument, coordinates?: CoordinateFrame): CivilDxf {
  const writer = new DxfWriter();
  const calibration: SiteCalibration | undefined = doc.civil?.crs?.calibration;
  const toGrid = resolveFrame(doc, coordinates) === 'grid' && calibration !== undefined;
  const frame: Frame = (point) => (toGrid && calibration ? localToGrid(calibration, point) : point);
  const rotationDeg = toGrid && calibration ? calibration.rotationDeg : 0;
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (!entity?.tags?.includes('civil')) continue;
    writeEntity(writer, doc.layers[entity.layerId]?.name ?? '0', entity, frame, rotationDeg);
  }
  return {
    text: `${assembleDxf(doc, writer)}\n`,
    entityCount: writer.entityCount,
    layers: [...writer.layers.keys()],
  };
}
