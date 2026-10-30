/** The composite engine asks an engine that declares `preferredAbove` first for inputs above that size (DES-7c step 7); the fall-through and refusal rules stay. */

import { describe, expect, it } from 'vitest';
import { MESH_ENGINE_NEEDS_HOST, composeMeshEngines } from '@core/geometry/mesh/engine';
import type { MeshEngineFailure, MeshOp, MeshOpName, MeshOpResult, MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { execute } from '@core/commands/registry';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { docWithMeshes, icosphere } from '../../helpers/meshFixtures';
import { contextWith } from '../../helpers/quadFixtures';

const op: MeshOp = { op: 'analyze', weldTolerance: 0, selfIntersections: false, maxListed: 1 };
const answer = (engine: string): MeshOpResult => ({
  report: { engine },
  provenance: { engine: 'ts', version: engine, algorithm: engine, reference: engine, deterministic: true },
});

/** An engine that lists `analyze` up to `cap`, asked-in-order recorder, answering `reply`. */
function engine(
  name: string,
  cap: number,
  reply: MeshOpResult | MeshEngineFailure,
  asked: string[],
  preferred?: number,
): MeshProcessingEngine {
  return {
    name,
    capabilities: () => new Map<MeshOpName, number>([['analyze', cap]]),
    ...(preferred !== undefined ? { preferredAbove: () => new Map<MeshOpName, number>([['analyze', preferred]]) } : {}),
    run: () => {
      asked.push(name);
      return reply;
    },
  };
}

const meshOf = (triangles: number): { mesh: { positions: number[]; indices: number[] } } => ({
  mesh: { positions: [0, 0, 0], indices: new Array<number>(triangles * 3).fill(0) },
});
const winner = (result: MeshOpResult | MeshEngineFailure): unknown => (result as MeshOpResult).report['engine'];

describe('preferredAbove', () => {
  it('goes first only above its threshold, and the listed order holds below it', () => {
    const asked: string[] = [];
    const composite = composeMeshEngines([engine('ts', 100, answer('ts'), asked), engine('native', Infinity, answer('native'), asked, 10)]);
    expect(winner(composite.run(meshOf(10), op))).toBe('ts');
    expect(winner(composite.run(meshOf(11), op))).toBe('native');
    expect(asked).toEqual(['ts', 'native']);
    expect(winner(composite.run(meshOf(5000), op))).toBe('native');
  });

  it('falls through to the other engine when the preferred one is unsupported or needs the host, and keeps any other refusal', () => {
    for (const code of ['MESH_ENGINE_UNSUPPORTED', MESH_ENGINE_NEEDS_HOST]) {
      const asked: string[] = [];
      const composite = composeMeshEngines([
        engine('ts', 100, answer('ts'), asked),
        engine('native', Infinity, { code, message: 'no' }, asked, 10),
      ]);
      expect(winner(composite.run(meshOf(50), op))).toBe('ts');
      expect(asked).toEqual(['native', 'ts']);
    }
    const refused = composeMeshEngines([
      engine('ts', 100, answer('ts'), []),
      engine('native', Infinity, { code: 'MESH_TIMEOUT', message: 'slow' }, [], 10),
    ]);
    expect(refused.run(meshOf(50), op)).toMatchObject({ code: 'MESH_TIMEOUT' });
  });

  it('reports the refusal of the last listed engine that refused, whichever order they were asked in', () => {
    const composite = composeMeshEngines([
      engine('ts', 100, answer('ts'), []),
      engine('native', Infinity, { code: MESH_ENGINE_NEEDS_HOST, message: 'host only' }, [], 10),
    ]);
    // the native engine goes first, refuses; the TypeScript engine is over its cap: the native refusal is the one reported
    expect(composite.run(meshOf(500), op)).toMatchObject({ code: MESH_ENGINE_NEEDS_HOST });
    expect(composeMeshEngines([]).run(meshOf(1), op)).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED' });
  });

  it('is not used by an engine that does not declare it, and a real mesh routes the same', () => {
    const asked: string[] = [];
    const composite = composeMeshEngines([engine('a', Infinity, answer('a'), asked), engine('b', Infinity, answer('b'), asked)]);
    expect(winner(composite.run({ mesh: icosphere(1, 1) }, op))).toBe('a');
    expect(asked).toEqual(['a']);
  });
});

describe('a native engine that cannot do the pair search leaves it to the TypeScript engine (analyze_mesh and check_mesh, fall-through)', () => {
  // a native-like engine: preferred above 15,000 triangles, answers like the TypeScript one except that it does not search crossing pairs
  const asked: string[] = [];
  const nativeLike: MeshProcessingEngine = {
    name: 'native-like',
    capabilities: () => new Map<MeshOpName, number>([['analyze', Infinity]]),
    preferredAbove: () => new Map<MeshOpName, number>([['analyze', 15_000]]),
    run: (input, asked_op) => {
      asked.push(`${asked_op.op}:${(asked_op as { selfIntersections?: boolean }).selfIntersections === true}`);
      if (asked_op.op === 'analyze' && asked_op.selfIntersections) return { code: 'MESH_ENGINE_UNSUPPORTED', message: 'no pair search' };
      return tsMeshEngine.run(input, asked_op);
    },
  };
  const { doc, ids } = docWithMeshes(icosphere(10, 5));

  it('analyze_mesh at 20,480 triangles still counts the crossing pairs (the TypeScript engine answers)', () => {
    asked.length = 0;
    const result = execute(doc, 'analyze_mesh', { id: ids[0] as string }, contextWith(nativeLike));
    expect(result.error, result.summary).toBeUndefined();
    expect((result.data as { selfIntersectionPairs: number | null }).selfIntersectionPairs).toBe(0);
    expect(asked).toEqual(['analyze:true']);
  });

  it('check_mesh at 20,480 triangles passes with the pair search done', () => {
    const result = execute(doc, 'check_mesh', { ids: [ids[0] as string], purpose: 'print' }, contextWith(nativeLike));
    expect(result.error, result.summary).toBeUndefined();
    expect((result.data as { findings: Array<{ code: string }> }).findings.map((f) => f.code)).not.toContain('MESH_CHECK_SELF_OVERLAP');
  });
});
