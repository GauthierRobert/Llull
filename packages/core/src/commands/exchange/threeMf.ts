/**
 * 3MF (3D Manufacturing Format, core spec 2015/02) package builder: a ZIP of [Content_Types].xml, _rels/.rels and 3D/3dmodel.model with
 * one `object` per body (name, base-material colour, welded indexed mesh) and one build `item` per object. Coordinates are millimetres.
 */

import { escapeXml } from '../../lib/escapeXml';
import { isHexColor } from '../../lib/isHexColor';
import { quantizedKey } from '../../lib/quantize';
import { zipStore } from '../../lib/zip';
import type { Triangle } from '../../geometry/triangles';

export interface ThreeMfBody {
  readonly name: string;
  /** Hex colour "#rrggbb". */
  readonly color: string;
  /** World-space triangles in millimetres. */
  readonly tris: readonly Triangle[];
}

export interface ThreeMfObjectReport {
  readonly name: string;
  readonly vertices: number;
  readonly triangles: number;
  /** Every edge is shared by exactly two triangles with opposite directions (a closed, consistently oriented shell). */
  readonly manifold: boolean;
}

const DEFAULT_COLOR = '#9AA5B1';
const WELD_UNIT = 1e-6;
const IDENTITY_TRANSFORM = '1 0 0 0 1 0 0 0 1 0 0 0';
const NUMBER_DIGITS = 6;

const num = (value: number): string => String(Number(value.toFixed(NUMBER_DIGITS)));

interface IndexedMesh {
  readonly vertices: ReadonlyArray<readonly [number, number, number]>;
  readonly triangles: ReadonlyArray<readonly [number, number, number]>;
}

/** Welds coincident corners (1e-6 mm) into shared vertices and drops triangles that collapse. */
function indexTriangles(tris: readonly Triangle[]): IndexedMesh {
  const ids = new Map<string, number>();
  const vertices: Array<readonly [number, number, number]> = [];
  const triangles: Array<readonly [number, number, number]> = [];
  const indexOf = (corner: readonly [number, number, number]): number => {
    const key = quantizedKey(corner, WELD_UNIT);
    const known = ids.get(key);
    if (known !== undefined) return known;
    ids.set(key, vertices.length);
    vertices.push(corner);
    return vertices.length - 1;
  };
  for (const [a, b, c] of tris) {
    const [i, j, k] = [indexOf(a), indexOf(b), indexOf(c)];
    if (i !== j && j !== k && i !== k) triangles.push([i, j, k]);
  }
  return { vertices, triangles };
}

function isManifold(mesh: IndexedMesh): boolean {
  if (mesh.triangles.length === 0) return false;
  const directed = new Map<string, number>();
  for (const [a, b, c] of mesh.triangles)
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const)
      directed.set(`${from}>${to}`, (directed.get(`${from}>${to}`) ?? 0) + 1);
  for (const [edge, count] of directed) {
    const [from, to] = edge.split('>');
    if (count !== 1 || directed.get(`${to}>${from}`) !== 1) return false;
  }
  return true;
}

function objectXml(id: number, materialIndex: number, body: ThreeMfBody, mesh: IndexedMesh): string {
  const vertices = mesh.vertices.map(([x, y, z]) => `     <vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>`);
  const triangles = mesh.triangles.map(([a, b, c]) => `     <triangle v1="${a}" v2="${b}" v3="${c}"/>`);
  return [
    `  <object id="${id}" type="model" name="${escapeXml(body.name)}" pid="1" pindex="${materialIndex}">`,
    '   <mesh>',
    '    <vertices>',
    ...vertices,
    '    </vertices>',
    '    <triangles>',
    ...triangles,
    '    </triangles>',
    '   </mesh>',
    '  </object>',
  ].join('\n');
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
  ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
  ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
  '</Types>\n';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  ' <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
  '</Relationships>\n';

/**
 * The 3MF archive of `bodies` (empty-mesh bodies are skipped) and a per-object report. Object ids are 2..n+1; the base-material group is id 1,
 * one `base` per body (displaycolor = the body colour), referenced by `pindex`.
 */
export function buildThreeMf(bodies: readonly ThreeMfBody[]): { bytes: Uint8Array; objects: ThreeMfObjectReport[] } {
  const meshes = bodies.map((body) => ({ body, mesh: indexTriangles(body.tris) })).filter(({ mesh }) => mesh.triangles.length > 0);
  const bases = meshes.map(({ body }) => {
    const color = isHexColor(body.color) ? body.color.toUpperCase() : DEFAULT_COLOR;
    return `   <base name="${escapeXml(body.name)}" displaycolor="${color}"/>`;
  });
  const objects = meshes.map(({ body, mesh }, index) => objectXml(index + 2, index, body, mesh));
  const items = meshes.map((_, index) => ` <item objectid="${index + 2}" transform="${IDENTITY_TRANSFORM}"/>`);
  const model = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ' <resources>',
    '  <basematerials id="1">',
    ...bases,
    '  </basematerials>',
    ...objects,
    ' </resources>',
    ' <build>',
    ...items,
    ' </build>',
    '</model>',
    '',
  ].join('\n');
  const encoder = new TextEncoder();
  const bytes = zipStore([
    { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: encoder.encode(ROOT_RELS) },
    { name: '3D/3dmodel.model', data: encoder.encode(model) },
  ]);
  return {
    bytes,
    objects: meshes.map(({ body, mesh }) => ({
      name: body.name,
      vertices: mesh.vertices.length,
      triangles: mesh.triangles.length,
      manifold: isManifold(mesh),
    })),
  };
}
