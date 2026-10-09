/**
 * ASCII DXF reader: header units, layer table, blocks and entities, flattened into world-space
 * primitives (block inserts expanded, LWPOLYLINE bulges and mirrored OCS handled).
 * @layer core/lib
 * @pure
 */

import type { Vec3 } from '../model/types';

export interface DxfRecord {
  readonly type: string;
  readonly codes: ReadonlyArray<readonly [number, string]>;
  /** VERTEX records of a POLYLINE. */
  readonly vertices?: readonly DxfRecord[];
}

interface DxfBlock {
  readonly base: Vec3;
  readonly entities: readonly DxfRecord[];
}

export interface DxfDrawing {
  /** $INSUNITS (0 unitless, 1 in, 2 ft, 4 mm, 5 cm, 6 m), null when absent. */
  readonly insUnits: number | null;
  /** Layer name -> ACI colour. */
  readonly layers: ReadonlyMap<string, number>;
  readonly blocks: ReadonlyMap<string, DxfBlock>;
  readonly entities: readonly DxfRecord[];
}

interface Common {
  readonly layer: string;
  /** ACI colour (256 = BYLAYER). */
  readonly color: number;
}

export type DxfPrimitive = Common &
  (
    | { readonly kind: 'line'; readonly a: Vec3; readonly b: Vec3 }
    | { readonly kind: 'polyline'; readonly points: readonly Vec3[]; readonly closed: boolean }
    | {
        readonly kind: 'arc';
        readonly center: Vec3;
        readonly radius: number;
        /** Radians, counter-clockwise. */
        readonly start: number;
        readonly end: number;
      }
    | { readonly kind: 'circle'; readonly center: Vec3; readonly radius: number }
    | { readonly kind: 'point'; readonly at: Vec3 }
    | {
        readonly kind: 'text';
        readonly at: Vec3;
        readonly height: number;
        readonly rotation: number;
        readonly content: string;
      }
    | { readonly kind: 'face'; readonly corners: readonly Vec3[] }
  );

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

export function codeValue(record: DxfRecord, code: number): string | undefined {
  return record.codes.find(([candidate]) => candidate === code)?.[1];
}

export function codeNumber(record: DxfRecord, code: number, fallback: number): number {
  const value = Number(codeValue(record, code));
  return codeValue(record, code) !== undefined && Number.isFinite(value) ? value : fallback;
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
    } else if (code === 0 && value === 'ENDSEC') {
      current = null;
    } else {
      current?.push([code, value]);
    }
  }
  const entitiesSection = sections.get('ENTITIES');
  if (entitiesSection === undefined) return null;
  const header = sections.get('HEADER') ?? [];
  const unitsAt = header.findIndex(([code, value]) => code === 9 && value === '$INSUNITS');
  const insUnits = unitsAt >= 0 ? Number(header[unitsAt + 1]?.[1]) : null;
  const layers = new Map<string, number>();
  for (const record of records(sections.get('TABLES') ?? [])) {
    if (record.type !== 'LAYER') continue;
    const name = codeValue(record, 2);
    if (name !== undefined) layers.set(name, Math.abs(codeNumber(record, 62, 7)));
  }
  const blocks = new Map<string, DxfBlock>();
  let block: { name: string; base: Vec3; entities: DxfRecord[] } | null = null;
  for (const record of groupPolylines(records(sections.get('BLOCKS') ?? []))) {
    if (record.type === 'BLOCK') {
      block = {
        name: codeValue(record, 2) ?? '',
        base: [codeNumber(record, 10, 0), codeNumber(record, 20, 0), codeNumber(record, 30, 0)],
        entities: [],
      };
    } else if (record.type === 'ENDBLK') {
      if (block) blocks.set(block.name, { base: block.base, entities: block.entities });
      block = null;
    } else {
      block?.entities.push(record);
    }
  }
  return {
    insUnits: insUnits !== null && Number.isFinite(insUnits) ? insUnits : null,
    layers,
    blocks,
    entities: groupPolylines(records(entitiesSection)),
  };
}

/** World transform of nested block inserts. */
interface Transform {
  readonly apply: (point: Vec3) => Vec3;
  /** Rotation added to angles (radians). */
  readonly rotation: number;
  /** Uniform scale, or null when non-uniform / mirrored (arcs become polylines). */
  readonly scale: number | null;
}

const IDENTITY: Transform = { apply: (point) => point, rotation: 0, scale: 1 };

function point(record: DxfRecord, offset = 0): Vec3 {
  return [
    codeNumber(record, 10 + offset, 0),
    codeNumber(record, 20 + offset, 0),
    codeNumber(record, 30 + offset, 0),
  ];
}

