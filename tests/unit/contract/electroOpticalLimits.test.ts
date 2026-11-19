/**
 * Every EOP slice command at its parameter limits (longest strings, extreme element counts) stores a slice that saves, loads and comes back
 * equal; one past a limit is refused at validation with the document unchanged. EOP only: the bounds live in `electroOptical/model.ts`
 * (EOP_LIMITS), shared by the command params and the load schema; a generic version over every plugin slice would need per-command
 * knowledge of which strings are stored, so it is not attempted here.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { EOP_LIMITS } from '@cae/electroOptical/model';
import { signingContext } from '../../helpers/signedPlantDoc';

const text = (length: number, fill = 'x'): string => fill.repeat(length);
const LONG_SOURCE = { citation: text(EOP_LIMITS.citation), locator: text(EOP_LIMITS.locator) };

const ok = (
  doc: CadDocument,
  name: string,
  params: Record<string, unknown>,
  ctx = undefined as typeof signingContext | undefined,
): CadDocument => {
  const result = execute(doc, name, params, ctx);
  expect(result.error, `${name}: ${result.summary}`).toBeUndefined();
  return result.document;
};

function base(): { doc: CadDocument; a: string; b: string } {
  let doc = createEmptyDocument();
  for (const [id, productForm] of [
    ['paint', 'coating'],
    ['strap', 'strap'],
  ] as const)
    doc = ok(doc, 'define_material_record', {
      id,
      designation: 'limits',
      productForm,
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
  doc = ok(doc, 'define_property_model', {
    material: 'strap',
    model: {
      id: 'rho',
      property: 'electricalResistivity',
      unit: 'ohm*m',
      variables: [],
      form: { kind: 'constant', value: 1e-8 },
      validity: [],
      basis: 'company',
      source: { citation: 'limits test input' },
    },
  });
  const first = execute(doc, 'add_box', { size: [10, 10, 10] });
  const second = execute(first.document, 'add_box', { size: [10, 10, 10], position: [0, 0, 10] });
  return { doc: second.document, a: first.affected[0] ?? '', b: second.affected[0] ?? '' };
}

const joint = (source: Record<string, unknown>, a: string, b: string): Record<string, unknown> => ({
  kind: 'joint',
  resistance: { value: 1e-300, unit: 'ohm' },
  source,
  interfaces: [a, b],
});

describe('electro-optical slice at its parameter limits (save -> load -> equal)', () => {
  it('every slice command at its longest strings and largest element count round-trips', () => {
    const { doc, a, b } = base();
    let next = ok(doc, 'assign_surface_coating', {
      entityId: a,
      coating: 'paint',
      location: 'bonded_interface',
      electrical: 'conductive',
      source: LONG_SOURCE,
    });
    next = ok(next, 'set_lightning_zone', { entityId: a, zone: '1C', source: LONG_SOURCE });
    const elements = Array.from({ length: EOP_LIMITS.elements }, (_, index) =>
      index % 2 === 0
        ? joint(LONG_SOURCE, a, b)
        : { kind: 'strap', material: 'strap', length: { value: 1e300, unit: 'm' }, crossSection: { value: 1e-300, unit: 'm^2' } },
    );
    const defined = execute(next, 'define_bond_path', {
      name: text(EOP_LIMITS.name),
      from: a,
      to: b,
      elements,
      limit: { value: Number.MIN_VALUE, unit: 'ohm', ruleId: text(EOP_LIMITS.key, 'r'), source: LONG_SOURCE },
      temperature: { value: -273.15, unit: 'degC' },
    });
    expect(defined.error, defined.summary).toBeUndefined();
    next = ok(
      defined.document,
      'dispose_bond_check',
      {
        pathId: defined.affected[0],
        decision: 'rejected',
        justification: text(EOP_LIMITS.justification),
        confirmation: { nonce: 'limits' },
      },
      signingContext,
    );
    const loaded = execute(createEmptyDocument(), 'load_document', { json: serializeDocument(next) });
    expect(loaded.error, loaded.summary).toBeUndefined();
    expect(loaded.document.electroOptical).toEqual(next.electroOptical);
  });

  it('a material reference with spaces round-trips (references are not slice keys)', () => {
    const { doc: start, a } = base();
    const doc = ok(start, 'define_material_record', {
      id: 'white paint',
      designation: 'limits',
      productForm: 'coating',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
    const next = ok(doc, 'assign_surface_coating', { entityId: a, coating: 'white paint' });
    const loaded = execute(createEmptyDocument(), 'load_document', { json: serializeDocument(next) });
    expect(loaded.error, loaded.summary).toBeUndefined();
    expect(loaded.document.electroOptical).toEqual(next.electroOptical);
  });

  it.each([
    [
      'set_lightning_zone citation',
      'set_lightning_zone',
      (a: string) => ({ entityId: a, zone: '2A', source: { citation: text(EOP_LIMITS.citation + 1) } }),
    ],
    [
      'set_lightning_zone locator',
      'set_lightning_zone',
      (a: string) => ({ entityId: a, zone: '2A', source: { citation: 'c', locator: text(EOP_LIMITS.locator + 1) } }),
    ],
    [
      'assign_surface_coating citation',
      'assign_surface_coating',
      (a: string) => ({ entityId: a, coating: 'paint', electrical: 'conductive', source: { citation: text(EOP_LIMITS.citation + 1) } }),
    ],
    [
      'define_bond_path name',
      'define_bond_path',
      (a: string, b: string) => ({ name: text(EOP_LIMITS.name + 1), from: a, to: b, elements: [joint({ citation: 'c' }, a, b)] }),
    ],
    [
      'define_bond_path joint citation',
      'define_bond_path',
      (a: string, b: string) => ({ name: 'n', from: a, to: b, elements: [joint({ citation: text(EOP_LIMITS.citation + 1) }, a, b)] }),
    ],
    [
      'define_bond_path element count',
      'define_bond_path',
      (a: string, b: string) => ({
        name: 'n',
        from: a,
        to: b,
        elements: Array.from({ length: EOP_LIMITS.elements + 1 }, () => joint({ citation: 'c' }, a, b)),
      }),
    ],
    [
      'define_bond_path rule id with a space',
      'define_bond_path',
      (a: string, b: string) => ({
        name: 'n',
        from: a,
        to: b,
        elements: [joint({ citation: 'c' }, a, b)],
        limit: { value: 1, unit: 'mohm', ruleId: 'rule 1', source: { citation: 'c' } },
      }),
    ],
    [
      'define_bond_path unit',
      'define_bond_path',
      (a: string, b: string) => ({
        name: 'n',
        from: a,
        to: b,
        elements: [{ kind: 'joint', resistance: { value: 1, unit: text(EOP_LIMITS.unit + 1) }, source: { citation: 'c' } }],
      }),
    ],
  ])('one past the limit is refused at validation: %s', (_label, name, params) => {
    const { doc, a, b } = base();
    const result = execute(doc, name, params(a, b));
    expect(result.summary).toContain('invalid params');
    expect(result.document).toBe(doc);
  });

  it('a justification one past the limit is refused at validation', () => {
    const { doc } = base();
    const result = execute(
      doc,
      'dispose_bond_check',
      { pathId: 'bp-1.1', decision: 'rejected', justification: text(EOP_LIMITS.justification + 1), confirmation: { nonce: 'n' } },
      signingContext,
    );
    expect(result.summary).toContain('invalid params');
    expect(result.document).toBe(doc);
  });
});
