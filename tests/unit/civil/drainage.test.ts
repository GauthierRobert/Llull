import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { manningFullFlow, partialFlowDischarge, rationalFlowLps, solvePartialFlow } from '@aec/civil/drainage/hydraulics';
import { expectNoOp } from '../../helpers/expectNoOp';
import { DEFAULT_CRITERIA, intensityAt } from '@aec/civil/drainage/drainageCriteria';
import { civilErrors } from '@aec/civil/validate';

function run(doc: CadDocument, name: string, params: Record<string, unknown> = {}): ReturnType<typeof execute> {
  return execute(doc, name, params);
}

function network(catchments = true): CadDocument {
  let doc = run(createEmptyDocument(), 'set_units', { units: 'm' }).document;
  const manholes: Array<Record<string, unknown>> = [
    { location: [0, 0], invertElevation: 98, rimElevation: 100, ...(catchments ? { catchmentAreaHa: 1 } : {}) },
    {
      location: [50, 0],
      invertElevation: 97.5,
      rimElevation: 100,
      ...(catchments ? { catchmentAreaHa: 0.5, runoffCoefficient: 0.6 } : {}),
    },
    { location: [100, 0], invertElevation: 97, rimElevation: 100, ...(catchments ? { inflowLps: 5 } : {}) },
  ];
  for (const params of manholes) doc = run(doc, 'add_manhole', params).document;
  doc = run(doc, 'add_pipe', { fromId: 'manhole-1', toId: 'manhole-2' }).document;
  doc = run(doc, 'add_pipe', { fromId: 'manhole-2', toId: 'manhole-3' }).document;
  return doc;
}

describe('hydraulics', () => {
  it('matches the Manning hand calculation for a 300 mm pipe at 1 %', () => {
    // A = pi 0.3^2 / 4, R = 0.075, Q = A R^(2/3) S^(1/2) / n
    expect(manningFullFlow(0.3, 0.01, 0.013)).toBeCloseTo(0.0969, 3);
    expect(manningFullFlow(0.3, -0.01, 0.013)).toBe(0);
  });
  it('solves partial flow monotonically and consistently', () => {
    const full = manningFullFlow(0.3, 0.01, 0.013);
    let previous = 0;
    for (const fraction of [0.05, 0.2, 0.5, 0.8, 1]) {
      const flow = solvePartialFlow(0.3, 0.01, 0.013, full * fraction);
      expect(flow.depthRatio).toBeGreaterThan(previous);
      expect(partialFlowDischarge(0.3, 0.01, 0.013, flow.depthRatio)).toBeCloseTo(full * fraction, 6);
      previous = flow.depthRatio;
    }
    expect(solvePartialFlow(0.3, 0.01, 0.013, full * 0.5).depthRatio).toBeCloseTo(0.5, 1);
    expect(solvePartialFlow(0.3, 0.01, 0.013, full * 2).surcharged).toBe(true);
    expect(solvePartialFlow(0.3, 0, 0.013, 0.01).surcharged).toBe(true);
    expect(solvePartialFlow(0.3, 0.01, 0.013, 0).depthRatio).toBe(0);
  });
  it('applies the rational method', () => {
    expect(rationalFlowLps(0.9, 50, 1)).toBeCloseTo(125, 6);
  });
});

