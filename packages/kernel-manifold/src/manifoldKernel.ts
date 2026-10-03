/**
 * Manifold-backed geometry kernel for boolean solid operations.
 *
 * @layer kernel (concrete adapter; injected by the app and the server — commands only
 *   see the GeometryKernel interface, architecture L9)
 *
 * Implements `GeometryKernel` using the manifold-3d WASM library.
 * Called once at startup via `createManifoldKernel()`; the returned kernel is
 * synchronous — Manifold operations are sync once WASM is loaded.
 *
 * Tessellation per entity kind:
 *   box       → Manifold.cube(size, center=true) — matches THREE.BoxGeometry centering
 *   cylinder  → Manifold.cylinder(height, radius, center=true) — llull cylinders run along +Z
 *   sphere    → Manifold.sphere(radius) — both three.js and Manifold center at origin
 *   extrusion → CrossSection(profile).extrude(depth) — both three.js ExtrudeGeometry and
 *               Manifold extrude along Z from z=0
 *   mesh      → Manifold mesh from MeshData (indexed or triangle soup), vertices welded
 *   cone, torus, wedge, pyramid, revolution → llull's own world-space tessellation
 *               (`entityToTriangles`, what the viewport and STL export use), welded
 *
 * Entity transform (position + Euler rotation in RADIANS) is applied AFTER
 * primitive construction: rotate about Z, then Y, then X (llull M = Rx·Ry·Rz), then translate.
 *
 * WASM boundary: `manifold-3d` types are loose; a minimal local interface
 * narrows the parts we use. The single `as ManifoldType` cast at init is the
 * only concession to the WASM boundary.
 */

import type { GeometryKernel, MeshData, BooleanOp } from '@core/geometry/kernel';
import type { Entity } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { entityToTriangles } from '@core/commands/export';

// ---------------------------------------------------------------------------
// Minimal local interface for the Manifold WASM module (avoids `any`).
// We only model the subset we actually call; the cast is at one boundary point.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Module-level singleton — WASM init is expensive; do it once.
// ---------------------------------------------------------------------------

let _cachedModule: ManifoldModule | null = null;

async function getManifoldModule(): Promise<ManifoldModule> {
  if (_cachedModule) return _cachedModule;
  // manifold-3d default export is an async factory.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory = (await import('manifold-3d')) as { default: (opts?: unknown) => Promise<any> };
  const raw = await factory.default();
  raw.setup();
  _cachedModule = raw as ManifoldModule;
  return _cachedModule;
}

// ---------------------------------------------------------------------------
// Euler rotation (radians) → ManifoldShape.rotate (degrees) helper.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Entity → Manifold solid tessellation.
// Returns null for unsupported / degenerate input.
// ---------------------------------------------------------------------------

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
    return applyTransform(prim, entity.position, entity.rotation);
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

/** Corners closer than 1/WELD_SCALE document units are merged into one vertex. */
const WELD_SCALE = 1e6;

/** Primitive tessellation never reads components; instances are not boolean operands. */
const NO_COMPONENTS = createEmptyDocument();

function entityToManifold(m: ManifoldModule, entity: Entity): ManifoldShape | null {
  switch (entity.kind) {
    case 'box': {
      const [sx, sy, sz] = entity.size;
      if (sx <= 0 || sy <= 0 || sz <= 0) return null;
      // THREE.BoxGeometry centers at origin — use center=true to match.
      const prim = m.Manifold.cube([sx, sy, sz], true);
      return applyTransform(prim, entity.position, entity.rotation);
    }

    case 'cylinder': {
      const { radius, height } = entity;
      if (radius <= 0 || height <= 0) return null;
      // llull cylinders run along +Z, centred on position — Manifold's native frame.
      const prim = m.Manifold.cylinder(height, radius, -1, 0, true);
      return applyTransform(prim, entity.position, entity.rotation);
    }

    case 'sphere': {
      const { radius } = entity;
      if (radius <= 0) return null;
      // Both three.js SphereGeometry and Manifold sphere center at origin.
      const prim = m.Manifold.sphere(radius, 32);
      return applyTransform(prim, entity.position, entity.rotation);
    }

    case 'extrusion': {
      const { profile, depth } = entity;
      if (profile.length < 3 || depth <= 0) return null;
      // THREE.ExtrudeGeometry extrudes along Z from z=0 — CrossSection.extrude matches.
      const polygons = [profile.map(([x, y]) => [x, y] as [number, number])];
      const cs = new m.CrossSection(polygons);
      const prim = cs.extrude(depth);
      cs.delete();
      return applyTransform(prim, entity.position, entity.rotation);
    }

    case 'mesh':
      // World-space geometry (position is [0,0,0]); indexed or triangle soup.
      return weldedManifold(m, entity.mesh.positions, entity.mesh.indices, entity);

    case 'cone':
    case 'torus':
    case 'wedge':
    case 'pyramid':
    case 'revolution': {
      // No dedicated primitive: use llull's own world-space tessellation (the geometry the
      // viewport renders and STL exports), so the kernel never disagrees with the model.
      const positions: number[] = [];
      for (const triangle of entityToTriangles(entity, NO_COMPONENTS)) {
        for (const [x, y, z] of triangle) positions.push(x, y, z);
      }
      return weldedManifold(m, positions, undefined, entity);
    }

    default:
      // 2D shapes (line, polyline, arc, circle, rectangle, point) are not solids.
      return null;
  }
}

