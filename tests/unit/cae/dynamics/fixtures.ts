/** PHY-09 fixtures: a steel strip with a fixed root in a frequency_response / random_response case. */
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

export const SOURCE = { citation: 'synthetic test fixture (tests/unit/cae/dynamics)' };

export function mustRun(doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): CadDocument {
  const result = execute(doc, name, params, ctx);
  if (result.rejected === true) throw new Error(`${name}: ${result.summary}`);
  return result.document;
}

export interface Strip {
  readonly doc: CadDocument;
  readonly boxId: string;
  readonly analysisId: string;
}

export interface StripOptions {
  readonly type?: 'frequency_response' | 'random_response';
  readonly modes?: number;
  readonly constraint?: boolean;
  readonly material?: boolean;
}

/** 100 x 20 x 3 mm strip (steel, elastic set), fixed at x = 0, in a dynamic case with `modes` modes. */
export function strip(options: StripOptions = {}): Strip {
  const { type = 'random_response', modes = 6, constraint = true, material = true } = options;
  const box = execute(createEmptyDocument(), 'add_box', { size: [100, 20, 3], position: [0, 0, 0], anchor: 'min' });
  const boxId = box.affected[0] ?? '';
  let doc = box.document;
  if (material) {
    doc = mustRun(doc, 'create_material', { name: 'steel', density: 0.0078, color: '#999999', metalness: 1, roughness: 0.4 });
    doc = mustRun(doc, 'add_material_model', {
      material: 'steel',
      id: 'elastic',
      model: { kind: 'elastic_isotropic', E: { value: 210000, unit: 'MPa' }, nu: { value: 0.3, unit: '1' } },
      basis: 'unspecified',
      source: SOURCE,
    });
    doc = mustRun(doc, 'define_constitutive_set', { material: 'steel', set: { id: 'linear', elastic: 'elastic' }, makeDefault: true });
    doc = mustRun(doc, 'assign_material', { materialName: 'steel', entityIds: [boxId] });
  }
  const created = execute(doc, 'create_analysis', { name: 'strip', analysisType: type, modes });
  const analysisId = created.affected[0] ?? '';
  doc = mustRun(created.document, 'set_part_idealization', { analysisId, entityId: boxId });
  if (constraint)
    doc = mustRun(doc, 'add_fea_constraint', {
      analysisId,
      name: 'root',
      kind: 'fixed',
      target: { entityId: boxId, facesNear: [[0, 10, 1.5]] },
    });
  return { doc, boxId, analysisId };
}

/** The strip with GEVS qualification, 2 % modal damping, a 20-2000 Hz sweep and z base excitation (the VC-DYN-21 plan). */
export function readyRandomStrip(): Strip {
  const base = strip();
  let doc = mustRun(base.doc, 'define_vibration_spectrum', { name: 'gevs_q', library: 'gevs_component_qual' });
  const { analysisId } = base;
  doc = mustRun(doc, 'set_dynamic_damping', {
    analysisId,
    model: 'modal',
    ratios: [{ fromMode: 1, toMode: 6, zeta: 0.02 }],
    source: SOURCE,
  });
  doc = mustRun(doc, 'set_base_excitation', { analysisId, direction: 'z', kind: 'acceleration', spectrum: 'gevs_q' });
  doc = mustRun(doc, 'set_frequency_sweep', { analysisId, fMinHz: 20, fMaxHz: 2000 });
  return { ...base, doc };
}