describe('drainage commands', () => {
  it('builds manholes and pipes with generated geometry', () => {
    const doc = network();
    expect(doc.civil?.order).toEqual(['manhole-1', 'manhole-2', 'manhole-3', 'pipe-1', 'pipe-2']);
    const pipe = doc.civil?.objects['pipe-1'];
    expect(pipe?.entityIds).toEqual(['pipe-1:body', 'pipe-1:plan', 'pipe-1:label']);
    const label = doc.entities['pipe-1:label'];
    expect(label?.kind === 'text' && label.content).toBe('Ø300 PVC 1.00 %');
    expect(doc.entities['manhole-1:body']?.kind).toBe('mesh');
    expect(doc.layers['layer-C-STRM-PIPE']).toBeDefined();
  });
  it('takes the rim from a surface and refuses bad manholes', () => {
    let doc = run(createEmptyDocument(), 'set_units', { units: 'm' }).document;
    expect(run(doc, 'add_manhole', { location: [0, 0], invertElevation: 1 }).affected).toEqual([]);
    expect(run(doc, 'add_manhole', { location: [0, 0], invertElevation: 1, surfaceId: 'surface-9' }).affected).toEqual([]);
    const bad = run(doc, 'add_manhole', { location: [0, 0], invertElevation: 5, rimElevation: 4 });
    expect(bad.document).toBe(doc);
    expect(bad.summary).toContain('must be above');
    expect(run(doc, 'add_manhole', { location: [0, 0], invertElevation: 1, rimElevation: 3, runoffCoefficient: 2 }).affected).toEqual([]);
    doc = run(doc, 'import_survey_points', {
      points: [
        { x: 0, y: 0, z: 10 },
        { x: 20, y: 0, z: 10 },
        { x: 0, y: 20, z: 10 },
        { x: 20, y: 20, z: 10 },
      ],
    }).document;
    doc = run(doc, 'create_surface', {}).document;
    const added = run(doc, 'add_manhole', { location: [10, 10], invertElevation: 7, surfaceId: 'surface-1' });
    expect(added.document.civil?.objects['manhole-1']).toMatchObject({ rimElevation: 10 });
    const outside = run(doc, 'add_manhole', { location: [500, 500], invertElevation: 7, surfaceId: 'surface-1' });
    expect(outside.summary).toContain('outside');
  });
  it('refuses self-loops, unknown ends, duplicates, cycles and coincident ends', () => {
    const doc = network();
    const refused = (params: Record<string, unknown>): string => {
      const result = run(doc, 'add_pipe', params);
      expectNoOp(result, doc);
      return result.summary;
    };
    expect(refused({ fromId: 'manhole-1', toId: 'manhole-1' })).toContain('itself');
    expect(refused({ fromId: 'manhole-1', toId: 'nope' })).toContain('not a manhole');
    expect(refused({ fromId: 'pipe-1', toId: 'manhole-1' })).toContain('not a manhole');
    expect(refused({ fromId: 'manhole-1', toId: 'manhole-2' })).toContain('already');
    expect(refused({ fromId: 'manhole-3', toId: 'manhole-1' })).toContain('loop');
    expect(refused({ fromId: 'manhole-1', toId: 'manhole-3', diameter: -1 })).toContain('diameter');
    const twin = run(doc, 'add_manhole', { location: [0, 0], invertElevation: 90, rimElevation: 95 }).document;
    expect(run(twin, 'add_pipe', { fromId: 'manhole-1', toId: 'manhole-4' }).summary).toContain('same plan');
  });
  it('warns on adverse slope', () => {
    const doc = network();
    const result = run(doc, 'add_pipe', { fromId: 'manhole-1', toId: 'manhole-3', invertFrom: 96, invertTo: 97 });
    expect(result.summary).toContain('adverse');
    expect(result.affected).toContain('pipe-3');
  });
  it('updates pipes and manholes, keeping connections', () => {
    const doc = network();
    const pipe = run(doc, 'update_pipe', { pipeId: 'pipe-1', diameter: 0.45, material: 'Concrete', name: 'Main' });
    expect(pipe.document.civil?.objects['pipe-1']).toMatchObject({ diameter: 0.45, material: 'Concrete', name: 'Main' });
    expect(run(doc, 'update_pipe', { pipeId: 'pipe-1' }).affected).toEqual([]);
    expect(run(doc, 'update_pipe', { pipeId: 'pipe-9', diameter: 1 }).summary).toContain('no pipe');
    expect(run(doc, 'update_pipe', { pipeId: 'pipe-1', manningN: 0 }).affected).toEqual([]);
    expect(run(doc, 'update_pipe', { pipeId: 'pipe-1', invertTo: 99 }).summary).toContain('adverse');
    const raised = run(doc, 'update_manhole', {
      manholeId: 'manhole-2',
      invertElevation: 97.8,
      catchmentAreaHa: 0,
      inflowLps: 0,
      name: 'Junction',
    });
    expect(raised.summary).toContain('pipe-2');
    expect(raised.summary).toContain('Warning');
    const manhole = raised.document.civil?.objects['manhole-2'];
    expect(manhole).toMatchObject({ name: 'Junction', invertElevation: 97.8 });
    expect(manhole && 'catchment' in manhole).toBe(false);
    expect(run(doc, 'update_manhole', { manholeId: 'manhole-2' }).affected).toEqual([]);
    expect(run(doc, 'update_manhole', { manholeId: 'x', name: 'a' }).summary).toContain('no manhole');
    expect(run(doc, 'update_manhole', { manholeId: 'manhole-2', rimElevation: 90 }).summary).toContain('must be above');
    expect(run(doc, 'update_manhole', { manholeId: 'manhole-2', diameter: 0 }).affected).toEqual([]);
    expect(run(doc, 'update_manhole', { manholeId: 'manhole-2', surfaceId: 's' }).summary).toContain('no surface');
    const moved = run(doc, 'update_manhole', { manholeId: 'manhole-2', location: [60, 10], runoffCoefficient: 0.5 });
    expect(moved.document.civil?.objects['manhole-2']).toMatchObject({ position: [60, 10] });
    expect(run(doc, 'update_manhole', { manholeId: 'manhole-2', location: [0, 0] }).summary).toContain('zero-length');
  });
  it('cascades deletion from a manhole to its pipes', () => {
    const doc = network();
    const result = run(doc, 'delete_civil_object', { id: 'manhole-2', cascade: true });
    expect(result.document.civil?.order).toEqual(['manhole-1', 'manhole-3']);
    expect(result.document.entities['pipe-1:body']).toBeUndefined();
  });
  it('refuses to delete generated entities and survives a save/load round trip', () => {
    const doc = network();
    const refused = run(doc, 'delete_entities', { ids: ['manhole-1:body'] });
    expect(refused.document.entities['manhole-1:body']).toBeDefined();
    expect(refused.affected).toEqual([]);
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(Object.keys(loaded.entities).sort()).toEqual(Object.keys(doc.entities).sort());
    expect(loaded.civil?.objects['pipe-2']).toMatchObject({ fromId: 'manhole-2', toId: 'manhole-3' });
  });
  it('is pure', () => {
    const doc = network();
    const before = JSON.stringify(doc);
    for (const [name, params] of [
      ['add_manhole', { location: [5, 5], invertElevation: 90, rimElevation: 99 }],
      ['add_pipe', { fromId: 'manhole-1', toId: 'manhole-3' }],
      ['update_pipe', { pipeId: 'pipe-1', diameter: 0.6 }],
      ['update_manhole', { manholeId: 'manhole-1', invertElevation: 97 }],
      ['check_drainage_network', {}],
      ['drainage_schedule', {}],
      ['size_drainage_pipes', {}],
    ] as const) {
      run(doc, name, params);
      expect(JSON.stringify(doc)).toBe(before);
    }
  });
});

