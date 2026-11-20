import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type DimensionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { xy } from '../helpers/xy';

const first = (result: { affected: readonly string[] }): string => result.affected[0]!;

/** Two vertical lines 120 apart, a circle, and two dimensions on them. */
function drawing(): { doc: CadDocument; linear: string; diameter: string } {
  let doc = createEmptyDocument();
  const run = (command: string, params: object): string => {
    const result = execute(doc, command, params);
    doc = result.document;
    return first(result);
  };
  const left = run('draw_polyline', { points: xy(0, 0, 0, 50) });
  const right = run('draw_polyline', { points: xy(120, 0, 120, 50) });
  const circle = run('draw_arc', { center: [60, 25], radius: 10 });
  const linear = run('add_dimension', { dimensionKind: 'linear', entityIds: [left, right] });
  const diameter = run('add_dimension', { dimensionKind: 'diameter', entityIds: [circle] });
  return { doc, linear, diameter };
}

const styleIdOf = (result: { data?: unknown }): string => (result.data as { styleId: string }).styleId;
const dimension = (doc: CadDocument, id: string): DimensionEntity => doc.entities[id] as DimensionEntity;
const sceneText = (doc: CadDocument, id: string): string | null =>
  (execute(doc, 'describe_scene', {}).data as { dimensions: Array<{ id: string; text: string | null }> }).dimensions.find(
    (entry) => entry.id === id,
  )?.text ?? null;

describe('create_dimension_style', () => {
  const { doc } = drawing();

  it('stores the given fields and returns the id', () => {
    const result = execute(doc, 'create_dimension_style', { name: 'ISO', textHeight: 3.5, arrowStyle: 'closed', decimalSeparator: ',' });
    const id = styleIdOf(result);
    expect(result.document.dimensionStyles?.[id]).toEqual({
      id,
      name: 'ISO',
      textHeight: 3.5,
      arrowStyle: 'closed',
      decimalSeparator: ',',
    });
    expect(result.document.activeDimensionStyleId).toBeUndefined();
    expect(result.summary).toContain(`Created dimension style ${id} ("ISO")`);
  });
  it('makeActive makes new dimensions use it', () => {
    const created = execute(doc, 'create_dimension_style', { name: 'Arch', arrowStyle: 'tick', makeActive: true });
    const id = styleIdOf(created);
    expect(created.document.activeDimensionStyleId).toBe(id);
    const circle = Object.values(created.document.entities).find((entity) => entity.kind === 'arc' || entity.kind === 'circle')!;
    const added = execute(created.document, 'add_dimension', { dimensionKind: 'radial', entityIds: [circle.id] });
    expect(dimension(added.document, first(added)).styleId).toBe(id);
    expect(added.summary).toContain(`style ${id}`);
  });
  it('refuses empty or duplicate names and invalid fields', () => {
    expectNoOp(execute(doc, 'create_dimension_style', { name: '  ' }), doc, 'name must not be empty');
    const once = execute(doc, 'create_dimension_style', { name: 'A' }).document;
    expectNoOp(execute(once, 'create_dimension_style', { name: 'A' }), once, 'already exists');
    expectNoOp(execute(doc, 'create_dimension_style', { name: 'B', textHeight: 0 }), doc, 'textHeight must be a finite number > 0');
    expectNoOp(execute(doc, 'create_dimension_style', { name: 'B', extensionGap: -1 }), doc, 'extensionGap must be');
    expectNoOp(execute(doc, 'create_dimension_style', { name: 'B', precision: 99 }), doc, 'precision must be an integer');
    expectNoOp(execute(doc, 'create_dimension_style', { name: 'B', prefix: 'x'.repeat(40) }), doc, 'prefix is longer');
    expectNoOp(execute(doc, 'create_dimension_style', { name: 'B', color: 'red' }), doc, 'color must be');
  });
  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'create_dimension_style', { name: 'P', makeActive: true }));
  });
});

