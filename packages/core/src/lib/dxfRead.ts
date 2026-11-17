/**
 * ASCII DXF reader: header units, layer table, blocks and entities, flattened into world-space primitives (block inserts expanded,
 * LWPOLYLINE bulges and mirrored OCS handled).
 */

import type { Vec3 } from '../model/vectors';
import { toRadians } from './angle';
import { type DxfRecord, codeNumber, codeValue, decodeDxfText, point } from './dxfRecord';
import {
  type DxfShape,
  type ShapeResult,
  type Transform,
  arcShape,
  ellipseShape,
  faceShape,
  hatchShape,
  lwPolylineShape,
  ocs,
  polylineShape,
  splineShape,
  textShape,
} from './dxfEntities';

interface DxfBlock {
  readonly base: Vec3;
  readonly entities: readonly DxfRecord[];
}

export interface DxfDrawing {
  /** $INSUNITS (0 unitless, 1 in, 2 ft, 4 mm, 5 cm, 6 m), null when absent. */
  readonly insUnits: number | null;
  /** Layer name -> ACI colour. */
  readonly layers: ReadonlyMap<string, number>;
  /** Layer name -> true colour (hex, code 420), hidden (negative colour or frozen) and locked flags. */
  readonly layerStyles: ReadonlyMap<string, DxfLayerStyle>;
  readonly blocks: ReadonlyMap<string, DxfBlock>;
  readonly entities: readonly DxfRecord[];
}

export interface DxfLayerStyle {
  readonly trueColor: string | null;
  readonly hidden: boolean;
  readonly locked: boolean;
}

interface Common {
  readonly layer: string;
  /** ACI colour (256 = BYLAYER). */
  readonly color: number;
  /** True colour (hex, code 420), or null. */
  readonly trueColor: string | null;
}

export type DxfPrimitive = Common & DxfShape;

/** True colour (code 420, 24-bit RGB) of a record as hex, or null. */
function trueColorOf(record: DxfRecord): string | null {
  const value = codeNumber(record, 420, -1);
  return value >= 0 && value <= 0xffffff ? `#${value.toString(16).padStart(6, '0')}` : null;
}

function pairs(text: string): Array<[number, string]> {
  const lines = text.split(/\r?\n/);
  const result: Array<[number, string]> = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number((lines[index] as string).trim());
    if (!Number.isInteger(code)) break;
    result.push([code, (lines[index + 1] as string).trim()]);
  }
  return result;
}

/** Splits a code stream into records, each starting at a group-0 pair. */
function records(stream: ReadonlyArray<readonly [number, string]>): DxfRecord[] {
  const result: Array<{ type: string; codes: Array<readonly [number, string]> }> = [];
  for (const pair of stream) {
    if (pair[0] === 0) result.push({ type: pair[1], codes: [] });
    else result[result.length - 1]?.codes.push(pair);
  }
  return result;
}

/** Attaches VERTEX records to their POLYLINE and drops SEQEND / ATTRIB noise. */
function groupPolylines(raw: readonly DxfRecord[]): DxfRecord[] {
  const result: DxfRecord[] = [];
  let open: { type: string; codes: DxfRecord['codes']; vertices: DxfRecord[] } | null = null;
  for (const record of raw) {
    if (record.type === 'VERTEX') {
      // A VERTEX outside POLYLINE…SEQEND has no meaning of its own (LibreDWG 0.11 repeats them).
      open?.vertices.push(record);
      continue;
    }
    if (record.type === 'SEQEND') {
      open = null;
      continue;
    }
    if (record.type === 'ATTRIB') continue;
    if (record.type === 'POLYLINE') {
      open = { type: record.type, codes: record.codes, vertices: [] };
      result.push(open);
      continue;
    }
    open = null;
    result.push(record);
  }
  return result;
}

/** Parse ASCII DXF text; null when it has no ENTITIES section. */
export function parseDxf(text: string): DxfDrawing | null {
  const stream = pairs(text);
  const sections = new Map<string, Array<[number, string]>>();
  let current: Array<[number, string]> | null = null;
  for (let index = 0; index < stream.length; index++) {
    const [code, value] = stream[index] as [number, string];
    if (code === 0 && value === 'SECTION') {
      const name = stream[index + 1]?.[1] ?? '';
      current = [];
      sections.set(name, current);
      index += 1;
    } else if (code === 0 && value === 'ENDSEC') current = null;
    else current?.push([code, value]);
  }
  const entitiesSection = sections.get('ENTITIES');
  if (entitiesSection === undefined) return null;
  const header = sections.get('HEADER') ?? [];
  const unitsAt = header.findIndex(([code, value]) => code === 9 && value === '$INSUNITS');
  const insUnits = unitsAt >= 0 ? Number(header[unitsAt + 1]?.[1]) : null;
  const layers = new Map<string, number>();
  const layerStyles = new Map<string, DxfLayerStyle>();
  for (const record of records(sections.get('TABLES') ?? [])) {
    if (record.type !== 'LAYER') continue;
    const rawName = codeValue(record, 2);
    if (rawName === undefined) continue;
    const name = decodeDxfText(rawName);
    const colour = codeNumber(record, 62, 7);
    layers.set(name, Math.abs(colour));
    layerStyles.set(name, {
      trueColor: trueColorOf(record),
      hidden: colour < 0 || (codeNumber(record, 70, 0) & 1) === 1,
      locked: (codeNumber(record, 70, 0) & 4) === 4,
    });
  }
  const blocks = new Map<string, DxfBlock>();
  let block: { name: string; base: Vec3; entities: DxfRecord[] } | null = null;
  for (const record of groupPolylines(records(sections.get('BLOCKS') ?? []))) {
    if (record.type === 'BLOCK')
      block = {
        name: codeValue(record, 2) ?? '',
        base: [codeNumber(record, 10, 0), codeNumber(record, 20, 0), codeNumber(record, 30, 0)],
        entities: [],
      };
    else if (record.type === 'ENDBLK') {
      if (block) blocks.set(block.name, { base: block.base, entities: block.entities });
      block = null;
    } else block?.entities.push(record);
  }
  return {
    insUnits: insUnits !== null && Number.isFinite(insUnits) ? insUnits : null,
    layers,
    layerStyles,
    blocks,
    entities: groupPolylines(records(entitiesSection)),
  };
}