describe('drainage analysis', () => {
  it('accumulates rational flows downstream and checks the pipes', () => {
    const doc = network();
    const result = run(doc, 'check_drainage_network', {});
    const data = result.data as {
      pipes: Array<Record<string, number | string | string[]>>;
      manholes: unknown[];
      failures: string[];
      csv: string;
    };
    const [first, second] = data.pipes;
    expect(first?.designLps).toBeCloseTo(125, 1);
    // 125 + 0.6 * 50 * 0.5 / 360 * 1000 (= 41.67) + 5 point inflow joins at manhole-3 only
    expect(second?.designLps).toBeCloseTo(125 + 41.67, 1);
    expect(first?.slopePct).toBe(1);
    expect(first?.fullLps).toBeCloseTo(96.9, 0);
    expect(first?.status).toBe('fail');
    expect(first?.reasons).toContain('capacity exceeded (surcharged)');
    expect(data.failures.length).toBeGreaterThan(0);
    expect(data.csv.split('\n')).toHaveLength(3);
    expect(result.summary).toContain('2 pipes');
    expect(result.affected).toEqual([]);
  });
  it('passes a lightly loaded network and reports depth ratio, velocity and cover', () => {
    const doc = run(network(), 'update_manhole', { manholeId: 'manhole-1', catchmentAreaHa: 0.2 }).document;
    const cleared = run(doc, 'update_manhole', { manholeId: 'manhole-2', catchmentAreaHa: 0, inflowLps: 0 }).document;
    const data = run(cleared, 'check_drainage_network', { minCoverM: 0.5 }).data as {
      pipes: Array<{ status: string; depthRatio: number; velocity: number; coverFromM: number; reasons: string[] }>;
      manholes: Array<{ dropM: number | null; depthM: number }>;
      failures: string[];
    };
    expect(data.pipes[0]).toMatchObject({ status: 'pass', coverFromM: 1.7 });
    expect(data.pipes[0]?.depthRatio).toBeGreaterThan(0.1);
    expect(data.pipes[0]?.velocity).toBeGreaterThan(0.6);
    expect(data.manholes[1]?.dropM).toBe(0);
    expect(data.manholes[0]?.depthM).toBe(2);
  });
  it('flags insufficient cover, velocity and adverse slope', () => {
    let doc = network();
    const shallow = run(doc, 'check_drainage_network', { minCoverM: 5 }).data as { pipes: Array<{ reasons: string[] }> };
    expect(shallow.pipes[0]?.reasons.join()).toContain('upstream cover');
    expect(shallow.pipes[0]?.reasons.join()).toContain('downstream cover');
    const fast = run(doc, 'check_drainage_network', { maxVelocity: 0.1, minVelocity: 0, rainfallIntensityMmH: 1 }).data as {
      pipes: Array<{ reasons: string[] }>;
    };
    expect(fast.pipes[0]?.reasons.join()).toContain('velocity');
    const slow = run(doc, 'check_drainage_network', { minVelocity: 5, maxVelocity: 9, rainfallIntensityMmH: 1 }).data as {
      pipes: Array<{ reasons: string[] }>;
    };
    expect(slow.pipes[0]?.reasons.join()).toContain('< 5');
    doc = run(doc, 'update_pipe', { pipeId: 'pipe-1', invertTo: 99 }).document;
    doc = run(doc, 'update_pipe', { pipeId: 'pipe-2', invertFrom: 99.5 }).document;
    const adverse = run(doc, 'check_drainage_network', {}).data as {
      pipes: Array<{ reasons: string[] }>;
      manholes: Array<{ reasons: string[] }>;
    };
    expect(adverse.pipes[0]?.reasons).toContain('adverse or zero slope');
    expect(adverse.manholes[1]?.reasons.join()).toContain('above incoming');
  });
  it('rejects bad criteria and empty networks', () => {
    const doc = network();
    expect(run(doc, 'check_drainage_network', { rainfallIntensityMmH: 0 }).summary).toContain('failed');
    expect(run(doc, 'check_drainage_network', { maxDepthRatio: 2 }).affected).toEqual([]);
    expect(run(doc, 'check_drainage_network', { minVelocity: 5, maxVelocity: 1 }).affected).toEqual([]);
    const empty = run(createEmptyDocument(), 'check_drainage_network', {});
    expect(empty.summary).toContain('no drainage pipes');
    expect(run(createEmptyDocument(), 'drainage_schedule', {}).summary).toContain('no manholes');
    expect(run(createEmptyDocument(), 'size_drainage_pipes', {}).summary).toContain('no pipes');
    expect(run(doc, 'size_drainage_pipes', { diameters: [0] }).affected).toEqual([]);
    expect(run(doc, 'size_drainage_pipes', { diameters: [] }).affected).toEqual([]);
  });
  it('writes manhole and pipe schedules', () => {
    const data = run(network(), 'drainage_schedule', {}).data as { manholeCsv: string; pipeCsv: string; csv: string };
    expect(data.manholeCsv.split('\n')[1]).toBe('manhole-1,MH1,0,0,100,98,2,1200');
    expect(data.pipeCsv.split('\n')[1]).toBe('pipe-1,P1,manhole-1,manhole-2,300,PVC,50,1,98,97.5');
    expect(data.csv).toContain('\n\n');
  });
  it('sizes pipes to the smallest passing commercial diameter', () => {
    const doc = network();
    const sized = run(doc, 'size_drainage_pipes', {});
    expect(sized.affected).toContain('pipe-1');
    const after = run(sized.document, 'check_drainage_network', {}).data as {
      pipes: Array<{ diameterMm: number; status: string; reasons: string[] }>;
    };
    expect(after.pipes[0]?.diameterMm).toBe(375);
    expect(after.pipes.every((p) => !p.reasons.some((r) => r.includes('depth') || r.includes('capacity')))).toBe(true);
    expect(sized.summary).toContain('Resized');
    const again = run(sized.document, 'size_drainage_pipes', {});
    expect(again.summary).toContain('no diameter change');
    const limited = run(doc, 'size_drainage_pipes', { diameters: [150], minVelocity: 0.1 });
    expect(limited.summary).toContain('Cannot size');
    const adverse = run(doc, 'update_pipe', { pipeId: 'pipe-1', invertTo: 99 }).document;
    expect(run(adverse, 'size_drainage_pipes', {}).summary).toContain('pipe-1');
  });
});

