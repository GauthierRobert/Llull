/**
 * VIS-M8e (plant 09, RS1 RS-6): `ctx.spatialIndex` behind `llull-compute bvh`. The native tree equals the TypeScript tree array for array
 * (the TypeScript build is the oracle), `check_clashes` and `planSceneOf` give the same answers with and without the port, and a binary that
 * is missing, crashes or times out is answered by the TypeScript build with the job folder removed. Native runs need llull-compute
 * (cargo build -p llull-compute --release in solver/) and are skipped with a logged reason otherwise; the fallback tests always run.
 * Opt-in timing: `VIS_PERF=1 npm --prefix server test -- spatialIndexNative --disableConsoleIntercept`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { type PackedBoxes, buildInstanceBvh, exportInstanceBvh, packBoxes } from '@core/geometry/instanceBvh';
import { planSceneOf } from '@core/geometry/planSceneCache';
import { frustumPlanes } from '@core/geometry/renderPlanCamera';
import { getSpatialIndex, setSpatialIndex } from '@core/geometry/spatialIndex';
import type { Vec3 } from '@core/model/types';
import { clashStressDocument } from '../../tests/helpers/clashStress';
import { SYN_RACK_BAYS, synRackDocument } from '../../tests/helpers/synRack';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { NATIVE_MIN_BOXES, createNativeSpatialIndex, installSpatialIndex } from '../src/native/spatialIndexPort';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('spatialIndexNative: llull-compute not built (cargo build -p llull-compute --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const KEEP = { ...process.env, LLULL_NATIVE_KEEP: '1' };
const MISSING = path.join(tmpdir(), 'no-such-llull-compute.exe');

function randomBoxes(count: number, seed: number, degenerate = 0): PackedBoxes {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const boxes: { min: Vec3; max: Vec3 }[] = [];
  for (let i = 0; i < count; i++) {
    const min: Vec3 = [next() * 200 - 100, next() * 200 - 100, next() * 40];
    boxes.push({ min, max: i < degenerate ? min : [min[0] + next() * 3, min[1] + next() * 3, min[2] + next() * 3] });
  }
  return packBoxes(boxes);
}

const jobFolders = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('llull-compute-'));
const newSince = (before: readonly string[]): string[] => jobFolders().filter((name) => !before.includes(name));
const removeNew = (before: readonly string[]): void =>
  newSince(before).forEach((name) => rmSync(path.join(tmpdir(), name), { recursive: true, force: true }));

/** The arrays of a tree (the transfer list is a different object per export). */
const arraysOf = (bvh: ReturnType<typeof buildInstanceBvh>): Omit<ReturnType<typeof exportInstanceBvh>, 'transfer'> => {
  const { transfer: _transfer, ...arrays } = exportInstanceBvh(bvh);
  return arrays;
};

afterEach(() => {
  setSpatialIndex(null);
  vi.restoreAllMocks();
});

const view = frustumPlanes({
  projection: 'perspective',
  eye: [0, -150, 60],
  direction: [0, 0.9486832980505138, -0.31622776601683794],
  up: [0, 0.31622776601683794, 0.9486832980505138],
  fovDeg: 40,
  viewHeight: 0,
  widthPx: 800,
  heightPx: 600,
});

