import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import { flattenDxf, parseDxf } from '@core/lib/dxfRead';
import { civilErrors } from '@aec/civil/validate';
import { gridSize, MAX_SAMPLES } from '@aec/civil/earthworksMath';
import { drawnInterval, MAX_CONTOUR_LEVELS } from '@aec/civil/surfaceEvaluate';
import { buildTin } from '@aec/civil/tin';
import { MAX_SURFACE_POINTS } from '@aec/civil/model';
import { metricDocument, surveyedDocument } from './fixtures';

function dxf(pairs: Array<[number, string | number]>): string {
  return pairs.map(([code, value]) => `${code}\n${value}`).join('\n') + '\n';
}

/** Blocks B0..B7, each inserting the next one `fanout` times; B7 holds one line. */
function blockBomb(fanout: number): string {
  const pairs: Array<[number, string | number]> = [
    [0, 'SECTION'],
    [2, 'BLOCKS'],
  ];
  for (let level = 0; level < 8; level++) {
    pairs.push([0, 'BLOCK'], [2, `B${level}`]);
    if (level === 7) {
      pairs.push([0, 'LINE'], [10, 0], [20, 0], [11, 1], [21, 1]);
    } else {
      for (let k = 0; k < fanout; k++) pairs.push([0, 'INSERT'], [2, `B${level + 1}`], [10, k]);
    }
    pairs.push([0, 'ENDBLK']);
  }
  pairs.push([0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'], [0, 'INSERT'], [2, 'B0']);
  pairs.push([0, 'ENDSEC'], [0, 'EOF']);
  return dxf(pairs);
}

describe('DXF resource limits', () => {
  it('stops expanding nested inserts at the primitive budget', () => {
    const drawing = parseDxf(blockBomb(10));
    if (!drawing) throw new Error('unparsed');
    const started = performance.now();
    const { primitives, skipped } = flattenDxf(drawing, 8, 1000);
    expect(primitives).toHaveLength(1000);
    expect(skipped.get('over limit')).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('drops non-finite LWPOLYLINE vertices', () => {
    const text = dxf([
      [0, 'SECTION'],
      [2, 'ENTITIES'],
      [0, 'LWPOLYLINE'],
      [38, 5],
      [10, 0],
      [20, 0],
      [10, 'oops'],
      [20, 1],
      [10, 2],
      [20, 2],
      [0, 'ENDSEC'],
    ]);
    const drawing = parseDxf(text);
    if (!drawing) throw new Error('unparsed');
    const [polyline] = flattenDxf(drawing).primitives;
    expect(polyline?.kind === 'polyline' && polyline.points).toEqual([
      [0, 0, 5],
      [2, 2, 5],
    ]);
    const imported = execute(metricDocument(), 'import_survey_dxf', { text });
    const group = imported.document.civil?.objects['pointGroup-1'];
    const positions = group?.category === 'pointGroup' ? group.points.map((p) => p.position) : [];
    expect(positions.flat().every(Number.isFinite)).toBe(true);
    // The project stays loadable.
    expect(() => deserializeDocument(serializeDocument(imported.document))).not.toThrow();
  });
});

describe('earthworks grid cap', () => {
  it('caps a thin strip after per-axis rounding', () => {
    const { columns, rows } = gridSize(1e-9, 100, 1e-9);
    expect(columns * rows).toBeLessThanOrEqual(MAX_SAMPLES);
    const wide = gridSize(100, 1e-9, 1e-9);
    expect(wide.columns * wide.rows).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(gridSize(10, 10, 1)).toEqual({ columns: 10, rows: 10 });
  });
});

describe('contours over a tall surface', () => {
  it('widens the interval so the whole range is contoured', () => {
    const tin = buildTin([
      [0, 0, 0],
      [10, 0, 1000],
      [0, 10, 0],
      [10, 10, 1000],
    ]);
    expect(drawnInterval(tin, 1)).toBe(Math.ceil(1000 / MAX_CONTOUR_LEVELS));
    expect(drawnInterval(tin, 10)).toBe(10);
    expect(drawnInterval(buildTin([]), 1)).toBe(1);
  });
});

describe('affected lists regenerated dependents', () => {
  it('update_surface reports the platform it regraded', () => {
    const doc = execute(surveyedDocument(), 'add_platform', {
      surfaceId: 'surface-1',
      boundary: [
        [30, 30],
        [50, 30],
        [50, 50],
        [30, 50],
      ],
      elevation: 102,
    }).document;
    const result = execute(doc, 'update_surface', { surfaceId: 'surface-1', contourInterval: 0.5 });
    expect(result.affected[0]).toBe('surface-1');
    expect(result.affected).toContain('platform-1:pad');
  });
});

describe('surface point limit', () => {
  it('refuses surfaces over the point limit', () => {
    let doc = metricDocument();
    const batch = 40000;
    for (let g = 0; g < Math.ceil(MAX_SURFACE_POINTS / batch) + 1; g++) {
      const points = Array.from({ length: batch }, (_, k) => ({ x: k, y: g, z: 0 }));
      doc = execute(doc, 'import_survey_points', { points }).document;
    }
    const result = execute(doc, 'create_surface', {});
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/point surface limit/);
  });
});

describe('civil file validation', () => {
  const base = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(surveyedDocument().civil)) as Record<string, unknown>;

  function withObject(object: Record<string, unknown>): Record<string, unknown> {
    const civil = base();
    const objects = civil['objects'] as Record<string, unknown>;
    objects[object['id'] as string] = object;
    civil['order'] = [...(civil['order'] as string[]), object['id']];
    return civil;
  }

  const alignment = {
    id: 'alignment-1',
    category: 'alignment',
    name: 'A',
    entityIds: [],
    points: [
      [0, 0],
      [10, 0],
    ],
    radii: [],
    startStation: 0,
    stationInterval: 20,
    profile: [],
  };

  it('accepts a valid model', () => {
    expect(civilErrors(base())).toEqual([]);
    expect(civilErrors(withObject(alignment))).toEqual([]);
  });

  it('rejects malformed profiles, sections, radii and orders', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [withObject({ ...alignment, profile: [null, null] }), /profile entries/],
      [withObject({ ...alignment, section: {} }), /section needs/],
      [withObject({ ...alignment, radii: [5] }), /alignment-1/],
      [
        withObject({
          id: 'manhole-1',
          category: 'manhole',
          name: 'M',
          entityIds: [],
          position: [0, 0],
          rimElevation: 1,
          invertElevation: 0,
          diameter: 1,
          catchment: { areaHa: 1, runoffCoefficient: 2 },
        }),
        /catchment needs/,
      ],
      [{ ...base(), order: ['pointGroup-1', 'pointGroup-1', 'surface-1'] }, /lists an id twice/],
      [{ ...base(), order: ['pointGroup-1'] }, /surface-1 is missing from civil.order/],
      [{ ...base(), counters: { surface: 'x' } }, /counters/],
    ];
    for (const [civil, message] of cases) {
      expect(civilErrors(civil).join('\n')).toMatch(message);
    }
  });

  it('rejects such a file on load with a clean error', () => {
    const doc = surveyedDocument();
    const envelope = JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> };
    envelope.document['civil'] = withObject({ ...alignment, profile: [null, null] });
    expect(() => deserializeDocument(JSON.stringify(envelope))).toThrow(/profile entries/);
  });
});