interface PipeData {
  id: string;
  tcMin: number;
  intensityMmH: number;
  sumCAHa: number;
  designLps: number;
  velocity: number;
  lengthM: number;
  hglUpM: number;
  hglDownM: number;
  surcharged: boolean;
  flooding: boolean;
  reasons: string[];
}
interface CheckData {
  pipes: PipeData[];
  manholes: Array<{ id: string; hglM: number; flooding: boolean; reasons: string[] }>;
  diverging: string[];
  csv: string;
}

const check = (doc: CadDocument, params: Record<string, unknown> = {}): CheckData =>
  run(doc, 'check_drainage_network', params).data as CheckData;

/** Full-bore capacity (m^3/s) of the 300 mm / 1 % / n 0.013 pipes used below. */
const FULL = manningFullFlow(0.3, 0.01, 0.013);
const FULL_AREA = (Math.PI * 0.3 * 0.3) / 4;

function build(manholes: Array<Record<string, unknown>>, pipes: Array<Record<string, unknown>>): CadDocument {
  let doc = run(createEmptyDocument(), 'set_units', { units: 'm' }).document;
  for (const params of manholes) doc = run(doc, 'add_manhole', params).document;
  for (const params of pipes) doc = run(doc, 'add_pipe', params).document;
  return doc;
}

