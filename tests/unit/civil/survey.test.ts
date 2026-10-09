import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import { parseSurvey } from '@aec/civil/surveyParse';
import { formatStation } from '@aec/civil/model';
import { civilObjectOf } from '@aec/civil/integrity';
import { gridSurvey, metricDocument, surveyedDocument } from './fixtures';

describe('parseSurvey', () => {
  it('reads PENZD with a header, comments and descriptions', () => {
    const parsed = parseSurvey(
      'PT,E,N,Z,DESC\n# comment\n1,100,200,10.5,EP left\n\n2,101,201,10.6\nbad,line\n',
      'PENZD',
    );
    expect(parsed.points).toEqual([
      { number: '1', easting: 100, northing: 200, elevation: 10.5, code: 'EP left' },
      { number: '2', easting: 101, northing: 201, elevation: 10.6 },
    ]);
    expect(parsed.rejectedLines).toEqual([6]);
  });

  it('swaps northing / easting for PNEZ and numbers unnumbered formats', () => {
    expect(parseSurvey('7;200;100;5', 'PNEZ').points[0]).toMatchObject({
      number: '7',
      easting: 100,
      northing: 200,
    });
    const tabbed = parseSurvey('100\t200\t3\n101\t201\t4', 'ENZ').points;
    expect(tabbed.map((point) => point.number)).toEqual(['1', '2']);
    expect(parseSurvey('200 100 3', 'NEZ').points[0]?.easting).toBe(100);
  });
});

describe('formatStation', () => {
  it('formats km+m', () => {
    expect(formatStation(0)).toBe('0+000.00');
    expect(formatStation(1234.5)).toBe('1+234.50');
    expect(formatStation(-20)).toBe('-0+020.00');
  });
});

describe('import_survey_points', () => {
  it('imports text and direct points, converting the source unit', () => {
    const doc = createEmptyDocument(); // mm document
    const result = execute(doc, 'import_survey_points', {
      name: 'Topo',
      text: '1,1,2,3,TOPO',
      points: [{ x: 4, y: 5, z: 6, code: 'TREE' }],
    });
    const group = result.document.civil?.objects['pointGroup-1'];
    expect(group?.category).toBe('pointGroup');
    if (group?.category !== 'pointGroup') return;
    expect(group.points.map((point) => point.position)).toEqual([
      [1000, 2000, 3000],
      [4000, 5000, 6000],
    ]);
    expect(group.points[1]).toMatchObject({ number: '2', code: 'TREE' });
    expect(result.affected[0]).toBe('pointGroup-1');
    expect(result.affected).toContain('pointGroup-1:p0');
    expect(result.summary).toMatch(/Imported 2 survey points as Topo/);
    expect(result.document.layers['layer-C-TOPO-PNTS']).toBeDefined();
  });

  it('reports skipped lines and refuses files without points', () => {
    const doc = metricDocument();
    const partial = execute(doc, 'import_survey_points', { text: '1,0,0,0\nx,y\n2,1,1,1' });
    expect(partial.summary).toMatch(/Skipped 1 unreadable line\(s\): 2/);
    const none = execute(doc, 'import_survey_points', { text: 'a,b,c\nd,e,f' });
    expect(none.document).toBe(doc);
    expect(none.summary).toMatch(/no valid point found .*unreadable lines 2/);
    expect(execute(doc, 'import_survey_points', {}).summary).toMatch(/format PENZD\)/);
  });

  it('keeps large groups as data only', () => {
    const result = execute(metricDocument(), 'import_survey_points', {
      text: gridSurvey(() => 1, 46, 1),
    });
    expect(result.summary).toMatch(/2116 survey points.*Markers not drawn/);
    expect(result.document.civil?.objects['pointGroup-1']?.entityIds).toEqual([]);
  });

  it('refuses more than 50000 points', () => {
    const points = Array.from({ length: 50001 }, (_, index) => ({ x: index, y: 0, z: 0 }));
    const doc = metricDocument();
    expect(execute(doc, 'import_survey_points', { points }).summary).toMatch(/50000-point limit/);
  });

  it('is pure', () => {
    const doc = metricDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'import_survey_points', { text: '1,0,0,0' });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('create_surface', () => {
  it('builds a TIN with contours and labels', () => {
    const doc = surveyedDocument((x) => 100 + x * 0.05);
    const surface = doc.civil?.objects['surface-1'];
    expect(surface?.category).toBe('surface');
    const entities = surface?.entityIds ?? [];
    expect(entities[0]).toBe('surface-1:tin');
    // 100 m wide, 5 m rise: contours at 101..104 (100 and 105 lie on the edge).
    const contours = entities.filter((id) => /:c\d+_\d+$/.test(id));
    expect(contours.length).toBeGreaterThanOrEqual(4);
    expect(entities.some((id) => id.endsWith('_label'))).toBe(true);
    expect(doc.layers['layer-C-TOPO-MAJR']).toBeDefined();
    expect(civilObjectOf(doc, 'surface-1:tin')).toBe('surface-1');
    expect(civilObjectOf(doc, 'nope')).toBeNull();
  });

  it('accepts explicit groups, extra points, boundary and edge limit', () => {
    const base = metricDocument();
    const result = execute(base, 'create_surface', {
      name: 'Design',
      points: [
        [0, 0, 1],
        [10, 0, 2],
        [0, 10, 3],
        [10, 10, 4],
      ],
      pointGroupIds: [],
      boundary: [
        [-1, -1],
        [11, -1],
        [11, 11],
        [-1, 11],
      ],
      maxEdgeLength: 50,
      contourInterval: 0.5,
      majorEvery: 0,
    });
    expect(result.summary).toMatch(
      /Created surface Design \(surface-1\): 4 points, 2 triangles; contours every 0.5 m/,
    );
    expect(result.data).toEqual({ surfaceId: 'surface-1' });
  });

  it('refuses unknown groups, bad options and degenerate input', () => {
    const doc = metricDocument();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ pointGroupIds: ['pointGroup-9'] }, /unknown point group\(s\) pointGroup-9/],
      [
        {
          boundary: [
            [0, 0],
            [1, 1],
          ],
        },
        /boundary must be a simple polygon/,
      ],
      [{ maxEdgeLength: 0 }, /maxEdgeLength must be > 0/],
      [{ contourInterval: -1 }, /contourInterval must be > 0/],
      [{ majorEvery: -1 }, /majorEvery must be >= 0/],
      [
        {
          points: [
            [0, 0, 0],
            [1, 1, 1],
            [2, 2, 2],
          ],
        },
        /no triangle/,
      ],
    ];
    for (const [params, message] of cases) {
      const result = execute(doc, 'create_surface', params);
      expect(result.document, JSON.stringify(params)).toBe(doc);
      expect(result.summary).toMatch(message);
    }
  });
});

