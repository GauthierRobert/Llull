/** 3MF core reader: ZIP -> `3D/3dmodel.model`; objects with a mesh become bodies, build items and components apply their transforms; `unit` gives the scale. */

import { unzip } from '../zipRead';
import { type MeshParseFailure, type ParseLimits, type ParsedBody, type ParsedMeshFile, parseFailure } from './types';

const UNIT_METRES: Readonly<Record<string, number>> = {
  micron: 1e-6,
  millimeter: 1e-3,
  centimeter: 1e-2,
  inch: 0.0254,
  foot: 0.3048,
  meter: 1,
};
/** Row-vector affine transform, 12 numbers m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32. */
type Affine = readonly number[];
const IDENTITY: Affine = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface ObjectDef {
  readonly name: string | undefined;
  readonly positions: number[];
  readonly triangles: number[];
  readonly components: Array<{ objectId: string; transform: Affine }>;
}

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) found[match[1] as string] = match[2] as string;
  return found;
}

function transformOf(value: string | undefined): Affine {
  const numbers = (value ?? '').trim().split(/\s+/).map(Number);
  return numbers.length === 12 && numbers.every(Number.isFinite) ? numbers : IDENTITY;
}

/** `first` applied, then `second` (row-vector convention). */
function compose(first: Affine, second: Affine): Affine {
  const at = (m: Affine, i: number): number => m[i] as number;
  const linear = (r: number, c: number): number =>
    at(first, r * 3) * at(second, c) + at(first, r * 3 + 1) * at(second, 3 + c) + at(first, r * 3 + 2) * at(second, 6 + c);
  const rows = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => linear(r, c)));
  const shift = [0, 1, 2].map(
    (c) => at(first, 9) * at(second, c) + at(first, 10) * at(second, 3 + c) + at(first, 11) * at(second, 6 + c) + at(second, 9 + c),
  );
  return [...rows, ...shift];
}

function apply(m: Affine, x: number, y: number, z: number): number[] {
  const at = (i: number): number => m[i] as number;
  return [
    x * at(0) + y * at(3) + z * at(6) + at(9),
    x * at(1) + y * at(4) + z * at(7) + at(10),
    x * at(2) + y * at(5) + z * at(8) + at(11),
  ];
}

function readObjects(xml: string): Map<string, ObjectDef> {
  const objects = new Map<string, ObjectDef>();
  for (const match of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const attrs = attributes(match[1] ?? '');
    const inner = match[2] ?? '';
    const positions: number[] = [];
    const triangles: number[] = [];
    for (const v of inner.matchAll(/<vertex\b([^>]*)\/?>/g)) {
      const a = attributes(v[1] ?? '');
      positions.push(Number(a['x']), Number(a['y']), Number(a['z']));
    }
    for (const t of inner.matchAll(/<triangle\b([^>]*)\/?>/g)) {
      const a = attributes(t[1] ?? '');
      triangles.push(Number(a['v1']), Number(a['v2']), Number(a['v3']));
    }
    const components = [...inner.matchAll(/<component\b([^>]*)\/?>/g)].map((c) => {
      const a = attributes(c[1] ?? '');
      return { objectId: a['objectid'] ?? '', transform: transformOf(a['transform']) };
    });
    objects.set(attrs['id'] ?? '', { name: attrs['name'], positions, triangles, components });
  }
  return objects;
}

interface Tally {
  bodies: number;
  triangles: number;
}

/** Expand object `id` into `into`; false when the expansion would exceed `limits` (components can multiply bodies without bound). */
function flatten(
  objects: Map<string, ObjectDef>,
  id: string,
  transform: Affine,
  depth: number,
  into: ParsedBody[],
  tally: Tally,
  limits: ParseLimits,
): boolean {
  const object = objects.get(id);
  if (object === undefined || depth > MAX_COMPONENT_DEPTH) return true;
  if (object.triangles.length > 0) {
    tally.bodies += 1;
    tally.triangles += object.triangles.length / 3;
    if (tally.bodies > limits.maxBodies || tally.triangles > limits.maxTriangles) return false;
    const positions: number[] = [];
    for (let i = 0; i + 2 < object.positions.length; i += 3) {
      positions.push(
        ...apply(transform, object.positions[i] as number, object.positions[i + 1] as number, object.positions[i + 2] as number),
      );
    }
    into.push({ ...(object.name !== undefined ? { name: object.name } : {}), positions, triangles: object.triangles, groups: [] });
  }
  return object.components.every((component) =>
    flatten(objects, component.objectId, compose(component.transform, transform), depth + 1, into, tally, limits),
  );
}

const MAX_COMPONENT_DEPTH = 8;

export function parse3mf(bytes: Uint8Array, limits: ParseLimits): ParsedMeshFile | MeshParseFailure {
  let model: Uint8Array | undefined;
  try {
    const entries = unzip(bytes, { select: (name) => name.toLowerCase().endsWith('.model'), maxBytes: limits.maxBytes });
    model = (
      entries.find((e) => e.name.toLowerCase() === '3d/3dmodel.model') ?? entries.find((e) => e.name.toLowerCase().endsWith('.model'))
    )?.data;
  } catch (error) {
    return parseFailure('MESH_IMPORT_PARSE', `3MF archive: ${error instanceof Error ? error.message : 'unreadable'}`);
  }
  if (model === undefined) return parseFailure('MESH_IMPORT_PARSE', '3MF archive has no 3D/3dmodel.model part');
  const xml = new TextDecoder().decode(model);
  const unit = attributes(/<model\b([^>]*)>/.exec(xml)?.[1] ?? '')['unit'] ?? 'millimeter';
  const unitMetres = UNIT_METRES[unit];
  if (unitMetres === undefined)
    return parseFailure('MESH_IMPORT_PARSE', `3MF unit "${unit}" is not one of ${Object.keys(UNIT_METRES).join(', ')}`);
  const objects = readObjects(xml);
  const items = [...xml.matchAll(/<item\b([^>]*)\/?>/g)].map((m) => attributes(m[1] ?? ''));
  const bodies: ParsedBody[] = [];
  const tally: Tally = { bodies: 0, triangles: 0 };
  const roots =
    items.length > 0
      ? items.map((item) => ({ id: item['objectid'] ?? '', transform: transformOf(item['transform']) }))
      : [...objects.keys()].map((id) => ({ id, transform: IDENTITY }));
  for (const root of roots) {
    if (!flatten(objects, root.id, root.transform, 0, bodies, tally, limits)) {
      return parseFailure(
        'MESH_IMPORT_TOO_LARGE',
        `3MF expands to more than ${limits.maxBodies} bodies or ${limits.maxTriangles} triangles`,
      );
    }
  }
  const bad = bodies.findIndex((b) => {
    const vertices = b.positions.length / 3;
    return !b.positions.every(Number.isFinite) || b.triangles.some((t) => !Number.isInteger(t) || t < 0 || t >= vertices);
  });
  if (bad >= 0)
    return parseFailure('MESH_IMPORT_PARSE', `3MF object ${bad} has a non-numeric vertex or a triangle index outside its vertex list`);
  return { format: '3mf', bodies, unitMetres, dropped: [] };
}
