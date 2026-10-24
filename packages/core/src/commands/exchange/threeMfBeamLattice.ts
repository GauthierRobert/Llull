/**
 * 3MF Beam Lattice Extension 1.2 (namespace http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02, ball extension 2020/07) writer pieces: the
 * object carrying `<b:beamlattice>` (nodes as mesh vertices, empty triangle list) and the helper mesh objects (`type="other"`: clipping mesh, representation mesh).
 * Coordinates are millimetres. A consumer that cannot build beams prints the representation mesh.
 */

import { escapeXml } from '../../lib/escapeXml';
import type { Triangle } from '../../geometry/triangles';
import type { BeamCap } from '../../model/beamLattice';
import { quantizedKey } from '../../lib/quantize';

export const BEAM_LATTICE_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02';
export const BEAM_BALLS_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/beamlattice/balls/2020/07';

export interface ThreeMfLattice {
  /** Node positions, millimetres. */
  readonly nodes: ReadonlyArray<readonly [number, number, number]>;
  readonly beams: ReadonlyArray<{
    readonly a: number;
    readonly b: number;
    readonly r1: number;
    readonly r2: number;
    readonly cap1: BeamCap;
    readonly cap2: BeamCap;
  }>;
  /** Default radius, millimetres. */
  readonly radius: number;
  /** Ball radius at every node, millimetres, or null. */
  readonly ballRadius: number | null;
  /** Triangles of the clipping mesh (millimetres) or null. */
  readonly clip: readonly Triangle[] | null;
  /** Triangles of the representation mesh (millimetres) or null. */
  readonly representation: readonly Triangle[] | null;
}

const NUMBER_DIGITS = 6;
const WELD_UNIT = 1e-6;
const num = (value: number): string => String(Number(value.toFixed(NUMBER_DIGITS)));

/** Shortest beam, a safe `minlength`: half of it, so the consumer ignores none of ours. */
function minLength(lattice: ThreeMfLattice): number {
  const lengths = lattice.beams.map((beam) => {
    const [p, q] = [lattice.nodes[beam.a] as readonly number[], lattice.nodes[beam.b] as readonly number[]];
    return Math.hypot((q[0] as number) - (p[0] as number), (q[1] as number) - (p[1] as number), (q[2] as number) - (p[2] as number));
  });
  const shortest = Math.min(...lengths);
  return Math.max(shortest / 2, 1e-6);
}

/** XML of the lattice object `id`. */
export function latticeObjectXml(
  id: number,
  name: string,
  materialIndex: number,
  lattice: ThreeMfLattice,
  ids: { readonly clip: number | null; readonly representation: number | null },
): string {
  const vertices = lattice.nodes.map(([x, y, z]) => `     <vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>`);
  const attributes = [
    `minlength="${num(minLength(lattice))}"`,
    `radius="${num(lattice.radius)}"`,
    ...(lattice.ballRadius === null ? [] : [`b2:ballmode="all"`, `b2:ballradius="${num(lattice.ballRadius)}"`]),
    ...(ids.clip === null ? [] : [`clippingmode="inside"`, `clippingmesh="${ids.clip}"`]),
    ...(ids.representation === null ? [] : [`representationmesh="${ids.representation}"`]),
  ];
  const beams = lattice.beams.map(
    (beam) =>
      `      <b:beam v1="${beam.a}" v2="${beam.b}" r1="${num(beam.r1)}" r2="${num(beam.r2)}" cap1="${beam.cap1}" cap2="${beam.cap2}"/>`,
  );
  return [
    `  <object id="${id}" type="model" name="${escapeXml(name)}" pid="1" pindex="${materialIndex}">`,
    '   <mesh>',
    '    <vertices>',
    ...vertices,
    '    </vertices>',
    '    <triangles>',
    '    </triangles>',
    `    <b:beamlattice ${attributes.join(' ')}>`,
    '     <b:beams>',
    ...beams,
    '     </b:beams>',
    '    </b:beamlattice>',
    '   </mesh>',
    '  </object>',
  ].join('\n');
}

/** Indexed, welded mesh of `tris` (degenerate triangles dropped). */
function indexed(tris: readonly Triangle[]): {
  vertices: Array<readonly [number, number, number]>;
  triangles: Array<readonly [number, number, number]>;
} {
  const ids = new Map<string, number>();
  const vertices: Array<readonly [number, number, number]> = [];
  const triangles: Array<readonly [number, number, number]> = [];
  const at = (corner: readonly [number, number, number]): number => {
    const key = quantizedKey(corner, WELD_UNIT);
    const known = ids.get(key);
    if (known !== undefined) return known;
    ids.set(key, vertices.length);
    vertices.push(corner);
    return vertices.length - 1;
  };
  for (const [a, b, c] of tris) {
    const [i, j, k] = [at(a), at(b), at(c)];
    if (i !== j && j !== k && i !== k) triangles.push([i, j, k]);
  }
  return { vertices, triangles };
}

/** A helper mesh object (`type="other"`, never a build item) used as clipping or representation mesh. */
export function otherObjectXml(id: number, name: string, tris: readonly Triangle[]): string {
  const mesh = indexed(tris);
  return [
    `  <object id="${id}" type="other" name="${escapeXml(name)}">`,
    '   <mesh>',
    '    <vertices>',
    ...mesh.vertices.map(([x, y, z]) => `     <vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>`),
    '    </vertices>',
    '    <triangles>',
    ...mesh.triangles.map(([a, b, c]) => `     <triangle v1="${a}" v2="${b}" v3="${c}"/>`),
    '    </triangles>',
    '   </mesh>',
    '  </object>',
  ].join('\n');
}
