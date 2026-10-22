/**
 * Manifold (manifold-3d WASM) mesh-processing engine (07 MSH M2): Minkowski sum / difference, mesh booleans, level-set offset / hollow / wrap
 * and smooth refinement, behind the core `MeshProcessingEngine` port. Results are Float32 meshes (Manifold stores float32 positions) and are
 * bound to the pinned `manifold-3d` version recorded in every provenance (D7).
 * @invariant outputs are manifold by construction; inputs that are not oriented 2-manifolds refuse with MESH_NON_MANIFOLD
 * @invariant every WASM object a call creates is freed when the call ends, whatever happens
 * @failure engine errors never throw: they come back as MeshEngineFailure with a stable MESH_* code
 */

import type { MeshData } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { MeshField } from '@core/geometry/mesh/field';
import { meshDiagonal } from '@core/geometry/mesh/weld';
import type {
  MeshEngineFailure,
  MeshInput,
  MeshOp,
  MeshOpName,
  MeshOpResult,
  MeshProcessingEngine,
  MeshProvenance,
} from '@core/geometry/mesh/engineTypes';
import { orientOutward } from '@core/geometry/meshVolume';
import { MANIFOLD_VERSION, loadManifoldModule } from './manifoldModule';

interface RawMesh {
  readonly numProp: number;
  readonly vertProperties: Float32Array;
  readonly triVerts: Uint32Array;
}

interface Solid {
  add(other: Solid): Solid;
  subtract(other: Solid): Solid;
  intersect(other: Solid): Solid;
  minkowskiSum(other: Solid): Solid;
  minkowskiDifference(other: Solid): Solid;
  smoothOut(minSharpAngle?: number, minSmoothness?: number): Solid;
  refine(n: number): Solid;
  refineToLength(length: number): Solid;
  getMesh(): RawMesh;
  status(): string;
  isEmpty(): boolean;
  delete(): void;
}

interface ManifoldApi {
  Manifold: {
    ofMesh(mesh: unknown): Solid;
    levelSet(
      sdf: (point: readonly number[]) => number,
      bounds: { min: Vec3; max: Vec3 },
      edgeLength: number,
      level?: number,
      tolerance?: number,
    ): Solid;
  };
  Mesh: new (options: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }) => unknown;
}

const failure = (code: string, message: string): MeshEngineFailure => ({ code, message });

const provenance = (algorithm: string, reference: string): MeshProvenance => ({
  engine: 'manifold',
  version: `manifold-3d@${MANIFOLD_VERSION}`,
  algorithm,
  reference,
  deterministic: true,
});

function cellCount(min: Vec3, max: Vec3, edge: number): number {
  return [0, 1, 2].reduce((cells, axis) => cells * Math.max(1, Math.ceil(((max[axis] as number) - (min[axis] as number)) / edge)), 1);
}

function boundsOf(positions: ReadonlyArray<number>, margin: number): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis] as number;
      if (value < (min[axis] as number)) min[axis] = value;
      if (value > (max[axis] as number)) max[axis] = value;
    }
  }
  return { min: [min[0] - margin, min[1] - margin, min[2] - margin], max: [max[0] + margin, max[1] + margin, max[2] + margin] };
}

/** The grid must put at least this many cells across the body's bounding-box diagonal, else the field is unresolved and the call refuses. */
const MIN_CELLS_ACROSS = 4;

class Engine implements MeshProcessingEngine {
  readonly name = 'manifold';
  /** WASM objects of the running call. */
  private owned: Solid[] = [];

  constructor(private readonly api: ManifoldApi) {}

  capabilities(): ReadonlyMap<MeshOpName, number> {
    return new Map<MeshOpName, number>([
      ['minkowski', Infinity],
      ['boolean', Infinity],
      ['offset', Infinity],
      ['hollow', Infinity],
      ['wrap', Infinity],
      ['subdivide', Infinity],
    ]);
  }

  private own(solid: Solid): Solid {
    this.owned.push(solid);
    return solid;
  }

  /** An oriented-2-manifold solid of `mesh` (freed with the call), or null when Manifold rejects it. */
  private solid(mesh: MeshData): Solid | null {
    const outward = orientOutward(mesh.positions, mesh.indices);
    try {
      const built = this.own(
        this.api.Manifold.ofMesh(
          new this.api.Mesh({ numProp: 3, vertProperties: new Float32Array(mesh.positions), triVerts: new Uint32Array(outward) }),
        ),
      );
      if (built.status() === 'NoError') return built;
    } catch {
      /* not an oriented 2-manifold */
    }
    return null;
  }