/** Arc points from `start` to `end` (radians, CCW) around `center`. */
function arcPoints(center: Vec3, radius: number, start: number, end: number): Vec3[] {
  let sweep = end - start;
  while (sweep <= 0) sweep += Math.PI * 2;
  const segments = Math.max(4, Math.ceil(sweep / (Math.PI / 24)));
  return Array.from({ length: segments + 1 }, (_, k): Vec3 => {
    const angle = start + (sweep * k) / segments;
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle), center[2]];
  });
}

/** LWPOLYLINE vertices with bulge arcs densified, at `elevation`. */
function lwPolylinePoints(record: DxfRecord, closed: boolean): Vec3[] {
  const elevation = codeNumber(record, 38, 0);
  const vertices: Array<{ x: number; y: number; bulge: number }> = [];
  for (const [code, value] of record.codes) {
    if (code === 10) vertices.push({ x: Number(value), y: 0, bulge: 0 });
    const last = vertices[vertices.length - 1];
    if (last && code === 20) last.y = Number(value);
    if (last && code === 42) last.bulge = Number(value);
  }
  const result: Vec3[] = [];
  const finite = vertices.filter(
    (vertex) => Number.isFinite(vertex.x) && Number.isFinite(vertex.y),
  );
  if (!Number.isFinite(elevation)) return [];
  finite.forEach((vertex, index) => {
    result.push([vertex.x, vertex.y, elevation]);
    const next = finite[index + 1] ?? (closed ? finite[0] : undefined);
    if (!next || vertex.bulge === 0 || !Number.isFinite(vertex.bulge)) return;
    const chord = Math.hypot(next.x - vertex.x, next.y - vertex.y);
    if (chord === 0) return;
    const theta = 4 * Math.atan(vertex.bulge);
    const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const midX = (vertex.x + next.x) / 2;
    const midY = (vertex.y + next.y) / 2;
    const sagitta = radius * Math.cos(theta / 2);
    const normal = [-(next.y - vertex.y) / chord, (next.x - vertex.x) / chord];
    const sign = vertex.bulge > 0 ? 1 : -1;
    const center: Vec3 = [
      midX + sign * (normal[0] as number) * sagitta,
      midY + sign * (normal[1] as number) * sagitta,
      elevation,
    ];
    const startAngle = Math.atan2(vertex.y - center[1], vertex.x - center[0]);
    const steps = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 24)));
    for (let k = 1; k < steps; k++) {
      const angle = startAngle + (theta * k) / steps;
      result.push([
        center[0] + Math.abs(radius) * Math.cos(angle),
        center[1] + Math.abs(radius) * Math.sin(angle),
        elevation,
      ]);
    }
  });
  return result;
}

function stripMText(text: string): string {
  return text
    .replace(/\\P/g, ' ')
    .replace(/\\[A-Za-z][^;\\{}]*;/g, '')
    .replace(/\\[~]/g, ' ')
    .replace(/[{}]/g, '')
    .trim();
}

function insertTransform(record: DxfRecord, block: DxfBlock, parent: Transform): Transform {
  const sx = codeNumber(record, 41, 1);
  const sy = codeNumber(record, 42, 1);
  const sz = codeNumber(record, 43, 1);
  const rotation = (codeNumber(record, 50, 0) * Math.PI) / 180;
  const at = point(record);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const uniform = sx === sy && sx > 0 && parent.scale !== null ? parent.scale * sx : null;
  return {
    apply: ([x, y, z]) => {
      const lx = (x - block.base[0]) * sx;
      const ly = (y - block.base[1]) * sy;
      return parent.apply([
        at[0] + lx * cos - ly * sin,
        at[1] + lx * sin + ly * cos,
        at[2] + (z - block.base[2]) * sz,
      ]);
    },
    rotation: parent.rotation + rotation,
    scale: uniform,
  };
}

/** True when the entity's extrusion direction is -Z (mirrored OCS: x is negated). */
function mirrored(record: DxfRecord): boolean {
  return codeNumber(record, 230, 1) < 0;
}

function ocs(record: DxfRecord, local: Vec3): Vec3 {
  return mirrored(record) ? [-local[0], local[1], -local[2]] : local;
}

export interface FlattenResult {
  readonly primitives: DxfPrimitive[];
  /** Entity types that were skipped (e.g. HATCH, DIMENSION, SPLINE), with counts. */
  readonly skipped: ReadonlyMap<string, number>;
}

/** Primitives produced by one flatten at most (nested block inserts can multiply exponentially). */
export const MAX_DXF_PRIMITIVES = 200000;

/**
 * World-space primitives of every entity (block inserts expanded up to `maxDepth`); entities past
 * `maxPrimitives` are counted in `skipped` as "over limit".
 */
