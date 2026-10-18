import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { caseOf, thermalFixture } from './fixtures';

const run = (doc: CadDocument, command: string, params: Record<string, unknown>): CommandResult => execute(doc, command, params);

function expectRefused(result: CommandResult, doc: CadDocument, code: string): void {
  expectNoOp(result, doc);
  expect(result.rejected).toBe(true);
  expect(result.error?.code).toBe(code);
  expect(result.error?.remediation.length).toBeGreaterThan(5);
}

function withContact(): { doc: CadDocument; analysisId: string; boxId: string; otherId: string; contactId: string } {
  const fixture = thermalFixture();
  const { analysisId, boxId } = fixture;
  const second = run(fixture.doc, 'add_box', { size: [1, 1, 0.05], position: [0, 0, 0.05] });
  const otherId = second.affected[0] ?? '';
  const parted = run(second.document, 'set_part_idealization', { analysisId, entityId: otherId });
  const made = run(parted.document, 'add_thermal_contact', {
    analysisId,
    name: 'iface',
    master: { entityId: boxId, facesNear: [[0.5, 0.5, 0.05]] },
    slave: { entityId: otherId, facesNear: [[0.5, 0.5, 0.05]] },
    conductance: { value: 2000, unit: 'W/(m^2*K)' },
  });
  return { doc: made.document, analysisId, boxId, otherId, contactId: made.affected[0] ?? '' };
}

describe('update_thermal_contact', () => {
  it('replaces only the given fields, keeps the id and the order of the contacts', () => {
    const { doc, analysisId, contactId, boxId } = withContact();
    const result = run(doc, 'update_thermal_contact', { analysisId, contactId, name: 'bolted', conductance: { points: [[1500, 0, 20]] } });
    expect(result.affected).toEqual([contactId]);
    const contact = caseOf(result.document, analysisId).thermal?.contacts[contactId];
    expect(contact).toMatchObject({ id: contactId, name: 'bolted', conductance: { points: [[1500, 0, 20]] }, master: { entityId: boxId } });
    expect(Object.keys(caseOf(result.document, analysisId).thermal?.contacts ?? {})).toEqual([contactId]);
    expectPure(doc, () => run(doc, 'update_thermal_contact', { analysisId, contactId, name: 'x' }));
  });

  it('refuses unknown ids, an empty update and a merged contact that is invalid', () => {
    const { doc, analysisId, contactId, boxId } = withContact();
    expectRefused(run(doc, 'update_thermal_contact', { analysisId, contactId: 'tc-9.9', name: 'x' }), doc, 'THM_CONTACT_NOT_FOUND');
    expectRefused(run(doc, 'update_thermal_contact', { analysisId: 'ghost', contactId, name: 'x' }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    expectRefused(run(doc, 'update_thermal_contact', { analysisId, contactId }), doc, 'THM_CONTACT_INVALID');
    expectRefused(
      run(doc, 'update_thermal_contact', { analysisId, contactId, slave: { entityId: boxId, facesNear: [[0.5, 0.5, 0]] } }),
      doc,
      'THM_CONTACT_INVALID',
    );
    expectRefused(
      run(doc, 'update_thermal_contact', { analysisId, contactId, conductance: { value: 0, unit: 'W/(m^2*K)' } }),
      doc,
      'THM_CONTACT_INVALID',
    );
    expectRefused(
      run(doc, 'update_thermal_contact', { analysisId, contactId, conductance: { value: 5, unit: 'W' } }),
      doc,
      'THM_UNITS_MISMATCH',
    );
  });
});

describe('delete_thermal_contact', () => {
  it('removes the contact and nothing else', () => {
    const { doc, analysisId, contactId } = withContact();
    const result = run(doc, 'delete_thermal_contact', { analysisId, contactId });
    expect(result.affected).toEqual([contactId]);
    expect(caseOf(result.document, analysisId).thermal?.contacts).toEqual({});
    expect(Object.keys(caseOf(result.document, analysisId).parts)).toHaveLength(2);
    expectPure(doc, () => run(doc, 'delete_thermal_contact', { analysisId, contactId }));
  });

  it('refuses an unknown contact, a second delete and an unknown analysis', () => {
    const { doc, analysisId, contactId } = withContact();
    expectRefused(run(doc, 'delete_thermal_contact', { analysisId, contactId: 'nope' }), doc, 'THM_CONTACT_NOT_FOUND');
    const deleted = run(doc, 'delete_thermal_contact', { analysisId, contactId }).document;
    expectRefused(run(deleted, 'delete_thermal_contact', { analysisId, contactId }), deleted, 'THM_CONTACT_NOT_FOUND');
    expectRefused(run(doc, 'delete_thermal_contact', { analysisId: 'ghost', contactId }), doc, 'FEA_ANALYSIS_NOT_FOUND');
  });
});
