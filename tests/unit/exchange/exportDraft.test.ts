/** export_dxf / export_svg: oracles, refusals, purity and the export_dxf -> import_dxf round trip (gaps listed explicitly). */
import { describe, expect, it } from 'vitest';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { parseDxf } from '@lib/dxfRead';
import { GOLDEN_LAYER_COLOR, goldenDraft, worldSignature } from '../../helpers/draft2dGolden';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

interface DxfData {
  readonly filename: string;
  readonly dxf: string;
  readonly version: string;
  readonly layers: string[];
  readonly exported: string[];
  readonly dimensions: number;
  readonly skipped: Array<{ id: string; kind: string; reason: string }>;
  readonly entityCount: number;
}
interface SvgData {
  readonly svg: string;
  readonly viewBox: number[];
  readonly widthMm: number;
  readonly heightMm: number;
  readonly layers: string[];
  readonly skipped: Array<{ id: string; reason: string }>;
}

const exportDxf = (doc: CadDocument, params: object = {}): { data: DxfData; summary: string } => {
  const result = execute(doc, 'export_dxf', params);
  return { data: result.data as DxfData, summary: result.summary };
};
const exportSvg = (doc: CadDocument, params: object = {}): { data: SvgData; summary: string } => {
  const result = execute(doc, 'export_svg', params);
  return { data: result.data as SvgData, summary: result.summary };
};

/** The [code, value] pairs of the file between two section markers. */
function section(dxf: string, name: string): Array<[string, string]> {
  const lines = dxf.split('\n');
  const start = lines.findIndex((line, index) => line === name && lines[index - 1] === '2' && lines[index - 2] === 'SECTION');
  const pairs: Array<[string, string]> = [];
  for (let at = start + 1; at + 1 < lines.length; at += 2) {
    if (lines[at] === '0' && lines[at + 1] === 'ENDSEC') break;
    pairs.push([lines[at] as string, lines[at + 1] as string]);
  }
  return pairs;
}

const withEntities = (...entities: Entity[]): CadDocument => ({
  ...createEmptyDocument(),
  entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
  order: entities.map((entity) => entity.id),
});
const line = (id: string, extra: Partial<Entity> = {}): Entity =>
  ({
    id,
    kind: 'line',
    start: [0, 0],
    end: [10, 0],
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ff0000',
    ...extra,
  }) as unknown as Entity;

