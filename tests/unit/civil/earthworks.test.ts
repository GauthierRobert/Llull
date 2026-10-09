import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type Vec2, type Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import { civilObject, getCivil } from '@aec/civil/model';

function step(doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument {
  const result = execute(doc, name, params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result.document;
}

/** Gridded survey points over [0,100]² with elevation z(x, y). */
function ground(z: (x: number, y: number) => number): CadDocument {
  let doc = execute(createEmptyDocument(), 'set_units', { units: 'm' }).document;
  const points: Array<{ x: number; y: number; z: number }> = [];
  for (let x = 0; x <= 100; x += 20) {
    for (let y = 0; y <= 100; y += 20) points.push({ x, y, z: z(x, y) });
  }
  doc = step(doc, 'import_survey_points', { points });
  return step(doc, 'create_surface', {});
}

const flat = (): CadDocument => ground(() => 100);
const sloped = (): CadDocument => ground((x) => 100 + 0.05 * x);

const PAD: Vec2[] = [
  [40, 40],
  [60, 40],
  [60, 60],
  [40, 60],
];

interface Volumes {
  platformId: string;
  cutM3: number;
  fillM3: number;
  netM3: number;
  [key: string]: unknown;
}

function withPad(doc: CadDocument, extra: Record<string, unknown> = {}): CadDocument {
  return step(doc, 'add_platform', {
    surfaceId: 'surface-1',
    boundary: PAD,
    elevation: 101,
    ...extra,
  });
}

describe('add_platform', () => {
  it('computes fill of a raised pad on flat ground (pad + batters)', () => {
    const result = execute(flat(), 'add_platform', {
      surfaceId: 'surface-1',
      boundary: PAD,
      elevation: 101,
      fillSlope: 2,
    });
    const data = result.data as Volumes;
    expect(data.platformId).toBe('platform-1');
    expect(data.cutM3).toBe(0);
    // 400 pad + 4 edges x 20 x 1 (triangle 2 x 1 / 2) + 4 quarter cones (pi r^2 h / 3 / 4 x 4)
    const analytic = 400 + 80 + (Math.PI * 4 * 1) / 3;
    expect(data.fillM3).toBeGreaterThan(analytic * 0.98);
    expect(data.fillM3).toBeLessThan(analytic * 1.02);
    expect(data.netM3).toBeCloseTo(-data.fillM3, 6);
    expect(result.summary).toContain('fill');
    const platform = civilObject(getCivil(result.document), 'platform-1', 'platform');
    expect(platform?.entityIds).toEqual(
      expect.arrayContaining([
        'platform-1:pad',
        'platform-1:outline',
        'platform-1:daylight',
        'platform-1:batter-fill',
        'platform-1:label',
      ]),
    );
    expect(platform?.entityIds).not.toContain('platform-1:batter-cut');
    expect(result.affected).toContain('platform-1');
    expect(result.document.order).toContain('platform-1:pad');
    expect(result.document.entities['platform-1:label']).toMatchObject({
      content: 'Pad Platform 1 +101.00',
    });
  });

  it('computes cut of a lowered pad and normalizes clockwise outlines to CCW', () => {
    const clockwise: Vec2[] = [...PAD].reverse();
    const result = execute(flat(), 'add_platform', {
      surfaceId: 'surface-1',
      boundary: clockwise,
      elevation: 99,
      name: 'Cutter',
    });
    const data = result.data as Volumes;
    expect(data.fillM3).toBe(0);
    const analytic = 400 + 60 + (Math.PI * 2.25) / 3;
    expect(data.cutM3).toBeGreaterThan(analytic * 0.98);
    expect(data.cutM3).toBeLessThan(analytic * 1.02);
    const platform = civilObject(getCivil(result.document), 'platform-1', 'platform');
    expect(platform?.name).toBe('Cutter');
    expect(platform?.boundary[0]).toEqual([40, 40]);
    expect(platform?.boundary[1]).toEqual([60, 40]);
    expect(result.document.entities['platform-1:batter-cut']).toBeDefined();
  });

  it('handles pads partly in cut and in fill on sloping ground', () => {
    const data = execute(sloped(), 'add_platform', {
      surfaceId: 'surface-1',
      boundary: PAD,
      elevation: 102.5,
      cutSlope: 2,
      fillSlope: 2,
    }).data as Volumes;
    expect(data.cutM3).toBeGreaterThan(0);
    expect(data.fillM3).toBeGreaterThan(0);
    expect(Math.abs(data.cutM3 - data.fillM3) / data.cutM3).toBeLessThan(0.02);
  });

  it('is a no-op for bad input', () => {
    const doc = flat();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ surfaceId: 'surface-9' }, 'no surface'],
      [
        {
          boundary: [
            [0, 0],
            [10, 10],
            [10, 0],
            [0, 10],
          ],
        },
        'simple',
      ],
      [
        {
          boundary: [
            [0, 0],
            [5, 5],
            [10, 10],
          ],
        },
        'simple',
      ],
      [
        {
          boundary: [
            [40, 40],
            [200, 40],
            [200, 60],
          ],
        },
        'outside the surface',
      ],
      [{ cutSlope: -1 }, 'cutSlope'],
      [{ fillSlope: 0 }, 'fillSlope'],
    ];
    for (const [override, text] of cases) {
      const result = execute(doc, 'add_platform', {
        surfaceId: 'surface-1',
        boundary: PAD,
        elevation: 101,
        ...override,
      });
      expect(result.affected, result.summary).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain(text);
    }
    expect(
      execute(doc, 'add_platform', { surfaceId: 'surface-1', boundary: [[0, 0]], elevation: 1 })
        .affected,
    ).toEqual([]);
  });

  it('is pure', () => {
    const doc = flat();
    const before = JSON.stringify(doc);
    withPad(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('update_platform', () => {
  it('changes the level and regenerates volumes', () => {
    const doc = withPad(flat());
    const before = (
      execute(doc, 'platform_earthworks', { platformId: 'platform-1' }).data as Volumes
    ).fillM3;
    const result = execute(doc, 'update_platform', {
      platformId: 'platform-1',
      elevation: 102,
      name: 'Raised',
    });
    const data = result.data as Volumes;
    expect(result.affected).toContain('platform-1');
    expect(data.fillM3).toBeGreaterThan(before * 1.9);
    const platform = civilObject(getCivil(result.document), 'platform-1', 'platform');
    expect(platform).toMatchObject({ elevation: 102, name: 'Raised' });
    const moved = execute(result.document, 'update_platform', {
      platformId: 'platform-1',
      boundary: [
        [30, 30],
        [50, 30],
        [50, 50],
        [30, 50],
      ],
      cutSlope: 1,
      fillSlope: 3,
    });
    expect(moved.affected.length).toBeGreaterThan(0);
  });

  it('is a no-op when nothing changes or input is invalid', () => {
    const doc = withPad(flat());
    for (const params of [
      { platformId: 'platform-1' },
      { platformId: 'platform-1', elevation: 101 },
      { platformId: 'platform-9', elevation: 5 },
      { platformId: 'platform-1', fillSlope: -2 },
      {
        platformId: 'platform-1',
        boundary: [
          [0, 0],
          [10, 10],
          [10, 0],
          [0, 10],
        ],
      },
      {
        platformId: 'platform-1',
        boundary: [
          [40, 40],
          [300, 40],
          [300, 60],
        ],
      },
    ]) {
      const result = execute(doc, 'update_platform', params);
      expect(result.affected, result.summary).toEqual([]);
      expect(result.document).toBe(doc);
    }
  });

  it('refuses when the surface was deleted', () => {
    const doc = withPad(flat());
    const civil = getCivil(doc);
    const orphan = {
      ...doc,
      civil: { ...civil, objects: { ...civil.objects, 'surface-1': undefined as never } },
    };
    delete (orphan.civil.objects as Record<string, unknown>)['surface-1'];
    for (const name of ['update_platform', 'platform_earthworks', 'balance_platform']) {
      const result = execute(orphan, name, { platformId: 'platform-1', elevation: 3 });
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain('no longer exists');
    }
  });
});

describe('platform_earthworks', () => {
  it('reports areas, depths and the daylight line without changing the document', () => {
    const doc = withPad(flat());
    const before = JSON.stringify(doc);
    const result = execute(doc, 'platform_earthworks', {
      platformId: 'platform-1',
      gridSpacing: 0.4,
    });
    const data = result.data as Volumes & Record<string, number | Vec2[]>;
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(data['padAreaM2']).toBe(400);
    expect(data['maxFillDepthM']).toBeCloseTo(1, 1);
    expect(data['maxCutDepthM']).toBe(0);
    expect(data['fillAreaM2'] as number).toBeGreaterThan(400);
    expect(data['gridSpacingM']).toBeCloseTo(0.4, 2);
    expect(data['samplesOutsideTin']).toBe(0);
    const daylight = data['daylight'] as Vec2[];
    expect(daylight.length).toBeGreaterThan(4);
    // Daylight of a 1 m fill at 2H:1V is 2 m from the pad edge.
    expect(Math.min(...daylight.map((p) => p[0]))).toBeCloseTo(38, 1);
    expect(Math.max(...daylight.map((p) => p[0]))).toBeLessThan(62.01);
  });

  it('counts samples outside a concave TIN and rejects bad input', () => {
    const doc = withPad(flat());
    expect(execute(doc, 'platform_earthworks', { platformId: 'platform-9' }).affected).toEqual([]);
    const bad = execute(doc, 'platform_earthworks', { platformId: 'platform-1', gridSpacing: -1 });
    expect(bad.summary).toContain('gridSpacing');
    const coarse = execute(doc, 'platform_earthworks', {
      platformId: 'platform-1',
      gridSpacing: 5,
    });
    expect((coarse.data as Volumes).fillM3).toBeGreaterThan(400);
    const tiny = execute(doc, 'platform_earthworks', {
      platformId: 'platform-1',
      gridSpacing: 1e-4,
    });
    expect((tiny.data as Record<string, number>)['samples'] ?? 0).toBeLessThanOrEqual(250000);
  });

  it('skips grid samples outside the TIN when the batter reaches past it', () => {
    let doc = execute(createEmptyDocument(), 'set_units', { units: 'm' }).document;
    doc = step(doc, 'import_survey_points', {
      points: [
        { x: 0, y: 0, z: 100 },
        { x: 30, y: 0, z: 100 },
        { x: 30, y: 30, z: 100 },
        { x: 0, y: 30, z: 100 },
        { x: 15, y: 15, z: 100 },
      ],
    });
    doc = step(doc, 'create_surface', {});
    doc = step(doc, 'add_platform', {
      surfaceId: 'surface-1',
      boundary: [
        [5, 5],
        [25, 5],
        [25, 25],
        [5, 25],
      ],
      elevation: 130,
      fillSlope: 2,
    });
    const data = execute(doc, 'platform_earthworks', { platformId: 'platform-1' }).data as Record<
      string,
      number | Vec2[]
    >;
    expect(data['daylightClipped'] as number).toBeGreaterThan(0);
    expect(data['fillM3'] as number).toBeGreaterThan(0);
  });
});

describe('balance_platform', () => {
  it('finds the level where cut equals fill', () => {
    const doc = withPad(sloped(), { cutSlope: 2, fillSlope: 2, elevation: 101 });
    const result = execute(doc, 'balance_platform', { platformId: 'platform-1' });
    const data = result.data as Volumes & { elevationM: number; residualM3: number };
    expect(data.elevationM).toBeCloseTo(102.5, 1);
    expect(Math.abs(data.cutM3 - data.fillM3) / data.cutM3).toBeLessThan(0.03);
    expect(Math.abs(data.residualM3)).toBeLessThan(data.cutM3 * 0.03);
    expect(result.summary).toContain('Balanced');
    const platform = civilObject(getCivil(result.document), 'platform-1', 'platform');
    expect(platform?.elevation).toBeCloseTo(102.5, 1);
    const again = execute(result.document, 'balance_platform', { platformId: 'platform-1' });
    expect(again.affected).toEqual([]);
    expect(again.summary).toContain('already balanced');
  });

  it('applies a swell factor (more fill needed than cut means a lower pad)', () => {
    const doc = withPad(sloped(), { cutSlope: 2, fillSlope: 2 });
    const plain = (
      execute(doc, 'balance_platform', { platformId: 'platform-1' }).data as {
        elevationM: number;
      }
    ).elevationM;
    const swelled = (
      execute(doc, 'balance_platform', { platformId: 'platform-1', swellFactor: 1.2 }).data as {
        elevationM: number;
      }
    ).elevationM;
    expect(swelled).toBeGreaterThan(plain);
  });

  it('is a no-op for bad input or when no balance exists', () => {
    const doc = withPad(flat());
    expect(execute(doc, 'balance_platform', { platformId: 'platform-9' }).affected).toEqual([]);
    expect(
      execute(doc, 'balance_platform', { platformId: 'platform-1', swellFactor: 0 }).summary,
    ).toContain('swellFactor');
    const plateau = withPad(
      ground((x, y) => (x >= 40 && x <= 60 && y >= 40 && y <= 60 ? 100 : 50)),
    );
    const result = execute(plateau, 'balance_platform', { platformId: 'platform-1' });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(plateau);
    expect(result.summary).toContain('no balancing level');
  });

  it('levels a pad on flat ground to the ground', () => {
    const doc = withPad(flat(), { elevation: 120 });
    const result = execute(doc, 'balance_platform', { platformId: 'platform-1' });
    expect((result.data as { elevationM: number }).elevationM).toBeCloseTo(100, 3);
  });
});

describe('compare_surfaces', () => {
  function twoSurfaces(): CadDocument {
    let doc = flat();
    const lifted: Vec3[] = [];
    for (let x = 0; x <= 100; x += 50) for (let y = 0; y <= 100; y += 50) lifted.push([x, y, 101]);
    doc = step(doc, 'create_surface', { points: lifted, pointGroupIds: [], name: 'Design' });
    return doc;
  }

  it('measures fill between existing and a raised design surface', () => {
    const doc = twoSurfaces();
    const result = execute(doc, 'compare_surfaces', {
      baseSurfaceId: 'surface-1',
      comparisonSurfaceId: 'surface-2',
    });
    const data = result.data as Record<string, number>;
    expect(data['fillM3']).toBeCloseTo(10000, 0);
    expect(data['cutM3']).toBe(0);
    expect(data['netM3']).toBeCloseTo(-10000, 0);
    expect(data['areaM2']).toBeCloseTo(10000, 0);
    expect(result.document).toBe(doc);
    const reverse = execute(doc, 'compare_surfaces', {
      baseSurfaceId: 'surface-2',
      comparisonSurfaceId: 'surface-1',
      gridSpacing: 10,
    });
    expect((reverse.data as Record<string, number>)['cutM3']).toBeCloseTo(10000, 0);
    expect(
      execute(doc, 'compare_surfaces', {
        baseSurfaceId: 'surface-1',
        comparisonSurfaceId: 'surface-1',
      }).summary,
    ).toContain('cut 0 m³, fill 0 m³');
  });

  it('reports mixed cut / fill and outside samples', () => {
    let doc = flat();
    doc = step(doc, 'create_surface', {
      pointGroupIds: [],
      points: [
        [0, 0, 98],
        [100, 0, 102],
        [100, 100, 102],
        [0, 100, 98],
        [50, 50, 100],
      ],
    });
    const data = execute(doc, 'compare_surfaces', {
      baseSurfaceId: 'surface-1',
      comparisonSurfaceId: 'surface-2',
    }).data as Record<string, number>;
    expect(data['cutM3']).toBeGreaterThan(0);
    expect(data['fillM3']).toBeGreaterThan(0);
    expect(Math.abs(data['netM3'] ?? 1)).toBeLessThan(50);
  });

  it('skips cells outside a TIN and is a no-op on bad input', () => {
    let doc = flat();
    doc = step(doc, 'create_surface', {
      pointGroupIds: [],
      points: [
        [0, 0, 100],
        [100, 0, 100],
        [50, 100, 100],
        [50, 40, 100],
      ],
    });
    const partial = execute(doc, 'compare_surfaces', {
      baseSurfaceId: 'surface-1',
      comparisonSurfaceId: 'surface-2',
      gridSpacing: 5,
    });
    expect((partial.data as Record<string, number>)['samplesOutsideTin']).toBeGreaterThan(0);
    expect(partial.summary).toContain('outside a TIN');
    for (const params of [
      { baseSurfaceId: 'surface-8', comparisonSurfaceId: 'surface-1' },
      { baseSurfaceId: 'surface-1', comparisonSurfaceId: 'surface-8' },
      { baseSurfaceId: 'surface-1', comparisonSurfaceId: 'surface-2', gridSpacing: 0 },
    ]) {
      expect(execute(doc, 'compare_surfaces', params).affected).toEqual([]);
    }
  });

  it('reports disjoint surfaces as a no-op', () => {
    let doc = flat();
    doc = step(doc, 'create_surface', {
      pointGroupIds: [],
      points: [
        [500, 500, 1],
        [600, 500, 1],
        [600, 600, 1],
      ],
    });
    const result = execute(doc, 'compare_surfaces', {
      baseSurfaceId: 'surface-1',
      comparisonSurfaceId: 'surface-2',
    });
    expect(result.summary).toContain('share no plan extent');
  });
});

describe('platform persistence and guards', () => {
  it('round-trips through save / load and re-derives the geometry', () => {
    const doc = withPad(flat());
    const loaded = deserializeDocument(serializeDocument(doc));
    const platform = civilObject(getCivil(loaded), 'platform-1', 'platform');
    expect(platform?.elevation).toBe(101);
    expect(loaded.entities['platform-1:pad']).toBeDefined();
    expect(loaded.entities['platform-1:daylight']).toBeDefined();
  });

  it('refuses to delete derived platform entities', () => {
    const doc = withPad(flat());
    const result = execute(doc, 'delete_entity', { ids: ['platform-1:pad'] });
    expect(result.document.entities['platform-1:pad']).toBeDefined();
  });

  it('deleting the platform removes its entities', () => {
    const doc = withPad(flat());
    const result = execute(doc, 'delete_civil_object', { id: 'platform-1' });
    expect(result.document.entities['platform-1:pad']).toBeUndefined();
  });
});
