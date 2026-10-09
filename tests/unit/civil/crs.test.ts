/** CRS + site calibration: set_coordinate_system, set_site_calibration, transform_coordinates, grid exports. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import { civilErrors } from '@aec/civil/validate';
import { metricDocument, surveyedDocument } from './fixtures';

const CALIBRATION = {
  localOrigin: [0, 0],
  gridOrigin: [1000, 2000],
  rotationDeg: 90,
  scaleFactor: 2,
};

function calibrated(base: CadDocument = metricDocument()): CadDocument {
  const named = execute(base, 'set_coordinate_system', {
    name: 'RGF93 / Lambert-93',
    epsg: 2154,
    verticalDatum: 'NGF-IGN69',
  }).document;
  return execute(named, 'set_site_calibration', CALIBRATION).document;
}

function transform(doc: CadDocument, points: number[][], direction: string): number[][] {
  const result = execute(doc, 'transform_coordinates', { points, direction });
  return (result.data as { points: number[][] }).points;
}

describe('set_coordinate_system / set_site_calibration', () => {
  it('stores the CRS, keeps the calibration, and is pure', () => {
    const doc = metricDocument();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'set_coordinate_system', { name: ' Lambert ', epsg: 2154 });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document.civil?.crs).toEqual({ name: 'Lambert', epsg: 2154 });
    const both = execute(result.document, 'set_site_calibration', CALIBRATION).document;
    const renamed = execute(both, 'set_coordinate_system', { name: 'Other' }).document;
    expect(renamed.civil?.crs?.calibration?.scaleFactor).toBe(2);
    expect(both.civil?.crs?.name).toBe('Lambert');
  });

  it('rejects bad input without changing the document', () => {
    const doc = metricDocument();
    for (const [name, params] of [
      ['set_coordinate_system', { name: '  ' }],
      ['set_coordinate_system', { name: 'X', epsg: 12.5 }],
      ['set_site_calibration', { ...CALIBRATION, scaleFactor: 0 }],
      ['set_site_calibration', { ...CALIBRATION, rotationDeg: Number.POSITIVE_INFINITY }],
    ] as const) {
      const result = execute(doc, name, params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
    }
  });

  it('survives object edits and a save / load round trip, and validates', () => {
    const doc = calibrated(surveyedDocument());
    expect(doc.civil?.crs?.epsg).toBe(2154);
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.civil?.crs?.calibration).toEqual(CALIBRATION);
    expect(
      civilErrors({ ...doc.civil, crs: { name: 'x', calibration: { scaleFactor: 0 } } }),
    ).not.toEqual([]);
    expect(civilErrors({ ...doc.civil, crs: { name: 3 } })).not.toEqual([]);
    expect(
      civilErrors({ ...doc.civil, crs: { name: 'x', epsg: -1, verticalDatum: 4 } }).length,
    ).toBe(2);
  });
});

describe('transform_coordinates', () => {
  it('applies rotation 90 deg and scale 2 about the origins', () => {
    const doc = calibrated();
    const [grid] = transform(doc, [[10, 0]], 'localToGrid');
    expect(grid?.[0]).toBeCloseTo(1000, 9);
    expect(grid?.[1]).toBeCloseTo(2020, 9);
    const [local] = transform(doc, [[1000, 2020]], 'gridToLocal');
    expect(local?.[0]).toBeCloseTo(10, 9);
    expect(local?.[1]).toBeCloseTo(0, 9);
  });

  it('round-trips local -> grid -> local', () => {
    const doc = execute(metricDocument(), 'set_site_calibration', {
      localOrigin: [12.5, -40],
      gridOrigin: [652000.25, 6862000.5],
      rotationDeg: 33.3,
      scaleFactor: 0.99964,
    }).document;
    const points = [
      [0, 0],
      [100, 250],
      [-33.3, 7],
    ];
    const back = transform(doc, transform(doc, points, 'localToGrid'), 'gridToLocal');
    back.forEach((point, index) => {
      expect(point[0]).toBeCloseTo(points[index]?.[0] ?? NaN, 6);
      expect(point[1]).toBeCloseTo(points[index]?.[1] ?? NaN, 6);
    });
  });

  it('is read-only and fails without calibration or points', () => {
    const doc = calibrated();
    const ok = execute(doc, 'transform_coordinates', {
      points: [[1, 1]],
      direction: 'localToGrid',
    });
    expect(ok.document).toBe(doc);
    expect(ok.affected).toEqual([]);
    const none = execute(metricDocument(), 'transform_coordinates', {
      points: [[1, 1]],
      direction: 'localToGrid',
    });
    expect(none.summary).toMatch(/no site calibration/);
    expect(
      execute(doc, 'transform_coordinates', { points: [], direction: 'localToGrid' }).data,
    ).toBeUndefined();
  });
});

describe('import_survey_points coordinates', () => {
  it('converts grid input to local and refuses grid without calibration', () => {
    const refused = execute(metricDocument(), 'import_survey_points', {
      text: '1,1000,2020,5,X',
      coordinates: 'grid',
    });
    expect(refused.affected).toEqual([]);
    expect(refused.summary).toMatch(/site calibration/);
    const imported = execute(calibrated(), 'import_survey_points', {
      text: '1,1000,2020,5,X',
      coordinates: 'grid',
    });
    const group = imported.document.civil?.objects['pointGroup-1'];
    const position = group?.category === 'pointGroup' ? group.points[0]?.position : undefined;
    expect(position?.[0]).toBeCloseTo(10, 9);
    expect(position?.[1]).toBeCloseTo(0, 9);
    expect(position?.[2]).toBe(5);
    const local = execute(calibrated(), 'import_survey_points', { text: '1,10,0,5,X' });
    const kept = local.document.civil?.objects['pointGroup-1'];
    expect(kept?.category === 'pointGroup' ? kept.points[0]?.position : null).toEqual([10, 0, 5]);
  });
});

describe('exports use grid coordinates when calibrated', () => {
  const survey = '1,10,0,5,TOPO\n2,20,0,6,TOPO\n3,10,10,7,TOPO';

  function site(): CadDocument {
    return execute(calibrated(), 'import_survey_points', { text: survey }).document;
  }

  it('LandXML writes CoordinateSystem and grid N E, or local on request', () => {
    const grid = (execute(site(), 'export_landxml', {}).data as { text: string }).text;
    expect(grid).toContain(
      '<CoordinateSystem name="RGF93 / Lambert-93" epsgCode="2154" verticalDatum="NGF-IGN69"/>',
    );
    expect(grid).toContain('2020 1000 5</CgPoint>');
    const local = (
      execute(site(), 'export_landxml', { coordinates: 'local' }).data as { text: string }
    ).text;
    expect(local).toContain('>0 10 5</CgPoint>');
    expect(local).not.toContain('CoordinateSystem');
  });

  it('LandXML without CRS has no CoordinateSystem; CRS alone keeps local coordinates', () => {
    const plain = execute(metricDocument(), 'import_survey_points', { text: survey }).document;
    expect((execute(plain, 'export_landxml', {}).data as { text: string }).text).not.toContain(
      'CoordinateSystem',
    );
    const named = execute(plain, 'set_coordinate_system', { name: 'Local' }).document;
    const text = (execute(named, 'export_landxml', {}).data as { text: string }).text;
    expect(text).toContain('<CoordinateSystem name="Local"/>');
    expect(text).toContain('>0 10 5</CgPoint>');
  });

  it('civil DXF writes grid POINTs by default and local on request', () => {
    const dxf = (execute(site(), 'export_civil_dxf', {}).data as { text: string }).text;
    expect(dxf).toContain('2020');
    const local = (
      execute(site(), 'export_civil_dxf', { coordinates: 'local' }).data as { text: string }
    ).text;
    expect(local).not.toContain('2020');
  });

  it('LandXML moves alignments, structures, surfaces and pads into the grid', () => {
    let doc = calibrated(surveyedDocument());
    doc = execute(doc, 'add_alignment', {
      points: [
        [50, 100],
        [150, 100],
      ],
    }).document;
    doc = execute(doc, 'add_manhole', {
      location: [20, 30],
      invertElevation: 90,
      rimElevation: 92,
    }).document;
    doc = execute(doc, 'add_platform', {
      surfaceId: 'surface-1',
      boundary: [
        [40, 40],
        [60, 40],
        [60, 60],
        [40, 60],
      ],
      elevation: 100,
    }).document;
    const text = (execute(doc, 'export_landxml', {}).data as { text: string }).text;
    expect(text).toContain('<Start>2100 800</Start>');
    expect(text).toContain('<Center>2040 940</Center>');
  });
});