describe('export_dxf oracle (hand-checked group codes)', () => {
  it('writes a line at elevation 2.5 as the exact R2000 entity records', () => {
    const doc = withEntities(line('line-1', { position: [1, 2, 2.5] } as Partial<Entity>));
    const { data } = exportDxf(doc);
    // world: (1,2,2.5) -> (11,2,2.5); colour #ff0000 = ACI 1 = true colour 16711680 (the default layer has no colour of its own)
    expect(section(data.dxf, 'ENTITIES')).toEqual([
      ['0', 'LINE'],
      ['5', '10000'],
      ['330', '1F'],
      ['100', 'AcDbEntity'],
      ['8', 'Layer 0'],
      ['62', '1'],
      ['420', '16711680'],
      ['100', 'AcDbLine'],
      ['10', '1'],
      ['20', '2'],
      ['30', '2.5'],
      ['11', '11'],
      ['21', '2'],
      ['31', '2.5'],
    ]);
    const header = section(data.dxf, 'HEADER');
    expect(header).toContainEqual(['1', 'AC1015']);
    expect(
      header.slice(
        header.findIndex(([, v]) => v === '$INSUNITS'),
        header.findIndex(([, v]) => v === '$INSUNITS') + 2,
      ),
    ).toEqual([
      ['9', '$INSUNITS'],
      ['70', '4'],
    ]);
    expect(
      header.slice(
        header.findIndex(([, v]) => v === '$EXTMAX'),
        header.findIndex(([, v]) => v === '$EXTMAX') + 3,
      ),
    ).toEqual([
      ['9', '$EXTMAX'],
      ['10', '11'],
      ['20', '2'],
    ]);
    expect(data.version).toBe('AC1015');
    expect(data.filename).toBe('drawing.dxf');
  });

  it('writes a circle, an arc in degrees and a closed LWPOLYLINE with the group codes the format defines', () => {
    const circle = {
      id: 'c',
      kind: 'circle',
      center: [3, 4],
      radius: 2,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#ff0000',
    };
    const arc = {
      id: 'a',
      kind: 'arc',
      center: [0, 0],
      radius: 5,
      startAngle: 0,
      endAngle: Math.PI / 2,
      position: [10, 0, 0],
      rotation: [0, 0, Math.PI / 2],
      layerId: 'layer-default',
      color: '#ff0000',
    };
    const rect = {
      id: 'r',
      kind: 'rectangle',
      width: 4,
      height: 2,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#ff0000',
    };
    const pairs = section(
      exportDxf(withEntities(circle as unknown as Entity, arc as unknown as Entity, rect as unknown as Entity)).data.dxf,
      'ENTITIES',
    );
    const records = pairs.filter(([code]) => code === '0').map(([, value]) => value);
    expect(records).toEqual(['CIRCLE', 'ARC', 'LWPOLYLINE']);
    const at = (type: string): Array<[string, string]> => {
      const start = pairs.findIndex(([code, value]) => code === '0' && value === type);
      return pairs.slice(
        start,
        pairs.findIndex(([code], index) => index > start && code === '0') === -1
          ? undefined
          : pairs.findIndex(([code], index) => index > start && code === '0'),
      );
    };
    expect(at('CIRCLE').filter(([code]) => ['10', '20', '40'].includes(code))).toEqual([
      ['10', '3'],
      ['20', '4'],
      ['40', '2'],
    ]);
    // arc centre (0,0) rotated 90° about its origin then placed at x = 10: centre (10,0); angles 90°..180°
    expect(at('ARC').filter(([code]) => ['10', '20', '40', '50', '51'].includes(code))).toEqual([
      ['10', '10'],
      ['20', '0'],
      ['40', '5'],
      ['50', '90'],
      ['51', '180'],
    ]);
    const polyline = at('LWPOLYLINE').filter(([code]) => ['90', '70', '10', '20'].includes(code));
    expect(polyline).toEqual([
      ['90', '4'],
      ['70', '1'],
      ['10', '0'],
      ['20', '0'],
      ['10', '4'],
      ['20', '0'],
      ['10', '4'],
      ['20', '2'],
      ['10', '0'],
      ['20', '2'],
    ]);
  });

  it('declares layers with name, colour (ACI + true colour), hidden (negative ACI) and locked (flag 4)', () => {
    const { data } = exportDxf(goldenDraft());
    expect(data.layers).toEqual(['WALLS', 'Notes & dims']);
    const layerTable = section(data.dxf, 'TABLES');
    const notes = layerTable.findIndex(([code, value]) => code === '2' && value === 'Notes & dims');
    // hidden: -ACI of #00aa00; locked: flag 4; true colour 0x00aa00 = 43520
    expect(layerTable.slice(notes, notes + 5)).toEqual([
      ['2', 'Notes & dims'],
      ['70', '4'],
      ['62', `-${layerTable[notes + 2]?.[1].replace('-', '')}`],
      ['420', '43520'],
      ['6', 'Continuous'],
    ]);
    expect(Number(layerTable[notes + 2]?.[1])).toBeLessThan(0);
  });
});

describe('export_svg oracle (hand-checked path)', () => {
  const arc = {
    id: 'a',
    kind: 'arc',
    center: [0, 0],
    radius: 10,
    startAngle: 0,
    endAngle: Math.PI / 2,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ff0000',
  };

  it('an arc is one exact A command (counter-clockwise on paper = sweep flag 0, y flipped) and the viewBox is extents + margin', () => {
    const { data } = exportSvg(withEntities(arc as unknown as Entity));
    // (10,0) -> (0,10) becomes (10,0) -> (0,-10); viewBox x -5..15, y -15..5 with the default 5 mm margin
    expect(data.svg).toContain('<path d="M 10 0 A 10 10 0 0 0 0 -10" stroke="#ff0000"/>');
    expect(data.viewBox).toEqual([-5, -15, 20, 20]);
    expect(data.svg).toContain('viewBox="-5 -15 20 20" width="20mm" height="20mm"');
    expect(data.svg).toContain('data-layer="Layer 0"');
  });

  it('an arc over 180 degrees sets the large-arc flag, a full turn is two half arcs; units convert to mm', () => {
    const big = exportSvg(withEntities({ ...arc, endAngle: (3 * Math.PI) / 2 } as unknown as Entity)).data.svg;
    expect(big).toContain('M 10 0 A 10 10 0 1 0 0 10"');
    const inches = { ...withEntities(arc as unknown as Entity), units: 'in' as const };
    expect(exportSvg(inches).data.svg).toContain('M 254 0 A 254 254 0 0 0 0 -254');
  });

  it('margin and line weight are parameters', () => {
    const { data } = exportSvg(withEntities(arc as unknown as Entity), { marginMm: 0, lineWeightMm: 0.5 });
    expect(data.viewBox).toEqual([0, -10, 10, 10]);
    expect(data.svg).toContain('stroke-width="0.5"');
  });
});

