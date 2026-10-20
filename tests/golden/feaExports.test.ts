/** Golden text of the FEA transports that are not registry commands (fea_export): Nastran BDF and VTU, built from a plan document and hand-built artifacts. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact } from '@core/model/analysis';
import { writeBdf } from '@cae/decks/bdfWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseFrd } from '@cae/results/frdReader';
import { writeVtu } from '@cae/results/vtuWriter';
import { X0_NODES, X2_NODES, barMesh, facesOn } from '../unit/cae/deckFixtures';
import { feaPlans } from './feaPlans';
import { runPlan } from './runPlan';

const outcome = runPlan(feaPlans['fea_static_margin_band_view'] ?? []);
const doc = outcome.document;
const analysis = Object.values(doc.analysis?.cases ?? {})[0];
const analysisId = analysis?.id ?? '';
const boxId = Object.keys(analysis?.parts ?? {})[0] ?? '';
const constraintId = analysis?.constraintOrder[0] ?? '';
const loads = analysis?.loadOrder ?? [];
const sets: Record<string, number[]> = { [`C_${constraintId}`]: X0_NODES };
const faces: Record<string, [number, number][]> = { [`C_${constraintId}`]: facesOn(X0_NODES) };
for (const id of loads) {
  sets[`L_${id}`] = X2_NODES;
  faces[`L_${id}`] = facesOn(X2_NODES);
}
const mesh = barMesh(doc, analysisId, boxId, sets, faces);
const results: FeResultsArtifact = {
  kind: 'fe_results',
  meshHash: 'golden-mesh-hash',
  inputHash: analysisInputHash(doc, analysisId, 'full'),
  solver: 'CalculiX',
  solverVersion: '2.21',
  steps: parseFrd(readFileSync('tests/unit/cae/fixtures/static.frd', 'utf8')),
};

describe('FEA exports (golden text)', () => {
  it('the plan builds', () => {
    expect(outcome.failedSteps).toEqual([]);
    expect(analysisId).not.toBe('');
  });

  it('Nastran BDF of the static plan: SOL 101 with a FORCE and a MOMENT on an RBE3 at its reference point', async () => {
    const written = writeBdf(doc, analysisId, mesh);
    expect(written).toHaveProperty('text');
    const text = 'text' in written ? written.text : JSON.stringify(written);
    const normalised = text
      .replace(/inputHash \w+ meshHash \w+/, 'inputHash H meshHash M')
      .replace(/llull inputHash [0-9a-f]{16}/, 'llull inputHash X')
      .replace(/\r\n/g, '\n');
    await expect(normalised).toMatchFileSnapshot('./__snapshots__/fea_static_margin_band_view.bdf');
  });

  it('VTU of the bar mesh with its static results (ascii): points, cells, U, von_mises, S', async () => {
    const written = writeVtu(mesh, results, 'ascii');
    expect(written.dropped).toBe(0);
    await expect(written.text.replace(/\r\n/g, '\n')).toMatchFileSnapshot('./__snapshots__/fea_bar_results.vtu');
  });

  it('VTU without results has the mesh arrays only', async () => {
    await expect(writeVtu(mesh, null, 'ascii').text.replace(/\r\n/g, '\n')).toMatchFileSnapshot('./__snapshots__/fea_bar_mesh.vtu');
  });
});

describe('FEA part 2 refusals recorded as behaviour', () => {
  const buckling = runPlan(feaPlans['fea_buckling_preload_view'] ?? []).document;
  const bucklingCase = Object.values(buckling.analysis?.cases ?? {})[0];
  const bucklingId = bucklingCase?.id ?? '';

  it('the BDF writer refuses a buckling analysis with a preload load case', () => {
    const bucklingMesh = barMesh(buckling, bucklingId, Object.keys(bucklingCase?.parts ?? {})[0] ?? '', {});
    expect(writeBdf(buckling, bucklingId, bucklingMesh)).toMatchObject({ code: 'FEA_BDF_UNSUPPORTED' });
  });

  it('fea_result_field refuses an analysis without a verified results artifact', () => {
    const refused = execute(buckling, 'fea_result_field', { analysisId: bucklingId, field: 'u_mag' });
    expect(refused.rejected).toBe(true);
    expect(refused.document).toBe(buckling);
    expect(refused.affected).toEqual([]);
  });
});