// ---------------------------------------------------------------------------
// MeshData extraction from a Manifold solid.
// ---------------------------------------------------------------------------

function manifoldToMeshData(solid: ManifoldShape): MeshData | null {
  if (solid.isEmpty()) return null;
  const mesh = solid.getMesh();
  if (!mesh || mesh.numProp < 3) return null;

  const nVerts = mesh.vertProperties.length / mesh.numProp;
  // Extract only XYZ from vertProperties (numProp may be > 3 if normals are packed in).
  const positions: number[] = new Array(nVerts * 3);
  for (let i = 0; i < nVerts; i++) {
    positions[i * 3] = mesh.vertProperties[i * mesh.numProp] ?? 0;
    positions[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 1] ?? 0;
    positions[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 2] ?? 0;
  }

  const indices: number[] = Array.from(mesh.triVerts);

  return { positions, indices };
}

// ---------------------------------------------------------------------------
// Kernel factory — the only export.
// ---------------------------------------------------------------------------

/**
 * Initialize the Manifold WASM module and return a synchronous GeometryKernel.
 * Call once at startup; install it as the process default (`setGeometryKernel`) or pass it
 * as an `ExecutionContext.kernel`.
 */
export async function createManifoldKernel(): Promise<GeometryKernel> {
  const mod = await getManifoldModule();

  return {
    booleanOp(op: BooleanOp, a: Entity, b: Entity): MeshData | null {
      let solidA: ManifoldShape | null = null;
      let solidB: ManifoldShape | null = null;
      let result: ManifoldShape | null = null;

      try {
        solidA = entityToManifold(mod, a);
        if (!solidA) return null;

        solidB = entityToManifold(mod, b);
        if (!solidB) return null;

        switch (op) {
          case 'union':
            result = solidA.add(solidB);
            break;
          case 'subtract':
            result = solidA.subtract(solidB);
            break;
          case 'intersect':
            result = solidA.intersect(solidB);
            break;
          default:
            return null;
        }

        return manifoldToMeshData(result);
      } catch {
        return null;
      } finally {
        // Free WASM objects to prevent memory leaks.
        try {
          solidA?.delete();
        } catch {
          /* ignore */
        }
        try {
          solidB?.delete();
        } catch {
          /* ignore */
        }
        try {
          result?.delete();
        } catch {
          /* ignore */
        }
      }
    },

    // Manifold cannot do filletEdges robustly — graceful no-op; OCC kernel handles it.
    filletEdges(_shape: MeshData, _edgeIndices: number[], _radius: number): MeshData | null {
      return null;
    },

    // Manifold cannot do chamferEdges robustly — graceful no-op (OCC returns null too).
    chamferEdges(_shape: MeshData, _edgeIndices: number[], _distance: number): MeshData | null {
      return null;
    },

    // Manifold cannot do shellSolid robustly — graceful no-op (OCC returns null too).
    shellSolid(_shape: MeshData, _thickness: number): MeshData | null {
      return null;
    },

    tessellate(entity: Entity): MeshData | null {
      let solid: ManifoldShape | null = null;
      try {
        solid = entityToManifold(mod, entity);
        if (!solid) return null;
        return manifoldToMeshData(solid);
      } catch {
        return null;
      } finally {
        try {
          solid?.delete();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