describe('export refusals (codes + remediation, never silent)', () => {
  const doc = goldenDraft();
  const solid = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] }).document;

  for (const command of ['export_dxf', 'export_svg']) {
    it(`${command}: empty selection, unknown id, non-2D id, no 2D entity`, () => {
      const empty = execute(doc, command, { ids: [] });
      expect(empty.error?.code).toBe('EXPORT2D_EMPTY_SELECTION');
      expect(empty.error?.remediation).toContain('omit `ids`');
      expectNoOp(empty, doc);
      const unknown = execute(doc, command, { ids: ['line-1', 'nope'] });
      expect(unknown.error).toMatchObject({ code: 'EXPORT2D_UNKNOWN_ID', ids: ['nope'] });
      const boxId = solid.order[0] as string;
      const merged = { ...solid, entities: { ...solid.entities, 'line-1': line('line-1') }, order: [...solid.order, 'line-1'] };
      const not2d = execute(merged, command, { ids: ['line-1', boxId] });
      expect(not2d.error).toMatchObject({ code: 'EXPORT2D_NOT_2D', ids: [boxId] });
      expect(not2d.summary).toContain('box');
      expectNoOp(not2d, merged);
      const nothing = execute(solid, command, {});
      expect(nothing.error?.code).toBe('EXPORT2D_NO_ENTITIES');
      const blank = createEmptyDocument();
      expect(execute(blank, command, {}).error?.code).toBe('EXPORT2D_NO_ENTITIES');
      expectNoOp(execute(blank, command, {}), blank);
    });

    it(`${command}: a tilted plane and an image are skipped with a warning without ids, refused with ids`, () => {
      const tilted = line('tilted', { rotation: [0.5, 0, 0] } as Partial<Entity>);
      const image = {
        id: 'img',
        kind: 'image',
        dataUrl: 'data:image/png;base64,AA==',
        pixelWidth: 1,
        pixelHeight: 1,
        width: 1,
        height: 1,
        opacity: 1,
        locked: false,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        layerId: 'layer-default',
        color: '#000000',
      } as unknown as Entity;
      const mixed = withEntities(line('ok'), tilted, image);
      const result = execute(mixed, command, {});
      const data = result.data as { skipped: Array<{ id: string; reason: string }>; exported: string[] };
      expect(data.exported).toEqual(['ok']);
      expect(data.skipped).toEqual([
        { id: 'tilted', kind: 'line', reason: 'TILTED_PLANE' },
        { id: 'img', kind: 'image', reason: 'IMAGE_UNDERLAY' },
      ]);
      expect(result.summary).toContain('tilted (TILTED_PLANE)');
      expect(result.summary).toContain('img (IMAGE_UNDERLAY)');
      expect(execute(mixed, command, { ids: ['tilted'] }).error?.code).toBe('EXPORT2D_TILTED_PLANE');
      expect(execute(mixed, command, { ids: ['img'] }).error?.code).toBe('EXPORT2D_IMAGE_UNDERLAY');
      expect(execute(withEntities(tilted), command, {}).error?.code).toBe('EXPORT2D_NO_ENTITIES');
    });

    it(`${command}: a non-finite coordinate and a dangling dimension are refused when named`, () => {
      const bad = line('bad', { end: [Number.NaN, 0] } as Partial<Entity>);
      expect(execute(withEntities(bad), command, { ids: ['bad'] }).error?.code).toBe('EXPORT2D_BAD_GEOMETRY');
      const dimension = {
        id: 'dim',
        kind: 'dimension',
        dimensionKind: 'linear',
        entityIds: ['gone', 'gone2'],
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        layerId: 'layer-default',
        color: '#000000',
      } as unknown as Entity;
      const dangling = withEntities(line('ok'), dimension);
      expect(execute(dangling, command, { ids: ['dim'] }).error?.code).toBe('EXPORT2D_DIMENSION_DANGLING');
      expect((execute(dangling, command, {}).data as { skipped: Array<{ reason: string }> }).skipped[0]?.reason).toBe('DIMENSION_DANGLING');
    });

    it(`${command}: is pure and idempotent`, () => {
      const source = goldenDraft();
      expectPure(source, () => execute(source, command, {}));
      expect(execute(source, command, {}).data).toEqual(execute(source, command, {}).data);
      expect(execute(source, command, {}).affected).toEqual([]);
    });
  }

  it('ids selects a subset in document order and counts it in the summary', () => {
    const { data, summary } = exportDxf(doc, { ids: ['circle-1', 'line-1'] });
    expect(data.exported).toEqual(['line-1', 'circle-1']);
    expect(data.entityCount).toBe(2);
    expect(summary).toContain('2 2D entities as 2 DXF entities');
  });
});

