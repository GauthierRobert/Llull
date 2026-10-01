import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildElevationDrawing, type ElevationSheet } from '@core/commands/building/elevation';
import { __resetIdCounter } from '@lib/id';

function hall(): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', {
    span: 12000,
    length: 18000,
    eaveHeight: 5000,
  }).document;
}

function box(): CadDocument {
  return execute(createEmptyDocument(), 'add_box', {
    position: [0, 0, 500],
    size: [2000, 1000, 1000],
  }).document;
}

beforeEach(() => __resetIdCounter());

describe('buildElevationDrawing', () => {
  it('projects a box onto the viewing plane, front faces only', () => {
    const doc = box();
    const south = buildElevationDrawing(doc, { direction: 'south' })!;
    // Only the 2 triangles of the south face are front-facing.
    expect(south.items).toHaveLength(2);
    expect(south.bounds).toEqual([-1000, 0, 1000, 1000]);
    // Its 4 outline edges are drawn, the diagonal is not.
    expect(south.items.flatMap((item) => item.edges)).toHaveLength(4);
    const east = buildElevationDrawing(doc, { direction: 'east' })!;
    expect(east.bounds).toEqual([-500, 0, 500, 1000]);
    const north = buildElevationDrawing(doc, { direction: 'north' })!;
    expect(north.bounds).toEqual([-1000, 0, 1000, 1000]);
    expect(buildElevationDrawing(doc, { direction: 'west' })!.items).toHaveLength(2);
  });

  it('sorts far faces first (painter) and clips at a section plane', () => {
    let doc = box();
    doc = execute(doc, 'add_box', { position: [0, 3000, 500], size: [500, 500, 500] }).document;
    const drawing = buildElevationDrawing(doc, { direction: 'south' })!;
    const depths = drawing.items.map((item) => item.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    // Cut through the first box at y = 0, viewed from the south: its near half is removed.
    const section = buildElevationDrawing(doc, { direction: 'south', cutAt: 0 })!;
    expect(section.cutLines.length).toBeGreaterThan(0);
    expect(section.items.every((item) => item.depth <= 0 + 1e-9)).toBe(true);
    // Only the cut outline remains when no face looks back at the viewer beyond the cut.
    const outline = buildElevationDrawing(box(), { direction: 'east', cutAt: 0 })!;
    expect(outline.items).toHaveLength(0);
    expect(outline.bounds).toEqual([-500, 0, 500, 1000]);
    // A cut beyond all geometry leaves nothing.
    expect(buildElevationDrawing(doc, { direction: 'south', cutAt: 10000 })).toBeNull();
  });

  it('excludes categories and hidden layers', () => {
    const doc = hall();
    const all = buildElevationDrawing(doc, { direction: 'south' })!;
    const frame = buildElevationDrawing(doc, { direction: 'south', exclude: ['panel'] })!;
    expect(frame.items.length).not.toBe(all.items.length);
    const layerId = doc.entities['panel-1:body']!.layerId;
    const hidden = execute(doc, 'set_layer_visibility', { id: layerId, visible: false });
    expect(hidden.affected.length, hidden.summary).toBeGreaterThan(0);
    expect(buildElevationDrawing(hidden.document, { direction: 'south' })!.items).toHaveLength(
      frame.items.length,
    );
  });

  it('returns null for a document without 3D geometry', () => {
    expect(buildElevationDrawing(createEmptyDocument(), { direction: 'north' })).toBeNull();
  });
});

describe('export_elevation_sheet', () => {
  it('draws a hall elevation with grids, level datum and title block', () => {
    const doc = hall();
    const snapshot = JSON.stringify(doc);
    const result = execute(doc, 'export_elevation_sheet', { direction: 'east' });
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const sheet = result.data as ElevationSheet;
    expect(sheet.filename).toBe('Untitled_project_East_elevation_A3_1-100.svg');
    expect(sheet.svg).toMatch(/^<svg xmlns/);
    expect(sheet.svg).toContain('<title>East elevation</title>');
    expect(sheet.svg).toContain('Level 0 +0.000');
    // Frame grid lines 1-4 are seen end-on from the east; column lines A/B are not.
    for (const label of ['>1<', '>2<', '>3<', '>4<']) expect(sheet.svg).toContain(label);
    expect(sheet.svg).not.toMatch(/text-anchor="middle">A</);
    expect(sheet.svg).toContain('fill-opacity="0.7"');
    expect(result.summary).toMatch(/visible face\(s\) at 1:100 on A3/);
  });

  it('draws a section with heavy cut lines and a custom title / scale', () => {
    const result = execute(hall(), 'export_elevation_sheet', {
      direction: 'south',
      cutAt: 9000,
      exclude: ['panel'],
      paper: 'A2',
      scale: 50,
    });
    const sheet = result.data as ElevationSheet;
    expect(sheet).toMatchObject({ paper: 'A2', scale: 50 });
    expect(sheet.svg).toContain('Section at y = 9000, viewed from south');
    expect(sheet.svg).toContain('class="section"');
    expect(sheet.svg).not.toContain('fill-opacity');
    const titled = execute(hall(), 'export_elevation_sheet', { title: 'Frame on line 2' });
    expect((titled.data as ElevationSheet).filename).toMatch(/^Untitled_project_Frame_on_line_2_/);
  });

  it.each([
    [{ direction: 'up' }, /direction must be/],
    [{ paper: 'B5' }, /paper must be/],
    [{ cutAt: Number.NaN }, /cutAt must be/],
    [{ exclude: 'panel' }, /exclude must be/],
    [{ scale: 0 }, /no 3D geometry|invalid scale/],
  ])('rejects %j', (params, message) => {
    const result = execute(hall(), 'export_elevation_sheet', params);
    expect(result.summary).toMatch(message);
    expect(result.data).toBeUndefined();
  });

  it('fails on an empty document', () => {
    expect(execute(createEmptyDocument(), 'export_elevation_sheet', {}).summary).toMatch(
      /no 3D geometry/,
    );
  });
});
