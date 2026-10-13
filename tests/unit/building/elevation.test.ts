import { describe, expect, it } from 'vitest';
import { portalHall } from '../../helpers/portalHall';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildElevationDrawing } from '@aec/building/drawings/elevationProjection';
import { chainLoops } from '@core/geometry/planeEdges';
import type { DrawingPrimitive } from '@core/model/drawing';
import type { ElevationSheet } from '@aec/building/drawings/elevation';

function hall(): CadDocument {
  return portalHall({ span: 12000, length: 18000, eaveHeight: 5000 });
}

function box(): CadDocument {
  return execute(createEmptyDocument(), 'add_box', {
    position: [0, 0, 500],
    size: [2000, 1000, 1000],
  }).document;
}

const ofStyle = (drawing: { primitives: DrawingPrimitive[] }, style: string): DrawingPrimitive[] =>
  drawing.primitives.filter((p) => p.style === style);

describe('buildElevationDrawing', () => {
  it('draws the visible outline of a box seen from each side, no hidden edges', () => {
    const doc = box();
    const south = buildElevationDrawing(doc, { direction: 'south' })!;
    expect(south.bounds).toEqual([-1000, 0, 1000, 1000]);
    // The 4 outline edges of the south face (back edges coincide and are drawn once).
    expect(ofStyle(south, 'visible')).toHaveLength(4);
    expect(ofStyle(south, 'hidden')).toHaveLength(0);
    expect(buildElevationDrawing(doc, { direction: 'east' })!.bounds).toEqual([-500, 0, 500, 1000]);
    expect(buildElevationDrawing(doc, { direction: 'north' })!.bounds).toEqual([-1000, 0, 1000, 1000]);
    expect(ofStyle(buildElevationDrawing(doc, { direction: 'west' })!, 'visible')).toHaveLength(4);
  });

  it('removes edges hidden by nearer solids and cuts a section', () => {
    let doc = box();
    // A small box behind the first one, seen from the south: entirely hidden, so not drawn.
    doc = execute(doc, 'add_box', { position: [0, 3000, 500], size: [500, 500, 500] }).document;
    const drawing = buildElevationDrawing(doc, { direction: 'south' })!;
    expect(ofStyle(drawing, 'visible')).toHaveLength(4);
    // Cut through the first box at y = 0, viewed from the south: its cut face is hatched.
    const section = buildElevationDrawing(doc, { direction: 'south', cutAt: 0 })!;
    expect(section.primitives.some((p) => p.type === 'polygon' && p.fill === 'hatch')).toBe(true);
    const outline = buildElevationDrawing(box(), { direction: 'east', cutAt: 0 })!;
    expect(outline.bounds).toEqual([-500, 0, 500, 1000]);
    // A cut beyond all geometry leaves nothing.
    expect(buildElevationDrawing(doc, { direction: 'south', cutAt: 10000 })).toBeNull();
  });

  it('excludes categories and hidden layers', () => {
    const doc = hall();
    const all = buildElevationDrawing(doc, { direction: 'south' })!;
    const frame = buildElevationDrawing(doc, { direction: 'south', exclude: ['panel'] })!;
    expect(frame.primitives.length).not.toBe(all.primitives.length);
    const layerId = doc.entities['panel-1:body']!.layerId;
    const hidden = execute(doc, 'update_layer', { id: layerId, visible: false });
    expect(hidden.affected.length, hidden.summary).toBeGreaterThan(0);
    expect(buildElevationDrawing(hidden.document, { direction: 'south' })!.primitives).toHaveLength(frame.primitives.length);
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
    expect(result.summary).toMatch(/drawn line\(s\) \/ cut face\(s\) at 1:100 on A3/);
    expect(sheet.svg).toContain('class="cut-line"');
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
    expect(sheet.svg).toContain('class="cut-hatch"');
    expect(sheet.svg).not.toContain('fill-opacity');
    const titled = execute(hall(), 'export_elevation_sheet', { title: 'Frame on line 2' });
    expect((titled.data as ElevationSheet).filename).toMatch(/^Untitled_project_Frame_on_line_2_/);
  });

  it.each([
    [{ direction: 'up' }, /export_elevation_sheet rejected: invalid params — direction/],
    [{ paper: 'B5' }, /rejected: invalid params — paper/],
    [{ cutAt: Number.NaN }, /rejected: invalid params — cutAt/],
    [{ exclude: 'panel' }, /rejected: invalid params — exclude/],
    [{ scale: 0 }, /no 3D geometry|invalid scale/],
  ])('rejects %j', (params, message) => {
    const result = execute(hall(), 'export_elevation_sheet', params);
    expect(result.summary).toMatch(message);
    expect(result.data).toBeUndefined();
  });

  it('draws a machine part without a ground line, with a scale bar that fits small scales', () => {
    const sheet = execute(box(), 'export_elevation_sheet', { direction: 'south', scale: 2 }).data as ElevationSheet;
    expect(sheet.svg).not.toContain('class="ground"');
    // 1:2 → 5 × 20 mm steps (a 50 mm bar on paper), labelled in mm.
    expect(sheet.svg).toContain('>100 mm</text>');
    const full = execute(box(), 'export_elevation_sheet', { direction: 'south', scale: 1 }).data as ElevationSheet;
    expect(full.svg).toContain('>50 mm</text>');
    const hallSheet = execute(hall(), 'export_elevation_sheet', {}).data as ElevationSheet;
    expect(hallSheet.svg).toContain('class="ground"');
  });

  it('fails on an empty document', () => {
    expect(execute(createEmptyDocument(), 'export_elevation_sheet', {}).summary).toMatch(/no 3D geometry/);
  });
});

describe('section poché', () => {
  it('chains cut segments into closed loops', () => {
    const loops = chainLoops(
      [
        [
          [0, 0],
          [1, 0],
        ],
        [
          [1, 1],
          [0, 1],
        ],
        [
          [1, 0],
          [1, 1],
        ],
        [
          [0, 1],
          [0, 0],
        ],
        [
          [5, 5],
          [6, 5],
        ],
      ],
      0.01,
    );
    expect(loops).toEqual([
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ]);
  });

  it('fills cut steel solid and concrete hatched', () => {
    let doc = execute(createEmptyDocument(), 'add_steel_member', {
      profile: 'SHS100x5',
      role: 'column',
      start: [0, 0, 0],
      end: [0, 0, 3000],
    }).document;
    doc = execute(doc, 'add_footing', { location: [3000, 0] }).document;
    const drawing = buildElevationDrawing(doc, { direction: 'south', cutAt: 0 })!;
    const cuts = drawing.primitives.filter((p) => p.type === 'polygon');
    // The plane y = 0 cuts the tube's two side walls: two solid steel strips.
    expect(cuts.filter((p) => p.type === 'polygon' && p.fill === 'solid')).toHaveLength(2);
    expect(cuts.some((p) => p.type === 'polygon' && p.fill === 'hatch')).toBe(true);
    const sheet = execute(doc, 'export_elevation_sheet', { direction: 'south', cutAt: 0 }).data as ElevationSheet;
    expect(sheet.svg).toContain('class="cut"');
    expect(sheet.svg).toContain('class="cut-hatch"');
    expect(sheet.svg).toContain('id="hatch-concrete"');
  });
});
