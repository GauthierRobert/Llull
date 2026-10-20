/** add_contact / delete_contact and their job wiring (RS1 RS-8c). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { buildExplicitJob } from '@cae/index';
import { explicitErrors } from '@cae/explicit/model';
import { barModel, code, must } from './support';

/** The bar model plus a second box (a plate under it) assigned the same material and added to the case. */
function withPlate(): { doc: CadDocument; analysisId: string; barId: string; plateId: string } {
  const model = barModel({ size: 5 });
  const plate = must(model.doc, 'add_box', { size: [40, 40, 5], position: [-15, -15, -10], anchor: 'min' });
  const plateId = plate.affected[0] ?? '';
  let doc = must(plate.document, 'assign_material', { materialName: 'steel_like', entityIds: [plateId] }).document;
  doc = must(doc, 'set_part_idealization', { analysisId: model.analysisId, entityId: plateId }).document;
  return { doc, analysisId: model.analysisId, barId: model.barId, plateId };
}

describe('add_contact / delete_contact', () => {
  const model = withPlate();

  it('adds contacts purely with a named default scale, keeps them across set_explicit_controls and passes them to the job', () => {
    const before = structuredClone(model.doc);
    const added = must(model.doc, 'add_contact', {
      analysisId: model.analysisId,
      name: 'impact',
      kind: 'nodes_to_surface',
      a: [model.barId],
      b: [model.plateId],
      friction: { static: 0.3 },
    });
    expect(model.doc).toEqual(before);
    const contactId = added.affected[1] ?? '';
    const spec = added.document.analysis?.cases[model.analysisId]?.explicit;
    expect(spec?.contacts?.[contactId]).toMatchObject({
      kind: 'nodes_to_surface',
      friction: { static: 0.3, dynamic: 0.3, decay: 0 },
      penaltyScale: { value: 0.1, defaulted: true },
    });
    expect(added.summary).toContain('penalty scale 0.1 (default)');
    const self = must(added.document, 'add_contact', {
      analysisId: model.analysisId,
      name: 'fold',
      kind: 'self',
      a: [model.barId],
      penaltyScale: { value: 0.05, source: 'study' },
    });
    const controls = must(self.document, 'set_explicit_controls', {
      analysisId: model.analysisId,
      endTime: { value: 1e-4, unit: 's' },
      historyInterval: { value: 1e-6, unit: 's' },
      mesh: { kind: 'structured_hex', size: 5 },
    });
    expect(controls.document.analysis?.cases[model.analysisId]?.explicit?.contactOrder).toHaveLength(2);
    const built = buildExplicitJob(controls.document, model.analysisId, null);
    if (!built.ok) throw new Error(built.message);
    const parts = [model.barId, model.plateId].sort();
    expect(built.job.contacts).toEqual([
      {
        name: 'impact',
        kind: 'nodes_to_surface',
        a: [parts.indexOf(model.barId)],
        b: [parts.indexOf(model.plateId)],
        friction: { static: 0.3, dynamic: 0.3, decay: 0 },
        penaltyScale: 0.1,
      },
      {
        name: 'fold',
        kind: 'self',
        a: [parts.indexOf(model.barId)],
        b: [],
        friction: { static: 0, dynamic: 0, decay: 0 },
        penaltyScale: 0.05,
      },
    ]);
    expect(new Set(built.job.elementPart)).toEqual(new Set([0, 1]));
    expect(explicitErrors(JSON.parse(JSON.stringify(controls.document)) as Record<string, unknown>)).toEqual([]);
    const removed = must(controls.document, 'delete_contact', { analysisId: model.analysisId, contactId });
    expect(removed.document.analysis?.cases[model.analysisId]?.explicit?.contactOrder).toHaveLength(1);
  });

  it('refuses bad contacts with their codes', () => {
    const base = { analysisId: model.analysisId, name: 'c', kind: 'surface_to_surface', a: [model.barId], b: [model.plateId] };
    const refused = (extra: Record<string, unknown>): string | undefined => code(execute(model.doc, 'add_contact', { ...base, ...extra }));
    expect(refused({ b: undefined })).toBe('EXP_CONTACT_INVALID');
    expect(refused({ kind: 'self' })).toBe('EXP_CONTACT_INVALID');
    expect(refused({ a: [] })).toBe('EXP_CONTACT_INVALID');
    expect(refused({ a: ['box-404'] })).toBe('EXP_TARGET_NOT_IN_CASE');
    expect(refused({ friction: { static: -1 } })).toBe('EXP_CONTACT_INVALID');
    expect(refused({ penaltyScale: { value: 0, source: 'x' } })).toBe('EXP_CONTACT_INVALID');
    expect(refused({ analysisId: 'an-404' })).toBe('FEA_ANALYSIS_NOT_FOUND');
    const once = must(model.doc, 'add_contact', base).document;
    expect(code(execute(once, 'add_contact', base))).toBe('EXP_CONTACT_INVALID');
    expect(code(execute(model.doc, 'delete_contact', { analysisId: model.analysisId, contactId: 'ct-404' }))).toBe('EXP_CONTACT_NOT_FOUND');
    const fresh = must(model.doc, 'create_analysis', { name: 'b', analysisType: 'explicit_dynamics' });
    expect(code(execute(fresh.document, 'add_contact', { ...base, analysisId: fresh.affected[0] }))).toBe('EXP_CONTROLS_MISSING');
    expect(code(execute(fresh.document, 'delete_contact', { analysisId: fresh.affected[0], contactId: 'ct-1' }))).toBe(
      'EXP_CONTROLS_MISSING',
    );
  });

  it('flags malformed contact slices on load', () => {
    const added = must(model.doc, 'add_contact', { analysisId: model.analysisId, name: 'c', kind: 'self', a: [model.barId] }).document;
    const raw = JSON.parse(JSON.stringify(added)) as { analysis: { cases: Record<string, { explicit: Record<string, unknown> }> } };
    const spec = raw.analysis.cases[model.analysisId]?.explicit;
    if (spec === undefined) throw new Error('no spec');
    spec['contactOrder'] = ['ct-missing'];
    expect(explicitErrors(raw as unknown as Record<string, unknown>)).toEqual([
      `analysis.cases.${model.analysisId}.explicit.contacts / contactOrder are malformed`,
    ]);
  });
});