describe('native spatial index = TypeScript build (VIS-M8e)', () => {
  native('builds the same tree array for array, through a job folder', () => {
    const boxes = randomBoxes(20_000, 7, 300);
    const warn = vi.spyOn(console, 'warn');
    const before = jobFolders();
    const bvh = createNativeSpatialIndex(BINARY as string, KEEP, { minBoxes: 0 }).build(boxes);
    const made = newSince(before);
    removeNew(before);
    expect(made, 'the native job ran').toHaveLength(1);
    expect(warn, 'the native tree was used, not the fallback').not.toHaveBeenCalled();
    const reference = buildInstanceBvh(boxes);
    expect(arraysOf(bvh)).toEqual(arraysOf(reference));
    expect(bvh.frustumQuery(view)).toEqual(reference.frustumQuery(view));
  });

  native('leaves no job folder behind, and makes none below the threshold', () => {
    const before = jobFolders();
    const port = createNativeSpatialIndex(BINARY as string, process.env, { minBoxes: 100 });
    port.build(randomBoxes(500, 3));
    expect(newSince(before)).toEqual([]);
    const kept = createNativeSpatialIndex(BINARY as string, KEEP, { minBoxes: 100 });
    kept.build(randomBoxes(99, 4));
    expect(newSince(before), 'below the threshold no job is started').toEqual([]);
    kept.build(randomBoxes(100, 4));
    expect(newSince(before), 'LLULL_NATIVE_KEEP=1 keeps the folder of a job').toHaveLength(1);
    removeNew(before);
  });

  it('the native threshold stays above the process start cost', () => {
    expect(NATIVE_MIN_BOXES).toBeGreaterThanOrEqual(10_000);
  });

  native('check_clashes answers the same with and without the port, and the port is used', () => {
    const doc = clashStressDocument(400, 1, 20_000);
    const plain = execute(doc, 'check_clashes', {}, defaultContext());
    const warn = vi.spyOn(console, 'warn');
    const before = jobFolders();
    const port = createNativeSpatialIndex(BINARY as string, KEEP, { minBoxes: 0 });
    const viaNative = execute(doc, 'check_clashes', {}, { ...defaultContext(), spatialIndex: port });
    const made = newSince(before).length;
    removeNew(before);
    expect(made).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(viaNative.summary).toBe(plain.summary);
    expect(viaNative.data).toEqual(plain.data);
    expect(plain.summary).toContain('hard clash');
  });

  native('planSceneOf takes the frustum query from the native tree', () => {
    const doc = synRackDocument(SYN_RACK_BAYS[0]);
    const warn = vi.spyOn(console, 'warn');
    const port = createNativeSpatialIndex(BINARY as string, process.env, { minBoxes: 0 });
    const withPort = { ...doc };
    planSceneOf(withPort, 0, port);
    const nativeQuery = planSceneOf(withPort, 0, port).query;
    const plain = { ...doc };
    planSceneOf(plain, 0);
    const tsQuery = planSceneOf(plain, 0).query;
    expect(warn).not.toHaveBeenCalled();
    expect(nativeQuery).toBeTypeOf('function');
    expect(nativeQuery?.(view).length).toBeGreaterThan(0);
    expect(nativeQuery?.(view)).toEqual(tsQuery?.(view));
  });

  native('installSpatialIndex installs the port when the binary exists and not otherwise', () => {
    expect(installSpatialIndex({ ...process.env, LLULL_COMPUTE: BINARY as string })).toBe(true);
    expect(getSpatialIndex()).not.toBeNull();
    expect(installSpatialIndex({ ...process.env, LLULL_COMPUTE: MISSING })).toBe(false);
    expect(getSpatialIndex()).toBeNull();
  });
});

describe('spatial index fallback (VIS-M8e)', () => {
  const boxes = randomBoxes(2_000, 11, 50);
  const expected = arraysOf(buildInstanceBvh(boxes));

  const answeredByTypeScript = (port: ReturnType<typeof createNativeSpatialIndex>, code: string): void => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = jobFolders();
    const bvh = port.build(boxes);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(code));
    expect(newSince(before), 'the job folder is removed').toEqual([]);
    expect(arraysOf(bvh)).toEqual(expected);
  };

  it('a missing binary (NATIVE_TOOL_MISSING) is answered by the TypeScript build', () => {
    answeredByTypeScript(createNativeSpatialIndex(MISSING, process.env, { minBoxes: 0 }), 'NATIVE_TOOL_MISSING');
  });

  it('a binary that exits without a final event is answered by the TypeScript build', () => {
    // `node bvh <folder>` cannot start a script named "bvh": it exits with an error and prints no job event
    answeredByTypeScript(
      createNativeSpatialIndex(process.execPath, { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, { minBoxes: 0 }),
      'NATIVE_PROTOCOL',
    );
  });

  native('a build that outlives its wait is killed and answered by the TypeScript build', () => {
    answeredByTypeScript(createNativeSpatialIndex(BINARY as string, process.env, { minBoxes: 0, timeoutMs: 1 }), 'NATIVE_TIMEOUT');
  });

  it('a box list that is not 6 numbers per box is answered by the TypeScript build', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(createNativeSpatialIndex(process.execPath, process.env, { minBoxes: 0 }).build(new Float64Array(13)).count).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not 6 per box'));
  });
});

describe.skipIf(process.env['VIS_PERF'] === undefined || BINARY === null)('spatial index timing (VIS-M8e, no gate)', () => {
  it.each([100_000, 250_000, 500_000, 1_000_000])(
    'n = %i',
    (count) => {
      const boxes = randomBoxes(count, 5, 100);
      const t0 = performance.now();
      buildInstanceBvh(boxes);
      const t1 = performance.now();
      createNativeSpatialIndex(BINARY as string, process.env, { minBoxes: 0 }).build(boxes);
      const t2 = performance.now();
      console.warn(`bvh n=${count}: TypeScript ${(t1 - t0).toFixed(0)} ms, native port (job folder round trip) ${(t2 - t1).toFixed(0)} ms`);
    },
    300_000,
  );
});
