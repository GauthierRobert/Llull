/**
 * Manifold (manifold-3d WASM) GeometryKernel: synchronous booleans and tessellation.
 *
 * Shapes are cached Manifold solids keyed by recipe (`kernelFromOps`); no B-rep (see `manifoldOps`).
 *
 * @layer kernel (concrete adapter injected by the app / server; commands see only GeometryKernel)
 * @invariant primitives are centred like three.js (box, cylinder along +Z, sphere) or extruded
 *   along +Z from z=0; entity transform = rotate Z, then Y, then X (M = Rx·Ry·Rz), then translate
 * @invariant cone, torus, wedge, pyramid, revolution, mesh: welded `entityToTriangles` geometry
 * @failure unsupported kind / degenerate size / non-closed mesh / Manifold error -> null
 */

import type { MeshData } from '@core/geometry/kernel';
import type { BooleanOp } from '@core/geometry/shapeRecipe';
import { kernelFromOps, type CachingKernel, type KernelOps } from '@core/geometry/shapeKernel';
import type { Entity } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { entityToTriangles } from '@core/commands/exportTriangulate';

// Minimal local interface for the Manifold WASM module (avoids `any`).
// We only model the subset we actually call; the cast is at one boundary point.

interface ManifoldMesh {
  readonly numProp: number;
  readonly vertProperties: Float32Array;
  readonly triVerts: Uint32Array;
}

interface ManifoldShape {
  add(other: ManifoldShape): ManifoldShape;
  subtract(other: ManifoldShape): ManifoldShape;
  intersect(other: ManifoldShape): ManifoldShape;
  translate(v: [number, number, number]): ManifoldShape;
  scale(factor: number): ManifoldShape;
  /** Rotate by Euler angles in DEGREES (Manifold convention). */
  rotate(v: [number, number, number]): ManifoldShape;
  getMesh(): ManifoldMesh;
  delete(): void;
  isEmpty(): boolean;
  status(): number;
}

interface CrossSectionShape {
  extrude(height: number): ManifoldShape;
  delete(): void;
}

interface ManifoldStatic {
  ofMesh(mesh: unknown): ManifoldShape;
  cube(size: [number, number, number], center?: boolean): ManifoldShape;
  cylinder(
    height: number,
    radiusLow: number,
    radiusHigh?: number,
    circularSegments?: number,
    center?: boolean,
  ): ManifoldShape;
  sphere(radius: number, circularSegments?: number): ManifoldShape;
}

interface ManifoldModule {
  Manifold: ManifoldStatic;
  CrossSection: new (polygons: Array<Array<[number, number]>>) => CrossSectionShape;
  Mesh: new (options: {
    numProp: number;
    vertProperties: Float32Array;
    triVerts: Uint32Array;
  }) => unknown;
  setup(): void;
}

let _cachedModule: ManifoldModule | null = null;

async function getManifoldModule(): Promise<ManifoldModule> {
  if (_cachedModule) return _cachedModule;
  // manifold-3d default export is an async factory.
  const factory = (await import('manifold-3d')) as unknown as {
    default: (opts?: unknown) => Promise<ManifoldModule>;
  };
  const loaded = await factory.default();
  loaded.setup();
  _cachedModule = loaded;
  return _cachedModule;
}

const RAD_TO_DEG = 180 / Math.PI;

function applyTransform(
  solid: ManifoldShape,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
): ManifoldShape {
  const [rx, ry, rz] = rotation;
  const [px, py, pz] = position;

  // llull rotation is M = Rx·Ry·Rz (Rz applied first); Manifold's rotate([x,y,z]) applies X
  // first, so compose the three axes explicitly: Z, then Y, then X (degrees).
  const aboutZ = solid.rotate([0, 0, rz * RAD_TO_DEG]);
  const aboutY = aboutZ.rotate([0, ry * RAD_TO_DEG, 0]);
  const aboutX = aboutY.rotate([rx * RAD_TO_DEG, 0, 0]);
  const translated = aboutX.translate([px, py, pz]);
  aboutZ.delete();
  aboutY.delete();
  aboutX.delete();
  return translated;
}

