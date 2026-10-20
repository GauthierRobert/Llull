/**
 * VC-RTE-25 (plant 02 RTE V2, RS1 RS-7): the native router (`llull-compute route`, crate llull-route) against the TypeScript reference
 * search of `auto_route_pipe`, through the `auto_route` transport. Identical PIs, bends, integer-µm cost, `optimal` and expansion count
 * on SC-RTE-08 and on seeded obstacle problems small enough for the TypeScript cap; the native solution passes `auto_route_pipe`
 * validation; a solution made stale by a document change is refused with the document unchanged; the 100 m x 100 m x 30 m / 50 mm
 * problem finishes within 2e6 expansions (time logged). Native runs skip with a logged reason when the binary is not built
 * (cargo build --profile compute -p llull-compute in solver/); the missing-binary and refusal paths always run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { parseRouteResult, runAutoRoute } from '../src/native/autoRoute';
import { isNativeTool, runNativeTool } from '../src/native/tools';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn(
    'routeNativeParity: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): native runs skipped',
  );
const native = BINARY === null ? it.skip : it;

let dir = '';
let store: FeArtifactCache;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-route-parity-'));
  store = createFeArtifactStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Vec3 = [number, number, number];
type Json = Record<string, unknown>;

/** A host on a mutable document; `beforeCommit` runs just before auto_route_pipe (to make the solution stale). */
function hostOf(start: CadDocument, beforeCommit?: (doc: CadDocument) => CadDocument): FeaHost & { doc: () => CadDocument } {
  let doc = start;
  return {
    doc: () => doc,
    getDoc: () => doc,
    applyCommand: (name, params) => {
      if (name === 'auto_route_pipe' && beforeCommit !== undefined) doc = beforeCommit(doc);
      const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
      if (result.rejected !== true) doc = result.document;
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
    },
  };
}

const must = (doc: CadDocument, name: string, params: Json): ReturnType<typeof execute> => {
  const result = execute(doc, name, params);
  expect(result.rejected, result.summary).toBeUndefined();
  return result;
};

/** Two DN100 BW tie-ins and a line; `boxes` = [centre, size] obstacles. */
function scenario(from: [Vec3, Vec3], to: [Vec3, Vec3], boxes: readonly [Vec3, Vec3][] = []): { doc: CadDocument; params: Json } {
  let doc = createEmptyDocument();
  for (const [position, size] of boxes) doc = must(doc, 'add_box', { position, size }).document;
  const a = must(doc, 'add_tie_in_point', { tag: 'A', position: from[0], direction: from[1], dn: 100, endType: 'BW' });
  const b = must(a.document, 'add_tie_in_point', { tag: 'B', position: to[0], direction: to[1], dn: 100, endType: 'BW' });
  const line = must(b.document, 'create_pipeline', { service: 'P', sequence: '8001', spec: 'CS150', dn: 100 });
  return {
    doc: line.document,
    params: { lineId: line.affected[0], from: { portId: a.affected[0] }, to: { portId: b.affected[0] }, grid: 50, bendCost: 1000 },
  };
}

const SC_RTE_08 = (): ReturnType<typeof scenario> =>
  scenario(
    [
      [0, 0, 0],
      [1, 0, 0],
    ],
    [
      [3000, 2000, 1000],
      [0, 0, -1],
    ],
  );

/** Seeded boxes between the SC-RTE-08 ports (LCG; positions on a 50 mm pitch). */
function seededBoxes(seed: number, count: number): [Vec3, Vec3][] {
  let state = seed;
  const next = (n: number): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
  return Array.from({ length: count }, (): [Vec3, Vec3] => [
    [500 + 50 * next(50), -500 + 50 * next(60), -200 + 50 * next(30)],
    [100 + 50 * next(8), 100 + 50 * next(8), 100 + 50 * next(8)],
  ]);
}