/** MH1..MH4 in a row, 50 m apart, pipes 300 mm at 1 %. `first` extends manhole-1. */
function chain(first: Record<string, unknown> = {}): CadDocument {
  const manholes = [0, 1, 2, 3].map((k) => ({
    location: [k * 50, 0],
    invertElevation: 98 - 0.5 * k,
    rimElevation: 100,
    ...(k === 0 ? first : {}),
  }));
  return build(
    manholes,
    [1, 2, 3].map((k) => ({ fromId: `manhole-${k}`, toId: `manhole-${k + 1}` })),
  );
}

describe('IDF and time of concentration', () => {
  it('evaluates i = a / (t + b)^c', () => {
    const criteria = { ...DEFAULT_CRITERIA, idf: { a: 1000, b: 10, c: 0.8 } };
    expect(intensityAt(criteria, 20)).toBeCloseTo(1000 / 30 ** 0.8, 9);
    expect(intensityAt(DEFAULT_CRITERIA, 20)).toBe(50);
    const rows = check(chain({ catchmentAreaHa: 1, runoffCoefficient: 0.9 }), { idf: { a: 1000, b: 10, c: 0.8 } }).pipes;
    expect(rows[0]?.intensityMmH).toBeCloseTo(1000 / 15 ** 0.8, 2);
    expect(rows[0]?.sumCAHa).toBeCloseTo(0.9, 4);
    expect(rows[0]?.designLps).toBeCloseTo(((0.9 * 1000) / 15 ** 0.8 / 360) * 1000, 1);
  });
  it('accumulates entry time and travel time along a 3-pipe chain', () => {
    // inflow = half the full-bore capacity => depth ratio 0.5 => v equals the full-bore velocity
    const rows = check(chain({ inflowLps: (FULL / 2) * 1000 })).pipes;
    const travelMin = 50 / (FULL / FULL_AREA) / 60;
    expect(travelMin).toBeCloseTo(0.6091, 3);
    expect(rows.map((r) => r.tcMin)).toEqual([5, expect.closeTo(5 + travelMin, 1), expect.closeTo(5 + 2 * travelMin, 1)]);
    expect(rows[0]?.velocity).toBeCloseTo(FULL / FULL_AREA, 2);
  });
  it('takes the maximum over upstream paths using each manhole entry time', () => {
    const doc = build(
      [
        { location: [0, 0], invertElevation: 98, rimElevation: 100, inflowLps: 5 },
        { location: [50, 0], invertElevation: 97.5, rimElevation: 100 },
        { location: [50, 50], invertElevation: 98, rimElevation: 100, inflowLps: 5, entryTimeMin: 20 },
        { location: [100, 0], invertElevation: 97, rimElevation: 100 },
      ],
      [
        { fromId: 'manhole-1', toId: 'manhole-2' },
        { fromId: 'manhole-3', toId: 'manhole-2' },
        { fromId: 'manhole-2', toId: 'manhole-4' },
      ],
    );
    const rows = check(doc).pipes;
    const slow = rows.find((r) => r.id === 'pipe-2');
    expect(slow?.tcMin).toBe(20);
    const outlet = rows.find((r) => r.id === 'pipe-3');
    const expected = 20 + (slow ? slow.lengthM / slow.velocity / 60 : 0);
    expect(outlet?.tcMin).toBeCloseTo(expected, 1);
    expect(outlet?.designLps).toBeCloseTo(10, 1);
  });
  it('warns when a larger outgoing pipe is invert-matched, leaving its crown above the incoming crown', () => {
    const manholes = [0, 1, 2].map((k) => ({
      location: [k * 50, 0],
      invertElevation: 98 - 0.5 * k,
      rimElevation: 100,
      ...(k === 0 ? { inflowLps: 20 } : k === 1 ? { inflowLps: 150 } : {}),
    }));
    const doc = build(
      manholes,
      [1, 2].map((k) => ({ fromId: `manhole-${k}`, toId: `manhole-${k + 1}` })),
    );
    const sized = run(doc, 'size_drainage_pipes', {});
    const data = sized.data as { crownWarnings: string[] };
    const diameter = (id: string): number => (sized.document.civil?.objects[id] as { diameter: number }).diameter;
    expect(diameter('pipe-2')).toBeGreaterThan(diameter('pipe-1'));
    expect(data.crownWarnings).toHaveLength(1);
    expect(data.crownWarnings[0]).toContain('pipe-2');
    expect(sized.summary).toContain('WARNING');
    expect(sized.summary).toContain('crown');
    const uniform = run(chain({ inflowLps: 20 }), 'size_drainage_pipes', {});
    expect((uniform.data as { crownWarnings: string[] } | undefined)?.crownWarnings ?? []).toEqual([]);
  });
  it('iterates sizing and velocities to convergence', () => {
    const doc = chain({ catchmentAreaHa: 2, runoffCoefficient: 0.9 });
    const sized = run(doc, 'size_drainage_pipes', { idf: { a: 1500, b: 8, c: 0.85 } });
    const data = sized.data as { iterations: number; converged: boolean };
    expect(data.converged).toBe(true);
    expect(data.iterations).toBeGreaterThanOrEqual(1);
    expect(data.iterations).toBeLessThanOrEqual(10);
    expect(sized.summary).toContain('IDF');
    const again = run(sized.document, 'size_drainage_pipes', { idf: { a: 1500, b: 8, c: 0.85 } });
    expect(again.summary).toContain('no diameter change');
    const rows = check(sized.document, { idf: { a: 1500, b: 8, c: 0.85 } }).pipes;
    expect(rows.every((r) => !r.reasons.some((x) => x.includes('depth')))).toBe(true);
    expect(rows[2]?.tcMin).toBeGreaterThan(rows[0]?.tcMin ?? 0);
  });
  it('keeps entryTimeMin through updates and validates it', () => {
    const doc = chain({ catchmentAreaHa: 1, entryTimeMin: 12 });
    expect(doc.civil?.objects['manhole-1']).toMatchObject({ entryTimeMin: 12 });
    const renamed = run(doc, 'update_manhole', { manholeId: 'manhole-1', name: 'Head' }).document;
    expect(renamed.civil?.objects['manhole-1']).toMatchObject({ entryTimeMin: 12, name: 'Head' });
    expect(check(doc).pipes[0]?.tcMin).toBe(12);
    const retimed = run(doc, 'update_manhole', { manholeId: 'manhole-1', entryTimeMin: 8 });
    expect(retimed.document.civil?.objects['manhole-1']).toMatchObject({ entryTimeMin: 8 });
    expect(run(doc, 'update_manhole', { manholeId: 'manhole-1', entryTimeMin: 0 }).affected).toEqual([]);
    expect(
      run(createEmptyDocument(), 'add_manhole', { location: [0, 0], invertElevation: 1, rimElevation: 3, entryTimeMin: -1 }).summary,
    ).toContain('entryTimeMin');
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.civil?.objects['manhole-1']).toMatchObject({ entryTimeMin: 12 });
    const raw = JSON.parse(JSON.stringify(doc.civil)) as { objects: Record<string, Record<string, unknown>> };
    expect(civilErrors(raw)).toEqual([]);
    const target = raw.objects['manhole-1'];
    if (target) target['entryTimeMin'] = -3;
    expect(civilErrors(raw).join()).toContain('entryTimeMin');
  });
});

