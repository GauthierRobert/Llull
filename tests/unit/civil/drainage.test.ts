import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import {
  manningFullFlow,
  partialFlowDischarge,
  rationalFlowLps,
  solvePartialFlow,
} from '@aec/civil/hydraulics';

function run(
  doc: CadDocument,
  name: string,
  params: Record<string, unknown> = {},
): ReturnType<typeof execute> {
  return execute(doc, name, params);
}

function network(catchments = true): CadDocument {
  let doc = run(createEmptyDocument(), 'set_units', { units: 'm' }).document;
  const manholes: Array<Record<string, unknown>> = [
    {
      location: [0, 0],
      invertElevation: 98,
      rimElevation: 100,
      ...(catchments ? { catchmentAreaHa: 1 } : {}),
    },
    {
      location: [50, 0],
      invertElevation: 97.5,
      rimElevation: 100,
      ...(catchments ? { catchmentAreaHa: 0.5, runoffCoefficient: 0.6 } : {}),
    },
    {
      location: [100, 0],
      invertElevation: 97,
      rimElevation: 100,
      ...(catchments ? { inflowLps: 5 } : {}),
    },
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
      expect(partialFlowDischarge(0.3, 0.01, 0.013, flow.depthRatio)).toBeCloseTo(
        full * fraction,
        6,
      );
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
    expect(
      run(doc, 'add_manhole', { location: [0, 0], invertElevation: 1, surfaceId: 'surface-9' })
        .affected,
    ).toEqual([]);
    const bad = run(doc, 'add_manhole', { location: [0, 0], invertElevation: 5, rimElevation: 4 });
    expect(bad.document).toBe(doc);
    expect(bad.summary).toContain('must be above');
    expect(
      run(doc, 'add_manhole', {
        location: [0, 0],
        invertElevation: 1,
        rimElevation: 3,
        runoffCoefficient: 2,
      }).affected,
    ).toEqual([]);
    doc = run(doc, 'import_survey_points', {
      points: [
        { x: 0, y: 0, z: 10 },
        { x: 20, y: 0, z: 10 },
        { x: 0, y: 20, z: 10 },
        { x: 20, y: 20, z: 10 },
      ],
    }).document;
    doc = run(doc, 'create_surface', {}).document;
    const added = run(doc, 'add_manhole', {
      location: [10, 10],
      invertElevation: 7,
      surfaceId: 'surface-1',
    });
    expect(added.document.civil?.objects['manhole-1']).toMatchObject({ rimElevation: 10 });
    const outside = run(doc, 'add_manhole', {
      location: [500, 500],
      invertElevation: 7,
      surfaceId: 'surface-1',
    });
    expect(outside.summary).toContain('outside');
  });

  it('refuses self-loops, unknown ends, duplicates, cycles and coincident ends', () => {
    const doc = network();
    const refused = (params: Record<string, unknown>): string => {
      const result = run(doc, 'add_pipe', params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      return result.summary;
    };
    expect(refused({ fromId: 'manhole-1', toId: 'manhole-1' })).toContain('itself');
    expect(refused({ fromId: 'manhole-1', toId: 'nope' })).toContain('not a manhole');
    expect(refused({ fromId: 'pipe-1', toId: 'manhole-1' })).toContain('not a manhole');
    expect(refused({ fromId: 'manhole-1', toId: 'manhole-2' })).toContain('already');
    expect(refused({ fromId: 'manhole-3', toId: 'manhole-1' })).toContain('loop');
    expect(refused({ fromId: 'manhole-1', toId: 'manhole-3', diameter: -1 })).toContain('diameter');
    const twin = run(doc, 'add_manhole', {
      location: [0, 0],
      invertElevation: 90,
      rimElevation: 95,
    }).document;
    expect(run(twin, 'add_pipe', { fromId: 'manhole-1', toId: 'manhole-4' }).summary).toContain(
      'same plan',
    );
  });

  it('warns on adverse slope', () => {
    const doc = network();
    const result = run(doc, 'add_pipe', {
      fromId: 'manhole-1',
      toId: 'manhole-3',
      invertFrom: 96,
      invertTo: 97,
    });
    expect(result.summary).toContain('adverse');
    expect(result.affected).toContain('pipe-3');
  });

  it('updates pipes and manholes, keeping connections', () => {
    const doc = network();
    const pipe = run(doc, 'update_pipe', {
      pipeId: 'pipe-1',
      diameter: 0.45,
      material: 'Concrete',
      name: 'Main',
    });
    expect(pipe.document.civil?.objects['pipe-1']).toMatchObject({
      diameter: 0.45,
      material: 'Concrete',
      name: 'Main',
    });
    expect(run(doc, 'update_pipe', { pipeId: 'pipe-1' }).affected).toEqual([]);
    expect(run(doc, 'update_pipe', { pipeId: 'pipe-9', diameter: 1 }).summary).toContain('no pipe');
    expect(run(doc, 'update_pipe', { pipeId: 'pipe-1', manningN: 0 }).affected).toEqual([]);
    expect(run(doc, 'update_pipe', { pipeId: 'pipe-1', invertTo: 99 }).summary).toContain(
      'adverse',
    );

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
    expect(run(doc, 'update_manhole', { manholeId: 'x', name: 'a' }).summary).toContain(
      'no manhole',
    );
    expect(
      run(doc, 'update_manhole', { manholeId: 'manhole-2', rimElevation: 90 }).summary,
    ).toContain('must be above');
    expect(run(doc, 'update_manhole', { manholeId: 'manhole-2', diameter: 0 }).affected).toEqual(
      [],
    );
    expect(
      run(doc, 'update_manhole', { manholeId: 'manhole-2', surfaceId: 's' }).summary,
    ).toContain('no surface');
    const moved = run(doc, 'update_manhole', {
      manholeId: 'manhole-2',
      location: [60, 10],
      runoffCoefficient: 0.5,
    });
    expect(moved.document.civil?.objects['manhole-2']).toMatchObject({ position: [60, 10] });
    expect(
      run(doc, 'update_manhole', { manholeId: 'manhole-2', location: [0, 0] }).summary,
    ).toContain('zero-length');
  });

  it('cascades deletion from a manhole to its pipes', () => {
    const doc = network();
    const result = run(doc, 'delete_civil_object', { id: 'manhole-2', cascade: true });
    expect(result.document.civil?.order).toEqual(['manhole-1', 'manhole-3']);
    expect(result.document.entities['pipe-1:body']).toBeUndefined();
  });

  it('refuses to delete generated entities and survives a save/load round trip', () => {
    const doc = network();
    const refused = run(doc, 'delete_entity', { id: 'manhole-1:body' });
    expect(refused.document.entities['manhole-1:body']).toBeDefined();
    expect(refused.affected).toEqual([]);
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(Object.keys(loaded.entities).sort()).toEqual(Object.keys(doc.entities).sort());
    expect(loaded.civil?.objects['pipe-2']).toMatchObject({
      fromId: 'manhole-2',
      toId: 'manhole-3',
    });
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
    const doc = run(network(), 'update_manhole', {
      manholeId: 'manhole-1',
      catchmentAreaHa: 0.2,
    }).document;
    const cleared = run(doc, 'update_manhole', {
      manholeId: 'manhole-2',
      catchmentAreaHa: 0,
      inflowLps: 0,
    }).document;
    const data = run(cleared, 'check_drainage_network', { minCoverM: 0.5 }).data as {
      pipes: Array<{
        status: string;
        depthRatio: number;
        velocity: number;
        coverFromM: number;
        reasons: string[];
      }>;
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
    const shallow = run(doc, 'check_drainage_network', { minCoverM: 5 }).data as {
      pipes: Array<{ reasons: string[] }>;
    };
    expect(shallow.pipes[0]?.reasons.join()).toContain('upstream cover');
    expect(shallow.pipes[0]?.reasons.join()).toContain('downstream cover');
    const fast = run(doc, 'check_drainage_network', {
      maxVelocity: 0.1,
      minVelocity: 0,
      rainfallIntensityMmH: 1,
    }).data as { pipes: Array<{ reasons: string[] }> };
    expect(fast.pipes[0]?.reasons.join()).toContain('velocity');
    const slow = run(doc, 'check_drainage_network', {
      minVelocity: 5,
      maxVelocity: 9,
      rainfallIntensityMmH: 1,
    }).data as { pipes: Array<{ reasons: string[] }> };
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
    expect(run(doc, 'check_drainage_network', { rainfallIntensityMmH: 0 }).summary).toContain(
      'failed',
    );
    expect(run(doc, 'check_drainage_network', { maxDepthRatio: 2 }).affected).toEqual([]);
    expect(run(doc, 'check_drainage_network', { minVelocity: 5, maxVelocity: 1 }).affected).toEqual(
      [],
    );
    const empty = run(createEmptyDocument(), 'check_drainage_network', {});
    expect(empty.summary).toContain('no drainage pipes');
    expect(run(createEmptyDocument(), 'drainage_schedule', {}).summary).toContain('no manholes');
    expect(run(createEmptyDocument(), 'size_drainage_pipes', {}).summary).toContain('no pipes');
    expect(run(doc, 'size_drainage_pipes', { diameters: [0] }).affected).toEqual([]);
    expect(run(doc, 'size_drainage_pipes', { diameters: [] }).affected).toEqual([]);
  });

  it('writes manhole and pipe schedules', () => {
    const data = run(network(), 'drainage_schedule', {}).data as {
      manholeCsv: string;
      pipeCsv: string;
      csv: string;
    };
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
    expect(
      after.pipes.every(
        (p) => !p.reasons.some((r) => r.includes('depth') || r.includes('capacity')),
      ),
    ).toBe(true);
    expect(sized.summary).toContain('Resized');
    const again = run(sized.document, 'size_drainage_pipes', {});
    expect(again.summary).toContain('no diameter change');
    const limited = run(doc, 'size_drainage_pipes', { diameters: [150], minVelocity: 0.1 });
    expect(limited.summary).toContain('Cannot size');
    const adverse = run(doc, 'update_pipe', { pipeId: 'pipe-1', invertTo: 99 }).document;
    expect(run(adverse, 'size_drainage_pipes', {}).summary).toContain('pipe-1');
  });
});