const routeData = (result: FeaToolResult): Json => {
  expect(result.isError, result.summary).toBe(false);
  return result.data as Json;
};

const compared = (data: Json): Json => ({
  pis: data['pis'],
  bends: data['bends'],
  cost: data['cost'],
  optimal: data['optimal'],
  expansions: data['expansions'],
  centrelineToPiLengthMm: data['centrelineToPiLengthMm'],
});

describe('auto_route: native vs TypeScript reference (VC-RTE-25)', () => {
  const nativeRun = (doc: CadDocument, params: Json): Promise<FeaToolResult> =>
    runAutoRoute(params, { timeoutS: 60 }, hostOf(doc), { store, runner: createComputeRunner({}, BINARY) });

  native('SC-RTE-08: same route, cost and expansions; 6000 mm, 2 bends, optimal (VC-RTE-18)', async () => {
    const { doc, params } = SC_RTE_08();
    const reference = must(doc, 'auto_route_pipe', params).data as Json;
    const routed = routeData(await nativeRun(doc, params));
    expect(compared(routed)).toEqual(compared(reference));
    expect(routed).toMatchObject({ centrelineToPiLengthMm: 6000, bends: 2, optimal: true, engine: 'llull-route' });
    expect((routed['native'] as Json)['version']).toBe('0.1.0');
  });

  native('seeded obstacle problems: identical PIs, bends, cost and expansions', async () => {
    for (const seed of [1, 7, 42, 2026]) {
      const { doc, params } = scenario(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        [
          [3000, 2000, 1000],
          [0, 0, -1],
        ],
        seededBoxes(seed, 12),
      );
      const reference = execute(doc, 'auto_route_pipe', params);
      const routed = await nativeRun(doc, params);
      if (reference.rejected === true) {
        expect(routed.isError, `seed ${seed}: ${routed.summary}`).toBe(true);
        expect(routed.summary).toContain(reference.error?.code ?? '?');
        continue;
      }
      expect(compared(routeData(routed)), `seed ${seed}`).toEqual(compared(reference.data as Json));
    }
  });

  native('a solution made stale by a document change is refused and nothing is committed', async () => {
    const { doc, params } = SC_RTE_08();
    const host = hostOf(doc, (current) => must(current, 'add_box', { position: [1500, 0, 0], size: [200, 200, 200] }).document);
    const result = await runAutoRoute(params, {}, host, { store, runner: createComputeRunner({}, BINARY) });
    expect(result.isError).toBe(true);
    expect(result.summary).toContain('RTE_AUTOROUTE_SOLUTION_INVALID');
    expect(result.summary).toContain('stale problemHash');
    expect(host.doc().plant?.piping?.runOrder).toEqual([]);
  });

  native(
    'a 1.6e10-cell box (>= 100 m x 100 m x 30 m at 50 mm) routes within 2e6 expansions (time logged, TBD on the reference machine)',
    async () => {
      // Ports 100 m apart on one line; a wall across the whole box at x = 50 m leaves a 1.5 m window whose edge is 1 m off that line,
      // so the route must jog and A* has to search the slack around it (1 761 410 expansions, measured 2026-10-19).
      const { doc, params } = scenario(
        [
          [0, 50000, 15000],
          [1, 0, 0],
        ],
        [
          [100000, 50000, 15000],
          [-1, 0, 0],
        ],
      );
      const keepOutBoxes = [
        { min: [50000, -1000, -36000], max: [50200, 51000, 66000] },
        { min: [50000, 52500, -36000], max: [50200, 101000, 66000] },
      ];
      const big = { ...params, bendCost: 100, gridMargin: 50000, keepOutBoxes };
      const problem = must(doc, 'route_problem', big).data as { problem: { bounds: { min: number[]; max: number[] } } };
      const cells = problem.problem.bounds.max.reduce((total, max, axis) => total * (max - (problem.problem.bounds.min[axis] ?? 0) + 1), 1);
      expect(cells).toBeGreaterThan(2000 * 2000 * 600);
      expect(execute(doc, 'auto_route_pipe', big).error?.code).toBe('RTE_AUTOROUTE_BUDGET');
      const started = Date.now();
      const routed = routeData(await nativeRun(doc, big));
      console.warn(`routeNativeParity: ${cells} cells: ${String(routed['expansions'])} expansions in ${Date.now() - started} ms`);
      expect(routed['expansions']).toBe(1_761_410);
      expect(routed).toMatchObject({ bends: 4, centrelineToPiLengthMm: 102300, optimal: true });
    },
    120_000,
  );

  native('llull auto_route on a document file commits the run (CLI)', async () => {
    const { doc, params } = SC_RTE_08();
    const file = path.join(dir, 'route.llull.json');
    writeFileSync(file, serializeDocument(doc));
    const out: string[] = [];
    const io: CliIo = {
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
    };
    const args = Object.entries(params).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    expect(await runCli(['auto_route', ...args, '--doc', file], io), out.join('\n')).toBe(EXIT_OK);
    const saved = deserializeDocument(readFileSync(file, 'utf8'));
    const runId = saved.plant?.piping?.runOrder[0] ?? '';
    expect(saved.plant?.piping?.runs[runId]?.autoRoute?.engine).toBe('llull-route');
    expect(saved.entities[runId]?.kind).toBe('mesh');
  });
});

