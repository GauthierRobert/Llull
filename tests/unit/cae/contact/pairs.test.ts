/** PHY-06 M2 contact-pair commands: add / update / delete, formulation rule (VC-CNT-60), named defaults (VC-CNT-61), load validation, lifecycle. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ContactSettings } from '@core/model/contact';
import { analysisErrors } from '@cae/model/validate';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshRequest } from '@cae/hash/meshRequest';
import { caseOf, withCase } from '@cae/shared/access';
import { blocks, must, pairParams, type Blocks } from './support';

const contactOf = (b: Blocks, doc = b.doc): ContactSettings | undefined => caseOf(doc, b.analysisId)?.contact;

describe('add_contact_pair', () => {
  it('creates the contact set-up with the first pair (formulation fixed), names the CalculiX stick-slope default (VC-CNT-61), is pure', () => {
    const b = blocks();
    const before = structuredClone(b.doc);
    const result = execute(
      b.doc,
      'add_contact_pair',
      pairParams(b, { friction: { mu: 0.2 }, adjust: { kind: 'clearance', value: 0.001 } }),
    );
    expect(result.error).toBeUndefined();
    expect(b.doc).toEqual(before);
    const [analysisId, pairId = ''] = result.affected;
    expect(analysisId).toBe(b.analysisId);
    expect(pairId).toMatch(/^cp-\d+\.1$/);
    const contact = contactOf(b, result.document);
    expect(contact?.formulation).toBe('surface_to_surface');
    expect(contact?.pairOrder).toEqual([pairId]);
    expect(contact?.pairs[pairId]).toMatchObject({
      name: 'stack',
      behaviour: { kind: 'linear', slope: 1e6 },
      friction: { mu: 0.2 },
      adjust: { kind: 'clearance', value: 0.001 },
    });
    expect(result.summary).toContain('stick slope 105000 MPa/mm (defaulted: CalculiX *FRICTION default');
    expect(analysisErrors(result.document as unknown as Record<string, unknown>)).toEqual([]);
    const keys = meshRequest(result.document, b.analysisId);
    expect('targets' in keys && keys.targets.map((target) => target.key)).toEqual(
      expect.arrayContaining([`CP_${pairId}_S`, `CP_${pairId}_M`]),
    );
    expect(analysisInputHash(result.document, b.analysisId, 'full')).not.toBe(analysisInputHash(b.doc, b.analysisId, 'full'));
  });

  it('refuses a second formulation with CNT_MIXED_CONTACT_TYPES (VC-CNT-60) and keeps the same one', () => {
    const b = blocks();
    const first = must(b.doc, 'add_contact_pair', pairParams(b, { formulation: 'node_to_surface' }));
    const mixed = execute(first.doc, 'add_contact_pair', pairParams(b, { name: 'second', formulation: 'mortar' }));
    expect(mixed.error?.code).toBe('CNT_MIXED_CONTACT_TYPES');
    expect(mixed.document).toBe(first.doc);
    const same = execute(first.doc, 'add_contact_pair', { ...pairParams(b, { name: 'second' }), formulation: undefined });
    expect(same.error).toBeUndefined();
    expect(contactOf(b, same.document)?.pairOrder).toHaveLength(2);
  });

  it.each([
    [{ formulation: undefined }, 'CNT_FORMULATION_UNSET'],
    [{ formulation: 'node_to_surface', behaviour: { kind: 'tied', slope: 1e6, stickSlope: 1e4 } }, 'CNT_BEHAVIOUR_FORMULATION_MISMATCH'],
    [{ smallSliding: true }, 'CNT_BEHAVIOUR_FORMULATION_MISMATCH'],
    [{ behaviour: { kind: 'tied', slope: 1e6, stickSlope: 1e4 }, friction: { mu: 0.1 } }, 'CNT_FRICTION_INVALID'],
    [{ behaviour: { kind: 'tied', slope: 1e6, stickSlope: 0 } }, 'CNT_BEHAVIOUR_INVALID'],
    [{ friction: { mu: 0 } }, 'CNT_FRICTION_INVALID'],
    [{ friction: { mu: 0.2, stickSlope: -1 } }, 'CNT_FRICTION_INVALID'],
    [{ behaviour: { kind: 'linear', slope: 0 } }, 'CNT_BEHAVIOUR_INVALID'],
    [{ behaviour: { kind: 'linear', slope: 1, c0: -1 } }, 'CNT_BEHAVIOUR_INVALID'],
    [{ behaviour: { kind: 'exponential', c0: 0.01, p0: 0 } }, 'CNT_BEHAVIOUR_INVALID'],
    [{ adjust: { kind: 'clearance', value: 0 } }, 'CNT_ADJUST_INVALID'],
    [{ noSlipRequired: true }, 'CNT_FRICTION_INVALID'],
    [{ activeSteps: ['stp-99.1'] }, 'CNT_STEP_UNKNOWN'],
    [{ master: { entityId: 'nope', facesNear: [[0, 0, 0]] } }, 'FEA_TARGET_UNRESOLVED'],
    [{ master: { entityId: 'box-1.1', pointsNear: [[0, 0, 0]] } }, 'FEA_TARGET_UNRESOLVED'],
  ])('refuses %j with %s (unchanged document)', (patch, code) => {
    const b = blocks();
    const params = Object.fromEntries(Object.entries(pairParams(b, patch)).filter(([, entry]) => entry !== undefined));
    const result = execute(b.doc, 'add_contact_pair', params);
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(b.doc);
    expect(result.affected).toEqual([]);
  });

  it('refuses the same faces twice (CNT_SELF_PAIR), a taken name, a part outside the case and a non-nonlinear case', () => {
    const b = blocks();
    const self = execute(b.doc, 'add_contact_pair', pairParams(b, { master: { entityId: b.upper, facesNear: [[0.5, 0.5, 1]] } }));
    expect(self.error?.code).toBe('CNT_SELF_PAIR');
    const first = must(b.doc, 'add_contact_pair', pairParams(b));
    expect(execute(first.doc, 'add_contact_pair', pairParams(b)).error?.code).toBe('CNT_PAIR_NAME_TAKEN');
    const other = must(b.doc, 'add_box', { size: [1, 1, 1], position: [5, 0, 0] });
    const outside = execute(
      other.doc,
      'add_contact_pair',
      pairParams(b, { master: { entityId: other.affected[0], facesNear: [[5, 0, 0.5]] } }),
    );
    expect(outside.error?.code).toBe('FEA_PART_NOT_IN_ANALYSIS');
    const linear = must(b.doc, 'create_analysis', { name: 'lin', analysisType: 'static' });
    const wrong = execute(linear.doc, 'add_contact_pair', { ...pairParams(b), analysisId: linear.affected[0] });
    expect(wrong.error?.code).toBe('NLS_CASE_NOT_NONLINEAR');
    expect(execute(b.doc, 'add_contact_pair', { ...pairParams(b), analysisId: 'an-404' }).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });
});

describe('update_contact_pair / delete_contact_pair', () => {
  it('merges given fields, clears with null, changes the formulation of a single pair, and is pure', () => {
    const b = blocks();
    const added = must(b.doc, 'add_contact_pair', pairParams(b, { friction: { mu: 0.2 }, activeSteps: [b.stepId] }));
    const pairId = added.affected[1] ?? '';
    const before = structuredClone(added.doc);
    const updated = execute(added.doc, 'update_contact_pair', {
      analysisId: b.analysisId,
      pair: 'stack',
      friction: null,
      activeSteps: null,
      behaviour: { kind: 'hard' },
      formulation: 'mortar',
    });
    expect(updated.error).toBeUndefined();
    expect(added.doc).toEqual(before);
    expect(updated.affected).toEqual([b.analysisId, pairId]);
    const contact = contactOf(b, updated.document);
    expect(contact?.formulation).toBe('mortar');
    expect(contact?.pairs[pairId]).toEqual({
      id: pairId,
      name: 'stack',
      slave: { entityId: b.upper, facesNear: [[0.5, 0.5, 1]] },
      master: { entityId: b.lower, facesNear: [[0.5, 0.5, 1]] },
      behaviour: { kind: 'hard' },
    });
    const renamed = must(updated.document, 'update_contact_pair', {
      analysisId: b.analysisId,
      pair: pairId,
      name: 'renamed',
      slave: { entityId: b.upper, facesNear: [[0.4, 0.4, 1]] },
      master: { entityId: b.lower, facesNear: [[0.4, 0.4, 1]] },
    });
    expect(contactOf(b, renamed.doc)?.pairs[pairId]?.name).toBe('renamed');
  });

  it('refuses unknown pairs, empty updates, a formulation change with two pairs, a taken name and an invalid merge', () => {
    const b = blocks();
    const one = must(b.doc, 'add_contact_pair', pairParams(b));
    const two = must(one.doc, 'add_contact_pair', pairParams(b, { name: 'second', formulation: undefined }));
    const update = (params: Record<string, unknown>): string | undefined =>
      execute(two.doc, 'update_contact_pair', { analysisId: b.analysisId, ...params }).error?.code;
    expect(update({ pair: 'nope', name: 'x' })).toBe('CNT_PAIR_NOT_FOUND');
    expect(update({ pair: 'stack' })).toBe('CNT_NOTHING_TO_UPDATE');
    expect(update({ pair: 'stack', formulation: 'mortar' })).toBe('CNT_MIXED_CONTACT_TYPES');
    expect(update({ pair: 'stack', name: 'second' })).toBe('CNT_PAIR_NAME_TAKEN');
    expect(update({ pair: 'stack', smallSliding: true })).toBe('CNT_BEHAVIOUR_FORMULATION_MISMATCH');
    expect(execute(b.doc, 'update_contact_pair', { analysisId: b.analysisId, pair: 'stack', name: 'x' }).error?.code).toBe(
      'CNT_PAIR_NOT_FOUND',
    );
  });

  it('deletes pairs; the last one removes the set-up so another formulation may follow; unknown pair refused', () => {
    const b = blocks();
    const one = must(b.doc, 'add_contact_pair', pairParams(b));
    const two = must(one.doc, 'add_contact_pair', pairParams(b, { name: 'second', formulation: undefined }));
    const before = structuredClone(two.doc);
    const first = execute(two.doc, 'delete_contact_pair', { analysisId: b.analysisId, pair: 'stack' });
    expect(two.doc).toEqual(before);
    expect(first.affected).toEqual([b.analysisId, one.affected[1]]);
    expect(contactOf(b, first.document)?.pairOrder).toEqual([two.affected[1]]);
    const last = must(first.document, 'delete_contact_pair', { analysisId: b.analysisId, pair: 'second' });
    expect(contactOf(b, last.doc)).toBeUndefined();
    expect(execute(last.doc, 'add_contact_pair', pairParams(b, { formulation: 'mortar' })).error).toBeUndefined();
    expect(execute(last.doc, 'delete_contact_pair', { analysisId: b.analysisId, pair: 'stack' }).error?.code).toBe('CNT_PAIR_NOT_FOUND');
  });
});

describe('contact slice lifecycle', () => {
  it('the analysis guard keeps an entity that only a contact pair references (not a part of the case)', () => {
    const b = blocks();
    const added = must(b.doc, 'add_contact_pair', pairParams(b));
    const extra = must(added.doc, 'add_box', { size: [1, 1, 1], position: [5, 0, 0] });
    const extraId = extra.affected[0] ?? '';
    const analysis = caseOf(extra.doc, b.analysisId);
    const contact = analysis?.contact;
    const pairId = contact?.pairOrder[0] ?? '';
    const pair = contact?.pairs[pairId];
    if (analysis === undefined || contact === undefined || pair === undefined) throw new Error('no pair');
    const pointing = withCase(extra.doc, {
      ...analysis,
      contact: { ...contact, pairs: { [pairId]: { ...pair, master: { entityId: extraId, facesNear: [[5, 0, 0.5]] } } } },
    });
    const removed = execute(pointing, 'delete_entities', { ids: [extraId] });
    expect(removed.document.entities[extraId]).toBeDefined();
    expect(removed.summary).toContain('is used by analysis');
  });

  it('blocks deleting an entity a pair references (analysis guard) and survives history replay with the same ids', () => {
    const b = blocks();
    const added = must(b.doc, 'add_contact_pair', pairParams(b));
    const removed = execute(added.doc, 'delete_entities', { ids: [b.upper] });
    expect(removed.document.entities[b.upper]).toBeDefined();
    const replayed = execute(added.doc, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(contactOf(b, replayed.document)).toEqual(contactOf(b, added.doc));
  });

  it('rejects malformed or inconsistent contact slices on load', () => {
    const b = blocks();
    const added = must(b.doc, 'add_contact_pair', pairParams(b, { activeSteps: [b.stepId] }));
    const contact = contactOf(b, added.doc);
    const analysis = caseOf(added.doc, b.analysisId);
    if (contact === undefined || analysis === undefined) throw new Error('no contact');
    const pairId = contact.pairOrder[0] ?? '';
    const pair = contact.pairs[pairId];
    if (pair === undefined) throw new Error('no pair');
    const errorsWith = (patch: Record<string, unknown>, root: Record<string, unknown> = {}): string[] =>
      analysisErrors(
        withCase(added.doc, { ...analysis, ...root, contact: { ...contact, ...patch } } as typeof analysis) as unknown as Record<
          string,
          unknown
        >,
      );
    expect(errorsWith({})).toEqual([]);
    expect(errorsWith({ formulation: 'magic' }).join()).toContain('contact.formulation');
    expect(errorsWith({ pairOrder: [] }).join()).toContain('missing from pairOrder');
    expect(errorsWith({ pairOrder: [pairId, pairId] }).join()).toContain('duplicate ids');
    expect(errorsWith({ pairOrder: [pairId, 'ghost'] }).join()).toContain("'ghost' is listed but missing");
    expect(errorsWith({ pairs: { [pairId]: { ...pair, id: 'other' } } }).join()).toContain('differs from its key');
    expect(
      errorsWith({ pairs: { [pairId]: { ...pair, behaviour: { kind: 'tied', slope: 1, stickSlope: 1 } } }, formulation: 'mortar' }).join(),
    ).toContain('CNT_BEHAVIOUR_FORMULATION_MISMATCH');
    expect(errorsWith({ pairs: { [pairId]: { ...pair, activeSteps: ['gone'] } } }).join()).toContain("'gone' is not a step");
    expect(errorsWith({ pairs: { [pairId]: { ...pair, master: { entityId: 'ghost', facesNear: [[0, 0, 0]] } } } }).join()).toContain(
      "entity 'ghost' does not exist",
    );
    expect(errorsWith({ pairs: { [pairId]: { ...pair, friction: { mu: 'x' } } } }).join()).toContain('friction.mu');
    expect(errorsWith({ pairs: { [pairId]: { ...pair, master: { entityId: b.lower, facesNear: [] } } } }).join()).toContain(
      'master.facesNear',
    );
    expect(errorsWith({ pairs: { [pairId]: { ...pair, slave: { entityId: b.upper, pointsNear: [[0, 0, 1]] } } } }).join()).toContain(
      'slave.facesNear',
    );
    const second = { ...pair, id: 'cp-9.1' };
    expect(errorsWith({ pairs: { [pairId]: pair, 'cp-9.1': second }, pairOrder: [pairId, 'cp-9.1'] }).join()).toContain(
      'is used by another pair',
    );
    const reserved = JSON.parse(`{"__proto__": ${JSON.stringify({ ...pair, id: '__proto__', name: 'p' })}}`) as Record<string, unknown>;
    expect(errorsWith({ pairs: { ...reserved, [pairId]: pair }, pairOrder: [pairId, '__proto__'] }).join()).toContain('reserved key');
    expect(errorsWith({}, { type: 'static', nonlinear: undefined }).join()).toContain('only nonlinear_static cases carry contact pairs');
    expect(errorsWith({ pairs: {}, pairOrder: [] }).join()).toContain('contact without pairs');
  });
});
