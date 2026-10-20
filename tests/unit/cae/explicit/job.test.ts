/** buildExplicitJob: structured hex8 mesh, tet4 from the 05 mesh artifact, materials and refusals (TR-EXP-70). */
import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildExplicitJob, type ExplicitJob } from '@cae/index';
import { explicitInputHash } from '@cae/explicit/hash';
import { barModel, must } from './support';

const jobOf = (doc: CadDocument, analysisId: string, mesh: FeMeshArtifact | null = null): ExplicitJob => {
  const built = buildExplicitJob(doc, analysisId, mesh);
  if (!built.ok) throw new Error(`${built.code}: ${built.message}`);
  return built.job;
};

const refusal = (doc: CadDocument, analysisId: string, mesh: FeMeshArtifact | null = null): string => {
  const built = buildExplicitJob(doc, analysisId, mesh);
  return built.ok ? 'ok' : built.code;
};

describe('buildExplicitJob', () => {
  const model = barModel({ size: 5 });

  it('meshes the bar 2 x 2 x 40 hex8 with the Flanagan-Belytschko node order and the case units', () => {
    const job = jobOf(model.doc, model.analysisId);
    expect(job.mesh.hex8.length / 8).toBe(160);
    expect(job.mesh.tet4).toEqual([]);
    expect(job.mesh.nodes.length / 3).toBe(3 * 3 * 41);
    const corners = job.mesh.hex8.slice(0, 8).map((node) => job.mesh.nodes.slice(3 * node, 3 * node + 3));
    expect(corners).toEqual([
      [0, 0, 0],
      [5, 0, 0],
      [5, 5, 0],
      [0, 5, 0],
      [0, 0, 5],
      [5, 0, 5],
      [5, 5, 5],
      [0, 5, 5],
    ]);
    expect(job.materials).toHaveLength(1);
    expect(job.materials[0]).toMatchObject({ E: 200000, nu: 0.3 });
    expect(job.materials[0]?.density).toBeCloseTo(7.85e-9, 20);
    expect(job.elementMaterial.every((index) => index === 0)).toBe(true);
    expect(job.initialVelocity.slice(0, 3)).toEqual([0, 0, -10000]);
    expect(job.walls).toEqual([{ name: 'anvil', point: [5, 5, 0], normal: [0, 0, 1] }]);
    expect(job.units).toEqual({ length: 'mm', stress: 'MPa', energy: 'mJ', force: 'N' });
    expect(job.inputHash).toBe(explicitInputHash(model.doc, model.doc.analysis?.cases[model.analysisId] ?? ({} as never)));
    expect(job.unverifiedReasons).toEqual([]);
  });

  it('reads Johnson-Cook strength from the default constitutive set in the case stress unit', () => {
    const plastic = barModel({ plastic: true, size: 5 });
    const material = jobOf(plastic.doc, plastic.analysisId).materials[0];
    expect(material?.johnsonCook).toEqual({ A: 300, B: 500, n: 0.5, C: 0.02, referenceRate: 1, m: 1, meltK: 1800, transitionK: 293.15 });
  });

  it('changes the input hash with the set-up and not with recorded results', () => {
    const moved = must(model.doc, 'set_initial_velocity', {
      analysisId: model.analysisId,
      entityId: model.barId,
      velocity: { vector: [0, 0, -1], unit: 'm/s' },
    });
    expect(jobOf(moved.document, model.analysisId).inputHash).not.toBe(jobOf(model.doc, model.analysisId).inputHash);
  });

  it('reads tet4 from a linear 05 mesh artifact and refuses quadratic elements', () => {
    const tetCase = must(model.doc, 'set_explicit_controls', {
      analysisId: model.analysisId,
      endTime: { value: 1e-4, unit: 's' },
      historyInterval: { value: 1e-6, unit: 's' },
    }).document;
    const mesh: FeMeshArtifact = {
      kind: 'fe_mesh',
      unitSystem: 'N-mm-t-s',
      mesher: 'test',
      mesherVersion: '1',
      inputHash: 'x',
      nodes: [
        [1, 0, 0, 0],
        [2, 1, 0, 0],
        [3, 0, 1, 0],
        [4, 0, 0, 1],
      ],
      blocks: [{ type: 'C3D4', entityId: model.barId, elements: [[1, 1, 2, 3, 4]] }],
      nodeSets: {},
      faceSets: {},
      targets: {},
    };
    const job = jobOf(tetCase, model.analysisId, mesh);
    expect(job.mesh.tet4).toEqual([0, 1, 2, 3]);
    expect(job.mesh.hex8).toEqual([]);
    expect(job.mesh.nodePart).toEqual([model.barId, model.barId, model.barId, model.barId]);
    expect(refusal(tetCase, model.analysisId)).toBe('EXP_MESH_MISSING');
    const quadratic: FeMeshArtifact = { ...mesh, blocks: [{ type: 'C3D10', entityId: model.barId, elements: [] }] };
    expect(refusal(tetCase, model.analysisId, quadratic)).toBe('EXP_MESH_UNSUPPORTED');
  });

  it('refuses rotated boxes, missing materials, no excitation and incomplete cases', () => {
    const rotated = must(model.doc, 'rotate_entity', { id: model.barId, delta: [0, 0, 0.1] });
    expect(refusal(rotated.document, model.analysisId)).toBe('EXP_MESH_UNSUPPORTED');
    const noVelocity = must(model.doc, 'set_initial_velocity', {
      analysisId: model.analysisId,
      entityId: model.barId,
      velocity: { vector: [0, 0, 0], unit: 'mm/s' },
    });
    expect(refusal(noVelocity.document, model.analysisId)).toBe('EXP_NO_EXCITATION');
    const again = execute(noVelocity.document, 'set_initial_velocity', {
      analysisId: model.analysisId,
      entityId: model.barId,
      velocity: { vector: [0, 0, 0], unit: 'mm/s' },
    });
    expect(again.document).toBe(noVelocity.document);
    expect(again.affected).toEqual([]);
    const bare = must(model.doc, 'add_box', { size: [5, 5, 5], position: [50, 0, 0] });
    const withBare = must(bare.document, 'set_part_idealization', { analysisId: model.analysisId, entityId: bare.affected[0] });
    expect(refusal(withBare.document, model.analysisId)).toBe('EXP_MATERIAL_INCOMPLETE');
    const fresh = must(model.doc, 'create_analysis', { name: 'b', analysisType: 'explicit_dynamics' });
    expect(refusal(fresh.document, fresh.affected[0] ?? '')).toBe('EXP_CONTROLS_MISSING');
    expect(refusal(model.doc, 'an-404')).toBe('FEA_ANALYSIS_NOT_FOUND');
    const empty = must(fresh.document, 'set_explicit_controls', {
      analysisId: fresh.affected[0],
      endTime: { value: 1, unit: 's' },
      historyInterval: { value: 1, unit: 's' },
    });
    expect(refusal(empty.document, fresh.affected[0] ?? '')).toBe('EXP_MESH_UNSUPPORTED');
  });
});
