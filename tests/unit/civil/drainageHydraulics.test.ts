import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import { DEFAULT_CRITERIA, intensityAt } from '@aec/civil/drainageCriteria';
import { civilErrors } from '@aec/civil/validate';
import { manningFullFlow } from '@aec/civil/hydraulics';

function run(
  doc: CadDocument,
  name: string,
  params: Record<string, unknown> = {},
): ReturnType<typeof execute> {
  return execute(doc, name, params);
}

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

function build(
  manholes: Array<Record<string, unknown>>,
  pipes: Array<Record<string, unknown>>,
): CadDocument {
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
    const rows = check(chain({ catchmentAreaHa: 1, runoffCoefficient: 0.9 }), {
      idf: { a: 1000, b: 10, c: 0.8 },
    }).pipes;
    expect(rows[0]?.intensityMmH).toBeCloseTo(1000 / 15 ** 0.8, 2);
    expect(rows[0]?.sumCAHa).toBeCloseTo(0.9, 4);
    expect(rows[0]?.designLps).toBeCloseTo(((0.9 * 1000) / 15 ** 0.8 / 360) * 1000, 1);
  });

  it('accumulates entry time and travel time along a 3-pipe chain', () => {
    // inflow = half the full-bore capacity => depth ratio 0.5 => v equals the full-bore velocity
    const rows = check(chain({ inflowLps: (FULL / 2) * 1000 })).pipes;
    const travelMin = 50 / (FULL / FULL_AREA) / 60;
    expect(travelMin).toBeCloseTo(0.6091, 3);
    expect(rows.map((r) => r.tcMin)).toEqual([
      5,
      expect.closeTo(5 + travelMin, 1),
      expect.closeTo(5 + 2 * travelMin, 1),
    ]);
    expect(rows[0]?.velocity).toBeCloseTo(FULL / FULL_AREA, 2);
  });

  it('takes the maximum over upstream paths using each manhole entry time', () => {
    const doc = build(
      [
        { location: [0, 0], invertElevation: 98, rimElevation: 100, inflowLps: 5 },
        { location: [50, 0], invertElevation: 97.5, rimElevation: 100 },
        {
          location: [50, 50],
          invertElevation: 98,
          rimElevation: 100,
          inflowLps: 5,
          entryTimeMin: 20,
        },
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
    expect(
      run(doc, 'update_manhole', { manholeId: 'manhole-1', entryTimeMin: 0 }).affected,
    ).toEqual([]);
    expect(
      run(createEmptyDocument(), 'add_manhole', {
        location: [0, 0],
        invertElevation: 1,
        rimElevation: 3,
        entryTimeMin: -1,
      }).summary,
    ).toContain('entryTimeMin');
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.civil?.objects['manhole-1']).toMatchObject({ entryTimeMin: 12 });
    const raw = JSON.parse(JSON.stringify(doc.civil)) as {
      objects: Record<string, Record<string, unknown>>;
    };
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
    expect((rows[1]?.designLps ?? 0) + (rows[2]?.designLps ?? 0)).toBeCloseTo(
      rows[0]?.designLps ?? 0,
      1,
    );
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
    const data = result.data as {
      text: string;
      fileName: string;
      pipeIds: string[];
      manholeIds: string[];
    };
    expect(data.text.startsWith('<svg')).toBe(true);
    for (const label of ['MH1', 'MH4', 'Chainage', 'Invert', 'HGL', 'Ø300', '150.00']) {
      expect(data.text).toContain(label);
    }
    expect(data.text).toContain('stroke="#1060d0"');
    expect(data.fileName).toBe('MH1_drainage_long_section.svg');
    expect(data.pipeIds).toEqual(['pipe-1', 'pipe-2', 'pipe-3']);
    expect(result.summary).toContain('3 pipe(s)');
    expect(result.affected).toEqual([]);
    const part = run(doc, 'export_drainage_long_section', {
      fromManholeId: 'manhole-2',
      toManholeId: 'manhole-3',
    }).data as { pipeIds: string[] };
    expect(part.pipeIds).toEqual(['pipe-2']);
  });

  it('follows the largest pipe at a fork and flags flooding in red', () => {
    const forkRun = run(diverging(), 'export_drainage_long_section', { fromManholeId: 'manhole-1' })
      .data as { manholeIds: string[] };
    expect(forkRun.manholeIds).toEqual(['manhole-1', 'manhole-2', 'manhole-3']);
    const flooded = run(twoManholes(100), 'export_drainage_long_section', {
      fromManholeId: 'manhole-1',
      outfallLevel: 97.8,
    }).data as { text: string };
    expect(flooded.text).toContain('#c00000');
  });

  it('refuses unknown manholes, missing runs and bad criteria', () => {
    const doc = chain();
    const refused = (params: Record<string, unknown>): string => {
      const result = run(doc, 'export_drainage_long_section', params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      return result.summary;
    };
    expect(refused({ fromManholeId: 'nope' })).toContain('no manhole');
    expect(refused({ fromManholeId: 'manhole-1', toManholeId: 'nope' })).toContain('no manhole');
    expect(refused({ fromManholeId: 'manhole-4' })).toContain('no pipe run');
    expect(refused({ fromManholeId: 'manhole-3', toManholeId: 'manhole-1' })).toContain(
      'no pipe run',
    );
    expect(refused({ fromManholeId: 'manhole-1', freeboardM: -1 })).toContain('freeboardM');
  });
});

describe('criteria validation and purity', () => {
  it('rejects conflicting or invalid rainfall and HGL settings', () => {
    const doc = chain({ catchmentAreaHa: 1 });
    const idf = { a: 1000, b: 10, c: 0.8 };
    const refused = (params: Record<string, unknown>): string => {
      const result = run(doc, 'check_drainage_network', params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
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
