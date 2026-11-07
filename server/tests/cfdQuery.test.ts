/**
 * 12 CFD M3a cfd_probe / cfd_slice / cfd_streamlines transports with a fake llull-compute (the real binary: `cfdSolveNative.test.ts`): the
 * job folder (job.json bound to the stored field by hash, the field file itself), reports and stored files, the trust / staleness refusals
 * before anything runs, native failures, caller cancellation, the document never changes, tool wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { runCfdQuery } from '../src/cfd/flowQuery';
import { cfdFileStore } from '../src/cfd/fileStore';
import { runCfdSolve } from '../src/cfd/flowSolve';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { isNativeTool, runNativeTool } from '../src/native/tools';
import { fakeField, fakeRunner, hostOf, missingRunner, sha, sphereModel, type FakeOptions, type TestHost } from './cfdTestSupport';

let dir = '';
let store: FeArtifactCache;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-cfd-query-'));
  store = createFeArtifactStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function solvedHost(): Promise<{ host: TestHost; ballId: string }> {
  const model = sphereModel();
  const host = hostOf(model, store);
  const solved = await runCfdSolve('re100', {}, host, { store, runner: fakeRunner() });
  if (solved.isError) throw new Error(solved.summary);
  return { host, ballId: model.ballId };
}

const probeAnswer = {
  probes: [
    { pointM: [2, 0, 0], velocityMS: [0.9, 0, 0.1], speedMS: 0.9055, pressurePa: -0.05, miss: null },
    { pointM: [0, 0, 0], velocityMS: null, speedMS: null, pressurePa: null, miss: 'solid' },
  ],
};

function llsl(samples: number): Buffer {
  const bytes = Buffer.alloc(72 + 4 * samples * samples);
  bytes.write('LLSL', 0, 'latin1');
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(samples, 8);
  bytes.writeUInt32LE(samples, 12);
  return bytes;
}

function llst(lines: number, points: number): Buffer {
  const bytes = Buffer.alloc(16 + 4 * (lines + 1) + 16 * points);
  bytes.write('LLST', 0, 'latin1');
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(lines, 8);
  bytes.writeUInt32LE(points, 12);
  return bytes;
}

const answering = (query: FakeOptions['query']): ReturnType<typeof fakeRunner> => fakeRunner(query === undefined ? {} : { query });

describe('cfd_probe', () => {
  it('runs flow-query on the stored field bound by hash and reports cp and U / U∞ without touching the document', async () => {
    const { host } = await solvedHost();
    const before = host.current();
    const runner = answering(() => ({ json: probeAnswer }));
    const result = await runCfdQuery(
      'probe',
      {
        caseId: 're100',
        points: [
          [2, 0, 0],
          [0, 0, 0],
        ],
      },
      host,
      { store, runner },
    );
    expect(result.isError, result.summary).toBe(false);
    expect(result.affected).toEqual([]);
    expect(host.current()).toBe(before);
    const [call] = runner.calls;
    expect(call?.args).toEqual(['flow-query']);
    expect(Object.keys(call?.files ?? {}).sort()).toEqual(['field.bin', 'job.json']);
    expect(call?.files['field.bin']?.equals(fakeField())).toBe(true);
    const job = JSON.parse(call?.files['job.json']?.toString('utf8') ?? '{}') as Record<string, unknown>;
    expect(job).toEqual({
      version: 1,
      field: 'field.bin',
      fieldSha256: sha(fakeField()),
      frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      op: 'probe',
      probe: {
        pointsM: [
          [2, 0, 0],
          [0, 0, 0],
        ],
      },
    });
    const probes = (result.data as { probes: Array<{ cp: number | null; speedRatio: number | null }> }).probes;
    expect(probes[0]?.cp).toBeCloseTo(-0.1, 10);
    expect(probes[0]?.speedRatio).toBeCloseTo(0.9055, 10);
    expect(result.summary).toContain('2 points — 1 in the fluid');
  });
});

describe('cfd_slice and cfd_streamlines', () => {
  it('stores the slice file content-addressed and reports it', async () => {
    const { host } = await solvedHost();
    const file = llsl(5);
    const runner = answering(() => ({
      json: {
        slice: {
          file: 'slice.bin',
          field: 'p',
          samples: 5,
          spacingM: 0.5,
          originM: [0, 0, 0],
          axisU: [1, 0, 0],
          axisV: [0, 0, 1],
          validSamples: 20,
          min: -0.4,
          max: 0.5,
        },
      },
      file,
    }));
    const result = await runCfdQuery('slice', { caseId: 're100', origin: [0, 0, 0], normal: [0, 1, 0], field: 'p' }, host, {
      store,
      runner,
    });
    expect(result.isError, result.summary).toBe(false);
    const job = JSON.parse(runner.calls[0]?.files['job.json']?.toString('utf8') ?? '{}') as { slice: Record<string, unknown> };
    expect(job.slice).toMatchObject({ field: 'p', spacingM: 0.125, dynamicPressurePa: 0.5 });
    expect(result.data).toMatchObject({ file: { sha256: sha(file), bytes: file.length, format: 'LLSL' } });
    expect(cfdFileStore(store.directory).get(sha(file))?.equals(file)).toBe(true);
  });

  it('traces streamlines, passes the job warnings on and stores the polylines', async () => {
    const { host } = await solvedHost();
    const file = llst(2, 7);
    const runner = answering((job) => ({
      json: {
        streamlines: {
          file: 'streamlines.bin',
          device: 'cpu',
          deterministic: true,
          precision: 'f64',
          gpuFallback: 'no adapter',
          points: 7,
          lines: (job['streamlines'] as { seedsM: unknown[] }).seedsM.map((_, seed) => ({
            seed,
            points: seed === 0 ? 7 : 0,
            lengthM: seed === 0 ? 4 : 0,
            stopBackward: seed === 0 ? 'left_domain' : 'wall',
            stopForward: seed === 0 ? 'left_domain' : 'wall',
          })),
        },
      },
      file,
    }));
    const result = await runCfdQuery(
      'streamlines',
      { caseId: 're100', rake: { kind: 'line', start: [-0.9, 0, 0], end: [0, 0, 0], count: 2 }, device: 'auto' },
      host,
      { store, runner },
    );
    expect(result.isError, result.summary).toBe(false);
    expect(result.data).toMatchObject({ stopCounts: { left_domain: 2, wall: 2 }, gpuFallback: 'no adapter', file: { sha256: sha(file) } });
    expect(result.summary).toContain('2 seeds -> 1 lines, 7 points');
  });
});

describe('query refusals', () => {
  it('refuses before running: invalid params, no result, a stale result, a missing field file, no binary', async () => {
    const runner = answering(() => ({ json: probeAnswer }));
    const fresh = hostOf(sphereModel(), store);
    const points = { caseId: 're100', points: [[2, 0, 0]] };
    expect(await runCfdQuery('probe', { caseId: 're100', points: [] }, fresh, { store, runner })).toMatchObject({
      data: { code: 'CFD_PARAM_INVALID' },
    });
    expect(await runCfdQuery('probe', points, fresh, { store, runner })).toMatchObject({ data: { code: 'CFD_NO_RESULT' } });
    const { host, ballId } = await solvedHost();
    const moved = execute(host.current(), 'move_entities', { ids: [ballId], delta: [0.25, 0, 0] }).document;
    const staleHost = { ...host, getDoc: () => moved };
    expect(await runCfdQuery('probe', points, staleHost, { store, runner })).toMatchObject({ data: { code: 'CFD_RESULT_STALE' } });
    expect(await runCfdQuery('probe', points, host, { store, runner: missingRunner() })).toMatchObject({
      data: { code: 'CFD_SOLVER_MISSING' },
    });
    rmSync(path.join(store.directory, 'cfd-files', `${sha(fakeField())}.bin`));
    expect(await runCfdQuery('probe', points, host, { store, runner })).toMatchObject({ data: { code: 'CFD_RESULT_MISSING' } });
    expect(runner.calls).toHaveLength(0);
  });

  it('maps native failures, bad answers and cancellation, and changes nothing', async () => {
    const { host } = await solvedHost();
    const points = { caseId: 're100', points: [[2, 0, 0]] };
    const failed = await runCfdQuery('probe', points, host, {
      store,
      runner: answering(() => ({ fail: { code: 'NATIVE_JOB_INPUT', message: 'bad' } })),
    });
    expect(failed).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_FAILED', nativeCode: 'NATIVE_JOB_INPUT' } });
    expect(failed.summary).toContain('query log tail');
    const timeout = await runCfdQuery('probe', points, host, {
      store,
      runner: answering(() => ({ fail: { code: 'NATIVE_TIMEOUT', message: 'slow' } })),
    });
    expect(timeout.data).toMatchObject({ code: 'CFD_TIMEOUT' });
    const malformed = await runCfdQuery('probe', points, host, { store, runner: answering(() => ({ json: { probes: 'x' } })) });
    expect(malformed.data).toMatchObject({ code: 'CFD_SOLVER_FAILED' });
    const shortSlice = await runCfdQuery('slice', { caseId: 're100', origin: [0, 0, 0], normal: [0, 0, 1] }, host, {
      store,
      runner: answering(() => ({
        json: {
          slice: {
            file: 'slice.bin',
            field: 'speed',
            samples: 4,
            spacingM: 1,
            originM: [0, 0, 0],
            axisU: [1, 0, 0],
            axisV: [0, 1, 0],
            validSamples: 0,
            min: null,
            max: null,
          },
        },
        file: llsl(3),
      })),
    });
    expect(shortSlice.data).toMatchObject({ code: 'CFD_SOLVER_FAILED' });
    const gone = new AbortController();
    gone.abort();
    const cancelled = await runCfdQuery(
      'probe',
      points,
      host,
      { store, runner: answering(() => ({ json: probeAnswer })) },
      { signal: gone.signal },
    );
    expect(cancelled.data).toMatchObject({ code: 'CFD_CANCELLED' });
  });
});

describe('query tool wiring', () => {
  it('runs the three queries as native tools that never change the document', async () => {
    for (const name of ['cfd_probe', 'cfd_slice', 'cfd_streamlines']) expect(isNativeTool(name)).toBe(true);
    const { host } = await solvedHost();
    const outcome = await runNativeTool('cfd_probe', { caseId: 're100', points: [[2, 0, 0]] }, host, {
      store,
      runner: answering(() => ({ json: probeAnswer })),
    });
    expect(outcome).toMatchObject({ isError: false, changed: false });
    const invalid = await runNativeTool('cfd_streamlines', { caseId: 're100' }, host, { store, runner: fakeRunner() });
    expect(invalid).toMatchObject({ isError: true, changed: false, data: { code: 'CFD_PARAM_INVALID' } });
  });
});
