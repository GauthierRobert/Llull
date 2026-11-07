/** export_dxf / export_svg review round: MTEXT and TEXT escapes, text round trips, layer clashes, SVG dimension / multi-line, gate, hostile input. */
import { describe, expect, it } from 'vitest';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { flattenDxf, parseDxf } from '@lib/dxfRead';
import { dxfText } from '@lib/dxfWriter';
import { boxOf, step } from '../materials/support';

const base = { position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'layer-default', color: '#000000' };
const entity = (fields: Record<string, unknown>): Entity => ({ ...base, ...fields }) as unknown as Entity;
const docOf = (...entities: Entity[]): CadDocument => ({
  ...createEmptyDocument(),
  entities: Object.fromEntries(entities.map((e) => [e.id, e])),
  order: entities.map((e) => e.id),
});
const dxfOf = (doc: CadDocument): string => (execute(doc, 'export_dxf', {}).data as { dxf: string }).dxf;
const back = (doc: CadDocument): Entity[] => {
  const imported = execute(createEmptyDocument(), 'import_dxf', { text: dxfOf(doc) });
  return imported.affected.map((id) => imported.document.entities[id] as Entity);
};
const text = (id: string, content: string, extra: Record<string, unknown> = {}): Entity =>
  entity({ id, kind: 'text', content, height: 2, ...extra });
const turn = (angle: number): number => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

describe('MTEXT round trip', () => {
  it('keeps content, position, rotation and anchor of rotated multi-line text (centre and right)', () => {
    const cases = [
      text('t1', 'first\nsecond', { anchor: 'center', position: [3, 4, 0], rotation: [0, 0, 0.6] }),
      text('t2', 'long line\nx\nthird', { anchor: 'right', position: [-5, 2, 1], rotation: [0, 0, -1.2], height: 3.5 }),
      text('t3', 'a\nb', { anchor: 'left', position: [1, 1, 0] }),
    ];
    for (const original of cases) {
      const [imported] = back(docOf(original));
      expect(imported).toMatchObject({
        kind: 'text',
        content: original.kind === 'text' ? original.content : '',
        anchor: (original as { anchor: string }).anchor,
      });
      expect(imported?.kind === 'text' && imported.height).toBeCloseTo((original as { height: number }).height, 9);
      imported?.position.forEach((value, axis) => expect(value).toBeCloseTo(original.position[axis] as number, 9));
      const gap = turn((imported?.rotation[2] as number) - original.rotation[2]);
      expect(Math.min(gap, 2 * Math.PI - gap)).toBeLessThan(1e-9);
    }
  });

  it('escapes backslashes, braces and \\U+ in MTEXT and TEXT, and %% control codes in TEXT', () => {
    const multi = 'a\\b {c} \\U+0041\nsecond \\P';
    expect((back(docOf(text('m', multi)))[0] as { content: string }).content).toBe(multi);
    const single = '100%% %%d \\U+0041 50% \\';
    const file = dxfOf(docOf(text('s', single)));
    expect(file).toContain('%%%');
    expect(file).toContain('\\U+005C');
    expect((back(docOf(text('s', single)))[0] as { content: string }).content).toBe(single);
    expect((back(docOf(text('s', '50%')))[0] as { content: string }).content).toBe('50%');
  });

  it('reads %%d %%p %%c from other CAD as degree, plus-minus and diameter', () => {
    const source = '0\nSECTION\n2\nENTITIES\n0\nTEXT\n8\n0\n10\n0\n20\n0\n40\n2\n1\n%%c25 %%p0.1 90%%d 5%%%\n0\nENDSEC\n0\nEOF\n';
    const result = execute(createEmptyDocument(), 'import_dxf', { text: source });
    expect(result.document.entities[result.affected[0] as string]).toMatchObject({ content: '\u00d825 \u00b10.1 90\u00b0 5%' });
  });
});

