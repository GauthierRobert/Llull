/** PHY-06 M3 bolt pretension commands (FR-CNT-03): add / delete, every refusal, torque-derived preload, load validation, lifecycle. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { PretensionSettings } from '@core/model/contact';
import { analysisErrors } from '@cae/model/validate';
import { analysisInputHash } from '@cae/hash/inputHash';
import { caseOf, withCase } from '@cae/shared/access';
import { must } from './support';
import { bolted, sectionParams, type Bolted } from './boltSupport';

const pretensionOf = (b: Bolted, doc = b.doc): PretensionSettings | undefined => caseOf(doc, b.analysisId)?.pretension;

describe('add_bolt_pretension', () => {
  it('records the bolt (id bp-<step>.<k>, lockAfter true named as the default), is pure, valid on load, changes the full hash but not the mesh hash', () => {
    const b = bolted();
    const before = structuredClone(b.doc);
    const result = execute(b.doc, 'add_bolt_pretension', sectionParams(b));
    expect(result.error).toBeUndefined();
    expect(b.doc).toEqual(before);
    const [analysisId, boltId = ''] = result.affected;
    expect(analysisId).toBe(b.analysisId);
    expect(boltId).toMatch(/^bp-\d+\.1$/);
    const settings = pretensionOf(b, result.document);
    expect(settings?.order).toEqual([boltId]);
    expect(settings?.bolts[boltId]).toMatchObject({
      name: 'm1',
      entityId: b.bolt,
      section: { point: [0.5, 0.5, 2], normal: [0, 0, 1] },
      preload: { kind: 'force', value: 10 },
      preloadStepId: b.stepId,
      lockAfter: true,
    });
    expect(result.summary).toContain('preload 10 N');
    expect(result.summary).toContain('lockAfter true (default)');
    expect(analysisErrors(result.document as unknown as Record<string, unknown>)).toEqual([]);
    expect(analysisInputHash(result.document, b.analysisId, 'full')).not.toBe(analysisInputHash(b.doc, b.analysisId, 'full'));
    expect(analysisInputHash(result.document, b.analysisId, 'mesh')).toBe(analysisInputHash(b.doc, b.analysisId, 'mesh'));
  });

  it('derives the force of a torque preload, P = T / (K D), and names the nut factor source', () => {
    const b = bolted();
    const result = execute(
      b.doc,
      'add_bolt_pretension',
      sectionParams(b, {
        lockAfter: false,
        preload: { kind: 'torque', torque: 50, diameter: 0.5, nutFactor: 0.2, nutFactorSource: 'test record TT-1' },
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.summary).toContain('preload 500 N');
    expect(result.summary).toContain('nut factor source: test record TT-1');
    expect(result.summary).toContain('lockAfter false');
    expect(result.summary).not.toContain('(default)');
  });

  it.each([
    ['analysisId', { analysisId: 'nope' }, 'FEA_ANALYSIS_NOT_FOUND'],
    ['entityId', { entityId: 'missing' }, 'FEA_TARGET_UNRESOLVED'],
    ['section (plane outside the part)', { section: { point: [0.5, 0.5, 9], normal: [0, 0, 1] } }, 'CNT_PRETENSION_SECTION_INVALID'],
    ['section (zero normal)', { section: { point: [0.5, 0.5, 2], normal: [0, 0, 0] } }, 'CNT_PRETENSION_SECTION_INVALID'],
    ['preload (force <= 0)', { preload: { kind: 'force', value: 0 } }, 'CNT_PRELOAD_INVALID'],
    ['preload (torque without nut factor)', { preload: { kind: 'torque', torque: 50, diameter: 0.5 } }, 'CNT_NUT_FACTOR_MISSING'],
    [
      'preload (torque without nut factor source)',
      { preload: { kind: 'torque', torque: 50, diameter: 0.5, nutFactor: 0.2, nutFactorSource: ' ' } },
      'CNT_NUT_FACTOR_MISSING',
    ],
    [
      'preload (torque <= 0)',
      { preload: { kind: 'torque', torque: 0, diameter: 0.5, nutFactor: 0.2, nutFactorSource: 's' } },
      'CNT_PRELOAD_INVALID',
    ],
    ['preloadStepId', { preloadStepId: 'gone' }, 'CNT_STEP_UNKNOWN'],
  ])('refuses a bad %s with %s and leaves the document unchanged', (_label, patch, code) => {
    const b = bolted();
    const result = execute(b.doc, 'add_bolt_pretension', sectionParams(b, patch));
    expect(result.error?.code).toBe(code);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(b.doc);
  });

  it('refuses a plate that is not a part of the case, a non-first preload step, a taken name and a case that is not nonlinear_static', () => {
    const b = bolted();
    const outside = must(b.doc, 'add_box', { size: [1, 1, 1], position: [5, 5, 5], anchor: 'min' });
    const notPart = execute(
      outside.doc,
      'add_bolt_pretension',
      sectionParams(b, { entityId: outside.affected[0], section: { point: [5.5, 5.5, 5.5], normal: [0, 0, 1] } }),
    );
    expect(notPart.error?.code).toBe('FEA_PART_NOT_IN_ANALYSIS');
    const second = must(b.doc, 'add_analysis_step', {
      analysisId: b.analysisId,
      name: 'service',
      multipliers: {},
      control: { kind: 'load', initialIncrement: 0.5, minIncrement: 0.001, maxIncrement: 0.5, maxIncrements: 20 },
    });
    const late = execute(second.doc, 'add_bolt_pretension', sectionParams(b, { preloadStepId: second.affected[0] }));
    expect(late.error?.code).toBe('CNT_PRETENSION_STEP_ORDER');
    const first = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const taken = execute(first.doc, 'add_bolt_pretension', sectionParams(b, { section: { point: [0.5, 0.5, 3], normal: [0, 0, 1] } }));
    expect(taken.error?.code).toBe('CNT_PAIR_NAME_TAKEN');
    const modal = must(b.doc, 'create_analysis', { name: 'linear', analysisType: 'static' });
    const linear = execute(modal.doc, 'add_bolt_pretension', sectionParams(b, { analysisId: modal.affected[0] }));
    expect(linear.error?.code).toBe('NLS_CASE_NOT_NONLINEAR');
  });

  it('accepts several bolts in the first step, in creation order', () => {
    const b = bolted();
    const one = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const two = must(
      one.doc,
      'add_bolt_pretension',
      sectionParams(b, { name: 'm2', section: { point: [0.5, 0.5, 3], normal: [0, 0, 1] } }),
    );
    expect(pretensionOf(b, two.doc)?.order).toEqual([one.affected[1], two.affected[1]]);
  });
});

describe('delete_bolt_pretension', () => {
  it('removes a bolt by id or name, the last one removes the settings, is pure', () => {
    const b = bolted();
    const one = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const two = must(
      one.doc,
      'add_bolt_pretension',
      sectionParams(b, { name: 'm2', section: { point: [0.5, 0.5, 3], normal: [0, 0, 1] } }),
    );
    const before = structuredClone(two.doc);
    const byName = execute(two.doc, 'delete_bolt_pretension', { analysisId: b.analysisId, bolt: 'm1' });
    expect(byName.error).toBeUndefined();
    expect(two.doc).toEqual(before);
    expect(byName.affected).toEqual([b.analysisId, one.affected[1]]);
    expect(pretensionOf(b, byName.document)?.order).toEqual([two.affected[1]]);
    const last = execute(byName.document, 'delete_bolt_pretension', { analysisId: b.analysisId, bolt: two.affected[1] });
    expect(pretensionOf(b, last.document)).toBeUndefined();
  });

  it('refuses an unknown bolt and a case that is not nonlinear_static, unchanged', () => {
    const b = bolted();
    const none = execute(b.doc, 'delete_bolt_pretension', { analysisId: b.analysisId, bolt: 'x' });
    expect(none.error?.code).toBe('CNT_PRETENSION_NOT_FOUND');
    expect(none.document).toBe(b.doc);
    const modal = must(b.doc, 'create_analysis', { name: 'linear', analysisType: 'static' });
    expect(execute(modal.doc, 'delete_bolt_pretension', { analysisId: modal.affected[0], bolt: 'x' }).error?.code).toBe(
      'NLS_CASE_NOT_NONLINEAR',
    );
  });
});

describe('bolt pretension lifecycle', () => {
  it('rejects a stored bolt that breaks a rule on load: not first step, unknown part, nut factor missing, duplicate order, reserved id', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const settings = pretensionOf(b, added.doc);
    const analysis = caseOf(added.doc, b.analysisId);
    const boltId = added.affected[1] ?? '';
    const bolt = settings?.bolts[boltId];
    if (settings === undefined || analysis === undefined || bolt === undefined) throw new Error('no bolt');
    const errors = (patch: Partial<typeof bolt>, order: readonly string[] = settings.order): string[] =>
      analysisErrors(
        withCase(added.doc, { ...analysis, pretension: { bolts: { [boltId]: { ...bolt, ...patch } }, order } }) as unknown as Record<
          string,
          unknown
        >,
      );
    expect(errors({})).toEqual([]);
    expect(errors({ preloadStepId: 'gone' }).join()).toContain('not the first step');
    expect(errors({ entityId: 'ghost' }).join()).toContain("entity 'ghost' does not exist");
    expect(errors({ preload: { kind: 'torque', torque: 1, diameter: 1, nutFactor: 0, nutFactorSource: '' } }).join()).toContain(
      'CNT_NUT_FACTOR_MISSING',
    );
    expect(errors({ preload: { kind: 'force', value: -1 } }).join()).toContain('CNT_PRELOAD_INVALID');
    expect(errors({}, [boltId, boltId]).join()).toContain('duplicate ids');
    expect(errors({}, []).join()).toContain('pretension without bolts');
    expect(errors({ id: 'other' }).join()).toContain('differs from its key');
    const linear = must(added.doc, 'create_analysis', { name: 'linear', analysisType: 'static' });
    const stray = caseOf(linear.doc, linear.affected[0] ?? '');
    if (stray === undefined) throw new Error('no case');
    expect(analysisErrors(withCase(linear.doc, { ...stray, pretension: settings }) as unknown as Record<string, unknown>).join()).toContain(
      'only nonlinear_static cases carry bolt pretensions',
    );
  });

  it('survives history replay with the same bolt ids, and rejects malformed shapes, reserved keys, shared names and a missing list entry on load', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const replayed = execute(added.doc, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(pretensionOf(b, replayed.document)).toEqual(pretensionOf(b, added.doc));
    const settings = pretensionOf(b, added.doc);
    const analysis = caseOf(added.doc, b.analysisId);
    const boltId = added.affected[1] ?? '';
    const bolt = settings?.bolts[boltId];
    if (settings === undefined || analysis === undefined || bolt === undefined) throw new Error('no bolt');
    const errorsOf = (pretension: unknown): string =>
      analysisErrors(withCase(added.doc, { ...analysis, pretension } as typeof analysis) as unknown as Record<string, unknown>).join();
    expect(errorsOf({ ...settings, bolts: { [boltId]: { ...bolt, preload: { kind: 'force', value: 'x' } } } })).toContain('preload');
    expect(errorsOf({ ...settings, bolts: { [boltId]: { ...bolt, section: { point: [0, 0], normal: [0, 0, 1] } } } })).toContain('section');
    expect(errorsOf({ ...settings, bolts: { [boltId]: { ...bolt, lockAfter: 'yes' } } })).toContain('lockAfter');
    expect(errorsOf({ ...settings, bolts: { [boltId]: { ...bolt, section: { point: [0, 0, 0], normal: [0, 0, 0] } } } })).toContain(
      'CNT_PRETENSION_SECTION_INVALID',
    );
    const twin = { ...bolt, id: 'bp-9.1' };
    expect(errorsOf({ bolts: { [boltId]: bolt, 'bp-9.1': twin }, order: [boltId, 'bp-9.1'] })).toContain('is used by another bolt');
    expect(errorsOf({ bolts: { [boltId]: bolt, 'bp-9.1': { ...twin, name: 'second' } }, order: [boltId] })).toContain('missing from order');
    expect(errorsOf({ bolts: { [boltId]: bolt }, order: [boltId, 'ghost'] })).toContain("'ghost' is listed but missing");
    const reserved = JSON.parse(`{"__proto__": ${JSON.stringify({ ...bolt, id: '__proto__', name: 'p' })}}`) as Record<string, unknown>;
    expect(errorsOf({ bolts: { ...reserved, [boltId]: bolt }, order: [boltId, '__proto__'] })).toContain('reserved key');
  });

  it('keeps the bolt part from being deleted while the analysis uses it, and renaming a bolt does not stale results', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const removed = execute(added.doc, 'delete_entities', { ids: [b.bolt] });
    expect(removed.document.entities[b.bolt]).toBeDefined();
    expect(removed.summary).toContain('is used by analysis');
    const analysis = caseOf(added.doc, b.analysisId);
    const settings = pretensionOf(b, added.doc);
    const bolt = settings?.bolts[added.affected[1] ?? ''];
    if (analysis === undefined || settings === undefined || bolt === undefined) throw new Error('no bolt');
    const renamed = withCase(added.doc, { ...analysis, pretension: { ...settings, bolts: { [bolt.id]: { ...bolt, name: 'other' } } } });
    expect(analysisInputHash(renamed, b.analysisId, 'full')).toBe(analysisInputHash(added.doc, b.analysisId, 'full'));
  });
});
