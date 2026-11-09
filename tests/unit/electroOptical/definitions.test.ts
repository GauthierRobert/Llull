import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { electroOpticalErrors } from '@cae/electroOptical/model';
import { run, runPlan } from './fixtures';

const SRC = { citation: 'test input (not a property claim)' };
const record = (doc: CadDocument, id: string, productForm = 'coating'): CadDocument =>
  run(doc, 'define_material_record', {
    id,
    designation: 'test',
    productForm,
    specs: [],
    licence: 'company-proprietary',
    exportMarking: { regime: 'none' },
  });

const withBox = (): { doc: CadDocument; box: string } => {
  const added = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  return { doc: record(added.document, 'paint'), box: added.affected[0] ?? '' };
};

describe('assign_surface_coating / remove_surface_coating', () => {
  it('records the assignment with a step-scoped id, defaulting to an exposed coating of unknown electrical effect', () => {
    const { doc, box } = withBox();
    const result = execute(doc, 'assign_surface_coating', { entityId: box, coating: 'paint' });
    expect(result.error).toBeUndefined();
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^sc-/);
    expect(result.document.electroOptical?.coatings[id]).toEqual({
      id,
      entityId: box,
      coating: 'paint',
      location: 'exposed',
      electrical: 'unknown',
    });
    expect(result.summary).toContain('electrical effect unknown');
  });

  it('is pure', () => {
    const { doc, box } = withBox();
    const before = structuredClone(doc);
    execute(doc, 'assign_surface_coating', { entityId: box, coating: 'paint' });
    expect(doc).toEqual(before);
  });

  it.each([
    ['an unknown entity', { entityId: 'nope', coating: 'paint' }, 'EOP_ENTITY_NOT_FOUND'],
    ['a material that is not a coating record', { entityId: '$box', coating: 'plain' }, 'EOP_COATING_NOT_FOUND'],
    ['a missing material', { entityId: '$box', coating: 'ghost' }, 'EOP_COATING_NOT_FOUND'],
    [
      'a declared electrical effect without a source',
      { entityId: '$box', coating: 'paint', electrical: 'conductive' },
      'EOP_PARAMS_INVALID',
    ],
    [
      'a declared effect with a blank source',
      { entityId: '$box', coating: 'paint', electrical: 'insulating', source: { citation: ' ' } },
      'EOP_PARAMS_INVALID',
    ],
  ])('refuses %s and leaves the document unchanged', (_label, params, code) => {
    const { doc, box } = withBox();
    const withPlain = record(doc, 'plain', 'sheet');
    const result = execute(withPlain, 'assign_surface_coating', {
      ...params,
      entityId: params.entityId === '$box' ? box : params.entityId,
    });
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(withPlain);
    expect(result.affected).toEqual([]);
  });

  it('refuses a 2D shape', () => {
    const { doc } = withBox();
    const line = execute(doc, 'draw_rectangle', { width: 2, height: 3 });
    const result = execute(line.document, 'assign_surface_coating', { entityId: line.affected[0], coating: 'paint' });
    expect(result.error?.code).toBe('EOP_ENTITY_NOT_FOUND');
  });

  it('a location carries one coating; a second is EOP_FACE_ALREADY_COATED, another location is allowed', () => {
    const { doc, box } = withBox();
    const first = run(doc, 'assign_surface_coating', { entityId: box, coating: 'paint' });
    const again = execute(first, 'assign_surface_coating', { entityId: box, coating: 'paint' });
    expect(again.error?.code).toBe('EOP_FACE_ALREADY_COATED');
    expect(again.document).toBe(first);
    const other = execute(first, 'assign_surface_coating', { entityId: box, coating: 'paint', location: 'bonded_interface' });
    expect(other.error).toBeUndefined();
    expect(Object.keys(other.document.electroOptical?.coatings ?? {})).toHaveLength(2);
  });

  it('removes an assignment; an unknown id is refused', () => {
    const { doc, box } = withBox();
    const assigned = execute(doc, 'assign_surface_coating', { entityId: box, coating: 'paint' });
    const id = assigned.affected[0] ?? '';
    const removed = execute(assigned.document, 'remove_surface_coating', { assignmentId: id });
    expect(removed.affected).toEqual([id]);
    expect(removed.document.electroOptical?.coatings).toEqual({});
    const refused = execute(assigned.document, 'remove_surface_coating', { assignmentId: 'sc-none' });
    expect(refused.error?.code).toBe('EOP_COATING_ASSIGNMENT_NOT_FOUND');
    expect(refused.document).toBe(assigned.document);
  });

  it('the coating material and the solid cannot be deleted while assigned (guard)', () => {
    const { doc, box } = withBox();
    const assigned = run(doc, 'assign_surface_coating', { entityId: box, coating: 'paint' });
    const deleted = execute(assigned, 'delete_entity', { ids: [box] });
    expect(deleted.rejected === true || deleted.error !== undefined).toBe(true);
    expect(deleted.document).toBe(assigned);
  });
});