describe('update_surface', () => {
  it('changes contours, boundary, edge limit and adds points', () => {
    const doc = surveyedDocument();
    const updated = execute(doc, 'update_surface', {
      surfaceId: 'surface-1',
      name: 'EG',
      contourInterval: 0.5,
      majorEvery: 2,
      boundary: [
        [0, 0],
        [50, 0],
        [50, 50],
        [0, 50],
      ],
      maxEdgeLength: 30,
      addPoints: [[200, 200, 0]],
    });
    expect(updated.summary).toMatch(/Updated surface EG \(surface-1\): 122 points/);
    const surface = updated.document.civil?.objects['surface-1'];
    expect(surface?.category === 'surface' && surface.contourInterval).toBe(0.5);
    const cleared = execute(updated.document, 'update_surface', {
      surfaceId: 'surface-1',
      boundary: [],
      maxEdgeLength: 0,
    });
    const after = cleared.document.civil?.objects['surface-1'];
    expect(after && 'boundary' in after).toBe(false);
    expect(after && 'maxEdgeLength' in after).toBe(false);
  });

  it('refuses unknown surfaces, bad options, no-ops and empty results', () => {
    const doc = surveyedDocument();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ surfaceId: 'surface-9' }, /no surface surface-9/],
      [{ surfaceId: 'surface-1', contourInterval: 0 }, /contourInterval must be > 0/],
      [{ surfaceId: 'surface-1' }, /nothing to change/],
      [{ surfaceId: 'surface-1', maxEdgeLength: 0.001 }, /would have no triangle/],
    ];
    for (const [params, message] of cases) {
      const result = execute(doc, 'update_surface', params);
      expect(result.document).toBe(doc);
      expect(result.summary).toMatch(message);
    }
  });
});

