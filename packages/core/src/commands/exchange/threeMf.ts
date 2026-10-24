/**
 * 3MF (3D Manufacturing Format, core spec 2015/02) package builder: a ZIP of [Content_Types].xml, _rels/.rels and 3D/3dmodel.model with
 * one `object` per body (name, base-material colour, welded indexed mesh) and one build `item` per object. Coordinates are millimetres.
 */

import { escapeXml } from '../../lib/escapeXml';
import { isHexColor } from '../../lib/isHexColor';
import { quantizedKey } from '../../lib/quantize';
import { crc32 } from '../../lib/crc32';
import { isClosedManifold } from '../../lib/isosurface/measures';
import { zipChunked, zipStore } from '../../lib/zip';
import type { Triangle } from '../../geometry/triangles';
import { IMPLICIT_NAMESPACE, type ThreeMfLevelSet, VOLUMETRIC_NAMESPACE, levelSetXml } from './threeMfImplicit';
import { type IndexedStats, type ThreeMfIndexedMesh, meshObjectChunks, modelSink } from './threeMfStream';
import { BEAM_BALLS_NAMESPACE, BEAM_LATTICE_NAMESPACE, type ThreeMfLattice, latticeObjectXml, otherObjectXml } from './threeMfBeamLattice';

export interface ThreeMfBody {
  readonly name: string;
  /** Hex colour "#rrggbb". */
  readonly color: string;
  /** World-space triangles in millimetres. */
  readonly tris: readonly Triangle[];
  /** Written instead of `tris` from the indexed arrays, streamed and deflated (a mesh too large to hold as triangles). */
  readonly indexed?: ThreeMfIndexedMesh;
  /** Written as a beam lattice object instead of a mesh (the triangles then go to the representation mesh of the lattice). */
  readonly lattice?: ThreeMfLattice;
  /** Written as a 3MF level set (an implicit function of native nodes) instead of a mesh. */
  readonly levelset?: ThreeMfLevelSet;
}