describe('dxfText', () => {
  const old = (content: string): string =>
    [...content.replace(/[\r\n]+/g, ' ')]
      .map((character) => {
        const code = character.codePointAt(0) ?? 63;
        return code < 128 ? character : `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
      })
      .join('');

  it('is byte-identical to the previous implementation over U+0080-U+FFFF (surrogates excluded)', () => {
    for (let start = 0x80; start <= 0xffff; start += 0x400) {
      const chars: string[] = [];
      for (let code = start; code < start + 0x400 && code <= 0xffff; code++)
        if (code < 0xd800 || code > 0xdfff) chars.push(String.fromCharCode(code));
      const run = chars.join('');
      expect(dxfText(run)).toBe(old(run));
    }
  });

  it('round-trips an astral character through surrogate escapes', () => {
    expect(dxfText('\u{1f600}')).toBe('\\U+D83D\\U+DE00');
    const [imported] = back(docOf(text('e', 'ok \u{1f600}')));
    expect((imported as { content: string }).content).toBe('ok \u{1f600}');
  });
});

describe('layers with the same name', () => {
  const doc = (): CadDocument => {
    const empty = createEmptyDocument();
    return {
      ...docOf(
        entity({ id: 'l1', kind: 'line', start: [0, 0], end: [1, 0], layerId: 'a' }),
        entity({ id: 'l2', kind: 'line', start: [0, 1], end: [1, 1], layerId: 'b' }),
      ),
      layers: {
        ...empty.layers,
        a: { id: 'a', name: 'Walls', visible: true, locked: false },
        b: { id: 'b', name: 'Walls', visible: true, locked: false },
      },
    };
  };

  it('keeps two layers apart by id in DXF and SVG (suffix on the clash)', () => {
    const dxf = execute(doc(), 'export_dxf', {}).data as { layers: string[]; dxf: string };
    expect(dxf.layers).toEqual(['Walls', 'Walls_2']);
    const svg = execute(doc(), 'export_svg', {}).data as { layers: string[]; svg: string };
    expect(svg.layers).toEqual(['Walls', 'Walls_2']);
    expect(svg.svg).toContain('data-layer="Walls_2"');
    const imported = execute(createEmptyDocument(), 'import_dxf', { text: dxf.dxf });
    expect(new Set(imported.affected.map((id) => imported.document.entities[id]?.layerId)).size).toBe(2);
  });
});

describe('export_svg dimension and multi-line text', () => {
  it('draws a dimension as lines + its value text and multi-line text as tspans', () => {
    const lines = [
      entity({ id: 'l1', kind: 'line', start: [0, 0], end: [10, 0] }),
      entity({ id: 'l2', kind: 'line', start: [0, 5], end: [10, 5] }),
      entity({ id: 'dim', kind: 'dimension', dimensionKind: 'linear', entityIds: ['l1', 'l2'], offset: 3 }),
      text('t', 'one\ntwo', { position: [20, 20, 0], rotation: [0, 0, 0.3] }),
    ];
    const result = execute(docOf(...lines), 'export_svg', {});
    const svg = (result.data as { svg: string; dimensions: number }).svg;
    expect((result.data as { dimensions: number }).dimensions).toBe(1);
    expect(result.summary).toContain('1 dimension(s) drawn as lines + text');
    expect(svg.match(/<tspan /g)).toHaveLength(2);
    expect(svg).toContain('>one</tspan>');
    expect(svg.match(/<text /g)).toHaveLength(2);
    expect(svg).toContain('rotate(-17.188734');
  });
});

describe('export gate', () => {
  it.each(['export_dxf', 'export_svg'])('%s refuses a document with export-controlled material', (name) => {
    const record = { id: 'secret', designation: 'X', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'ITAR' } };
    const marked = boxOf(step(createEmptyDocument(), 'define_material_record', record), 'secret').doc;
    const doc = {
      ...marked,
      entities: { ...marked.entities, l: entity({ id: 'l', kind: 'line', start: [0, 0], end: [1, 0] }) },
      order: [...marked.order, 'l'],
    };
    const result = execute(doc, name, {}, { ...defaultContext(), humanSignature: null });
    expect(result.error?.code).toBe('MAT_EXPORT_CONTROLLED');
    expect(result.data).toBeUndefined();
  });
});

describe('import_dxf hostile NURBS and fan-out', () => {
  const groups = (...flat: Array<string | number>): string => flat.join('\n') + '\n';
  const line = [0, 'LINE', 8, 'L', 10, 0, 20, 0, 11, 1, 21, 1];
  const splineWith = (...codes: Array<string | number>): string =>
    groups(0, 'SECTION', 2, 'ENTITIES', ...line, 0, 'SPLINE', 8, 'S', ...codes, 0, 'ENDSEC', 0, 'EOF');
  const controls = [10, 0, 20, 0, 10, 1, 20, 1, 10, 2, 20, 0];

  it.each([
    ['a zero weight', [71, 2, 72, 6, 73, 3, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, ...controls, 41, 1, 41, 0, 41, 1]],
    ['a negative weight', [71, 2, 72, 6, 73, 3, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, ...controls, 41, 1, 41, -2, 41, 1]],
    ['decreasing knots', [71, 2, 72, 6, 73, 3, 40, 0, 40, 0, 40, 1, 40, 0.5, 40, 1, 40, 1, ...controls]],
    ['knots at -1e308 / +1e308', [71, 2, 72, 6, 73, 3, 40, -1e308, 40, -1e308, 40, -1e308, 40, 1e308, 40, 1e308, 40, 1e308, ...controls]],
    ['a NaN control point', [71, 2, 72, 6, 73, 3, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 10, 'NaN', 20, 0, 10, 1, 20, 1, 10, 2, 20, 0]],
  ])('%s: the SPLINE is skipped as malformed and the good LINE still imports', (_name, codes) => {
    const result = execute(createEmptyDocument(), 'import_dxf', { text: splineWith(...codes) });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0] as string]?.kind).toBe('line');
    expect(result.summary).toContain('SPLINE (malformed)');
  });

  it('skips and counts entities whose coordinates overflow after unit scaling', () => {
    const source = groups(
      0,
      'SECTION',
      2,
      'HEADER',
      9,
      '$INSUNITS',
      70,
      6,
      0,
      'ENDSEC',
      0,
      'SECTION',
      2,
      'ENTITIES',
      ...line,
      0,
      'LINE',
      8,
      'L',
      10,
      1e308,
      20,
      0,
      11,
      1,
      21,
      1,
      0,
      'ENDSEC',
      0,
      'EOF',
    );
    const result = execute(createEmptyDocument(), 'import_dxf', { text: source });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('1 entities with non-finite coordinates');
  });

  it('bounds a self-referencing block of empty INSERTs by the records visited', () => {
    const inserts = Array.from({ length: 50 }, () => [0, 'INSERT', 2, 'B', 8, '0', 10, 0, 20, 0]).flat();
    const source = groups(
      0,
      'SECTION',
      2,
      'BLOCKS',
      0,
      'BLOCK',
      2,
      'B',
      10,
      0,
      20,
      0,
      30,
      0,
      ...inserts,
      0,
      'ENDBLK',
      0,
      'ENDSEC',
      0,
      'SECTION',
      2,
      'ENTITIES',
      0,
      'INSERT',
      2,
      'B',
      8,
      '0',
      0,
      'ENDSEC',
      0,
      'EOF',
    );
    const drawing = parseDxf(source);
    const result = flattenDxf(drawing as NonNullable<typeof drawing>);
    expect(result.primitives).toHaveLength(0);
    expect(result.skipped.get('over limit')).toBeGreaterThan(0);
  });
});