// Entity → Manifold solid tessellation.
// Returns null for unsupported / degenerate input.

/**
 * Build a Manifold from triangles, merging coincident corners so the result is an oriented
 * 2-manifold. `indices` undefined → `positions` is a triangle soup (9 numbers per triangle).
 * Returns null when the triangles do not close into a valid solid.
 */
function weldedManifold(
  m: ManifoldModule,
  positions: ReadonlyArray<number>,
  indices: ReadonlyArray<number> | undefined,
  entity: Entity,
): ManifoldShape | null {
  const corners = indices ?? Array.from({ length: positions.length / 3 }, (_, i) => i);
  const vertexOf = new Map<string, number>();
  const vertProperties: number[] = [];
  const triVerts: number[] = [];
  for (const corner of corners) {
    const x = positions[corner * 3] ?? 0;
    const y = positions[corner * 3 + 1] ?? 0;
    const z = positions[corner * 3 + 2] ?? 0;
    const key = `${Math.round(x * WELD_SCALE)},${Math.round(y * WELD_SCALE)},${Math.round(z * WELD_SCALE)}`;
    let vertex = vertexOf.get(key);
    if (vertex === undefined) {
      vertex = vertProperties.length / 3;
      vertexOf.set(key, vertex);
      vertProperties.push(x, y, z);
    }
    triVerts.push(vertex);
  }
  if (signedVolume(vertProperties, triVerts) < 0) {
    // Inside-out input (consistent but inward winding): flip every triangle.
    for (let i = 0; i + 2 < triVerts.length; i += 3) {
      [triVerts[i + 1], triVerts[i + 2]] = [triVerts[i + 2] ?? 0, triVerts[i + 1] ?? 0];
    }
  }
  try {
    const mesh = new m.Mesh({
      numProp: 3,
      vertProperties: new Float32Array(vertProperties),
      triVerts: new Uint32Array(triVerts),
    });
    const prim = m.Manifold.ofMesh(mesh);
    // Tessellated primitives are already world-space; a mesh entity still honours its transform.
    if (entity.kind !== 'mesh') return prim;
    try {
      return applyTransform(prim, entity.position, entity.rotation);
    } finally {
      release(prim);
    }
  } catch {
    return null;
  }
}

function signedVolume(vertices: readonly number[], triangles: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const at = (corner: number, axis: number): number =>
      vertices[(triangles[i + corner] ?? 0) * 3 + axis] ?? 0;
    const [ax, ay, az] = [at(0, 0), at(0, 1), at(0, 2)];
    const [bx, by, bz] = [at(1, 0), at(1, 1), at(1, 2)];
    const [cx, cy, cz] = [at(2, 0), at(2, 1), at(2, 2)];
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}

/** Shoelace area of a polygon: positive for counter-clockwise, negative for clockwise. */
function signedArea(outline: ReadonlyArray<readonly [number, number]>): number {
  let twice = 0;
  outline.forEach(([x, y], i) => {
    const [nextX, nextY] = outline[(i + 1) % outline.length] ?? [x, y];
    twice += x * nextY - nextX * y;
  });
  return twice / 2;
}

/** Corners closer than 1/WELD_SCALE document units are merged into one vertex. */
const WELD_SCALE = 1e6;

/** Primitive tessellation never reads components; instances are not boolean operands. */
const NO_COMPONENTS = createEmptyDocument();

