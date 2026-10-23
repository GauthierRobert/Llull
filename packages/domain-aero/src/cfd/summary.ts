/**
 * The `CfdResultSummary` recomputed from a `cfd_result` artifact (trust model of 05 §4.1): coefficients from the artifact's forces and the
 * case reference, provenance from the solver facts. The record command stores exactly this; the transport passes the same object.
 */

import type { CfdResultArtifact } from '@core/model/cfdResult';
import type { Vec3 } from '@core/model/types';
import type { CfdCase, CfdResultSummary } from '@aero/cfd/types';

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The wgpu backend named in an adapter string such as `NVIDIA … (Vulkan, DiscreteGpu)`. */
export function backendOf(adapter: string | undefined): 'vulkan' | 'metal' | 'dx12' | 'cpu' {
  const lower = (adapter ?? '').toLowerCase();
  if (lower.includes('vulkan')) return 'vulkan';
  if (lower.includes('metal')) return 'metal';
  if (lower.includes('dx12')) return 'dx12';
  return 'cpu';
}

/** Summary of `artifact` for `cfdCase`: the coefficients use the CASE reference area / length (the cross-check of the solver's own). */
export function cfdSummary(cfdCase: CfdCase, artifact: CfdResultArtifact, resultsHash: string): CfdResultSummary {
  const { forces, flow } = artifact;
  const q = flow.dynamicPressurePa;
  const qArea = q * cfdCase.reference.areaM2;
  const qAreaLength = qArea * cfdCase.reference.lengthM;
  const drag = dot(forces.totalN, forces.dragAxis);
  return {
    caseId: cfdCase.id,
    resultsHash,
    caseHash: artifact.caseHash,
    geometryHash: artifact.geometryHash,
    solver: artifact.solver,
    converged: artifact.converged,
    forces: {
      totalN: forces.totalN,
      momentNm: forces.momentNm,
      cd: drag / qArea,
      cl: dot(forces.totalN, forces.liftAxis) / qArea,
      cs: dot(forces.totalN, forces.sideAxis) / qArea,
      cm: [forces.momentNm[0] / qAreaLength, forces.momentNm[1] / qAreaLength, forces.momentNm[2] / qAreaLength],
      cdAM2: drag / q,
    },
    perBody: artifact.perBody,
    peaks: artifact.peaks,
    grid: { cells: artifact.grid.cells, finestCellM: artifact.grid.cellM, levels: 1 },
    provenance: {
      solverVersion: artifact.solverVersion,
      device: {
        backend: artifact.device === 'gpu' ? backendOf(artifact.adapter) : 'cpu',
        name: artifact.adapter ?? `cpu (${artifact.precision}${artifact.deterministic ? ', deterministic' : ''})`,
        driver: '',
      },
      wallTimeS: artifact.elapsedS,
      steps: artifact.steps,
      notModelled: artifact.notModelled,
      defaults: artifact.defaults,
    },
    verified: true,
  };
}