describe('dimension styles drive the drawn text', () => {
  it('formats with the style precision, separator, prefix and suffix; the dimension precision still wins', () => {
    const { doc, linear, diameter } = drawing();
    const created = execute(doc, 'create_dimension_style', { name: 'EU', precision: 1, decimalSeparator: ',', suffix: ' mm', prefix: '~' });
    const styled = execute(created.document, 'apply_dimension_style', { styleId: styleIdOf(created) }).document;
    expect(sceneText(styled, linear)).toBe('~120,0 mm');
    expect(sceneText(styled, diameter)).toBe('Ø~20,0 mm');
    const precise = execute(doc, 'add_dimension', {
      dimensionKind: 'diameter',
      entityIds: dimension(doc, diameter).entityIds,
      precision: 2,
      style: styleIdOf(created),
    });
    expect(precise.summary).toContain('no dimension style');
    const withStyle = execute(created.document, 'add_dimension', {
      dimensionKind: 'diameter',
      entityIds: dimension(doc, diameter).entityIds,
      precision: 2,
      style: styleIdOf(created),
    });
    expect(sceneText(withStyle.document, first(withStyle))).toBe('Ø~20,00 mm');
  });
  it('writes the style text height into the DXF export', () => {
    const { doc } = drawing();
    const created = execute(doc, 'create_dimension_style', { name: 'Big', textHeight: 4.375 });
    const styled = execute(created.document, 'apply_dimension_style', { styleId: styleIdOf(created) }).document;
    const dxf = (execute(styled, 'export_dxf', {}).data as { dxf: string }).dxf;
    const plain = (execute(doc, 'export_dxf', {}).data as { dxf: string }).dxf;
    expect(dxf).toMatch(/\n40\n4\.375\n/);
    expect(plain).not.toMatch(/\n40\n4\.375\n/);
  });
  it('add_dimension refuses an unknown style', () => {
    const { doc, diameter } = drawing();
    expectNoOp(
      execute(doc, 'add_dimension', { dimensionKind: 'diameter', entityIds: dimension(doc, diameter).entityIds, style: 'nope' }),
      doc,
      "no dimension style 'nope'",
    );
  });
});