function diverging(): CadDocument {
  return build(
    [
      { location: [0, 0], invertElevation: 98, rimElevation: 100, catchmentAreaHa: 1 },
      { location: [50, 0], invertElevation: 97.5, rimElevation: 100 },
      { location: [100, 0], invertElevation: 97, rimElevation: 100 },
      { location: [50, 50], invertElevation: 97, rimElevation: 100 },
    ],
    [
      { fromId: 'manhole-1', toId: 'manhole-2' },
      { fromId: 'manhole-2', toId: 'manhole-3', diameter: 0.3 },
      { fromId: 'manhole-2', toId: 'manhole-4', diameter: 0.15 },
    ],
  );
}

describe('diverging networks', () => {
  it('splits flow by full-bore capacity share without double counting', () => {
    const result = run(diverging(), 'check_drainage_network', {});
    const data = result.data as CheckData;
    const inflow = data.pipes[0]?.designLps ?? 0;
    const [, big, small] = data.pipes;
    expect((big?.designLps ?? 0) + (small?.designLps ?? 0)).toBeCloseTo(inflow, 1);
    const share = 0.3 ** (8 / 3) / (0.3 ** (8 / 3) + 0.15 ** (8 / 3));
    expect(big?.designLps).toBeCloseTo(inflow * share, 1);
    expect(data.diverging).toEqual(['manhole-2']);
    expect(result.summary).toContain('Diverging at manhole-2');
    expect(big?.tcMin).toBe(small?.tcMin);
  });
  it('sizes both branches from their share', () => {
    const sized = run(diverging(), 'size_drainage_pipes', {});
    expect((sized.data as { converged: boolean }).converged).toBe(true);
    const rows = check(sized.document).pipes;
    expect((rows[1]?.designLps ?? 0) + (rows[2]?.designLps ?? 0)).toBeCloseTo(rows[0]?.designLps ?? 0, 1);
  });
});

