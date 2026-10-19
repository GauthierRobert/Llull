/** PHY-04 M4b fixtures: a coupled_temperature_displacement case on the two-tetrahedron box (fixed face, 120 degC face), with cp / orthotropic helpers. */
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { mustRun } from '../deckFixtures';
import { thermoFixture } from './fixtures';

export const REF = { value: 20, unit: 'degC' };

export const constant = (id: string, property: string, unit: string, value: number, direction?: string): Record<string, unknown> => ({
  id,
  property,
  unit,
  variables: [],
  validity: [],
  form: { kind: 'constant', value },
  basis: 'company',
  ...(direction === undefined ? {} : { direction }),
  source: { citation: 'synthetic test fixture' },
});

export interface CoupledFixture {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly mesh: FeMeshArtifact;
  readonly boxId: string;
  readonly bcId: string;
  readonly fixId: string;
}

/** `orthotropic`: the material gets cte models for the directions 1 / 2 / 3 (`a1`, `a2`, `a3`) instead of the thermalStrain model. */
export function coupledFixture(
  options: {
    transient?: Record<string, unknown>;
    withCp?: boolean;
    orthotropic?: readonly number[];
    initial?: number;
    amplitude?: boolean;
  } = {},
): CoupledFixture {
  const base = thermoFixture({ field: null, ...(options.orthotropic === undefined ? {} : { model: null }) });
  let doc: CadDocument = base.doc;
  doc = mustRun(doc, 'define_property_model', { material: 'mat', model: constant('E', 'E', 'GPa', 210) });
  doc = mustRun(doc, 'define_property_model', { material: 'mat', model: constant('nu', 'nu', '1', 0.3) });
  doc = mustRun(doc, 'define_property_model', { material: 'mat', model: constant('k', 'k', 'W/(m*K)', 50) });
  if (options.withCp !== false)
    doc = mustRun(doc, 'define_property_model', { material: 'mat', model: constant('cp', 'cp', 'J/(kg*K)', 480) });
  options.orthotropic?.forEach((alpha, index) => {
    doc = mustRun(doc, 'define_property_model', {
      material: 'mat',
      model: { ...constant(`cte${index + 1}`, 'cte', '1/K', alpha, String(index + 1)) },
    });
  });
  const created = execute(doc, 'create_analysis', {
    name: 'C',
    analysisType: 'coupled_temperature_displacement',
    referenceTemperature: REF,
  });
  const analysisId = created.affected[0] ?? '';
  doc = mustRun(created.document, 'set_part_idealization', { analysisId, entityId: base.boxId });
  doc = mustRun(doc, 'add_fea_load', {
    analysisId,
    name: 'thermal load case',
    kind: 'gravity',
    loadCase: 'thermal',
    category: 'limit',
    vector: [0, 0, -1],
  });
  const fix = execute(doc, 'add_fea_constraint', {
    analysisId,
    name: 'fix',
    kind: 'fixed',
    target: { entityId: base.boxId, facesNear: [[0, 5, 5]] },
  });
  doc = fix.document;
  if (options.amplitude === true)
    doc = mustRun(doc, 'define_amplitude', {
      analysisId,
      name: 'ramp',
      kind: 'table',
      points: [
        [0, 0],
        [10, 1],
      ],
    });
  const bc = execute(doc, 'add_thermal_bc', {
    analysisId,
    name: 'hot',
    kind: 'temperature',
    value: 120,
    unit: 'degC',
    target: { entityId: base.boxId, facesNear: [[10, 5, 5]] },
    ...(options.amplitude === true ? { amplitude: 'ramp' } : {}),
  });
  doc = bc.document;
  const bcId = bc.affected[0] ?? '';
  if (options.initial !== undefined) doc = mustRun(doc, 'set_initial_temperature', { analysisId, value: options.initial, unit: 'degC' });
  if (options.transient !== undefined) doc = mustRun(doc, 'set_thermal_step', { analysisId, ...options.transient });
  const mesh: FeMeshArtifact = {
    ...base.mesh,
    inputHash: analysisInputHash(doc, analysisId, 'mesh'),
    nodeSets: { [`C_${fix.affected[0]}`]: [1, 3, 4], [`B_${bcId}`]: [2, 5] },
  };
  return { doc, analysisId, mesh, boxId: base.boxId, bcId, fixId: fix.affected[0] ?? '' };
}

export const textOf = (result: { text: string } | { code: string; message: string }): string =>
  'text' in result ? result.text : JSON.stringify(result);