describe('export_dxf -> import_dxf round trip (golden drawing, every kind)', () => {
  const sorted = (doc: CadDocument): Array<{ key: string; numbers: number[] }> =>
    doc.order
      .map((id) => worldSignature(doc, doc.entities[id] as Entity))
      .sort((a, b) => (a.key + a.numbers.map((n) => n.toFixed(4)).join()).localeCompare(b.key + b.numbers.map((n) => n.toFixed(4)).join()));

  it.each(['mm', 'm', 'in'] as const)('gives back the same kinds, layers, colours and geometry within 1e-9 (%s)', (units) => {
    const source = { ...goldenDraft(), units };
    const { data } = exportDxf(source);
    const target = { ...createEmptyDocument(), units };
    const imported = execute(target, 'import_dxf', { text: data.dxf });
    expect(imported.affected).toHaveLength(source.order.length);
    const before = sorted(source);
    const after = sorted(imported.document);
    expect(after.map((s) => s.key)).toEqual(before.map((s) => s.key));
    before.forEach((signature, index) => {
      const other = after[index] as { numbers: number[] };
      expect(other.numbers).toHaveLength(signature.numbers.length);
      signature.numbers.forEach((value, at) => expect(Math.abs(value - (other.numbers[at] as number))).toBeLessThan(1e-9));
    });
    const kinds = (doc: CadDocument): string[] => doc.order.map((id) => (doc.entities[id] as Entity).kind).sort();
    expect(kinds(imported.document)).toEqual(kinds(source));
    const layers = Object.values(imported.document.layers);
    expect(layers.find((layer) => layer.name === 'WALLS')).toMatchObject({ visible: true, locked: false, color: GOLDEN_LAYER_COLOR });
    expect(layers.find((layer) => layer.name === 'Notes & dims')).toMatchObject({ visible: false, locked: true, color: '#00aa00' });
  });

  it('the file parses as R2000 with the LLULL application registered and HATCH / ELLIPSE / SPLINE / LWPOLYLINE entities', () => {
    const { data } = exportDxf(goldenDraft());
    const types = new Set(
      section(data.dxf, 'ENTITIES')
        .filter(([code]) => code === '0')
        .map(([, value]) => value),
    );
    expect([...types].sort()).toEqual(['ARC', 'CIRCLE', 'ELLIPSE', 'HATCH', 'LINE', 'LWPOLYLINE', 'POINT', 'SPLINE', 'TEXT']);
    expect(section(data.dxf, 'TABLES')).toContainEqual(['2', 'LLULL']);
    expect(parseDxf(data.dxf)?.entities.length).toBe(data.entityCount);
  });

  it('GAPS (listed, asserted): dimension -> lines + text, multi-line text -> one line, forbidden layer characters', () => {
    // 1. a dimension comes back as plain lines + a text on its layer (not associative)
    const base = withEntities(line('l1'), { ...line('l2'), start: [0, 5], end: [10, 5] } as unknown as Entity);
    const dimension = {
      id: 'dim',
      kind: 'dimension',
      dimensionKind: 'linear',
      entityIds: ['l1', 'l2'],
      offset: 3,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#000000',
    } as unknown as Entity;
    const dimmed = { ...base, entities: { ...base.entities, dim: dimension }, order: [...base.order, 'dim'] };
    const exported = exportDxf(dimmed);
    expect(exported.data.dimensions).toBe(1);
    expect(exported.summary).toContain('1 dimension(s) written as lines + text (not associative)');
    const back = execute(createEmptyDocument(), 'import_dxf', { text: exported.data.dxf }).document;
    const kinds = Object.values(back.entities).map((e) => e.kind);
    expect(kinds).not.toContain('dimension');
    expect(kinds).toContain('text');
    expect(kinds.filter((kind) => kind === 'line').length).toBeGreaterThan(2);
    // 2. multi-line text is an MTEXT; the importer joins its lines with a space
    const multi = withEntities({
      id: 't',
      kind: 'text',
      content: 'first\nsecond',
      height: 2,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#000000',
    } as unknown as Entity);
    const mtext = exportDxf(multi).data.dxf;
    expect(section(mtext, 'ENTITIES')).toContainEqual(['1', 'first\\Psecond']);
    const text = Object.values(execute(createEmptyDocument(), 'import_dxf', { text: mtext }).document.entities)[0];
    expect(text).toMatchObject({ kind: 'text', content: 'first second' });
    // 3. forbidden layer characters are replaced and reported in data.layers
    const named = {
      ...withEntities(line('l')),
      layers: { ...createEmptyDocument().layers, odd: { id: 'odd', name: 'A:B/C', visible: true, locked: false } },
    };
    named.entities = { l: { ...line('l'), layerId: 'odd' } as unknown as Entity };
    expect(exportDxf(named).data.layers).toEqual(['A_B_C']);
  });

  it('non-ASCII text and layer names survive through \\U+XXXX escapes', () => {
    const base = createEmptyDocument();
    const doc = {
      ...withEntities(
        { ...line('l'), layerId: 'u' } as unknown as Entity,
        {
          id: 't',
          kind: 'text',
          content: 'Ø25 ±0.1°',
          height: 2,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          layerId: 'u',
          color: '#000000',
        } as unknown as Entity,
      ),
      layers: { ...base.layers, u: { id: 'u', name: 'Épure', visible: true, locked: false } },
    };
    const { data } = exportDxf(doc);
    expect(data.dxf).toContain('\\U+00D8');
    expect([...data.dxf].every((character) => (character.codePointAt(0) ?? 0) < 128)).toBe(true);
    const back = execute(createEmptyDocument(), 'import_dxf', { text: data.dxf }).document;
    expect(Object.values(back.layers).map((layer) => layer.name)).toContain('Épure');
    expect(Object.values(back.entities).find((e) => e.kind === 'text')).toMatchObject({ content: 'Ø25 ±0.1°' });
  });

  it('a foreign SPLINE (NURBS without LLULL data) is sampled; an elliptical arc becomes a polyline', () => {
    const text = [
      '0',
      'SECTION',
      '2',
      'ENTITIES',
      '0',
      'SPLINE',
      '8',
      'S',
      '70',
      '8',
      '71',
      '2',
      '72',
      '6',
      '73',
      '3',
      '40',
      '0',
      '40',
      '0',
      '40',
      '0',
      '40',
      '1',
      '40',
      '1',
      '40',
      '1',
      '10',
      '0',
      '20',
      '0',
      '30',
      '0',
      '10',
      '5',
      '20',
      '5',
      '30',
      '0',
      '10',
      '10',
      '20',
      '0',
      '30',
      '0',
      '0',
      'ELLIPSE',
      '8',
      'E',
      '10',
      '0',
      '20',
      '0',
      '30',
      '0',
      '11',
      '4',
      '21',
      '0',
      '31',
      '0',
      '40',
      '0.5',
      '41',
      '0',
      '42',
      '1.5707963267948966',
      '0',
      'ENDSEC',
      '0',
      'EOF',
    ].join('\n');
    const result = execute(createEmptyDocument(), 'import_dxf', { text });
    const [spline, arc] = result.affected.map((id) => result.document.entities[id] as Entity);
    expect(spline?.kind).toBe('spline');
    expect(spline?.kind === 'spline' && spline.points.length).toBeGreaterThan(8);
    // the quadratic Bézier (0,0) (5,5) (10,0) peaks at (5, 2.5)
    expect(spline?.kind === 'spline' && Math.max(...spline.points.map((p) => p[1]))).toBeCloseTo(2.5, 6);
    expect(arc?.kind).toBe('polyline');
  });
});
