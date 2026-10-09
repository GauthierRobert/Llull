/** export_landxml / export_civil_dxf: LandXML 1.2 content (N E Z order, metres) and civil DXF. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CivilModel, ManholeObject, PipeObject } from '@core/model/civil';
import { execute } from '@core/commands/registry';
import { gridSurvey, metricDocument, surveyedDocument } from './fixtures';

function text(doc: CadDocument, name: string, params: unknown = {}): string {
  const data = execute(doc, name, params).data as { text: string; fileName: string };
  return data.text;
}

const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;

function manhole(id: string, name: string, x: number, y: number, invert: number): ManholeObject {
  return {
    id,
    category: 'manhole',
    name,
    entityIds: [],
    position: [x, y],
    rimElevation: invert + 2,
    invertElevation: invert,
    diameter: 1,
  };
}

/** Metric document whose civil model holds two manholes joined by one pipe (no geometry). */
function networkDocument(): CadDocument {
  const pipe: PipeObject = {
    id: 'pipe-1',
    category: 'pipe',
    name: 'P1',
    entityIds: [],
    fromId: 'manhole-1',
    toId: 'manhole-2',
    diameter: 0.3,
    material: 'PVC',
    manningN: 0.013,
    invertFrom: 99,
    invertTo: 98.5,
  };
  const civil: CivilModel = {
    objects: {
      'manhole-1': manhole('manhole-1', 'MH1', 0, 0, 99),
      'manhole-2': manhole('manhole-2', 'MH1', 50, 0, 98.5),
      'pipe-1': pipe,
    },
    order: ['manhole-1', 'manhole-2', 'pipe-1'],
    counters: {},
  };
  return { ...metricDocument(), civil };
}

describe('export_landxml', () => {
  it('writes CgPoints, the TIN points and faces in N E Z order', () => {
    const doc = surveyedDocument((x) => 100 + x * 0.05, 3, 10);
    const result = execute(doc, 'export_landxml', { date: '2026-10-09' });
    const data = result.data as { text: string; fileName: string };
    expect(data.fileName).toBe('Untitled_project.xml');
    expect(data.text).toContain('xmlns="http://www.landxml.org/schema/LandXML-1.2"');
    expect(data.text).toContain('linearUnit="meter"');
    expect(data.text).toContain('date="2026-10-09"');
    expect(count(data.text, /<CgPoint /g)).toBe(9);
    expect(count(data.text, /<P id=/g)).toBe(9);
    expect(count(data.text, /<F>/g)).toBe(8);
    // Point 7 is at easting 20, northing 0, elevation 101: written "N E Z".
    expect(data.text).toContain('<CgPoint name="7" code="TOPO">0 20 101</CgPoint>');
    expect(result.summary).toContain('9 CgPoints, 1 surface(s) with 8 faces');
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });

  it('converts document millimetres to metres', () => {
    const doc = execute(createEmptyDocument(), 'import_survey_points', {
      text: gridSurvey((x, y) => 50 + x + y, 2, 10),
    }).document;
    expect(doc.units).toBe('mm');
    const xml = text(doc, 'export_landxml');
    expect(xml).toContain('<CgPoint name="3" code="TOPO">0 10 60</CgPoint>');
    expect(xml).toContain('date="1970-01-01"');
  });

  it('writes the storm pipe network with unique names and inverts', () => {
    const xml = text(networkDocument(), 'export_landxml');
    expect(xml).toContain('<PipeNetwork name="Storm" pipeNetType="storm">');
    expect(xml).toContain('<Struct name="MH1 (manhole-1)" elevRim="101" elevSump="99">');
    expect(xml).toContain('<Center>0 50</Center>');
    expect(xml).toContain('<CircStruct diameter="1000"/>');
    expect(xml).toContain('<Invert elev="99" flowDir="out" refPipe="P1"/>');
    expect(xml).toContain('<Invert elev="98.5" flowDir="in" refPipe="P1"/>');
    expect(xml).toContain(
      '<Pipe name="P1" refStart="MH1 (manhole-1)" refEnd="MH1 (manhole-2)" length="50" slope="0.01">',
    );
    expect(xml).toContain('<CircPipe diameter="300" material="PVC" mannings="0.013"/>');
    expect(xml).not.toContain('<Surfaces>');
  });

  it('escapes names and uses the project name for the file', () => {
    let doc = execute(surveyedDocument(), 'set_project_info', {
      name: 'Site <A> & B',
      date: '2026-01-02',
    }).document;
    doc = execute(doc, 'import_survey_points', {
      name: 'Topo "east"',
      points: [{ x: 1, y: 2, z: 3 }],
    }).document;
    const data = execute(doc, 'export_landxml', {}).data as { text: string; fileName: string };
    expect(data.fileName).toBe('Site_A_B.xml');
    expect(data.text).toContain('<Project name="Site &lt;A&gt; &amp; B"/>');
    expect(data.text).toContain('<CgPoints name="Topo &quot;east&quot;">');
    expect(data.text).toContain('date="2026-01-02"');
  });

  it('refuses an empty civil model', () => {
    const doc = metricDocument();
    const result = execute(doc, 'export_landxml', {});
    expect(result.data).toBeUndefined();
    expect(result.summary).toMatch(/nothing to export/);
    expect(result.document).toBe(doc);
  });
});

describe('export_civil_dxf', () => {
  it('writes points, contours at their elevation, labels and TIN 3DFACEs on C-* layers', () => {
    const doc = surveyedDocument((x) => 100 + x * 0.05, 5, 10);
    const result = execute(doc, 'export_civil_dxf', {});
    const data = result.data as { text: string; fileName: string; layers: string[] };
    expect(data.fileName).toBe('Untitled_project_civil.dxf');
    expect(data.layers).toEqual(
      expect.arrayContaining(['C-TOPO-PNTS', 'C-TOPO-TINN', 'C-TOPO-MINR']),
    );
    const civilEntities = Object.values(doc.entities).filter((e) => e.tags?.includes('civil'));
    const mesh = civilEntities.find((e) => e.kind === 'mesh');
    if (mesh?.kind !== 'mesh') throw new Error('no TIN mesh');
    const faces = count(data.text, /^3DFACE$/gm);
    expect(faces).toBeGreaterThanOrEqual(mesh.mesh.indices.length / 3);
    expect(count(data.text, /^POINT$/gm)).toBe(25);
    const contour = civilEntities.find(
      (e) => e.kind === 'polyline' && e.layerId === 'layer-C-TOPO-MINR',
    );
    if (contour?.kind !== 'polyline') throw new Error('no contour');
    const lines = data.text.split('\n');
    const start = lines.findIndex(
      (line, index) => line === 'POLYLINE' && lines[index + 2] === 'C-TOPO-MINR',
    );
    // Header point: 10 x / 20 y / 30 elevation.
    expect(lines.slice(start, start + 14)).toContain(String(contour.position[2]));
    expect(result.summary).toMatch(/^DXF Untitled_project_civil\.dxf: \d+ entities/);
    expect(result.document).toBe(doc);
  });

  it('refuses a document without civil entities', () => {
    const doc = execute(createEmptyDocument(), 'draw_line', {
      start: [0, 0],
      end: [1, 1],
    }).document;
    const result = execute(doc, 'export_civil_dxf', {});
    expect(result.data).toBeUndefined();
    expect(result.summary).toMatch(/nothing to export/);
  });
});