function twoManholes(rim: number): CadDocument {
  return build(
    [
      { location: [0, 0], invertElevation: 98, rimElevation: rim, inflowLps: 193.4 },
      { location: [50, 0], invertElevation: 97.5, rimElevation: rim },
    ],
    [{ fromId: 'manhole-1', toId: 'manhole-2' }],
  );
}

describe('hydraulic grade line', () => {
  it('matches the hand calculation for a surcharged pipe', () => {
    // Q = 0.1934 m3/s in a 300 mm pipe: A = 0.070686, R = 0.075, Sf = (Q n / (A R^(2/3)))^2
    const q = 0.1934;
    const area = (Math.PI * 0.09) / 4;
    const sf = ((q * 0.013) / (area * 0.075 ** (2 / 3))) ** 2;
    expect(sf).toBeCloseTo(0.04, 3);
    const tailwater = 97.8;
    const loss = (0.5 * (q / area) ** 2) / (2 * 9.80665);
    const data = check(twoManholes(101), { outfallLevel: tailwater });
    const pipe = data.pipes[0];
    expect(pipe?.hglDownM).toBeCloseTo(tailwater, 3);
    expect(pipe?.hglUpM).toBeCloseTo(tailwater + sf * 50 + loss, 2);
    expect(pipe?.surcharged).toBe(true);
    expect(pipe?.flooding).toBe(false);
    expect(data.manholes[0]?.hglM).toBeCloseTo(tailwater + sf * 50 + loss, 2);
    expect(data.csv.split('\n')[0]).toContain('hgl_up_m,hgl_down_m,surcharged,flooding');
    const lossless = check(twoManholes(101), { outfallLevel: tailwater, manholeLossK: 0 });
    expect(lossless.pipes[0]?.hglUpM).toBeCloseTo(tailwater + sf * 50, 2);
  });
  it('flags flooding when the HGL exceeds rim minus freeboard', () => {
    const data = check(twoManholes(100), { outfallLevel: 97.8 });
    expect(data.pipes[0]?.flooding).toBe(true);
    expect(data.manholes[0]).toMatchObject({ flooding: true });
    expect(data.manholes[0]?.reasons.join()).toContain('flooding risk');
    expect(data.manholes[1]?.flooding).toBe(false);
    const relaxed = check(twoManholes(100), { outfallLevel: 97.8, freeboardM: 0 });
    expect(relaxed.pipes[0]?.flooding).toBe(false);
  });
  it('follows normal depth for free flow with the default tailwater', () => {
    const data = check(chain({ inflowLps: (FULL / 2) * 1000 }));
    expect(data.pipes[2]?.hglDownM).toBeCloseTo(96.5 + 0.15, 2);
    expect(data.pipes[0]?.hglUpM).toBeCloseTo(98 + 0.15, 2);
    expect(data.pipes.some((r) => r.surcharged || r.flooding)).toBe(false);
  });
  it('is raised by a high tailwater all the way up a chain', () => {
    const data = check(chain({ inflowLps: (FULL / 2) * 1000 }), { outfallLevel: 98.5 });
    expect(data.pipes[2]?.hglDownM).toBeCloseTo(98.5, 3);
    expect(data.pipes[0]?.hglUpM).toBeGreaterThan(98.5);
    expect(data.pipes.every((r) => r.surcharged)).toBe(true);
    expect(data.pipes[0]?.reasons).toContain('HGL above obvert (surcharged)');
  });
});