describe('surface queries', () => {
  it('samples elevations and slopes', () => {
    const doc = surveyedDocument((x) => 100 + x * 0.05);
    const result = execute(doc, 'surface_elevation', {
      surfaceId: 'surface-1',
      points: [
        [50, 50],
        [500, 0],
        [10, 10],
        [20, 20],
        [30, 30],
        [40, 40],
      ],
    });
    const data = result.data as {
      points: Array<{ elevation: number | null; slopePercent: number | null }>;
    };
    expect(data.points[0]?.elevation).toBeCloseTo(102.5, 6);
    expect(data.points[0]?.slopePercent).toBeCloseTo(5, 2);
    expect(data.points[1]).toMatchObject({ elevation: null, slopePercent: null });
    expect(result.summary).toMatch(/102.500 m \(5 %\); outside; .*; …\s*\(1 outside the surface\)/);
    expect(result.document).toBe(doc);
    expect(execute(doc, 'surface_elevation', { surfaceId: 'x', points: [[0, 0]] }).summary).toMatch(
      /no surface x/,
    );
  });

  it('reports surface statistics', () => {
    const doc = surveyedDocument((x) => 100 + x * 0.05);
    const result = execute(doc, 'surface_report', { surfaceId: 'surface-1' });
    expect(result.data).toMatchObject({
      points: 121,
      triangles: 200,
      planAreaM2: 10000,
      minElevationM: 100,
      maxElevationM: 105,
      meanElevationM: 102.5,
      meanSlopePercent: 5,
    });
    expect(execute(doc, 'surface_report', { surfaceId: 'x' }).summary).toMatch(/no surface x/);
  });
});

describe('civil model management', () => {
  it('describes the model, filtered by category', () => {
    const doc = surveyedDocument();
    const all = execute(doc, 'describe_civil', {});
    expect(all.summary).toMatch(/1 pointGroup, 1 surface/);
    const surfaces = execute(doc, 'describe_civil', { category: 'surface' });
    expect((surfaces.data as { objects: unknown[] }).objects).toEqual([
      {
        id: 'surface-1',
        category: 'surface',
        name: 'EG 1',
        references: ['pointGroup-1'],
        entities: expect.any(Number),
      },
    ]);
    expect(execute(metricDocument(), 'describe_civil', {}).summary).toBe(
      'The civil model is empty.',
    );
  });

  it('deletes objects, refusing referenced ones unless cascading', () => {
    const doc = surveyedDocument();
    expect(execute(doc, 'delete_civil_object', { id: 'nope' }).summary).toMatch(/no civil object/);
    const refused = execute(doc, 'delete_civil_object', { id: 'pointGroup-1' });
    expect(refused.document).toBe(doc);
    expect(refused.summary).toMatch(/surface-1 reference pointGroup-1/);
    const cascaded = execute(doc, 'delete_civil_object', { id: 'pointGroup-1', cascade: true });
    expect(cascaded.affected).toEqual(['pointGroup-1', 'surface-1']);
    expect(Object.keys(cascaded.document.entities)).toEqual([]);
    // Ids are never reused.
    const again = execute(cascaded.document, 'import_survey_points', { text: '1,0,0,0' });
    expect(again.affected[0]).toBe('pointGroup-2');
  });

  it('guards generated geometry and clears with the document', () => {
    const doc = surveyedDocument();
    const refused = execute(doc, 'delete_entity', { id: 'surface-1:tin' });
    expect(refused.summary).toMatch(/generated by civil object\(s\) surface-1/);
    const cleared = execute(doc, 'clear_document', {});
    expect(cleared.document.civil).toBeUndefined();
  });

  it('round-trips through save / load without storing derived geometry', () => {
    const doc = surveyedDocument();
    const json = serializeDocument(doc);
    const stored = JSON.parse(json) as { document: { entities: Record<string, unknown> } };
    expect(Object.keys(stored.document.entities)).toEqual([]);
    const loaded = deserializeDocument(json);
    expect(Object.keys(loaded.entities).sort()).toEqual(Object.keys(doc.entities).sort());
    expect(loaded.civil).toEqual(doc.civil);
  });

  it('rejects files with an invalid civil model', () => {
    const doc = surveyedDocument();
    const envelope = JSON.parse(serializeDocument(doc)) as {
      document: { civil: { objects: Record<string, Record<string, unknown>> } };
    };
    const surface = envelope.document.civil.objects['surface-1'];
    if (surface) surface['contourInterval'] = -1;
    expect(() => deserializeDocument(JSON.stringify(envelope))).toThrow(
      /contourInterval must be > 0/,
    );
  });
});