/** Untransformed primitive of a solid entity, or null for degenerate / unsupported entities. */
function primitiveOf(m: ManifoldModule, entity: Entity): ManifoldShape | null {
  switch (entity.kind) {
    case 'box': {
      const [sx, sy, sz] = entity.size;
      return sx > 0 && sy > 0 && sz > 0 ? m.Manifold.cube([sx, sy, sz], true) : null;
    }
    case 'cylinder':
      return entity.radius > 0 && entity.height > 0
        ? m.Manifold.cylinder(entity.height, entity.radius, -1, 0, true)
        : null;
    case 'sphere':
      return entity.radius > 0 ? m.Manifold.sphere(entity.radius, 32) : null;
    case 'extrusion': {
      if (entity.profile.length < 3 || entity.depth <= 0) return null;
      const outline = entity.profile.map(([x, y]) => [x, y] as [number, number]);
      // Manifold fills counter-clockwise outlines only; a clockwise profile would extrude to nothing.
      const section = new m.CrossSection([signedArea(outline) < 0 ? outline.reverse() : outline]);
      const prim = section.extrude(entity.depth);
      section.delete();
      return prim;
    }
    default:
      return null;
  }
}

function entityToManifold(m: ManifoldModule, entity: Entity): ManifoldShape | null {
  switch (entity.kind) {
    case 'mesh':
      return weldedManifold(m, entity.mesh.positions, entity.mesh.indices, entity);
    case 'cone':
    case 'torus':
    case 'wedge':
    case 'pyramid':
    case 'revolution': {
      const positions: number[] = [];
      for (const triangle of entityToTriangles(entity, NO_COMPONENTS)) {
        for (const [x, y, z] of triangle) positions.push(x, y, z);
      }
      return weldedManifold(m, positions, undefined, entity);
    }
    case 'box':
    case 'cylinder':
    case 'sphere':
    case 'extrusion': {
      const prim = primitiveOf(m, entity);
      if (!prim) return null;
      try {
        return applyTransform(prim, entity.position, entity.rotation);
      } finally {
        prim.delete();
      }
    }
    default:
      return null;
  }
}

function manifoldToMeshData(solid: ManifoldShape): MeshData | null {
  if (solid.isEmpty()) return null;
  const mesh = solid.getMesh();
  if (!mesh || mesh.numProp < 3) return null;
  const positions: number[] = [];
  for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp) {
    positions.push(
      mesh.vertProperties[i] ?? 0,
      mesh.vertProperties[i + 1] ?? 0,
      mesh.vertProperties[i + 2] ?? 0,
    );
  }
  return { positions, indices: Array.from(mesh.triVerts) };
}

/** Free a WASM object; Manifold may already have released it, so failures are ignored. */
function release(solid: ManifoldShape | null): void {
  try {
    solid?.delete();
  } catch {
    /* already released */
  }
}

/** Run `body`, mapping any Manifold exception to null and freeing every solid it registered. */
function withSolids<T>(
  body: (own: <S extends ManifoldShape | null>(solid: S) => S) => T | null,
): T | null {
  const owned: Array<ManifoldShape | null> = [];
  try {
    return body((solid) => {
      owned.push(solid);
      return solid;
    });
  } catch {
    return null;
  } finally {
    owned.forEach(release);
  }
}

const COMBINE = { union: 'add', subtract: 'subtract', intersect: 'intersect' } as const;

/**
 * Native Manifold operations behind the recipe evaluator. Manifold is a mesh kernel: no B-rep, so
 * fillet / chamfer / shell, `topology` and `exportStep` are null.
 */
export function manifoldOps(mod: ManifoldModule): KernelOps<ManifoldShape> {
  return {
    solid: (entity) => withSolids(() => entityToManifold(mod, entity)),
    boolean: (op: BooleanOp, a, b) => withSolids(() => a[COMBINE[op]](b)),
    fillet: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape, position, rotation) =>
      withSolids(() => applyTransform(shape, position, rotation)),
    scale: (shape, factor) => (factor > 0 ? withSolids(() => shape.scale(factor)) : null),
    tessellate: (shape) => withSolids(() => manifoldToMeshData(shape)),
    topology: () => null,
    exportStep: () => null,
    release,
  };
}

/**
 * Initialize the Manifold WASM module and return a synchronous GeometryKernel.
 * Call once at startup; install it as the process default (`setGeometryKernel`) or pass it
 * as an `ExecutionContext.kernel`.
 */
export async function createManifoldKernel(): Promise<CachingKernel> {
  return kernelFromOps(manifoldOps(await getManifoldModule()));
}
