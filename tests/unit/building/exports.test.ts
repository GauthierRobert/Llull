import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { boundsOf, dimensionLabel } from '@aec/planArchitectural';
import { buildPlanDrawing } from '@aec/planDrawing';
import { type DxfExport } from '@aec/dxfExport';
import { DxfWriter, dxfLayerName, dxfText } from '@aec/dxfWriter';
import { escapeXml } from '@lib/escapeXml';
import { fitScale, type PlanSheet } from '@aec/sheet';
import { type IfcExport } from '@aec/ifcBuild';
import { ifcGuid, ifcReal, ifcString } from '@aec/ifcStep';
import { fileSlug } from '@aec/model';

/** True for code points XML 1.0 forbids (C0 controls other than tab, LF, CR; U+FFFE; U+FFFF). */
function isIllegalXmlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    code === 0xfffe ||
    code === 0xffff
  );
}

function run(doc: CadDocument, name: string, params: unknown): CadDocument {
  return execute(doc, name, params).document;
}

function house(): CadDocument {
  let doc = run(createEmptyDocument(), 'set_project_info', {
    name: 'Maison Dupont',
    author: 'BTP Martin',
    date: '2026-10-01',
  });
  doc = run(doc, 'add_level', { name: 'Rez-de-chaussée' });
  doc = run(doc, 'add_grid_system', { xSpacings: [5000, 5000], ySpacings: [8000] });
  doc = run(doc, 'draw_walls', {
    points: [
      [0, 0],
      [10000, 0],
      [10000, 8000],
      [0, 8000],
    ],
    closed: true,
    thickness: 300,
  });
  doc = run(doc, 'add_door', { wallId: 'wall-1', offset: 2000 });
  doc = run(doc, 'add_door', { wallId: 'wall-3', offset: 2000, swing: 'right' });
  doc = run(doc, 'add_window', { wallId: 'wall-1', offset: 7000 });
  doc = run(doc, 'add_window', { wallId: 'wall-2', offset: 4000, sillHeight: 1500, height: 600 });
  doc = run(doc, 'add_slab', { wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'] });
  doc = run(doc, 'add_column', { location: [5000, 4000] });
  doc = run(doc, 'add_column', { location: [2000, 4000], shape: 'circular' });
  doc = run(doc, 'add_beam', { start: [0, 4000], end: [10000, 4000] });
  doc = run(doc, 'add_stair', { start: [6000, 1000], riserCount: 12 });
  doc = run(doc, 'add_room', {
    name: 'Séjour',
    boundary: [
      [150, 150],
      [9850, 150],
      [9850, 7850],
      [150, 7850],
    ],
  });
  return doc;
}

describe('plan drawing', () => {
  it('cuts walls at door gaps and window gaps but not high windows', () => {
    const plan = buildPlanDrawing(house(), undefined)!;
    expect(plan.level.name).toBe('Rez-de-chaussée');
    const wallPolygons = plan.primitives.filter(
      (p) => p.type === 'polygon' && p.layer === 'A-WALL',
    );
    // wall-1: door + window gaps → 3 pieces; wall-3: door → 2; wall-2 high window (sill 1.5 m) → 1; wall-4 → 1
    expect(wallPolygons).toHaveLength(7);
    expect(plan.primitives.filter((p) => p.type === 'arc')).toHaveLength(2);
    expect(plan.primitives.filter((p) => p.layer === 'A-GLAZ')).toHaveLength(6);
    expect(plan.primitives.some((p) => p.type === 'circle' && p.layer === 'S-COLS')).toBe(true);
    expect(
      plan.primitives.some(
        (p) => p.type === 'polygon' && p.layer === 'S-BEAM' && p.style === 'hidden',
      ),
    ).toBe(true);
    expect(plan.primitives.some((p) => p.type === 'text' && p.content === 'UP 12R')).toBe(true);
    expect(plan.primitives.some((p) => p.type === 'text' && p.content === '001 · 74.69 m²')).toBe(
      true,
    );
    const dims = plan.primitives
      .filter((p) => p.type === 'dimension')
      .map((p) => p.type === 'dimension' && p.label);
    expect(dims).toEqual(['10300', '8300', '5000', '5000', '8000']);
  });

  it('returns null for an unknown level and can skip dimensions', () => {
    const doc = house();
    expect(buildPlanDrawing(doc, 'level-9')).toBeNull();
    expect(buildPlanDrawing(createEmptyDocument(), undefined)).toBeNull();
    const plain = buildPlanDrawing(doc, 'level-1', { dimensions: false })!;
    expect(plain.primitives.some((p) => p.type === 'dimension')).toBe(false);
  });

  it('helpers', () => {
    expect(boundsOf([])).toEqual([0, 0, 0, 0]);
    let metres = run(createEmptyDocument(), 'set_units', { units: 'm' });
    expect(dimensionLabel(metres, 2.45)).toBe('2450');
    metres = run(metres, 'add_wall', { start: [0, 0], end: [4, 0] });
    expect(
      buildPlanDrawing(metres, undefined)!.primitives.flatMap((p) =>
        p.type === 'dimension' ? [p.label] : [],
      ),
    ).toEqual(['4200', '200']);
    expect(fileSlug('Rez-de-chaussée / 1', 'x')).toBe('Rez-de-chaussee_1');
    expect(fileSlug('***', 'x')).toBe('x');
  });
});

describe('export_dxf', () => {
  it('writes an R12 DXF with AIA layers, entities and the 2D drafting', () => {
    let doc = house();
    doc = run(doc, 'draw_line', { start: [0, -3000], end: [10000, -3000] });
    doc = run(doc, 'draw_rectangle', { width: 1000, height: 500, position: [0, -5000] });
    doc = run(doc, 'draw_circle', { center: [0, 0], radius: 300, position: [12000, 0] });
    doc = run(doc, 'draw_arc', { center: [0, 0], radius: 300, startAngle: 0, endAngle: 1.5 });
    doc = run(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    });
    doc = run(doc, 'draw_ellipse', { center: [0, 0], radiusX: 2, radiusY: 1 });
    doc = run(doc, 'draw_spline', {
      points: [
        [0, 0],
        [1, 2],
        [3, 1],
      ],
    });
    doc = run(doc, 'draw_point', { position: [5, 5] });
    doc = run(doc, 'add_text', { content: 'Note ²', position: [0, -6000, 0], height: 200 });
    const snapshot = structuredClone(doc);
    const result = execute(doc, 'export_dxf', {});
    expect(doc).toEqual(snapshot);
    expect(result.document).toBe(doc);
    const data = result.data as DxfExport;
    expect(data.filename).toBe('Maison_Dupont_Rez-de-chaussee.dxf');
    expect(data.dxf.startsWith('0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009')).toBe(true);
    expect(data.dxf.trimEnd().endsWith('0\nEOF')).toBe(true);
    expect(data.layers).toEqual(
      expect.arrayContaining(['A-WALL', 'A-DOOR', 'A-GLAZ', 'S-GRID', 'A-ANNO-DIMS', 'Layer_0']),
    );
    expect(data.dxf).toContain('\nARC\n');
    expect(data.dxf).toContain('\nPOINT\n');
    expect(data.dxf).toContain('Note \\U+00B2');
    expect(data.dxf).toMatch(/\nLAYER\n2\nS-BEAM\n70\n0\n62\n4\n6\nDASHED/);
    // DXF is a strict alternation of group codes and values.
    const lines = data.dxf.trimEnd().split('\n');
    expect(lines.length % 2).toBe(0);
    for (let index = 0; index < lines.length; index += 2) expect(lines[index]).toMatch(/^\d+$/);
  });

  it('exports drafting-only documents and fails cleanly', () => {
    const drafting = run(createEmptyDocument(), 'draw_line', { start: [0, 0], end: [1, 0] });
    const result = execute(drafting, 'export_dxf', {});
    expect((result.data as DxfExport).filename).toBe('Untitled_project_drafting.dxf');
    expect(execute(drafting, 'export_dxf', { levelId: 'level-1' }).summary).toMatch(/no level/);
    expect(execute(createEmptyDocument(), 'export_dxf', {}).summary).toMatch(/nothing to export/);
    expect(execute(drafting, 'export_dxf', { includeDrafting: false }).summary).toMatch(/nothing/);
  });

  it('name and text helpers', () => {
    expect(dxfLayerName('Layer 0 / walls')).toBe('Layer_0___walls');
    expect(dxfLayerName('')).toBe('0');
    expect(dxfText('a\nb é')).toBe('a b \\U+00E9');
  });
});

describe('export_plan_sheet', () => {
  it('auto-fits a standard scale and draws the title block', () => {
    const result = execute(house(), 'export_plan_sheet', {});
    const sheet = result.data as PlanSheet;
    expect(sheet).toMatchObject({ paper: 'A3', scale: 100, levelId: 'level-1' });
    expect(sheet.filename).toBe('Maison_Dupont_Rez-de-chaussee_A3_1-100.svg');
    expect(sheet.svg).toContain('width="420mm" height="297mm"');
    expect(sheet.svg).toContain('id="title-block"');
    expect(sheet.svg).toContain('Maison Dupont');
    expect(sheet.svg).toContain('1:100 @ A3');
    expect(sheet.svg).toContain('class="cut"');
    expect(sheet.svg).toContain('class="hidden"');
    expect(sheet.svg).toMatch(/<path d="M [\d.]+ [\d.]+ A /);
    expect(sheet.svg).toContain('id="north-arrow"');
    expect(sheet.svg).toContain('id="scale-bar"');
  });

  it('honours paper, scale and title; rejects bad input', () => {
    const doc = house();
    const sheet = execute(doc, 'export_plan_sheet', { paper: 'A1', scale: 50, title: 'Plan <RDC>' })
      .data as PlanSheet;
    expect(sheet.svg).toContain('width="841mm"');
    expect(sheet.svg).toContain('Plan &lt;RDC&gt;');
    expect(execute(doc, 'export_plan_sheet', { paper: 'B5' }).summary).toMatch(
      /rejected: invalid params — paper/,
    );
    expect(execute(doc, 'export_plan_sheet', { scale: 0 }).summary).toMatch(/invalid scale/);
    expect(execute(createEmptyDocument(), 'export_plan_sheet', {}).data).toBeUndefined();
  });

  it('fitScale extends past the standard scales (1-2-5) and escapeXml escapes', () => {
    expect(fitScale(1e9, 1e9, { x: 0, y: 0, width: 100, height: 100 })).toBe(20_000_000);
    expect(fitScale(1000, 1000, { x: 0, y: 0, width: 100, height: 100 })).toBe(20);
    expect(escapeXml('a&"b')).toBe('a&amp;&quot;b');
  });
});

describe('export_ifc', () => {
  it('writes a schema-shaped IFC4 file with spatial structure, voids and fills', () => {
    let doc = house();
    doc = run(doc, 'add_level', { name: 'Toit' });
    doc = run(doc, 'add_slab', {
      boundary: [
        [0, 0],
        [10000, 0],
        [10000, 8000],
      ],
      role: 'roof',
    });
    const result = execute(doc, 'export_ifc', {});
    const data = result.data as IfcExport;
    expect(data.filename).toBe('Maison_Dupont.ifc');
    expect(data.ifc).toMatch(/^ISO-10303-21;\nHEADER;/);
    expect(data.ifc).toContain("FILE_SCHEMA(('IFC4'));");
    expect(data.ifc).toContain("'2026-10-01T00:00:00'");
    for (const type of [
      'IFCPROJECT',
      'IFCSITE',
      'IFCBUILDING(',
      'IFCBUILDINGSTOREY',
      'IFCWALL(',
      'IFCDOOR(',
      'IFCWINDOW(',
      'IFCOPENINGELEMENT',
      'IFCRELVOIDSELEMENT',
      'IFCRELFILLSELEMENT',
      'IFCSLAB(',
      'IFCCOLUMN(',
      'IFCBEAM(',
      'IFCSTAIR(',
      'IFCSPACE(',
      'IFCMATERIAL(',
      'IFCCIRCLEPROFILEDEF',
    ]) {
      expect(data.ifc).toContain(type);
    }
    expect(data.ifc).toContain('.ROOF.');
    expect(data.ifc).toContain('.SINGLE_SWING_RIGHT.');
    expect(data.productCount).toBe(15);
    // Every #reference points at a defined record.
    const defined = new Set([...data.ifc.matchAll(/^#(\d+)=/gm)].map((match) => match[1]));
    const referenced = [...data.ifc.matchAll(/#(\d+)(?!=)/g)].map((match) => match[1]);
    expect(referenced.every((id) => defined.has(id))).toBe(true);
    expect(defined.size).toBe(data.entityCount);
    // GlobalIds are unique and stable.
    const guids = [...data.ifc.matchAll(/\('([0-9A-Za-z_$]{22})'/g)].map((match) => match[1]);
    expect(new Set(guids).size).toBe(guids.length);
    expect((execute(doc, 'export_ifc', {}).data as IfcExport).ifc).toBe(data.ifc);
    expect(result.summary).toMatch(/2 storey/);
  });

  it('fails without levels; honours an explicit timestamp', () => {
    expect(execute(createEmptyDocument(), 'export_ifc', {}).summary).toMatch(/no levels/);
    const doc = run(createEmptyDocument(), 'add_level', {});
    const data = execute(doc, 'export_ifc', { timestamp: '2027-01-02T03:04:05' }).data as IfcExport;
    expect(data.ifc).toContain("'2027-01-02T03:04:05'");
    expect((execute(doc, 'export_ifc', {}).data as IfcExport).ifc).toContain(
      "'1970-01-01T00:00:00'",
    );
  });

  it('encoding helpers', () => {
    expect(ifcGuid('a')).toHaveLength(22);
    expect(ifcGuid('a')).not.toBe(ifcGuid('b'));
    expect(ifcGuid('a')).toMatch(/^[0-3]/);
    expect(ifcString("l'é\\")).toBe("'l''\\X2\\00E9\\X0\\\\\\'");
    expect(ifcReal(3)).toBe('3.');
    expect(ifcReal(0.5)).toBe('0.5');
    expect(ifcReal(-0)).toBe('0.');
    expect(ifcReal(1e21)).toBe('1.E+21');
  });
});

describe('identity', () => {
  it('two projects never share IFC GlobalIds; one project keeps them stable', () => {
    const a = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [1000, 0] });
    const b = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [1000, 0] });
    const guids = (doc: CadDocument): string[] =>
      [
        ...(execute(doc, 'export_ifc', {}).data as IfcExport).ifc.matchAll(
          /\('([0-9A-Za-z_$]{22})'/g,
        ),
      ].map((match) => match[1]!);
    const shared = guids(a).filter((guid) => guids(b).includes(guid));
    expect(shared).toEqual([]);
    expect(guids(a)).toEqual(guids(run(a, 'set_project_info', { client: 'X' })));
  });

  it('element and level numbers are never reused after a delete', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [1000, 0] });
    doc = run(doc, 'add_wall', { start: [0, 500], end: [1000, 500] });
    doc = run(doc, 'delete_building_element', { elementIds: ['wall-2'] });
    doc = run(doc, 'add_wall', { start: [0, 900], end: [1000, 900] });
    expect(Object.keys(doc.building!.elements)).toEqual(['wall-1', 'wall-3']);
    doc = run(doc, 'add_level', {});
    doc = run(doc, 'delete_level', { levelId: 'level-2' });
    doc = run(doc, 'add_level', {});
    expect(doc.building!.levelOrder).toEqual(['level-1', 'level-3']);
  });

  it('escapes astral characters with \\X4\\', () => {
    expect(ifcString('🏠')).toBe("'\\X4\\0001F3E0\\X0\\'");
  });
});

describe('DXF drafting text and extents', () => {
  it('keeps text rotation / alignment and covers drafting in $EXTMAX', () => {
    let doc = run(createEmptyDocument(), 'add_wall', { start: [0, 0], end: [1000, 0] });
    doc = run(doc, 'add_text', {
      content: 'Far note',
      position: [50000, 20000, 0],
      height: 250,
      rotation: [0, 0, Math.PI / 2],
      anchor: 'right',
    });
    const dxf = (execute(doc, 'export_dxf', {}).data as DxfExport).dxf;
    expect(dxf).toMatch(/Far note\n50\n90\n72\n2\n11\n50000/);
    expect(dxf).toMatch(/\$EXTMAX\n10\n50000\n20\n20000/);
  });
});

describe('DXF layer names', () => {
  it('keeps layers that differ only by punctuation distinct, in first-seen order', () => {
    const writer = new DxfWriter();
    writer.line('A B', [0, 0], [1, 0]);
    writer.line('A_B', [0, 0], [1, 1]);
    writer.line('A B', [0, 0], [0, 1]);
    writer.polyline(
      'A/B',
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      false,
    );
    writer.line('S-GRID', [0, 0], [1, 0]);
    expect([...writer.layers.keys()]).toEqual(['A_B', 'A_B_2', 'A_B_3', 'S-GRID']);
    const layerOfEntity = (type: string): string[] =>
      writer.lines.flatMap((line, index) =>
        line === type && writer.lines[index - 1] === '0' ? [writer.lines[index + 2] as string] : [],
      );
    expect(layerOfEntity('LINE')).toEqual(['A_B', 'A_B_2', 'A_B', 'S-GRID']);
    expect(layerOfEntity('POLYLINE')).toEqual(['A_B_3']);
    expect(writer.layers.get('S-GRID')).toBe(1);
    expect(new DxfWriter().layers.size).toBe(0);
  });
});

describe('SVG sheets stay well-formed XML for hostile names', () => {
  it('escapes markup and drops control characters in plan and elevation sheets', () => {
    const nasty = `<A&B> "q" 'x' \u0001\u000b é`;
    let doc = run(createEmptyDocument(), 'set_project_info', { name: nasty, author: nasty });
    doc = run(doc, 'add_level', { name: nasty });
    doc = run(doc, 'draw_walls', {
      points: [
        [0, 0],
        [6000, 0],
        [6000, 5000],
        [0, 5000],
      ],
      closed: true,
    });
    doc = run(doc, 'add_room', { name: nasty, wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'] });
    for (const name of ['export_plan_sheet', 'export_elevation_sheet']) {
      const svg = (execute(doc, name, {}).data as { svg: string }).svg;
      expect([...svg].filter(isIllegalXmlCharacter), name).toEqual([]);
      expect(svg, name).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#)/);
      expect(svg, name).toContain('&lt;A&amp;B&gt;');
    }
  });
});

describe('extreme model sizes', () => {
  const viewport = { x: 0, y: 0, width: 400, height: 250 };

  it('fitScale goes beyond the standard scales so the drawing always fits', () => {
    expect(fitScale(10, 10, viewport)).toBeLessThanOrEqual(20);
    for (const extent of [5_000_000, 500_000_000, 123_456_789_012]) {
      const scale = fitScale(extent, extent / 2, viewport);
      expect(extent / scale, String(extent)).toBeLessThanOrEqual(viewport.width * 0.92);
      expect(extent / scale, String(extent)).toBeGreaterThan(viewport.width * 0.92 * 0.19);
      expect([1, 2, 5].includes(scale / 10 ** Math.floor(Math.log10(scale)))).toBe(true);
    }
    expect(fitScale(Infinity, 1, viewport)).toBe(2000);
  });

  it('plan sheet warns when a requested scale does not fit the paper, not when auto-fitted', () => {
    const doc = house();
    const auto = execute(doc, 'export_plan_sheet', {});
    expect((auto.data as PlanSheet).fits).toBe(true);
    expect(auto.summary).not.toMatch(/WARNING/);
    const tooBig = execute(doc, 'export_plan_sheet', { scale: 5 });
    expect((tooBig.data as PlanSheet).fits).toBe(false);
    expect(tooBig.summary).toMatch(/WARNING: the drawing is larger than the paper at this scale/);
    expect(execute(doc, 'export_plan_sheet', { scale: 100 }).summary).not.toMatch(/WARNING/);
  });

  it('elevation sheet warns when a requested scale does not fit, not when auto-fitted', () => {
    const doc = house();
    const auto = execute(doc, 'export_elevation_sheet', {});
    expect((auto.data as { fits: boolean }).fits).toBe(true);
    expect(auto.summary).not.toMatch(/WARNING/);
    const tooBig = execute(doc, 'export_elevation_sheet', { scale: 5 });
    expect((tooBig.data as { fits: boolean }).fits).toBe(false);
    expect(tooBig.summary).toMatch(/WARNING: the view is larger than the paper at this scale/);
  });

  it('DXF hatch density is capped for a 500 km wall', () => {
    let doc = run(createEmptyDocument(), 'add_level', { name: 'L' });
    doc = run(doc, 'add_wall', { start: [0, 0], end: [500_000_000, 0], thickness: 10_000_000 });
    const data = execute(doc, 'export_dxf', {}).data as DxfExport;
    expect(data.entityCount).toBeLessThan(5000);
  });
});

describe('export_ifc counts', () => {
  it('reports elements and IFC products separately and truthfully', () => {
    const hall = execute(createEmptyDocument(), 'add_portal_frame_building', {
      span: 12000,
      length: 12000,
      baySpacing: 6000,
    }).document;
    const result = execute(hall, 'export_ifc', {});
    const data = result.data as IfcExport;
    const modelled = Object.keys(hall.building?.elements ?? {}).length;
    expect(data.elementCount).toBeGreaterThan(0);
    expect(data.elementCount).toBeLessThanOrEqual(modelled);
    expect(data.productCount).toBeGreaterThanOrEqual(data.elementCount);
    expect(result.summary).toContain(
      `${data.elementCount} building element(s) as ${data.productCount} IFC product(s)`,
    );
    const plain = execute(house(), 'export_ifc', {}).data as IfcExport;
    expect(plain.elementCount).toBeLessThanOrEqual(plain.productCount);
  });
});

describe('export_ifc header timestamp', () => {
  it('uses an ISO project date, and falls back (saying so) for a free-text date', () => {
    const iso = execute(house(), 'export_ifc', {});
    expect((iso.data as IfcExport).ifc).toContain("'2026-10-01T00:00:00'");
    expect(iso.summary).not.toMatch(/not YYYY-MM-DD/);
    const prose = run(house(), 'set_project_info', { date: '1 Oct 2026' });
    const fallback = execute(prose, 'export_ifc', {});
    expect((fallback.data as IfcExport).ifc).toContain("'1970-01-01T00:00:00'");
    expect((fallback.data as IfcExport).ifc).not.toContain('1 Oct 2026T00');
    expect(fallback.summary).toMatch(/Project date "1 Oct 2026" is not YYYY-MM-DD/);
    const explicit = execute(prose, 'export_ifc', { timestamp: '2027-01-02T03:04:05' });
    expect(explicit.summary).not.toMatch(/not YYYY-MM-DD/);
  });
});

describe('cut fills (hatches)', () => {
  it('marks wall and column cuts as hatched and steel sections as solid with holes', () => {
    let doc = house();
    doc = run(doc, 'add_column', { location: [20000, 20000] });
    doc = run(doc, 'add_steel_member', {
      profile: 'SHS100x5',
      role: 'column',
      start: [25000, 20000, 0],
      end: [25000, 20000, 3000],
    });
    const primitives = buildPlanDrawing(doc, undefined)!.primitives;
    const fills = (layer: string): Array<string | undefined> =>
      primitives.flatMap((p) => (p.type === 'polygon' && p.layer === layer ? [p.fill] : []));
    expect(new Set(fills('A-WALL'))).toEqual(new Set(['hatch']));
    expect(fills('S-COLS')).toContain('hatch');
    const steel = primitives.find((p) => p.type === 'polygon' && p.fill === 'solid');
    expect(steel?.type === 'polygon' && steel.holes).toHaveLength(1);
  });

  it('writes ANSI31 lines and SOLID fills on -PATT layers in the DXF', () => {
    let doc = house();
    doc = run(doc, 'add_steel_member', {
      profile: 'HEA300',
      role: 'column',
      start: [25000, 20000, 0],
      end: [25000, 20000, 3000],
    });
    doc = run(doc, 'add_column', { location: [30000, 20000], shape: 'circular', width: 400 });
    const data = execute(doc, 'export_dxf', { levelId: 'level-1' }).data as DxfExport;
    expect(data.layers).toEqual(expect.arrayContaining(['A-WALL-PATT', 'S-COLS-PATT']));
    expect(data.dxf).toMatch(/0\nSOLID\n8\nS-COLS-PATT\n/);
    expect(data.dxf).toMatch(/0\nLINE\n8\nA-WALL-PATT\n/);
    // Pattern layers are grey (ACI 8) in the layer table.
    expect(data.dxf).toMatch(/2\nA-WALL-PATT\n70\n0\n62\n8\n/);
  });

  it('hatches cut walls and keeps steel section holes open on the SVG sheet', () => {
    let doc = house();
    doc = run(doc, 'add_steel_member', {
      profile: 'SHS100x5',
      role: 'column',
      start: [2000, 2000, 0],
      end: [2000, 2000, 3000],
    });
    const sheet = execute(doc, 'export_plan_sheet', {}).data as PlanSheet;
    expect(sheet.svg).toContain('id="hatch-concrete"');
    expect(sheet.svg).toContain('class="cut-hatch"');
    expect(sheet.svg).toMatch(/<path d="M[^"]+ZM[^"]+Z" fill-rule="evenodd" class="cut"/);
  });
});