const IDENTITY: Transform = { apply: (point) => point, rotation: 0, scale: 1 };

function insertTransform(record: DxfRecord, block: DxfBlock, parent: Transform): Transform {
  const sx = codeNumber(record, 41, 1);
  const sy = codeNumber(record, 42, 1);
  const sz = codeNumber(record, 43, 1);
  const rotation = toRadians(codeNumber(record, 50, 0));
  const at = point(record);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const uniform = sx === sy && sx > 0 && parent.scale !== null ? parent.scale * sx : null;
  return {
    apply: ([x, y, z]) => {
      const lx = (x - block.base[0]) * sx;
      const ly = (y - block.base[1]) * sy;
      return parent.apply([at[0] + lx * cos - ly * sin, at[1] + lx * sin + ly * cos, at[2] + (z - block.base[2]) * sz]);
    },
    rotation: parent.rotation + rotation,
    scale: uniform,
  };
}

export interface FlattenResult {
  readonly primitives: DxfPrimitive[];
  /** Entity types that were skipped (e.g. DIMENSION, IMAGE, a SPLINE or HATCH that cannot be read), with counts. */
  readonly skipped: ReadonlyMap<string, number>;
}

/** Records visited by one flatten at most (empty block inserts nest and fan out without producing primitives). */
const MAX_DXF_RECORDS = 500000;

/** Primitives produced by one flatten at most (nested block inserts can multiply exponentially). */
const MAX_DXF_PRIMITIVES = 200000;

/** The shape of one non-INSERT record in world space; the skip key for an entity type that is not read. */
function shapeOf(record: DxfRecord, world: (local: Vec3) => Vec3, transform: Transform): ShapeResult {
  switch (record.type) {
    case 'LINE':
      return { kind: 'line', a: world(point(record)), b: world(point(record, 1)) };
    case 'POINT':
      return { kind: 'point', at: world(point(record)) };
    case 'LWPOLYLINE':
      return lwPolylineShape(record, world);
    case 'POLYLINE':
      return polylineShape(record, world);
    case 'ARC':
    case 'CIRCLE':
      return arcShape(record, world, transform);
    case 'TEXT':
    case 'MTEXT':
      return textShape(record, world, transform);
    case 'ELLIPSE':
      return ellipseShape(record, transform);
    case 'SPLINE':
      return splineShape(record, transform);
    case 'HATCH':
      return hatchShape(record, world);
    case '3DFACE':
      return faceShape(record, world);
    default:
      return { skip: record.type };
  }
}

/**
 * World-space primitives of every entity (block inserts expanded up to `maxDepth`); entities past `maxPrimitives` are counted in `skipped`
 * as "over limit".
 */
export function flattenDxf(drawing: DxfDrawing, maxDepth = 8, maxPrimitives = MAX_DXF_PRIMITIVES): FlattenResult {
  const primitives: DxfPrimitive[] = [];
  const skipped = new Map<string, number>();
  let visited = 0;
  const skip = (key: string): void => {
    skipped.set(key, (skipped.get(key) ?? 0) + 1);
  };
  const visit = (list: readonly DxfRecord[], transform: Transform, depth: number, inherited: Common | null): void => {
    for (const record of list) {
      visited += 1;
      if (primitives.length >= maxPrimitives || visited > MAX_DXF_RECORDS) {
        skip('over limit');
        continue;
      }
      const rawLayer = decodeDxfText(codeValue(record, 8) ?? '0');
      const layer = inherited && rawLayer === '0' ? inherited.layer : rawLayer;
      const rawColor = codeNumber(record, 62, 256);
      const color = inherited && rawColor === 0 ? inherited.color : rawColor;
      const common: Common = { layer, color, trueColor: trueColorOf(record) ?? inherited?.trueColor ?? null };
      if (record.type === 'INSERT') {
        const block = drawing.blocks.get(codeValue(record, 2) ?? '');
        if (!block || depth >= maxDepth) skip('INSERT');
        else visit(block.entities, insertTransform(record, block, transform), depth + 1, common);
        continue;
      }
      const made = shapeOf(record, (local) => transform.apply(ocs(record, local)), transform);
      if (made === null) continue;
      if ('skip' in made) skip(made.skip);
      else primitives.push({ ...common, ...made });
    }
  };
  visit(drawing.entities, IDENTITY, 0, null);
  return { primitives, skipped };
}