describe('update / apply / delete / activate / list', () => {
  const setup = (): { doc: CadDocument; style: string; other: string; linear: string; diameter: string } => {
    const { doc, linear, diameter } = drawing();
    const a = execute(doc, 'create_dimension_style', { name: 'A', textHeight: 2, arrowStyle: 'dot', makeActive: true });
    const b = execute(a.document, 'create_dimension_style', { name: 'B' });
    const applied = execute(b.document, 'apply_dimension_style', { styleId: styleIdOf(a), entityIds: [linear] }).document;
    return { doc: applied, style: styleIdOf(a), other: styleIdOf(b), linear, diameter };
  };

  it('update changes and resets fields and reports the dimensions using it', () => {
    const { doc, style, linear } = setup();
    const result = execute(doc, 'update_dimension_style', { styleId: style, name: 'A2', arrowSize: 1, reset: ['arrowStyle'] });
    expect(result.document.dimensionStyles?.[style]).toEqual({ id: style, name: 'A2', textHeight: 2, arrowSize: 1 });
    expect(result.affected).toEqual([linear]);
    expect(result.summary).toContain('1 dimension(s) use it');
  });
  it('update refuses unknown styles, empty changes, duplicate names and bad values', () => {
    const { doc, style } = setup();
    expectNoOp(execute(doc, 'update_dimension_style', { styleId: 'x', name: 'Q' }), doc, "no dimension style 'x'");
    expectNoOp(execute(doc, 'update_dimension_style', { styleId: style }), doc, 'give at least one field');
    expectNoOp(execute(doc, 'update_dimension_style', { styleId: style, name: 'B' }), doc, 'already exists');
    expectNoOp(execute(doc, 'update_dimension_style', { styleId: style, name: ' ' }), doc, 'name must not be empty');
    expectNoOp(execute(doc, 'update_dimension_style', { styleId: style, arrowSize: -2 }), doc, 'arrowSize must be');
    expectNoOp(execute(doc, 'update_dimension_style', { styleId: style, textHeight: 2 }), doc, 'already has those values');
    expectNoOp(execute(doc, 'update_dimension_style', { styleId: style, reset: ['suffix'] }), doc, 'already has those values');
    expectNoOp(execute(doc, 'apply_dimension_style', { styleId: style, entityIds: [] }), doc, 'entityIds is empty');
  });
  it('apply restyles given or all dimensions, null clears, refuses non-dimensions', () => {
    const { doc, other, linear, diameter } = setup();
    const all = execute(doc, 'apply_dimension_style', { styleId: other });
    expect([...all.affected].sort()).toEqual([linear, diameter].sort());
    expect(dimension(all.document, diameter).styleId).toBe(other);
    const cleared = execute(all.document, 'apply_dimension_style', { styleId: null, entityIds: [diameter] });
    expect(dimension(cleared.document, diameter).styleId).toBeUndefined();
    expect(cleared.summary).toContain('Cleared');
    const line = dimension(doc, linear).entityIds[0]!;
    expectNoOp(execute(doc, 'apply_dimension_style', { styleId: other, entityIds: [line] }), doc, 'not a dimension');
    expectNoOp(execute(doc, 'apply_dimension_style', { styleId: other, entityIds: ['missing'] }), doc, 'not in the document');
    expectNoOp(execute(doc, 'apply_dimension_style', { styleId: 'zz' }), doc, "no dimension style 'zz'");
    const empty = createEmptyDocument();
    const styled = execute(empty, 'create_dimension_style', { name: 'S' });
    expectNoOp(execute(styled.document, 'apply_dimension_style', { styleId: styleIdOf(styled) }), styled.document, 'no dimensions');
  });
  it('delete moves its dimensions and the active pointer to replaceWith, or clears them', () => {
    const { doc, style, other, linear } = setup();
    const replaced = execute(doc, 'delete_dimension_style', { styleId: style, replaceWith: other });
    expect(replaced.document.dimensionStyles?.[style]).toBeUndefined();
    expect(dimension(replaced.document, linear).styleId).toBe(other);
    expect(replaced.document.activeDimensionStyleId).toBe(other);
    expect(replaced.affected).toEqual([linear]);
    const dropped = execute(doc, 'delete_dimension_style', { styleId: style });
    expect(dimension(dropped.document, linear).styleId).toBeUndefined();
    expect('activeDimensionStyleId' in dropped.document).toBe(false);
    expectNoOp(execute(doc, 'delete_dimension_style', { styleId: 'q' }), doc, "no dimension style 'q'");
    expectNoOp(execute(doc, 'delete_dimension_style', { styleId: style, replaceWith: style }), doc, 'must be another existing style');
  });
  it('set_active_dimension_style sets and clears; list reports usage', () => {
    const { doc, style, other } = setup();
    expect(execute(doc, 'set_active_dimension_style', { styleId: other }).document.activeDimensionStyleId).toBe(other);
    expect('activeDimensionStyleId' in execute(doc, 'set_active_dimension_style', { styleId: null }).document).toBe(false);
    expectNoOp(execute(doc, 'set_active_dimension_style', { styleId: 'nope' }), doc, "no dimension style 'nope'");
    const listed = execute(doc, 'list_dimension_styles', {});
    expect(listed.document).toBe(doc);
    const data = listed.data as { activeStyleId: string | null; styles: Array<{ id: string; dimensionCount: number }> };
    expect(data.activeStyleId).toBe(style);
    expect(data.styles.map((entry) => [entry.id, entry.dimensionCount])).toEqual([
      [style, 1],
      [other, 0],
    ]);
    expect(execute(createEmptyDocument(), 'list_dimension_styles', {}).summary).toContain('No dimension styles');
  });
  it('every style command is pure', () => {
    const { doc, style, other } = setup();
    expectPure(doc, () => execute(doc, 'update_dimension_style', { styleId: style, textHeight: 9 }));
    expectPure(doc, () => execute(doc, 'apply_dimension_style', { styleId: other }));
    expectPure(doc, () => execute(doc, 'delete_dimension_style', { styleId: style }));
    expectPure(doc, () => execute(doc, 'set_active_dimension_style', { styleId: null }));
  });
});