export interface ThreeMfObjectReport {
  readonly name: string;
  readonly vertices: number;
  readonly triangles: number;
  /** Every edge is shared by exactly two triangles with opposite directions (a closed, consistently oriented shell). */
  readonly manifold: boolean;
  /** Beams of a beam-lattice object (absent on mesh objects). */
  readonly beams?: number;
  /** Nodes of the implicit function of a level-set object (absent on mesh objects). */
  readonly levelsetNodes?: number;
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

/** A line of the model part, or a generator of text batches written between newlines. */
type ModelPart = string | (() => Iterable<string>);

const NO_MESH: IndexedMesh = { vertices: [], triangles: [] };

/** The archive with the model part streamed through a deflate sink (the two small parts are stored). */
function zipStreamed(model: readonly ModelPart[]): Uint8Array {
  const sink = modelSink();
  const encoder = new TextEncoder();
  model.forEach((part, index) => {
    if (index > 0) sink.push('\n');
    if (typeof part === 'string') sink.push(part);
    else for (const text of part()) sink.push(text);
  });
  const stored = (name: string, text: string): Parameters<typeof zipChunked>[0][number] => {
    const data = encoder.encode(text);
    return { name, method: 0, crc: crc32(data), size: data.length, chunks: [data], storedSize: data.length };
  };
  const { crc, size, chunks, storedSize } = sink.done();
  return zipChunked([
    stored('[Content_Types].xml', CONTENT_TYPES),
    stored('_rels/.rels', ROOT_RELS),
    { name: '3D/3dmodel.model', method: 8, crc, size, chunks, storedSize },
  ]);
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
 * The 3MF archive of `bodies` (empty bodies are skipped) and a per-object report. Object ids are 2..n+1; the base-material group is id 1,
 * one `base` per body (displaycolor = the body colour), referenced by `pindex`. A body with a `lattice` becomes a beam-lattice object (Beam Lattice Extension
 * 1.2); its clipping and representation meshes are extra `type="other"` objects (ids after n+1, defined before the objects that use them), never build items.
 */
export function buildThreeMf(bodies: readonly ThreeMfBody[]): { bytes: Uint8Array; objects: ThreeMfObjectReport[] } {
  const entries = bodies
    .map((body) => ({ body, mesh: body.indexed === undefined ? indexTriangles(body.tris) : NO_MESH }))
    .filter(({ body, mesh }) =>
      body.levelset !== undefined
        ? true
        : body.indexed !== undefined
          ? body.indexed.indices.length >= 3
          : body.lattice === undefined
            ? mesh.triangles.length > 0
            : body.lattice.beams.length > 0,
    );
  const bases = entries.map(({ body }) => {
    const color = isHexColor(body.color) ? body.color.toUpperCase() : DEFAULT_COLOR;
    return `   <base name="${escapeXml(body.name)}" displaycolor="${color}"/>`;
  });
  let nextId = entries.length + 2;
  const helpers: string[] = [];
  const stats = entries.map((): IndexedStats => ({ vertices: 0, triangles: 0 }));
  const objects = entries.map(({ body, mesh }, index): ModelPart => {
    if (body.indexed !== undefined) {
      const indexed = body.indexed;
      return () => meshObjectChunks(index + 2, index, body.name, indexed, stats[index] as IndexedStats);
    }
    if (body.levelset !== undefined) {
      const made = levelSetXml(index + 2, nextId, body.name, index, body.levelset);
      nextId = made.nextId;
      helpers.push(...made.resources);
      return made.object;
    }
    const lattice = body.lattice;
    if (lattice === undefined) return objectXml(index + 2, index, body, mesh);
    const helper = (tris: readonly Triangle[] | null, label: string): number | null => {
      if (tris === null || tris.length === 0) return null;
      const id = nextId;
      nextId += 1;
      helpers.push(otherObjectXml(id, `${body.name} ${label}`, tris));
      return id;
    };
    const ids = { clip: helper(lattice.clip, 'clipping mesh'), representation: helper(lattice.representation, 'representation mesh') };
    return latticeObjectXml(index + 2, body.name, index, lattice, ids);
  });
  const items = entries.map((_, index) => ` <item objectid="${index + 2}" transform="${IDENTITY_TRANSFORM}"/>`);
  const lattices = entries.filter(({ body }) => body.lattice !== undefined);
  const balls = lattices.some(({ body }) => body.lattice?.ballRadius !== null && body.lattice?.ballRadius !== undefined);
  const implicit = entries.some(({ body }) => body.levelset !== undefined);
  const required = [...(lattices.length > 0 ? ['b'] : []), ...(balls ? ['b2'] : []), ...(implicit ? ['v', 'i'] : [])];
  const extensions =
    required.length === 0
      ? ''
      : `${lattices.length > 0 ? ` xmlns:b="${BEAM_LATTICE_NAMESPACE}"` : ''}${balls ? ` xmlns:b2="${BEAM_BALLS_NAMESPACE}"` : ''}${implicit ? ` xmlns:v="${VOLUMETRIC_NAMESPACE}" xmlns:i="${IMPLICIT_NAMESPACE}"` : ''} requiredextensions="${required.join(' ')}"`;
  const model: ModelPart[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${extensions}>`,
    ' <resources>',
    '  <basematerials id="1">',
    ...bases,
    '  </basematerials>',
    ...helpers,
    ...objects,
    ' </resources>',
    ' <build>',
    ...items,
    ' </build>',
    '</model>',
    '',
  ];
  const encoder = new TextEncoder();
  const bytes = model.every((part) => typeof part === 'string')
    ? zipStore([
        { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES) },
        { name: '_rels/.rels', data: encoder.encode(ROOT_RELS) },
        { name: '3D/3dmodel.model', data: encoder.encode(model.join('\n')) },
      ])
    : zipStreamed(model);
  return {
    bytes,
    objects: entries.map(({ body, mesh }, index) =>
      body.levelset !== undefined
        ? { name: body.name, vertices: 0, triangles: 0, manifold: false, levelsetNodes: body.levelset.program.instructions.length }
        : body.indexed !== undefined
          ? {
              name: body.name,
              vertices: (stats[index] as IndexedStats).vertices,
              triangles: (stats[index] as IndexedStats).triangles,
              manifold: isClosedManifold({ positions: body.indexed.positions, indices: body.indexed.indices }),
            }
          : body.lattice === undefined
            ? { name: body.name, vertices: mesh.vertices.length, triangles: mesh.triangles.length, manifold: isManifold(mesh) }
            : { name: body.name, vertices: body.lattice.nodes.length, triangles: 0, manifold: false, beams: body.lattice.beams.length },
    ),
  };
}
