/** PHY-04 M4b: the bimetal FE plan (VC-TMC-04, two bonded materials): the plan replays, its inputs are the pack's, and its deck is what the solver reads. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { FeMeshArtifact } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { packCase } from '../../physics/benchmarkCases';
import { PACK } from '../../physics/thermomech/thermomechFixtures';
import { textOf } from './coupledSupport';

const PLAN_FILE = `docs/physics/${PACK}/validation/plans/tmc_bimetal_cantilever.plan.json`;
const SERVER_COPY = 'server/tests/fixtures/thermomech/tmc_bimetal_cantilever.plan.json';

interface Action {
  readonly command: string;
  readonly params: Record<string, unknown>;
}
interface Step {
  readonly command: string;
  readonly ok: boolean;
  readonly summary: string;
}

const actions = JSON.parse(readFileSync(PLAN_FILE, 'utf8')) as Action[];

function replay(): { doc: CadDocument; steps: Step[] } {
  const result = execute(createEmptyDocument(), 'build_project', { actions }, defaultContext());
  return { doc: result.document, steps: (result.data as { steps: Step[] }).steps };
}

/** Two stacked 50 x 1 x 0.5 mm hexahedra split into six tetrahedra each, sharing the four interface nodes (id = 1 + i + 2j + 4k at (50 i, j, 0.5 k)). */
function stackedMesh(lowerId: string, upperId: string, inputHash: string, nodeSets: FeMeshArtifact['nodeSets']): FeMeshArtifact {
  const TETS = [
    [1, 2, 4, 8],
    [1, 6, 2, 8],
    [1, 4, 3, 8],
    [1, 3, 7, 8],
    [1, 5, 6, 8],
    [1, 7, 5, 8],
  ];
  const nodes: FeMeshArtifact['nodes'] = Array.from({ length: 12 }, (_, index) => [
    index + 1,
    (index & 1) * 50,
    (index >> 1) & 1,
    0.5 * (index >> 2),
  ]);
  let next = 1;
  const block = (entityId: string, base: number): FeMeshArtifact['blocks'][number] => ({
    type: 'C3D4',
    entityId,
    elements: TETS.map((tet) => [next++, ...tet.map((corner) => base + corner)]),
  });
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '0',
    inputHash,
    nodes,
    blocks: [block(lowerId, 0), block(upperId, 4)],
    nodeSets,
    faceSets: {},
    targets: {},
  };
}

describe('tmc_bimetal_cantilever plan', () => {
  it('replays through build_project with every step ok and the server fixture is the same plan', () => {
    const { steps } = replay();
    expect(steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
    expect(readFileSync(SERVER_COPY, 'utf8').replace(/\r\n/g, '\n')).toBe(readFileSync(PLAN_FILE, 'utf8').replace(/\r\n/g, '\n'));
  });

  it('uses the inputs of VC-TMC-04 (thicknesses, moduli, expansion coefficients, temperature rise, length)', () => {
    const inputs = (packCase(PACK, 'VC-TMC-04.a') as unknown as { inputs: Record<string, number> }).inputs;
    const boxes = actions.filter((action) => action.command === 'add_box').map((action) => action.params['size'] as number[]);
    expect(boxes.map((size) => size[2])).toEqual([inputs['t1_mm'], inputs['t2_mm']]);
    expect(boxes.map((size) => size[0])).toEqual([inputs['L_mm'], inputs['L_mm']]);
    const models = actions
      .filter((action) => action.command === 'add_material_model')
      .map((action) => action.params['model'] as { E: { value: number } });
    expect(models.map((model) => model.E.value * 1000)).toEqual([inputs['E1_MPa'], inputs['E2_MPa']]);
    const strains = actions
      .filter((action) => action.command === 'define_property_model')
      .map((action) => (action.params['model'] as { form: { coefficients: number[] } }).form.coefficients[1]);
    expect(strains).toEqual([inputs['alpha1_per_K'], inputs['alpha2_per_K']]);
    const field = actions.find((action) => action.command === 'set_temperature_field')?.params['source'] as { value: { value: number } };
    const analysis = actions.find((action) => action.command === 'create_analysis')?.params['referenceTemperature'] as { value: number };
    expect(field.value.value - analysis.value).toBe(inputs['dT_K']);
  });

  it('writes one material per layer (own E and secant CTE about 20 degC), the conformal interface nodes and the uniform 120 degC field', () => {
    const { doc } = replay();
    const analysisId = doc.analysis?.caseOrder[0] ?? '';
    const analysisCase = doc.analysis?.cases[analysisId];
    expect(analysisCase?.mesh.bonding).toBe('conformal');
    const [lowerId = '', upperId = ''] = Object.keys(analysisCase?.parts ?? {});
    const clamps = (analysisCase?.constraintOrder ?? []).map((id) => `C_${id}`);
    const base = stackedMesh(lowerId, upperId, '', { [clamps[0] ?? '']: [1, 2, 3, 4], [clamps[1] ?? '']: [5, 6, 7, 8] });
    const mesh = { ...base, inputHash: analysisInputHash(doc, analysisId, 'mesh') };
    const text = textOf(writeInp(doc, analysisId, mesh));
    expect(text).toContain('*MATERIAL, NAME=M_1\n*ELASTIC\n200000, 0.3\n');
    expect(text).toContain('*MATERIAL, NAME=M_2\n*ELASTIC\n100000, 0.3\n');
    expect(text.match(/\*EXPANSION, ZERO=20\n0\.000012\n/g)).toHaveLength(1);
    expect(text.match(/\*EXPANSION, ZERO=20\n0\.000019\n/g)).toHaveLength(1);
    expect(text).toContain('*SOLID SECTION, ELSET=P_' + lowerId.replace(/[^A-Za-z0-9_]/g, '_') + ', MATERIAL=M_1');
    expect(text).toContain('*SOLID SECTION, ELSET=P_' + upperId.replace(/[^A-Za-z0-9_]/g, '_') + ', MATERIAL=M_2');
    const shared = mesh.blocks[0]?.elements
      .flatMap((element) => element.slice(1))
      .filter((id) => mesh.blocks[1]?.elements.some((element) => element.includes(id)));
    expect([...new Set(shared)].sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
    expect(text).toMatch(/\*TEMPERATURE\n1, 120\n/);
    expect(text).toContain('*NODE FILE\nU, NT\n');
  });
});
