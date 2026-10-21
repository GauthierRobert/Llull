/** 12 CFD M1 review fixes: custom box with symmetry, deleted bodies, inlet/outlet openings, not_run status, load validation, duplicates, memory wording. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { cfdPlugin } from '@aero/index';
import { isUnverified } from '@aero/cfd/prepare';
import { expectRefusal } from '../../../helpers/commandAssertions';
import { addBody, boxMesh, metreDocument, ok, prepare, rowOf, withCase } from './fixtures';

const unit = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, -0.5, 0], anchor: 'min' });

describe('custom domain box with a symmetry plane', () => {
  it('checks containment against the full custom box, not the half domain', () => {
    const doc = withCase(unit.doc, [unit.id], {
      domain: { rule: 'custom', box: { min: [-1, -2, -1], max: [3, 2, 2] }, symmetryPlane: 'xz' },
    });
    const report = prepare(doc);
    expect(report.checks.some((check) => check.code === 'CFD_PARAM_INVALID')).toBe(false);
    expect(report.domain?.box.min[1]).toBe(0);
    const tooSmall = withCase(unit.doc, [unit.id], {
      domain: { rule: 'custom', box: { min: [-1, -0.2, -1], max: [3, 2, 2] }, symmetryPlane: 'xz' },
    });
    expect(rowOf(prepare(tooSmall), 'CFD_PARAM_INVALID').message).toContain('does not contain');
  });
});

describe('bodies deleted after the case was made', () => {
  const two = addBody(unit.doc, 'add_box', { size: [1, 1, 1], position: [5, 0, 0], anchor: 'min' });
  const doc = withCase(two.doc, [unit.id, two.id], { excludedEntityIds: [] });
  const without = (id: string): CadDocument => ok(doc, 'delete_entities', { ids: [id] }).document;

  it('prepare and check_cfd fail with CFD_ENTITY_NOT_FOUND listing the ids', () => {
    const gone = without(two.id);
    const report = prepare(gone);
    const row = rowOf(report, 'CFD_ENTITY_NOT_FOUND');
    expect(row.status).toBe('fail');
    expect(row['ids']).toEqual([two.id]);
    expect(report.status).toBe('fail');
    const checked = ok(gone, 'check_cfd', {}).data as { status: string; cases: Array<{ failing: string[] }> };
    expect(checked.status).toBe('fail');
    expect(checked.cases[0]?.failing).toContain('CFD_ENTITY_NOT_FOUND');
  });

  it('an update is not blocked by an excluded or already-missing id, but a new unknown id is refused', () => {
    const withExcluded = ok(doc, 'update_cfd_case', { caseId: 'c1', excludedEntityIds: [two.id] }).document;
    const gone = ok(withExcluded, 'delete_entities', { ids: [two.id] }).document;
    expect(ok(gone, 'update_cfd_case', { caseId: 'c1', quality: 'draft' }).document.cfd?.cases['c1']?.quality).toBe('draft');
    expect(prepare(gone).checks.some((check) => check.code === 'CFD_ENTITY_NOT_FOUND')).toBe(false);
    expectRefusal(gone, 'update_cfd_case', { caseId: 'c1', excludedEntityIds: ['ghost'] }, 'CFD_ENTITY_NOT_FOUND');
    const missingBody = without(unit.id);
    expect(ok(missingBody, 'update_cfd_case', { caseId: 'c1', entityIds: [two.id] }).affected).toEqual(['c1']);
  });
});

describe('inlet / outlet openings (§5.1 step 8)', () => {
  const open = boxMesh([0, 0, 0], [1, 1, 1]);
  const mesh = ok(metreDocument(), 'import_mesh', { bodies: [{ positions: open.positions, indices: open.indices.slice(0, 30) }] });
  const id = mesh.affected[0] as string;

  it('open edges of a body tagged inlet do not count as non-watertight', () => {
    const untagged = withCase(mesh.document, [id]);
    expect(rowOf(prepare(untagged), 'CFD_GEOMETRY_NOT_WATERTIGHT').status).toBe('fail');
    const tagged = ok(untagged, 'set_cfd_boundary', { caseId: 'c1', kind: 'inlet', entityId: id }).document;
    const row = rowOf(prepare(tagged), 'CFD_GEOMETRY_NOT_WATERTIGHT');
    expect(row.status).toBe('pass');
    expect(row['openingEdges']).toBe(4);
    const walled = ok(untagged, 'set_cfd_boundary', { caseId: 'c1', kind: 'wall', entityId: id }).document;
    expect(rowOf(prepare(walled), 'CFD_GEOMETRY_NOT_WATERTIGHT').status).toBe('fail');
  });
});

describe('not_run is never a pass', () => {
  it('only the neutral memory row is exempt', () => {
    const base = { code: 'X', message: '' };
    expect(isUnverified({ ...base, status: 'not_run' })).toBe(true);
    expect(isUnverified({ ...base, status: 'not_run', neutral: true })).toBe(false);
    expect(isUnverified({ ...base, status: 'pass' })).toBe(false);
  });

  it('a case without device memory stays pass', () => {
    expect(prepare(withCase(unit.doc, [unit.id])).status).toBe('pass');
  });
});

describe('case validation', () => {
  it('refuses a body listed twice', () => {
    expectRefusal(
      unit.doc,
      'create_cfd_case',
      { id: 'c1', entityIds: [unit.id, unit.id], freestream: { speedMS: 1 }, reference: { areaM2: 1, lengthM: 1 } },
      'CFD_PARAM_INVALID',
      'entityIds',
    );
  });

  it('says so when the case fits at no allowed resolution', () => {
    const report = prepare(withCase(unit.doc, [unit.id]), { deviceMemoryBytes: 1000 });
    const row = rowOf(report, 'CFD_MEMORY_EXCEEDED');
    expect(row.status).toBe('fail');
    expect(row.message).toContain('any allowed resolution');
    expect(row['largestFittingCellsPerReferenceLength']).toBeNull();
  });

  it('notes that the moment point is not recomputed when the bodies change', () => {
    const doc = withCase(unit.doc, [unit.id]);
    const other = addBody(doc, 'add_box', { size: [1, 1, 1], position: [9, 9, 9], anchor: 'min' });
    const result = execute(other.doc, 'update_cfd_case', { caseId: 'c1', entityIds: [other.id] });
    expect((result.data as { notes: string[] }).notes[0]).toContain('momentPointM');
    expect(result.summary).toContain('not recomputed');
    const given = execute(other.doc, 'update_cfd_case', { caseId: 'c1', entityIds: [other.id], reference: { momentPointM: [9, 9, 9] } });
    expect((given.data as { notes: string[] }).notes).toEqual([]);
  });
});

describe('load validation reuses the case checks', () => {
  const doc = withCase(unit.doc, [unit.id]);
  const mutated = (edit: (c: Record<string, unknown>) => void): string[] => {
    const raw = JSON.parse(JSON.stringify(doc)) as { cfd: { cases: Record<string, Record<string, unknown>> } };
    edit(raw.cfd.cases['c1'] as Record<string, unknown>);
    return cfdPlugin.document?.validate(raw as unknown as Record<string, unknown>) ?? [];
  };

  it('rejects bad numbers, a custom rule without box and malformed vectors', () => {
    expect(mutated(() => undefined)).toEqual([]);
    expect(mutated((c) => (c['cellsPerReferenceLength'] = 3))[0]).toContain('cellsPerReferenceLength');
    expect(mutated((c) => (c['freestream'] = { alphaDeg: 0, betaDeg: 0, speedMS: -1 }))[0]).toContain('mach / speedMS');
    expect(mutated((c) => (c['domain'] = { rule: 'custom' }))[0]).toContain('domain.box');
    expect(mutated((c) => (c['domain'] = { rule: 'custom', box: { min: [0, 0], max: [1, 1, 1] } }))[0]).toContain('domain.box');
    expect(mutated((c) => (c['entityIds'] = ['a', 'a']))[0]).toContain('twice');
    expect(mutated((c) => (c['outputs'] = { surfaceFields: [], slices: [{ origin: [0, 0, 0] }], probes: [] }))[0]).toContain('outputs');
    expect(mutated((c) => ((c['freestream'] as Record<string, unknown>)['air'] = { densityKgM3: 'x' }))[0]).toContain('freestream.air');
  });
});
