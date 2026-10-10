import { describe, expect, it } from 'vitest';
import { type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { flattenDxf, parseDxf, codeNumber } from '@core/lib/dxfRead';
import { aciToHex, insUnitsMillimetres } from '@core/lib/dxfUnits';

/** DXF text from [code, value] pairs. */
function dxf(...pairs: Array<[number, string | number]>): string {
  return pairs.map(([code, value]) => `${code}\n${value}`).join('\n') + '\n';
}

const header = (units: number): Array<[number, string | number]> => [
  [0, 'SECTION'],
  [2, 'HEADER'],
  [9, '$INSUNITS'],
  [70, units],
  [0, 'ENDSEC'],
];

const tables: Array<[number, string | number]> = [
  [0, 'SECTION'],
  [2, 'TABLES'],
  [0, 'TABLE'],
  [2, 'LAYER'],
  [0, 'LAYER'],
  [2, 'WALLS'],
  [62, 1],
  [0, 'LAYER'],
  [2, 'TOPO'],
  [62, -3],
  [0, 'ENDTAB'],
  [0, 'ENDSEC'],
];

const blocks: Array<[number, string | number]> = [
  [0, 'SECTION'],
  [2, 'BLOCKS'],
  [0, 'BLOCK'],
  [2, 'TICK'],
  [10, 1],
  [20, 0],
  [30, 0],
  [0, 'LINE'],
  [8, '0'],
  [10, 1],
  [20, 0],
  [30, 0],
  [11, 2],
  [21, 0],
  [31, 0],
  [0, 'CIRCLE'],
  [8, '0'],
  [10, 1],
  [20, 0],
  [40, 1],
  [0, 'ENDBLK'],
  [0, 'ENDSEC'],
];

function drawing(units = 6): string {
  return dxf(
    ...header(units),
    ...tables,
    ...blocks,
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    [0, 'LINE'],
    [8, 'WALLS'],
    [10, 0],
    [20, 0],
    [30, 0],
    [11, 10],
    [21, 0],
    [31, 0],
    [0, 'LWPOLYLINE'],
    [8, 'WALLS'],
    [62, 5],
    [90, 3],
    [70, 1],
    [38, 2],
    [10, 0],
    [20, 0],
    [42, 1],
    [10, 2],
    [20, 0],
    [10, 2],
    [20, 2],
    [0, 'POLYLINE'],
    [8, 'TOPO'],
    [70, 8],
    [0, 'VERTEX'],
    [10, 0],
    [20, 0],
    [30, 100],
    [0, 'VERTEX'],
    [10, 5],
    [20, 0],
    [30, 101],
    [0, 'SEQEND'],
    [0, 'ARC'],
    [8, 'WALLS'],
    [10, 0],
    [20, 0],
    [40, 3],
    [50, 0],
    [51, 90],
    [230, -1],
    [0, 'POINT'],
    [8, 'TOPO'],
    [10, 7],
    [20, 8],
    [30, 99.5],
    [0, 'TEXT'],
    [8, 'TOPO'],
    [10, 3],
    [20, 4],
    [30, 0],
    [40, 0.5],
    [1, '101.25'],
    [0, 'MTEXT'],
    [8, 'ANNO'],
    [10, 0],
    [20, 9],
    [1, '{\\fArial|b0;Site}\\Pplan'],
    [0, '3DFACE'],
    [8, 'TIN'],
    [10, 0],
    [20, 0],
    [30, 1],
    [11, 1],
    [21, 0],
    [31, 1],
    [12, 1],
    [22, 1],
    [32, 1],
    [13, 1],
    [23, 1],
    [33, 1],
    [0, 'INSERT'],
    [8, 'MARKS'],
    [2, 'TICK'],
    [10, 20],
    [20, 0],
    [50, 90],
    [41, 2],
    [42, 2],
    [0, 'INSERT'],
    [8, 'MARKS'],
    [2, 'TICK'],
    [10, 30],
    [20, 0],
    [41, 2],
    [42, 1],
    [0, 'INSERT'],
    [2, 'MISSING'],
    [0, 'HATCH'],
    [8, 'WALLS'],
    [0, 'ENDSEC'],
    [0, 'EOF'],
  );
}

describe('dxf reader', () => {
  it('parses header units, layers, blocks and grouped polylines', () => {
    const parsed = parseDxf(drawing());
    expect(parsed?.insUnits).toBe(6);
    expect(parsed?.layers.get('TOPO')).toBe(3);
    expect(parsed?.blocks.get('TICK')?.entities).toHaveLength(2);
    const polyline = parsed?.entities.find((record) => record.type === 'POLYLINE');
    expect(polyline?.vertices).toHaveLength(2);
    expect(parseDxf('not a dxf')).toBeNull();
    expect(parsed && codeNumber(parsed.entities[0] as never, 99, 7)).toBe(7);
  });

  it('flattens entities into world primitives', () => {
    const parsed = parseDxf(drawing());
    if (!parsed) throw new Error('unparsed');
    const { primitives, skipped } = flattenDxf(parsed);
    const kinds = primitives.map((primitive) => primitive.kind);
    expect(kinds.filter((kind) => kind === 'face')).toHaveLength(1);
    const lw = primitives.find((p) => p.kind === 'polyline' && p.layer === 'WALLS');
    // Bulge 1 = half circle between (0,0) and (2,0): extra points below the chord, at elevation 2.
    expect(lw?.kind === 'polyline' && lw.points.length).toBeGreaterThan(4);
    expect(lw?.kind === 'polyline' && lw.points.every((p) => p[2] === 2)).toBe(true);
    expect(lw?.kind === 'polyline' && lw.points.some((p) => p[1] < -0.9)).toBe(true);
    const arc = primitives.find((p) => p.kind === 'arc');
    // Mirrored OCS: 0°..90° becomes 90°..180°.
    expect(arc?.kind === 'arc' && arc.start).toBeCloseTo(Math.PI / 2, 9);
    expect(arc?.kind === 'arc' && arc.end).toBeCloseTo(Math.PI, 9);
    const text = primitives.find((p) => p.kind === 'text' && p.layer === 'ANNO');
    expect(text?.kind === 'text' && text.content).toBe('Site plan');
    // Uniform insert: block line (1,0)->(2,0) relative to base (1,0), scaled 2, rotated 90°.
    const blockLine = primitives.find((p) => p.kind === 'line' && p.layer === 'MARKS');
    expect(blockLine?.kind === 'line' && blockLine.b[0]).toBeCloseTo(20, 9);
    expect(blockLine?.kind === 'line' && blockLine.b[1]).toBeCloseTo(2, 9);
    expect(primitives.some((p) => p.kind === 'circle' && p.layer === 'MARKS')).toBe(true);
    // Non-uniform insert turns the circle into a closed polyline.
    expect(primitives.some((p) => p.kind === 'polyline' && p.layer === 'MARKS' && p.closed)).toBe(
      true,
    );
    expect(skipped.get('HATCH')).toBe(1);
    expect(skipped.get('INSERT')).toBe(1);
  });

  it('maps colours and units', () => {
    expect(aciToHex(1)).toBe('#ff0000');
    expect(aciToHex(250)).toBe('#333333');
    expect(aciToHex(255)).toBe('#ffffff');
    expect(aciToHex(0)).toBe('#000000');
    for (const aci of [10, 50, 90, 130, 170, 210, 245, 11, 19]) {
      expect(aciToHex(aci)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect([1, 2, 4, 5, 6, 0].map(insUnitsMillimetres)).toEqual([25.4, 304.8, 1, 10, 1000, null]);
  });
});

describe('import_dxf', () => {
  it('imports entities on DXF layers, scaled to the document unit', () => {
    const doc = createEmptyDocument(); // mm
    const result = execute(doc, 'import_dxf', { text: drawing(6) });
    expect(result.summary).toMatch(/Imported DXF \(\$INSUNITS 6\)/);
    expect(result.summary).toMatch(/new layers: WALLS, TOPO/);
    expect(result.summary).toMatch(/skipped 1 INSERT, 1 HATCH/);
    expect(result.summary).toMatch(/1 3D line\(s\)\/polyline\(s\) flattened/);
    const entities = result.affected.map((id) => result.document.entities[id] as Entity);
    const line = entities.find((e) => e.kind === 'line' && e.color === '#ff0000');
    expect(line?.kind === 'line' && line.end).toEqual([10000, 0]);
    const walls = Object.values(result.document.layers).find((layer) => layer.name === 'WALLS');
    expect(line?.layerId).toBe(walls?.id);
    const polyline = entities.find((e) => e.kind === 'polyline' && e.color === '#0000ff');
    expect(polyline?.position[2]).toBe(2000);
    expect(entities.some((e) => e.kind === 'mesh')).toBe(true);
    expect(entities.some((e) => e.kind === 'text')).toBe(true);
    expect(entities.some((e) => e.kind === 'point' && e.position[2] === 99500)).toBe(true);
  });

  it('honours sourceUnit, layer filters, and refuses junk', () => {
    const doc = createEmptyDocument();
    const filtered = execute(doc, 'import_dxf', {
      text: drawing(0),
      sourceUnit: 'mm',
      layers: ['topo'],
    });
    expect(filtered.summary).toMatch(/Imported DXF \(mm\): 1 polyline, 1 point, 1 text/);
    const assumed = execute(doc, 'import_dxf', { text: drawing(0), layers: ['TIN'] });
    expect(assumed.summary).toMatch(/mm \(assumed\)/);
    const none = execute(doc, 'import_dxf', { text: drawing(), layers: ['NOPE'] });
    expect(none.document).toBe(doc);
    expect(none.summary).toMatch(/nothing importable on layers NOPE/);
    const junk = execute(doc, 'import_dxf', { text: 'hello' });
    expect(junk.document).toBe(doc);
    expect(junk.summary).toMatch(/not an ASCII DXF/);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'import_dxf', { text: drawing() });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('import_survey_dxf', () => {
  it('collects elevated points, vertices, faces and spot heights', () => {
    const doc = execute(createEmptyDocument(), 'set_units', { units: 'm' }).document;
    const result = execute(doc, 'import_survey_dxf', {
      text: drawing(6),
      sources: ['points', 'vertices', 'faces', 'text'],
    });
    expect(result.summary).toMatch(/Imported \d+ survey points from DXF \(m\)/);
    const group = result.document.civil?.objects['pointGroup-1'];
    const positions = group?.category === 'pointGroup' ? group.points.map((p) => p.position) : [];
    expect(positions).toContainEqual([7, 8, 99.5]);
    expect(positions).toContainEqual([5, 0, 101]);
    expect(positions).toContainEqual([3, 4, 101.25]);
    const topo = execute(doc, 'import_survey_dxf', {
      text: drawing(0),
      layers: ['TOPO'],
      name: 'T',
    });
    expect(topo.summary).toMatch(/as T \(pointGroup-1\)/);
  });

  it('refuses drawings without elevated points', () => {
    const doc = createEmptyDocument();
    const flat = execute(doc, 'import_survey_dxf', { text: drawing(), layers: ['MARKS'] });
    expect(flat.document).toBe(doc);
    expect(flat.summary).toMatch(/at elevation 0 ignored/);
    expect(execute(doc, 'import_survey_dxf', { text: 'x' }).summary).toMatch(/not an ASCII DXF/);
    const kept = execute(doc, 'import_survey_dxf', {
      text: drawing(),
      layers: ['MARKS'],
      keepZeroElevation: true,
    });
    expect(kept.affected[0]).toBe('pointGroup-1');
  });
});

describe('converter quirks', () => {
  it('ignores VERTEX records repeated after SEQEND (LibreDWG 0.11 dwg2dxf)', () => {
    const vertices = (z: number): Array<[number, string | number]> => [
      [0, 'VERTEX'],
      [10, 0],
      [20, 0],
      [30, z],
      [0, 'VERTEX'],
      [10, 5],
      [20, 0],
      [30, z],
    ];
    const text = dxf(
      [0, 'SECTION'],
      [2, 'ENTITIES'],
      [0, 'POLYLINE'],
      [8, 'CONTOURS'],
      [70, 8],
      ...vertices(100),
      [0, 'SEQEND'],
      ...vertices(100),
      [0, 'ENDSEC'],
    );
    const result = execute(createEmptyDocument(), 'import_dxf', { text, sourceUnit: 'mm' });
    expect(result.summary).toBe('Imported DXF (mm): 1 polyline. new layers: CONTOURS.');
  });
});