  private extract(solid: Solid): MeshData {
    const raw = solid.getMesh();
    const positions: number[] = [];
    for (let i = 0; i < raw.vertProperties.length; i += raw.numProp) {
      positions.push(raw.vertProperties[i] as number, raw.vertProperties[i + 1] as number, raw.vertProperties[i + 2] as number);
    }
    return { positions, indices: Array.from(raw.triVerts) };
  }

  private notManifold(which: string): MeshEngineFailure {
    return failure('MESH_NON_MANIFOLD', `${which} is not an oriented 2-manifold (open, non-manifold or self-touching edges)`);
  }

  run(input: MeshInput, op: MeshOp): MeshOpResult | MeshEngineFailure {
    this.owned = [];
    try {
      switch (op.op) {
        case 'minkowski':
          return this.minkowski(input.mesh, op.other.mesh, op.kind);
        case 'boolean':
          return this.boolean(input.mesh, op.others, op.kind);
        case 'offset':
          return op.method === 'level_set'
            ? this.offset(input.mesh, op.distance, op.tolerance, op.maxCells)
            : failure('MESH_ENGINE_UNSUPPORTED', 'normal offset is a TypeScript-engine op');
        case 'hollow':
          return this.hollow(input.mesh, op.wall, op.tolerance, op.maxCells);
        case 'wrap':
          return this.wrap(input.mesh, op.tolerance, op.maxCells);
        case 'subdivide':
          return op.method === 'smooth'
            ? this.smooth(input.mesh, op)
            : failure('MESH_ENGINE_UNSUPPORTED', `${op.method} subdivision is a TypeScript-engine op`);
        default:
          return failure('MESH_ENGINE_UNSUPPORTED', `the Manifold engine does not answer "${op.op}"`);
      }
    } catch (error) {
      return failure('MESH_BOOLEAN_FAILED', `Manifold: ${error instanceof Error ? error.message : 'engine error'}`);
    } finally {
      for (const solid of this.owned) {
        try {
          solid.delete();
        } catch {
          /* already freed */
        }
      }
      this.owned = [];
    }
  }

  private minkowski(a: MeshData, b: MeshData, kind: 'sum' | 'difference'): MeshOpResult | MeshEngineFailure {
    const left = this.solid(a);
    if (left === null) return this.notManifold('operand a');
    const right = this.solid(b);
    if (right === null) return this.notManifold('operand b');
    const result = this.own(kind === 'sum' ? left.minkowskiSum(right) : left.minkowskiDifference(right));
    return {
      mesh: this.extract(result),
      report: { kind },
      provenance: provenance(
        `Minkowski ${kind} by convex decomposition`,
        'Manifold minkowskiSum / minkowskiDifference (convex-part pairwise hulls, unioned)',
      ),
    };
  }

  private boolean(
    base: MeshData,
    others: ReadonlyArray<MeshInput>,
    kind: 'union' | 'subtract' | 'intersect',
  ): MeshOpResult | MeshEngineFailure {
    let current = this.solid(base);
    if (current === null) return this.notManifold('operand a');
    for (const [index, other] of others.entries()) {
      const tool = this.solid(other.mesh);
      if (tool === null) return this.notManifold(others.length === 1 ? 'operand b' : `tool ${index + 1}`);
      current = this.own(kind === 'union' ? current.add(tool) : kind === 'subtract' ? current.subtract(tool) : current.intersect(tool));
    }
    const status = current.status();
    if (status !== 'NoError') return failure('MESH_BOOLEAN_FAILED', `Manifold status ${status}`);
    return {
      mesh: this.extract(current),
      report: { kind, tools: others.length },
      provenance: provenance('mesh boolean with guaranteed-manifold output', 'Manifold CSG (Chan, Manifold library)'),
    };
  }

  /**
   * Level set of `inside` (positive = inside) over the padded bounds of `positions`. The grid edge is the requested `tolerance` (a vertex of a
   * 1-Lipschitz distance field then lies within one edge of the surface, so |dV| <= area x tolerance); when that exceeds `maxCells` the edge
   * grows to fit the cap and the report carries the coarser worst case (`toleranceMet` false, `worstVertexError` = the edge). A grid with fewer
   * than MIN_CELLS_ACROSS cells across the body refuses.
   */
  private levelSet(
    positions: ReadonlyArray<number>,
    margin: number,
    tolerance: number,
    maxCells: number,
    inside: (point: Vec3) => number,
  ): { solid: Solid; report: Record<string, unknown> } | MeshEngineFailure {
    const diagonal = meshDiagonal(positions);
    let edge = tolerance;
    let { min, max } = boundsOf(positions, margin + 2 * edge);
    let cells = cellCount(min, max, edge);
    for (let pass = 0; cells > maxCells && pass < 8; pass++) {
      edge *= Math.max(1.01, Math.cbrt(cells / maxCells) * 1.01);
      ({ min, max } = boundsOf(positions, margin + 2 * edge));
      cells = cellCount(min, max, edge);
    }
    if (cells > maxCells || edge * MIN_CELLS_ACROSS > diagonal) {
      return failure(
        'MESH_OFFSET_RESOLUTION',
        `a grid of at most ${maxCells} cells has edge ${edge.toPrecision(4)}, coarser than a quarter of the ${diagonal.toPrecision(4)} bounding-box diagonal`,
      );
    }
    const solid = this.own(
      this.api.Manifold.levelSet((p) => inside([p[0] as number, p[1] as number, p[2] as number]), { min, max }, edge, 0),
    );
    return { solid, report: { tolerance, edgeLength: edge, cells, toleranceMet: edge <= tolerance * (1 + 1e-9), worstVertexError: edge } };
  }