describe('export_drainage_long_section', () => {
  it('draws ground, pipes, HGL, labels and the table band', () => {
    const doc = chain({ inflowLps: (FULL / 2) * 1000 });
    const result = run(doc, 'export_drainage_long_section', { fromManholeId: 'manhole-1' });
    const data = result.data as { text: string; fileName: string; pipeIds: string[]; manholeIds: string[] };
    expect(data.text.startsWith('<svg')).toBe(true);
    for (const label of ['MH1', 'MH4', 'Chainage', 'Invert', 'HGL', 'Ø300', '150.00']) {
      expect(data.text).toContain(label);
    }
    expect(data.text).toContain('stroke="#1060d0"');
    expect(data.fileName).toBe('MH1_drainage_long_section.svg');
    expect(data.pipeIds).toEqual(['pipe-1', 'pipe-2', 'pipe-3']);
    expect(result.summary).toContain('3 pipe(s)');
    expect(result.affected).toEqual([]);
    const part = run(doc, 'export_drainage_long_section', { fromManholeId: 'manhole-2', toManholeId: 'manhole-3' }).data as {
      pipeIds: string[];
    };
    expect(part.pipeIds).toEqual(['pipe-2']);
  });
  it('prints a real scale, data.svg and a clean data band', () => {
    const data = run(chain({ inflowLps: (FULL / 2) * 1000 }), 'export_drainage_long_section', { fromManholeId: 'manhole-1' }).data as {
      svg: string;
      text: string;
    };
    expect(data.svg).toBe(data.text);
    expect(data.svg).toMatch(/Scale H 1:[1-9]\d* {2}V 1:[1-9]\d*;/);
    expect(data.svg).toMatch(/text-anchor="start"[^>]*>0\.00<\/text>/);
  });
  it('follows the largest pipe at a fork and flags flooding in red', () => {
    const forkRun = run(diverging(), 'export_drainage_long_section', { fromManholeId: 'manhole-1' }).data as { manholeIds: string[] };
    expect(forkRun.manholeIds).toEqual(['manhole-1', 'manhole-2', 'manhole-3']);
    const flooded = run(twoManholes(100), 'export_drainage_long_section', { fromManholeId: 'manhole-1', outfallLevel: 97.8 }).data as {
      text: string;
    };
    expect(flooded.text).toContain('#c00000');
  });
  it('refuses unknown manholes, missing runs and bad criteria', () => {
    const doc = chain();
    const refused = (params: Record<string, unknown>): string => {
      const result = run(doc, 'export_drainage_long_section', params);
      expectNoOp(result, doc);
      return result.summary;
    };
    expect(refused({ fromManholeId: 'nope' })).toContain('no manhole');
    expect(refused({ fromManholeId: 'manhole-1', toManholeId: 'nope' })).toContain('no manhole');
    expect(refused({ fromManholeId: 'manhole-4' })).toContain('no pipe run');
    expect(refused({ fromManholeId: 'manhole-3', toManholeId: 'manhole-1' })).toContain('no pipe run');
    expect(refused({ fromManholeId: 'manhole-1', freeboardM: -1 })).toContain('freeboardM');
  });
});

describe('criteria validation and purity', () => {
  it('rejects conflicting or invalid rainfall and HGL settings', () => {
    const doc = chain({ catchmentAreaHa: 1 });
    const idf = { a: 1000, b: 10, c: 0.8 };
    const refused = (params: Record<string, unknown>): string => {
      const result = run(doc, 'check_drainage_network', params);
      expectNoOp(result, doc);
      return result.summary;
    };
    expect(refused({ idf, rainfallIntensityMmH: 60 })).toContain('not both');
    expect(refused({ idf: { ...idf, a: 0 } })).toContain('idf needs');
    expect(refused({ idf: { ...idf, b: -1 } })).toContain('idf needs');
    expect(refused({ manholeLossK: -1 })).toContain('manholeLossK');
    expect(refused({ freeboardM: -0.1 })).toContain('freeboardM');
    expect(run(doc, 'size_drainage_pipes', { idf, rainfallIntensityMmH: 60 }).affected).toEqual([]);
  });
  it('is pure', () => {
    const doc = diverging();
    const before = JSON.stringify(doc);
    for (const [name, params] of [
      ['check_drainage_network', { idf: { a: 1000, b: 10, c: 0.8 }, outfallLevel: 98 }],
      ['size_drainage_pipes', { idf: { a: 1000, b: 10, c: 0.8 } }],
      ['export_drainage_long_section', { fromManholeId: 'manhole-1' }],
      ['update_manhole', { manholeId: 'manhole-1', entryTimeMin: 9 }],
    ] as const) {
      run(doc, name, params);
      expect(JSON.stringify(doc)).toBe(before);
    }
  });
});