describe('dimension styles in saved files', () => {
  it('round-trip through save / load', () => {
    const { doc, linear } = drawing();
    const created = execute(doc, 'create_dimension_style', { name: 'R', extensionGap: 1, makeActive: true });
    const styled = execute(created.document, 'apply_dimension_style', { styleId: styleIdOf(created) }).document;
    const loaded = deserializeDocument(serializeDocument(styled));
    expect(loaded.dimensionStyles).toEqual(styled.dimensionStyles);
    expect(loaded.activeDimensionStyleId).toBe(styleIdOf(created));
    expect(dimension(loaded, linear).styleId).toBe(styleIdOf(created));
  });
  it('refuse a dangling styleId, a dangling active style or a bad field', () => {
    const { doc, linear } = drawing();
    const envelope = (document: unknown): string => JSON.stringify({ format: 'llull-document', version: 3, document });
    const dangling = { ...doc, entities: { ...doc.entities, [linear]: { ...dimension(doc, linear), styleId: 'ghost' } } };
    expect(() => deserializeDocument(envelope(dangling))).toThrow(/styleId 'ghost' does not name a dimension style/);
    expect(() => deserializeDocument(envelope({ ...doc, activeDimensionStyleId: 'ghost' }))).toThrow(/activeDimensionStyleId 'ghost'/);
    const bad = { ...doc, dimensionStyles: { s: { id: 's', name: 'S', arrowStyle: 'hook' } } };
    expect(() => deserializeDocument(envelope(bad))).toThrow(/dimensionStyle 's': arrowStyle must be/);
    expect(() => deserializeDocument(envelope({ ...doc, dimensionStyles: [] }))).toThrow(/dimensionStyles must be an object/);
    expect(() => deserializeDocument(envelope({ ...doc, dimensionStyles: { s: { id: 't', name: 'S' } } }))).toThrow(/needs id/);
  });
});

describe('dimension style ids and the step counter', () => {
  it('a file whose nextStepNumber is stale still never re-mints a style id', () => {
    const { doc } = drawing();
    const created = execute(doc, 'create_dimension_style', { name: 'S' });
    const id = styleIdOf(created);
    const stale = { ...created.document, nextStepNumber: 1 };
    const loaded = deserializeDocument(JSON.stringify({ format: 'llull-document', version: 3, document: stale }));
    expect(loaded.nextStepNumber).toBeGreaterThan(Number(/-(\d+)\./.exec(id)![1]));
  });
});

describe('dimension style load validation, field by field', () => {
  const { doc } = drawing();
  const load =
    (style: Record<string, unknown>): (() => unknown) =>
    () =>
      deserializeDocument(
        JSON.stringify({
          format: 'llull-document',
          version: 3,
          document: { ...doc, dimensionStyles: { s: { id: 's', name: 'S', ...style } } },
        }),
      );
  it.each([
    ['textHeight', 0],
    ['arrowSize', -1],
    ['extensionGap', -0.1],
    ['extensionBeyond', 'far'],
    ['precision', 1.5],
    ['angularPrecision', 99],
    ['decimalSeparator', ';'],
    ['prefix', 'x'.repeat(33)],
    ['suffix', 7],
    ['color', '#12345'],
  ])('refuses a bad %s', (key, value) => {
    expect(load({ [key]: value })).toThrow(new RegExp(`dimensionStyle 's': ${key} must be`));
  });
  it('accepts every field at a valid value', () => {
    const style = {
      textHeight: 2.5,
      arrowSize: 0.5,
      arrowStyle: 'tick',
      extensionGap: 0,
      extensionBeyond: 1,
      precision: 2,
      angularPrecision: 0,
      decimalSeparator: ',',
      prefix: 'R',
      suffix: ' mm',
      color: '#112233',
    };
    expect((load(style)() as CadDocument).dimensionStyles?.['s']).toEqual({ id: 's', name: 'S', ...style });
  });
});
