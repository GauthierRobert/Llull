/**
 * Manifold-backed geometry kernel for boolean solid operations.
 *
 * @layer ui/geometry
 *
 * Implements `GeometryKernel` using the manifold-3d WASM library.
 * Called once at startup via `createManifoldKernel()`; the returned kernel is
 * synchronous — Manifold operations are sync once WASM is loaded.
 *
 * Tessellation per entity kind:
 *   box       → Manifold.cube(size, center=true) — matches THREE.BoxGeometry centering
 *   cylinder  → Manifold.cylinder(height, radius, center=true) rotated −90° around X
 *               to align with three.js CylinderGeometry (Y-axis, centered)
 *   sphere    → Manifold.sphere(radius) — both three.js and Manifold center at origin
 *   extrusion → CrossSection(profile).extrude(depth) — both three.js ExtrudeGeometry and
 *               Manifold extrude along Z from z=0
 *   mesh      → Manifold mesh from MeshData (already world-space; position=[0,0,0])
 *
 * Entity transform (position + Euler rotation in RADIANS) is applied AFTER
 * primitive construction: rotate first (converting rad→deg), then translate.
 * This matches how three.js applies rotation then position.
 *
 * WASM boundary: `manifold-3d` types are loose; a minimal local interface
 * narrows the parts we use. The single `as ManifoldType` cast at init is the
 * only concession to the WASM boundary.
 */

import type { GeometryKernel, MeshData, BooleanOp } from '@core/geometry/kernel';
import type { Entity } from '@core/model/types';

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
// Applies ZYX Euler sequence to match three.js default ('XYZ' in three's enum
// maps to extrinsic XYZ, which is our representation: [rx, ry, rz] radians).
// ---------------------------------------------------------------------------

const RAD_TO_DEG = 180 / Math.PI;

function applyTransform(
  solid: ManifoldShape,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
): ManifoldShape {
  const [rx, ry, rz] = rotation;
  const [px, py, pz] = position;

  // Apply rotation in XYZ order (degrees).
  const rotated = solid.rotate([rx * RAD_TO_DEG, ry * RAD_TO_DEG, rz * RAD_TO_DEG]);
  // Then translate.
  const translated = rotated.translate([px, py, pz]);
  // rotated is an intermediate — free it.
  rotated.delete();
  return translated;
}

// ---------------------------------------------------------------------------
// Entity → Manifold solid tessellation.
// Returns null for unsupported / degenerate input.
// ---------------------------------------------------------------------------

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
      // Manifold cylinder is along Z; THREE.CylinderGeometry is along Y, centered.
      // Produce a Z-axis centered cylinder, then rotate −90° around X → Y-axis.
      const prim = m.Manifold.cylinder(height, radius, -1, 0, true);
      const aligned = prim.rotate([-90, 0, 0]);
      prim.delete();
      // Now apply entity transform on top of the Y-axis alignment.
      return applyTransform(aligned, entity.position, entity.rotation);
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

    case 'mesh': {
      // MeshSolidEntity holds world-space geometry; position is always [0,0,0].
      // Re-use the flat arrays directly via the Manifold mesh constructor approach.
      // Manifold's setup() exposes ManifoldTri constructor only via the C++ binding;
      // the JS API wraps it. We build from raw arrays using the `meshGL` property.
      // The public API accepts a MeshGL object with vertProperties + triVerts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const manifoldAny = m.Manifold as any;
      if (typeof manifoldAny.ofMesh !== 'function') {
        // Fallback: no direct mesh constructor found — return null gracefully.
        return null;
      }
      const meshInput = {
        numProp: 3,
        vertProperties: new Float32Array(entity.mesh.positions),
        triVerts: new Uint32Array(entity.mesh.indices),
      };
      try {
        const prim = manifoldAny.ofMesh(meshInput) as ManifoldShape;
        return applyTransform(prim, entity.position, entity.rotation);
      } catch {
        return null;
      }
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
 * Call once at app startup; inject the result via `setGeometryKernel(kernel)`.
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
        try { solidA?.delete(); } catch { /* ignore */ }
        try { solidB?.delete(); } catch { /* ignore */ }
        try { result?.delete(); } catch { /* ignore */ }
      }
    },

    // Manifold cannot do filletEdges robustly — graceful no-op; OCC kernel handles it.
    filletEdges(_shape: MeshData, _edgeIndices: number[], _radius: number): MeshData | null {
      return null;
    },

    // Manifold cannot do chamferEdges robustly — graceful no-op; OCC kernel handles it.
    chamferEdges(_shape: MeshData, _edgeIndices: number[], _distance: number): MeshData | null {
      return null;
    },

    // Manifold cannot do shellSolid robustly — graceful no-op; OCC kernel handles it.
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
        try { solid?.delete(); } catch { /* ignore */ }
      }
    },
  };
}
