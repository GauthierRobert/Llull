/** set_explicit_shell and the structured shell mesh (RS1 RS-8c). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { buildExplicitJob } from '@cae/index';
import { explicitErrors } from '@cae/explicit/model';
import { barModel, code, must } from './support';

/** The bar model plus a 50 x 50 x 2 mm plate under it (part of the case). */
function withPlate(): { doc: ReturnType<typeof barModel>['doc']; analysisId: string; barId: string; plateId: string } {
  const model = barModel({ size: 5 });
  const plate = must(model.doc, 'add_box', { size: [50, 50, 2], position: [-20, -20, -10], anchor: 'min' });
  const plateId = plate.affected[0] ?? '';
  let doc = must(plate.document, 'assign_material', { materialName: 'steel_like', entityIds: [plateId] }).document;
  doc = must(doc, 'set_part_idealization', { analysisId: model.analysisId, entityId: plateId }).document;
  return { doc, analysisId: model.analysisId, barId: model.barId, plateId };
}

describe('set_explicit_shell', () => {
  const model = withPlate();

  it('meshes a thin box on its mid-surface, keeps the setting across controls and clears it', () => {
    const before = structuredClone(model.doc);
    const set = must(model.doc, 'set_explicit_shell', { analysisId: model.analysisId, entityId: model.plateId, shell: true, points: 3 });
    expect(model.doc).toEqual(before);
    expect(set.summary).toContain('thickness 2 mm, 3 point(s)');
    const controls = must(set.document, 'set_explicit_controls', {
      analysisId: model.analysisId,
      endTime: { value: 1e-4, unit: 's' },
      historyInterval: { value: 1e-6, unit: 's' },
      mesh: { kind: 'structured_hex', size: 10 },
    });
    const built = buildExplicitJob(controls.document, model.analysisId, null);
    if (!built.ok) throw new Error(built.message);
    const { mesh } = built.job;
    expect(mesh.shell4.length / 4).toBe(25);
    expect(mesh.shellThickness.every((t) => t === 2)).toBe(true);
    expect(mesh.hex8.length / 8).toBe(20);
    expect(mesh.elementPart.slice(20)).toEqual(new Array<string>(25).fill(model.plateId));
    const plateNode = mesh.shell4[0] ?? 0;
    expect(mesh.nodes[3 * plateNode + 2]).toBe(-9);
    expect(explicitErrors(JSON.parse(JSON.stringify(controls.document)) as Record<string, unknown>)).toEqual([]);
    const cleared = must(set.document, 'set_explicit_shell', { analysisId: model.analysisId, entityId: model.plateId, shell: false });
    expect(cleared.document.analysis?.cases[model.analysisId]?.explicit?.shells).toBeUndefined();
    const feaMesh = must(controls.document, 'set_explicit_controls', {
      analysisId: model.analysisId,
      endTime: { value: 1e-4, unit: 's' },
      historyInterval: { value: 1e-6, unit: 's' },
    });
    const refused = buildExplicitJob(feaMesh.document, model.analysisId, null);
    expect(refused.ok ? 'ok' : refused.code).toBe('EXP_MESH_UNSUPPORTED');
  });

  it('refuses thick or foreign parts, bad point counts and cases without controls', () => {
    const base = { analysisId: model.analysisId, entityId: model.plateId, shell: true };
    expect(code(execute(model.doc, 'set_explicit_shell', { ...base, entityId: model.barId }))).toBe('EXP_SHELL_INVALID');
    expect(code(execute(model.doc, 'set_explicit_shell', { ...base, points: 9 }))).toBe('EXP_SHELL_INVALID');
    expect(code(execute(model.doc, 'set_explicit_shell', { ...base, entityId: 'box-404' }))).toBe('EXP_TARGET_NOT_IN_CASE');
    const rotated = must(model.doc, 'rotate_entity', { id: model.plateId, delta: [0, 0, 0.2] });
    expect(code(execute(rotated.document, 'set_explicit_shell', base))).toBe('EXP_SHELL_INVALID');
    const fresh = must(model.doc, 'create_analysis', { name: 'b', analysisType: 'explicit_dynamics' });
    expect(code(execute(fresh.document, 'set_explicit_shell', { ...base, analysisId: fresh.affected[0] }))).toBe('EXP_CONTROLS_MISSING');
    expect(code(execute(model.doc, 'set_explicit_shell', { ...base, analysisId: 'an-404' }))).toBe('FEA_ANALYSIS_NOT_FOUND');
    const raw = JSON.parse(JSON.stringify(model.doc)) as { analysis: { cases: Record<string, { explicit: Record<string, unknown> }> } };
    const spec = raw.analysis.cases[model.analysisId]?.explicit;
    if (spec === undefined) throw new Error('no spec');
    spec['shells'] = { [model.plateId]: { points: 'two' } };
    expect(explicitErrors(raw as unknown as Record<string, unknown>)).toEqual([
      `analysis.cases.${model.analysisId}.explicit.shells is malformed`,
    ]);
  });
});