describe('auto_route without the binary and on refusals', () => {
  it('refuses NATIVE_TOOL_MISSING with the install hint, leaving the document unchanged', async () => {
    const { doc, params } = SC_RTE_08();
    const host = hostOf(doc);
    const result = await runAutoRoute(params, {}, host, { store, runner: createComputeRunner({}, null) });
    expect(result.isError).toBe(true);
    expect(result.data).toEqual({ code: 'NATIVE_TOOL_MISSING' });
    expect(result.summary).toContain('auto_route_pipe without solution');
    expect(host.doc()).toBe(doc);
  });

  it('passes route_problem refusals through before any job runs', async () => {
    const { doc, params } = SC_RTE_08();
    const result = await runNativeTool('auto_route', { ...params, lineId: 'line-nope' }, hostOf(doc), {
      store,
      runner: createComputeRunner({}, null),
    });
    expect(isNativeTool('auto_route')).toBe(true);
    expect(result?.isError).toBe(true);
    expect(result?.summary).toContain('RTE_UNKNOWN_LINE');
    expect(result?.changed).toBe(false);
  });

  it('reads result.json strictly', () => {
    expect(parseRouteResult('nope')).toBe('result.json is not JSON');
    expect(parseRouteResult('[]')).toBe('result.json is not an object');
    expect(parseRouteResult('{"status":"lost"}')).toBe('result.json lacks status, problemHash or expansions');
    expect(parseRouteResult('{"status":"found","problemHash":"h","expansions":1}')).toBe(
      'a found result lacks pisUm, lengthUm, bends or cost',
    );
    expect(parseRouteResult('{"status":"budget","problemHash":"h","expansions":3}')).toEqual({
      status: 'budget',
      problemHash: 'h',
      expansions: 3,
      version: 'unknown',
    });
  });

  it('lists auto_route in the CLI help and describe', async () => {
    const out: string[] = [];
    const io: CliIo = {
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
    };
    expect(await runCli(['describe', 'auto_route'], io)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('llull-compute route');
    const file = path.join(dir, 'missing.llull.json');
    expect(await runCli(['new', '--doc', file], io)).toBe(EXIT_OK);
    expect(await runCli(['auto_route', 'lineId=nope', 'from={"portId":"a"}', 'to={"portId":"b"}', '--doc', file], io)).toBe(
      EXIT_COMMAND_ERROR,
    );
    expect(out.join('\n')).toContain('RTE_UNKNOWN_LINE');
  });
});
