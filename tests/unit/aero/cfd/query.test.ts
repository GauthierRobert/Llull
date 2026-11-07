/**
 * 12 CFD M3a result queries, pure side (@aero): params (CFD_PARAM_INVALID), rakes, the trust / staleness ladder of `flowQueryInput`
 * (CFD_CASE_NOT_FOUND, CFD_NO_RESULT, CFD_RESULT_MISSING, CFD_RESULT_HASH_MISMATCH, CFD_RESULT_STALE), the job (frame, field hash, named
 * defaults), the answer parsers / file cross-checks, the field header, the reports, and the protocol schemas pinned to the plugin's.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { toParamsSchema } from '@core/commands/schema';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { flowQueryInput, parseFlowQuery, type FlowQueryInput, type FlowQueryRequest } from '@aero/cfd/queryInput';
import { flowFieldHeader, flowQueryReport, parseFlowQueryAnswer } from '@aero/cfd/queryOutput';
import { cfdProbeParams, cfdSliceParams, cfdStreamlinesParams, rakeSeeds } from '@aero/cfd/queryParams';
import { buildNativeToolDefinitions } from '@protocol/nativeTools';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { FIELD_SHA, recordedSphere } from './resultFixtures';

const recorded = recordedSphere();

function request(op: 'probe' | 'slice' | 'streamlines', params: Record<string, unknown>): FlowQueryRequest {
  const parsed = parseFlowQuery(op, { caseId: 'c1', ...params });
  if ('ok' in parsed) throw new Error(parsed.message);
  return parsed;
}

function input(op: 'probe' | 'slice' | 'streamlines', params: Record<string, unknown>, doc = recorded.doc): FlowQueryInput {
  const built = flowQueryInput(doc, request(op, params), recorded.port, null);
  if (!built.ok) throw new Error(built.message);
  return built;
}

const refusalCode = (built: ReturnType<typeof flowQueryInput>): string => (built.ok ? 'ok' : built.code);

describe('query params and rakes', () => {
  it('names every invalid path with CFD_PARAM_INVALID', () => {
    const bad = parseFlowQuery('probe', { caseId: 'c1', points: [] });
    expect(bad).toMatchObject({ ok: false, code: 'CFD_PARAM_INVALID' });
    expect('ok' in bad && bad.message).toContain('points');
    const rake = parseFlowQuery('streamlines', { caseId: 'c1', rake: { kind: 'cone' } });
    expect('ok' in rake && rake.message).toContain('rake');
    expect(parseFlowQuery('slice', { caseId: 'c1', origin: [0, 0, 0], normal: [0, 1, 0], spacingM: -1 })).toMatchObject({
      code: 'CFD_PARAM_INVALID',
    });
  });

  it('spaces line seeds evenly, spans planes centre ± axes, puts sphere seeds on the sphere and caps planes', () => {
    expect(rakeSeeds({ kind: 'line', start: [0, 0, 0], end: [1, 0, 0], count: 3 })).toEqual([
      [0, 0, 0],
      [0.5, 0, 0],
      [1, 0, 0],
    ]);
    expect(rakeSeeds({ kind: 'line', start: [2, 0, 0], end: [1, 0, 0], count: 1 })).toEqual([[2, 0, 0]]);
    const plane = rakeSeeds({ kind: 'plane', centre: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 2, 0], nu: 3, nv: 2 });
    expect(plane).toEqual([
      [-1, -2, 1],
      [0, -2, 1],
      [1, -2, 1],
      [-1, 2, 1],
      [0, 2, 1],
      [1, 2, 1],
    ]);
    expect(rakeSeeds({ kind: 'plane', centre: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], nu: 1, nv: 1 })).toEqual([[0, 0, 0]]);
    const sphere = rakeSeeds({ kind: 'sphere', centre: [1, 2, 3], radiusM: 2, count: 50 });
    if (typeof sphere === 'string') throw new Error(sphere);
    for (const seed of sphere) expect(Math.hypot(seed[0] - 1, seed[1] - 2, seed[2] - 3)).toBeCloseTo(2, 12);
    expect(rakeSeeds({ kind: 'sphere', centre: [0, 0, 0], radiusM: 1, count: 1 })).toEqual([[0, 0, 1]]);
    expect(rakeSeeds({ kind: 'plane', centre: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], nu: 65, nv: 64 })).toContain('4096');
    expect(rakeSeeds({ kind: 'points', points: [[1, 2, 3]] })).toEqual([[1, 2, 3]]);
  });
});

describe('flowQueryInput trust ladder', () => {
  const probe = (doc = recorded.doc, port = recorded.port): ReturnType<typeof flowQueryInput> =>
    flowQueryInput(doc, request('probe', { points: [[1, 0, 0]] }), port, null);

  it('builds the probe job on a trusted, current result: case frame, field hash, world points', () => {
    const built = input('probe', { points: [[1, 0, 0]] });
    expect(built.job).toEqual({
      version: 1,
      field: 'field.bin',
      fieldSha256: FIELD_SHA,
      frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      op: 'probe',
      probe: { pointsM: [[1, 0, 0]] },
    });
    expect(built.resultsHash).toBe(recorded.hash);
  });

  it('refuses an unknown case, a case without result and an unverified record', () => {
    expect(refusalCode(flowQueryInput(recorded.doc, request('probe', { caseId: 'nope', points: [[0, 0, 0]] }), recorded.port, null))).toBe(
      'CFD_CASE_NOT_FOUND',
    );
    const fresh = recordedSphere();
    const cleared = execute(fresh.doc, 'update_cfd_case', { caseId: 'c1', quality: 'draft' }).document;
    const withoutResult = { ...cleared, cfd: { cases: cleared.cfd?.cases ?? {}, results: {} } };
    expect(refusalCode(probe(withoutResult))).toBe('CFD_NO_RESULT');
    const summary = recorded.doc.cfd?.results['c1'];
    const unverified = { ...recorded.doc, cfd: { cases: recorded.doc.cfd?.cases ?? {}, results: { c1: { ...summary, verified: false } } } };
    expect(refusalCode(probe(unverified as typeof recorded.doc))).toBe('CFD_RESULT_MISSING');
  });

  it('refuses a bundle missing from the store, a tampered bundle and a record that differs from it', () => {
    expect(refusalCode(probe(recorded.doc, { get: () => null }))).toBe('CFD_RESULT_MISSING');
    expect(refusalCode(flowQueryInput(recorded.doc, request('probe', { points: [[0, 0, 0]] }), null, null))).toBe('CFD_RESULT_MISSING');
    const tampered: CfdResultArtifact = { ...recorded.artifact, steps: 1 };
    expect(refusalCode(probe(recorded.doc, { get: () => tampered }))).toBe('CFD_RESULT_HASH_MISMATCH');
    const summary = recorded.doc.cfd?.results['c1'];
    const edited = { ...recorded.doc, cfd: { cases: recorded.doc.cfd?.cases ?? {}, results: { c1: { ...summary, converged: false } } } };
    expect(refusalCode(probe(edited as typeof recorded.doc))).toBe('CFD_RESULT_HASH_MISMATCH');
  });

  it('refuses a bundle solved before M3a, which has no field file', () => {
    const legacy = Object.fromEntries(Object.entries(recorded.artifact).filter(([key]) => key !== 'field')) as unknown as CfdResultArtifact;
    const hash = sha256Hex(canonicalJson(legacy));
    const port = { get: (key: string): CfdResultArtifact | null => (key === hash ? legacy : null) };
    const doc = execute(
      recorded.doc,
      'record_cfd_results',
      { caseId: 'c1', resultsHash: hash },
      { ...defaultContext(), cfdResults: port },
    ).document;
    expect(doc.cfd?.results['c1']?.resultsHash).toBe(hash);
    const built = probe(doc, port);
    expect(refusalCode(built)).toBe('CFD_RESULT_MISSING');
    expect(!built.ok && built.message).toContain('no field file');
  });

  it('refuses a stale result: the body moved or the case changed', () => {
    const moved = execute(recorded.doc, 'move_entities', { ids: [recorded.ballId], delta: [0.2, 0, 0] }, defaultContext()).document;
    const stale = probe(moved);
    expect(refusalCode(stale)).toBe('CFD_RESULT_STALE');
    expect(!stale.ok && stale.message).toContain('flow surface changed');
    const updated = execute(recorded.doc, 'update_cfd_case', { caseId: 'c1', freestream: { speedMS: 3 } }).document;
    expect(refusalCode(probe(updated))).toBe('CFD_RESULT_STALE');
  });

  it('turns world points into the case frame through the job frame of a rotated case', () => {
    const turned = recordedSphere({ flowAxis: [0, 1, 0] });
    const built = flowQueryInput(turned.doc, request('probe', { points: [[0, 1, 0]] }), turned.port, null);
    if (!built.ok) throw new Error(built.message);
    expect(built.job['frame']).toEqual({ x: [0, 1, 0], y: [-1, 0, 0], z: [0, 0, 1] });
  });
});

describe('slice and streamline jobs', () => {
  it('fills the slice defaults from the grid and names them', () => {
    const built = input('slice', { origin: [0, 0, 0], normal: [0, 1, 0] });
    expect(built.job['slice']).toEqual({
      originM: [0, 0, 0],
      normal: [0, 1, 0],
      field: 'speed',
      spacingM: 0.125,
      extentM: 2.5,
      dynamicPressurePa: 2,
    });
    expect(built.defaults.map((entry) => entry.path)).toEqual(['field', 'spacingM', 'extentM']);
    const given = input('slice', { origin: [0, 0, 0], normal: [0, 1, 0], field: 'cp', spacingM: 0.1, extentM: 1 });
    expect(given.defaults).toEqual([]);
  });

  it('derives the streamline step, length and stagnation speed from the grid and the free stream', () => {
    const built = input('streamlines', { rake: { kind: 'line', start: [-0.9, -0.3, 0], end: [-0.9, 0.3, 0], count: 4 } });
    expect(built.job['streamlines']).toMatchObject({
      stepM: 0.0625,
      maxLengthM: 7.5,
      maxSteps: 120,
      minSpeedMS: 2e-4,
      toleranceM: 0.03125,
      direction: 'both',
      device: 'auto',
    });
    expect(built.seeds).toHaveLength(4);
    const capped = input('streamlines', { rake: { kind: 'points', points: [[0, 0, 0]] }, stepM: 0.0001, maxLengthM: 100 });
    expect(capped.job['streamlines']).toMatchObject({ maxSteps: 20_000 });
    const tooLong = flowQueryInput(
      recorded.doc,
      request('streamlines', { rake: { kind: 'points', points: [[0, 0, 0]] }, stepM: 1 }),
      recorded.port,
      null,
    );
    expect(tooLong).toMatchObject({ ok: false, code: 'CFD_PARAM_INVALID' });
    const overCap = flowQueryInput(
      recorded.doc,
      request('streamlines', { rake: { kind: 'plane', centre: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], nu: 100, nv: 100 } }),
      recorded.port,
      null,
    );
    expect(overCap).toMatchObject({ ok: false, code: 'CFD_PARAM_INVALID' });
  });
});

function llst(lines: number, points: number): Uint8Array {
  const bytes = new Uint8Array(16 + 4 * (lines + 1) + 16 * points);
  bytes.set([76, 76, 83, 84]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, lines, true);
  view.setUint32(12, points, true);
  return bytes;
}

function llsl(samples: number): Uint8Array {
  const bytes = new Uint8Array(72 + 4 * samples * samples);
  bytes.set([76, 76, 83, 76]);
  new DataView(bytes.buffer).setUint32(8, samples, true);
  return bytes;
}

describe('answers and reports', () => {
  const probeAnswer = {
    probes: [
      { pointM: [1, 0, 0], velocityMS: [1.6, 0, 0], speedMS: 1.6, pressurePa: -0.5, miss: null },
      { pointM: [0, 0, 0], velocityMS: null, speedMS: null, pressurePa: null, miss: 'solid' },
      { pointM: [9, 0, 0], velocityMS: null, speedMS: null, pressurePa: null, miss: 'outside' },
    ],
  };

  it('reports probes with cp and the speed ratio to the free stream, and counts the misses', () => {
    const answered = parseFlowQueryAnswer('probe', JSON.stringify(probeAnswer), new Uint8Array());
    if (typeof answered === 'string') throw new Error(answered);
    const report = flowQueryReport(input('probe', { points: [[1, 0, 0]] }), answered, null);
    const probes = report.data['probes'] as Array<{ cp: number | null; speedRatio: number | null }>;
    expect(probes[0]).toMatchObject({ cp: -0.25, speedRatio: 0.8 });
    expect(probes[1]).toMatchObject({ cp: null, speedRatio: null });
    expect(report.summary).toContain('3 points — 1 in the fluid');
    expect(report.summary).toContain('1 in a body, 1 outside the domain');
    expect(report.summary).toContain(recorded.hash.slice(0, 12));
  });

  it('checks the slice file against query.json and reports the range and the stored file', () => {
    const slice = {
      slice: {
        file: 'slice.bin',
        field: 'speed',
        samples: 3,
        spacingM: 0.5,
        originM: [0, 0, 0],
        axisU: [1, 0, 0],
        axisV: [0, 0, 1],
        validSamples: 7,
        min: 0.1,
        max: 2.2,
      },
    };
    expect(parseFlowQueryAnswer('slice', JSON.stringify(slice), llsl(4))).toContain('3 x 3');
    const answered = parseFlowQueryAnswer('slice', JSON.stringify(slice), llsl(3));
    if (typeof answered === 'string') throw new Error(answered);
    const report = flowQueryReport(input('slice', { origin: [0, 0, 0], normal: [0, 1, 0] }), answered, {
      sha256: 'b'.repeat(64),
      bytes: 108,
    });
    expect(report.summary).toContain('speed on a 3 x 3 patch');
    expect(report.summary).toContain('7 samples in the fluid, 0.1..2.2 m/s');
    expect(report.data['file']).toEqual({ sha256: 'b'.repeat(64), bytes: 108, format: 'LLSL' });
    expect((report.data['slice'] as Record<string, unknown>)['file']).toBeUndefined();
  });

  it('checks the streamline file counts and reports the stop reasons', () => {
    const lines = {
      streamlines: {
        file: 'streamlines.bin',
        device: 'cpu',
        deterministic: true,
        precision: 'f64',
        points: 5,
        lines: [
          { seed: 0, points: 5, lengthM: 3.5, stopBackward: 'left_domain', stopForward: 'wall' },
          { seed: 1, points: 0, lengthM: 0, stopBackward: 'wall', stopForward: 'wall' },
        ],
      },
    };
    expect(parseFlowQueryAnswer('streamlines', JSON.stringify(lines), llst(2, 4))).toContain('2 lines and 5 points');
    const miscounted = { streamlines: { ...lines.streamlines, points: 6 } };
    expect(parseFlowQueryAnswer('streamlines', JSON.stringify(miscounted), llst(2, 6))).toContain('its lines 5');
    const answered = parseFlowQueryAnswer('streamlines', JSON.stringify(lines), llst(2, 5));
    if (typeof answered === 'string') throw new Error(answered);
    const built = input('streamlines', {
      rake: {
        kind: 'points',
        points: [
          [-0.9, 0, 0],
          [0, 0, 0],
        ],
      },
    });
    const report = flowQueryReport(built, answered, { sha256: 'c'.repeat(64), bytes: 108 });
    expect(report.data['stopCounts']).toEqual({ left_domain: 1, wall: 3 });
    expect(report.summary).toContain('2 seeds -> 1 lines, 5 points');
    expect(report.summary).toContain('cpu f64, deterministic');
    const gpu = parseFlowQueryAnswer(
      'streamlines',
      JSON.stringify({
        streamlines: { ...lines.streamlines, device: 'gpu', adapter: 'RTX (Vulkan)', deterministic: false, precision: 'f32' },
      }),
      llst(2, 5),
    );
    if (typeof gpu === 'string') throw new Error(gpu);
    expect(flowQueryReport(built, gpu, null).summary).toContain('on gpu RTX (Vulkan) f32');
  });

  it('rejects malformed query.json', () => {
    expect(parseFlowQueryAnswer('probe', '{', new Uint8Array())).toBe('query.json is not JSON');
    expect(parseFlowQueryAnswer('probe', '{"probes":[{"pointM":[0,0]}]}', new Uint8Array())).toContain('probes.0');
    expect(parseFlowQueryAnswer('slice', '{}', new Uint8Array())).toContain('slice');
    expect(parseFlowQueryAnswer('streamlines', '{}', new Uint8Array())).toContain('streamlines');
  });
});

describe('field header', () => {
  function header(nx: number, ny: number, nz: number, mirrors: number, extra = 0): Uint8Array {
    const bytes = new Uint8Array(56 + 16 * mirrors + 17 * nx * ny * nz + extra);
    bytes.set([76, 76, 70, 68]);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 1, true);
    [nx, ny, nz].forEach((n, k) => view.setUint32(8 + 4 * k, n, true));
    view.setFloat64(20, 0.125, true);
    [-1, -0.75, 0].forEach((o, k) => view.setFloat64(28 + 8 * k, o, true));
    view.setUint32(52, mirrors, true);
    return bytes;
  }

  it('reads the grid of a field file and refuses a damaged one', () => {
    expect(flowFieldHeader(header(2, 3, 4, 1))).toEqual({ nx: 2, ny: 3, nz: 4, cellM: 0.125, originM: [-1, -0.75, 0], mirrors: 1 });
    expect(flowFieldHeader(header(2, 3, 4, 0, 1))).toContain('declares');
    expect(flowFieldHeader(new Uint8Array(10))).toContain('LLFD');
    const wrongVersion = header(2, 2, 2, 0);
    new DataView(wrongVersion.buffer).setUint32(4, 2, true);
    expect(flowFieldHeader(wrongVersion)).toContain('version 2');
  });
});

describe('protocol schemas', () => {
  it('publishes exactly the plugin schemas of the three queries', () => {
    const tools = new Map(buildNativeToolDefinitions().map((tool) => [tool.name, tool]));
    expect(tools.get('cfd_probe')?.inputSchema).toEqual(toParamsSchema(cfdProbeParams));
    expect(tools.get('cfd_slice')?.inputSchema).toEqual(toParamsSchema(cfdSliceParams));
    expect(tools.get('cfd_streamlines')?.inputSchema).toEqual(toParamsSchema(cfdStreamlinesParams));
    expect(tools.get('cfd_stop')?.inputSchema.required).toEqual(['caseId']);
  });
});