describe('define_bond_path / delete_bond_path', () => {
  const { doc, aliases } = runPlan('eop_bonding_paths.plan.json', 'define_bond_path');
  const [box, structure] = [aliases['box'] ?? '', aliases['structure'] ?? ''];
  const joint = { kind: 'joint', resistance: { value: 1, unit: 'mohm' }, source: SRC };
  const define = (params: Record<string, unknown>): CommandResult =>
    execute(doc, 'define_bond_path', { name: 'p', from: box, to: structure, elements: [joint], ...params });

  it('stores the path with a step-scoped id and its limit as unverified', () => {
    const result = define({ limit: { value: 2.5, unit: 'mohm', ruleId: 'r', source: SRC } });
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^bp-/);
    expect(result.document.electroOptical?.bondPaths[id]?.limit).toMatchObject({ value: 2.5, unit: 'mohm', unverified: true });
    expect(result.summary).toContain('unverified');
    expect(define({}).summary).toContain('no limit');
  });

  it('is pure', () => {
    const before = structuredClone(doc);
    define({});
    expect(doc).toEqual(before);
  });

  it.each([
    ['a blank name', { name: ' ' }, 'EOP_PARAMS_INVALID'],
    ['an unknown endpoint', { from: 'ghost' }, 'EOP_ENTITY_NOT_FOUND'],
    ['an unknown interface solid', { elements: [{ ...joint, interfaces: ['$box', 'ghost'] }] }, 'EOP_ENTITY_NOT_FOUND'],
    ['no element', { elements: [] }, 'EOP_BOND_ELEMENT_INVALID'],
    ['a joint without a source citation', { elements: [{ ...joint, source: { citation: ' ' } }] }, 'EOP_BOND_ELEMENT_INVALID'],
    ['a joint resistance in a length unit', { elements: [{ ...joint, resistance: { value: 1, unit: 'mm' } }] }, 'EOP_BOND_ELEMENT_INVALID'],
    ['a zero joint resistance', { elements: [{ ...joint, resistance: { value: 0, unit: 'ohm' } }] }, 'EOP_BOND_ELEMENT_INVALID'],
    [
      'a strap of an unknown material',
      { elements: [{ kind: 'strap', material: 'ghost', length: { value: 1, unit: 'm' }, crossSection: { value: 1, unit: 'mm^2' } }] },
      'EOP_BOND_ELEMENT_INVALID',
    ],
    [
      'a strap with a negative length',
      {
        elements: [{ kind: 'strap', material: 'strap_61iacs', length: { value: -1, unit: 'm' }, crossSection: { value: 1, unit: 'mm^2' } }],
      },
      'EOP_BOND_ELEMENT_INVALID',
    ],
    [
      'a strap with a length unit for its area',
      { elements: [{ kind: 'strap', material: 'strap_61iacs', length: { value: 1, unit: 'm' }, crossSection: { value: 1, unit: 'mm' } }] },
      'EOP_BOND_ELEMENT_INVALID',
    ],
    [
      'a limit without a citation',
      { limit: { value: 2.5, unit: 'mohm', ruleId: 'r', source: { citation: '' } } },
      'EOP_LIMIT_SOURCE_REQUIRED',
    ],
    ['a limit without a rule id', { limit: { value: 2.5, unit: 'mohm', ruleId: '', source: SRC } }, 'EOP_LIMIT_SOURCE_REQUIRED'],
    ['a negative limit', { limit: { value: -2.5, unit: 'mohm', ruleId: 'r', source: SRC } }, 'EOP_PARAMS_INVALID'],
    ['a temperature that is not one', { temperature: { value: 20, unit: 'mm' } }, 'EOP_PARAMS_INVALID'],
  ])('refuses %s with its code and leaves the document unchanged', (_label, params, code) => {
    const result = define(JSON.parse(JSON.stringify(params).replaceAll('$box', box)));
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('deletes a path and its disposition; an unknown id is refused', () => {
    const created = define({});
    const id = created.affected[0] ?? '';
    const removed = execute(created.document, 'delete_bond_path', { pathId: id });
    expect(removed.affected).toEqual([id]);
    expect(removed.document.electroOptical?.bondPaths).toEqual({});
    const refused = execute(created.document, 'delete_bond_path', { pathId: 'bp-none' });
    expect(refused.error?.code).toBe('EOP_PATH_NOT_FOUND');
    expect(refused.document).toBe(created.document);
  });
});

describe('the electroOptical slice on load (hostile input)', () => {
  const path = {
    id: 'bp-1.1',
    name: 'p',
    from: 'a',
    to: 'b',
    elements: [{ kind: 'joint', resistance: { value: 1, unit: 'mohm' }, source: SRC }],
  };
  const slice = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    electroOptical: { coatings: {}, bondPaths: { 'bp-1.1': path }, dispositions: {}, ...overrides },
  });

  it('accepts a valid slice and an absent one', () => {
    expect(electroOpticalErrors(slice({}))).toEqual([]);
    expect(electroOpticalErrors({})).toEqual([]);
  });

  it.each([
    ['an id that differs from its key', slice({ bondPaths: { other: path } })],
    [
      'a reserved entity key',
      slice({ coatings: { 'sc-1.1': { id: 'sc-1.1', entityId: '__proto__', coating: 'c', location: 'exposed', electrical: 'unknown' } } }),
    ],
    ['a path without elements', slice({ bondPaths: { 'bp-1.1': { ...path, elements: [] } } })],
    [
      'a joint resistance in a wrong unit',
      slice({ bondPaths: { 'bp-1.1': { ...path, elements: [{ ...path.elements[0], resistance: { value: 1, unit: 'kg' } }] } } }),
    ],
    [
      'a negative joint resistance',
      slice({ bondPaths: { 'bp-1.1': { ...path, elements: [{ ...path.elements[0], resistance: { value: -1, unit: 'ohm' } }] } } }),
    ],
    [
      'a non-finite value',
      slice({
        bondPaths: { 'bp-1.1': { ...path, limit: { value: 1e308 * 10, unit: 'ohm', ruleId: 'r', source: SRC, unverified: true } } },
      }),
    ],
    [
      'a limit without source',
      slice({ bondPaths: { 'bp-1.1': { ...path, limit: { value: 1, unit: 'ohm', ruleId: 'r', unverified: true } } } }),
    ],
    [
      'an unknown electrical effect',
      slice({ coatings: { 'sc-1.1': { id: 'sc-1.1', entityId: 'a', coating: 'c', location: 'exposed', electrical: 'maybe' } } }),
    ],
    [
      'a coating id that differs from its key',
      slice({ coatings: { x: { id: 'y', entityId: 'a', coating: 'c', location: 'exposed', electrical: 'unknown' } } }),
    ],
    [
      'a disposition with a malformed hash',
      slice({
        dispositions: {
          'bp-1.1': {
            pathId: 'bp-1.1',
            decision: 'accepted',
            justification: 'j',
            inputsHash: 'zz',
            signer: 's',
            signatureId: 'i',
            signature: {},
            documentUid: 'u',
          },
        },
      }),
    ],
    ['an extra key', slice({ extra: 1 })],
    ['a non-object slice', { electroOptical: 'x' }],
  ])('refuses %s with a named path', (_label, raw) => {
    const errors = electroOpticalErrors(raw as Record<string, unknown>);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('electroOptical');
  });
});
