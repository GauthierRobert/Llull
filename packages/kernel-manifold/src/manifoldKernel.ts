/**
 * Manifold (manifold-3d WASM) GeometryKernel: synchronous booleans and tessellation.
 *
 * Shapes are cached Manifold solids keyed by recipe (`kernelFromOps`); no B-rep (see `manifoldOps`).
 *
 * @invariant primitives are centred like three.js (box, cylinder along +Z, sphere) or extruded
 *   along +Z from z=0; entity transform = rotate Z, then Y, then X (M = Rx·Ry·Rz), then translate
 * @invariant cone, torus, wedge, pyramid, revolution, sweep, mesh: welded `entityToTriangles` geometry
 * @failure unsupported kind / degenerate size / non-closed mesh / Manifold error -> null
 */

import type { MeshData } from '@core/model/types';
import type { BooleanOp } from '@core/model/types';
import { kernelFromOps, type CachingKernel, type KernelOps } from '@core/geometry/shapeKernel';
import { type Entity, createEmptyDocument, is2D } from '@core/model/types';
import { orientOutward, soupIndices } from '@core/geometry/meshVolume';
import { entityTrianglePositions } from '@core/geometry/entityTriangles';
import { toCounterClockwise } from '@lib/polygon';
import { release, withOwned } from '@core/geometry/nativeObject';

// The subset of the Manifold WASM module we call (one cast at the boundary).
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
  cylinder(height: number, radiusLow: number, radiusHigh?: number, circularSegments?: number, center?: boolean): ManifoldShape;
  sphere(radius: number, circularSegments?: number): ManifoldShape;
}

interface ManifoldModule {
  Manifold: ManifoldStatic;
  CrossSection: new (polygons: Array<Array<[number, number]>>) => CrossSectionShape;
  Mesh: new (options: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }) => unknown;
  setup(): void;
}

let _cachedModule: ManifoldModule | null = null;

async function getManifoldModule(): Promise<ManifoldModule> {
  if (_cachedModule) return _cachedModule;
  const factory = (await import('manifold-3d')) as unknown as { default: (opts?: unknown) => Promise<ManifoldModule> };
  const loaded = await factory.default();
  loaded.setup();
  return (_cachedModule = loaded);
}

const RAD_TO_DEG = 180 / Math.PI;

function applyTransform(
  solid: ManifoldShape,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
): ManifoldShape {
  const [rx, ry, rz] = rotation;
  // llull rotation is M = Rx·Ry·Rz (Rz applied first); Manifold's rotate([x,y,z]) applies X
  // first, so compose the three axes explicitly: Z, then Y, then X (degrees).
  const aboutZ = solid.rotate([0, 0, rz * RAD_TO_DEG]);
  const aboutY = aboutZ.rotate([0, ry * RAD_TO_DEG, 0]);
  const aboutX = aboutY.rotate([rx * RAD_TO_DEG, 0, 0]);
  const translated = aboutX.translate([...position]);
  [aboutZ, aboutY, aboutX].forEach((step) => step.delete());
  return translated;
}

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
  const corners = indices ?? soupIndices(positions);
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
  const outwardTriVerts = orientOutward(vertProperties, triVerts);
  try {
    const mesh = new m.Mesh({ numProp: 3, vertProperties: new Float32Array(vertProperties), triVerts: new Uint32Array(outwardTriVerts) });
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

/** Corners closer than 1/WELD_SCALE document units are merged into one vertex. */
const WELD_SCALE = 1e6;

/** Primitive tessellation never reads components; instances are not boolean operands. */
const NO_COMPONENTS = createEmptyDocument();

type PrimitiveEntity = Extract<Entity, { kind: 'box' | 'cylinder' | 'sphere' | 'extrusion' }>;

/** Untransformed Manifold primitive of a box / cylinder / sphere / extrusion; null when degenerate. */
function primitiveOf(m: ManifoldModule, entity: PrimitiveEntity): ManifoldShape | null {
  switch (entity.kind) {
    case 'box': {
      const [sx, sy, sz] = entity.size;
      return sx > 0 && sy > 0 && sz > 0 ? m.Manifold.cube([sx, sy, sz], true) : null;
    }
    case 'cylinder':
      return entity.radius > 0 && entity.height > 0 ? m.Manifold.cylinder(entity.height, entity.radius, -1, 0, true) : null;
    case 'sphere':
      return entity.radius > 0 ? m.Manifold.sphere(entity.radius, 32) : null;
    case 'extrusion': {
      if (entity.profile.length < 3 || entity.depth <= 0) return null;
      // Manifold fills counter-clockwise outlines only; a clockwise profile would extrude to nothing.
      const outline = toCounterClockwise(entity.profile).map(([x, y]): [number, number] => [x, y]);
      const section = new m.CrossSection([outline]);
      const prim = section.extrude(entity.depth);
      section.delete();
      return prim;
    }
  }
}

function entityToManifold(m: ManifoldModule, entity: Entity): ManifoldShape | null {
  if (is2D(entity)) return null;
  switch (entity.kind) {
    case 'mesh':
      return weldedManifold(m, entity.mesh.positions, entity.mesh.indices, entity);
    case 'cone':
    case 'torus':
    case 'wedge':
    case 'pyramid':
    case 'revolution':
    case 'sweep':
    case 'loft':
    case 'subdivision':
      return weldedManifold(m, entityTrianglePositions(entity, NO_COMPONENTS), undefined, entity);
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
    case 'instance':
      return null;
  }
}

function manifoldToMeshData(solid: ManifoldShape): MeshData | null {
  if (solid.isEmpty()) return null;
  const mesh = solid.getMesh();
  if (!mesh || mesh.numProp < 3) return null;
  const positions: number[] = [];
  for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp) {
    positions.push(mesh.vertProperties[i] ?? 0, mesh.vertProperties[i + 1] ?? 0, mesh.vertProperties[i + 2] ?? 0);
  }
  return { positions, indices: Array.from(mesh.triVerts) };
}

const COMBINE = { union: 'add', subtract: 'subtract', intersect: 'intersect' } as const;

/** Manifold is a mesh kernel: no B-rep, so fillet / chamfer / shell / blend, `topology` and `exportStep` are null. */
function manifoldOps(mod: ManifoldModule): KernelOps<ManifoldShape> {
  return {
    unsupported: new Set(['fillet', 'chamfer', 'shell', 'blend']),
    solid: (entity) => withOwned(() => entityToManifold(mod, entity)),
    boolean: (op: BooleanOp, a, b) => withOwned(() => a[COMBINE[op]](b)),
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape, position, rotation) => withOwned(() => applyTransform(shape, position, rotation)),
    scale: (shape, factor) => (factor > 0 ? withOwned(() => shape.scale(factor)) : null),
    tessellate: (shape) => withOwned(() => manifoldToMeshData(shape)),
    topology: () => null,
    exportStep: () => null,
    release,
  };
}

/** Load the WASM once at startup; install via `setGeometryKernel` or pass as `ExecutionContext.kernel`. */
export async function createManifoldKernel(): Promise<CachingKernel> {
  return kernelFromOps(manifoldOps(await getManifoldModule()));
}