export function flattenDxf(
  drawing: DxfDrawing,
  maxDepth = 8,
  maxPrimitives = MAX_DXF_PRIMITIVES,
): FlattenResult {
  const primitives: DxfPrimitive[] = [];
  const skipped = new Map<string, number>();
  const visit = (
    list: readonly DxfRecord[],
    transform: Transform,
    depth: number,
    inherited: Common | null,
  ): void => {
    for (const record of list) {
      if (primitives.length >= maxPrimitives) {
        skipped.set('over limit', (skipped.get('over limit') ?? 0) + 1);
        continue;
      }
      const rawLayer = codeValue(record, 8) ?? '0';
      const layer = inherited && rawLayer === '0' ? inherited.layer : rawLayer;
      const rawColor = codeNumber(record, 62, 256);
      const color = inherited && rawColor === 0 ? inherited.color : rawColor;
      const common: Common = { layer, color };
      const world = (local: Vec3): Vec3 => transform.apply(ocs(record, local));
      switch (record.type) {
        case 'LINE':
          primitives.push({
            ...common,
            kind: 'line',
            a: world(point(record)),
            b: world(point(record, 1)),
          });
          break;
        case 'POINT':
          primitives.push({ ...common, kind: 'point', at: world(point(record)) });
          break;
        case 'LWPOLYLINE': {
          const closed = (codeNumber(record, 70, 0) & 1) === 1;
          const points = lwPolylinePoints(record, closed).map(world);
          if (points.length >= 2) primitives.push({ ...common, kind: 'polyline', points, closed });
          break;
        }
        case 'POLYLINE': {
          const flags = codeNumber(record, 70, 0);
          if ((flags & (16 | 64)) !== 0) {
            skipped.set('POLYLINE mesh', (skipped.get('POLYLINE mesh') ?? 0) + 1);
            break;
          }
          const elevation = codeNumber(record, 30, 0);
          const points = (record.vertices ?? []).map((vertex) => {
            const local = point(vertex);
            return world((flags & 8) === 8 ? local : [local[0], local[1], elevation]);
          });
          if (points.length >= 2) {
            primitives.push({ ...common, kind: 'polyline', points, closed: (flags & 1) === 1 });
          }
          break;
        }
        case 'ARC':
        case 'CIRCLE': {
          const local = point(record);
          const radius = codeNumber(record, 40, 0);
          if (!(radius > 0)) break;
          let start = record.type === 'ARC' ? (codeNumber(record, 50, 0) * Math.PI) / 180 : 0;
          let end = record.type === 'ARC' ? (codeNumber(record, 51, 360) * Math.PI) / 180 : 0;
          if (mirrored(record)) [start, end] = [Math.PI - end, Math.PI - start];
          const center = world(local);
          if (transform.scale === null) {
            const points = arcPoints(
              ocs(record, local),
              radius,
              start,
              record.type === 'ARC' ? end : Math.PI * 2,
            ).map((p) => transform.apply(p));
            primitives.push({
              ...common,
              kind: 'polyline',
              points,
              closed: record.type === 'CIRCLE',
            });
          } else if (record.type === 'CIRCLE') {
            primitives.push({
              ...common,
              kind: 'circle',
              center,
              radius: radius * transform.scale,
            });
          } else {
            primitives.push({
              ...common,
              kind: 'arc',
              center,
              radius: radius * transform.scale,
              start: start + transform.rotation,
              end: end + transform.rotation,
            });
          }
          break;
        }
        case 'TEXT':
        case 'MTEXT': {
          const raw =
            record.type === 'MTEXT'
              ? stripMText(
                  record.codes
                    .filter(([code]) => code === 3 || code === 1)
                    .map(([, value]) => value)
                    .join(''),
                )
              : (codeValue(record, 1) ?? '').trim();
          if (raw === '') break;
          const height = codeNumber(record, 40, 1) * (transform.scale ?? 1);
          primitives.push({
            ...common,
            kind: 'text',
            at: world(point(record)),
            height: height > 0 ? height : 1,
            rotation: (codeNumber(record, 50, 0) * Math.PI) / 180 + transform.rotation,
            content: raw,
          });
          break;
        }
        case '3DFACE': {
          const corners = [0, 1, 2, 3].map((k) => world(point(record, k)));
          const [, , c, d] = corners as [Vec3, Vec3, Vec3, Vec3];
          const unique =
            c[0] === d[0] && c[1] === d[1] && c[2] === d[2] ? corners.slice(0, 3) : corners;
          primitives.push({ ...common, kind: 'face', corners: unique });
          break;
        }
        case 'INSERT': {
          const block = drawing.blocks.get(codeValue(record, 2) ?? '');
          if (!block || depth >= maxDepth) {
            skipped.set('INSERT', (skipped.get('INSERT') ?? 0) + 1);
            break;
          }
          visit(block.entities, insertTransform(record, block, transform), depth + 1, common);
          break;
        }
        default:
          skipped.set(record.type, (skipped.get(record.type) ?? 0) + 1);
      }
    }
  };
  visit(drawing.entities, IDENTITY, 0, null);
  return { primitives, skipped };
}