  private offset(mesh: MeshData, distance: number, tolerance: number, maxCells: number): MeshOpResult | MeshEngineFailure {
    const field = new MeshField(mesh.positions, orientOutward(mesh.positions, mesh.indices));
    const built = this.levelSet(mesh.positions, Math.max(distance, 0), tolerance, maxCells, (p) => distance - field.signedDistance(p));
    if ('code' in built) return built;
    return {
      mesh: this.extract(built.solid),
      report: built.report,
      provenance: provenance(
        'level-set offset: signed distance (BVH) + generalized winding number, marching tetrahedra on a BCC grid',
        'Manifold.levelSet; Jacobson et al. 2013 winding number',
      ),
    };
  }

  private hollow(mesh: MeshData, wall: number, tolerance: number, maxCells: number): MeshOpResult | MeshEngineFailure {
    const outward = orientOutward(mesh.positions, mesh.indices);
    const field = new MeshField(mesh.positions, outward);
    const built = this.levelSet(mesh.positions, 0, tolerance, maxCells, (p) => -wall - field.signedDistance(p));
    if ('code' in built) return built;
    const outer = this.solid({ positions: mesh.positions, indices: outward });
    if (outer === null) return this.notManifold('the input mesh');
    if (built.solid.isEmpty()) {
      return failure('MESH_PARAM_INVALID', `wallThickness ${wall} leaves no cavity: the body is thinner than twice the wall`);
    }
    const shell = this.own(outer.subtract(built.solid));
    return {
      mesh: this.extract(shell),
      report: { ...built.report, wall },
      provenance: provenance(
        'hollow = input minus the level-set parallel body at -wall (sealed cavity)',
        'Manifold.levelSet + CSG subtract',
      ),
    };
  }

  private wrap(mesh: MeshData, tolerance: number, maxCells: number): MeshOpResult | MeshEngineFailure {
    const field = new MeshField(mesh.positions, mesh.indices);
    const half = tolerance / 2;
    const built = this.levelSet(mesh.positions, half, tolerance, maxCells, (p) => {
      const distance = field.distance(p);
      return field.winding(p) > 0.5 ? distance + half : half - distance;
    });
    if ('code' in built) return built;
    return {
      mesh: this.extract(built.solid),
      report: built.report,
      provenance: provenance(
        'wrap: level set of (unsigned distance - tolerance/2) signed by the generalized winding number > 1/2',
        'Manifold.levelSet; Jacobson et al. 2013; Fusion Wrap / Rebuild',
      ),
    };
  }

  private smooth(mesh: MeshData, op: Extract<MeshOp, { op: 'subdivide' }>): MeshOpResult | MeshEngineFailure {
    const source = this.solid(mesh);
    if (source === null) return this.notManifold('the input mesh');
    const tangent = this.own(source.smoothOut(op.featureAngleDeg, 0));
    const refined = this.own(op.maxEdge !== undefined ? tangent.refineToLength(op.maxEdge) : tangent.refine(2 ** op.levels));
    return {
      mesh: this.extract(refined),
      report: { levels: op.levels, ...(op.maxEdge !== undefined ? { maxEdge: op.maxEdge } : {}), featureAngleDeg: op.featureAngleDeg },
      provenance: provenance('tangent-continuous smoothing (smoothOut) then refinement', 'Manifold.smoothOut / refine / refineToLength'),
    };
  }
}

/** Load the WASM once; install with `setMeshProcessingEngine` (or pass as `ExecutionContext.meshProcessing`). */
export async function createManifoldMeshEngine(): Promise<MeshProcessingEngine> {
  return new Engine((await loadManifoldModule()) as ManifoldApi);
}

/** The engine over a hand-made module: tests drive its failure paths with it. */
export function manifoldMeshEngineOver(api: unknown): MeshProcessingEngine {
  return new Engine(api as ManifoldApi);
}
