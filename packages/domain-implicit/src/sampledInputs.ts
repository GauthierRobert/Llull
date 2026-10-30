/**
 * Scalar inputs read from analysis results (05 IMP 14.11, VC-IMP-29): the density grid of a topology study (`topology_density`) and a result field of a finite-element
 * analysis (`fea_result`: von Mises stress or displacement magnitude on the tetrahedra of the recorded mesh). The plugin reads document data and the injected artifact
 * port only (L10): `doc.analysis.cases[..]` records and `ExecutionContext.feaArtifacts`, never the `topology` or `cae` plugins.
 * @invariant the sampled data is a pure function of (document records, artifacts), so a changed or re-recorded result gives another program and another content hash (stale body)
 * @invariant the port of the running command is ambient (`withArtifacts`) because the compiler has no context: set by `catalog.ts` around every command, absent elsewhere (then the input is "not found")
 */

import type { FeArtifactPort, UnitSystem } from '@core/model/analysis';
import type { GridSamples, SampledField, TetSamples } from '@core/geometry/field/sampled';
import type { FeTopologyArtifact } from '@core/model/topology';
import type { CadDocument, Vec3 } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { base64ToUint8Array } from '@lib/base64';

let current: FeArtifactPort | null = null;

/** Runs `body` with `port` as the artifact store the field compiler reads (restored afterwards). */
export function withArtifacts<T>(port: FeArtifactPort | null | undefined, body: () => T): T {
  const previous = current;
  current = port ?? previous;
  try {
    return body();
  } finally {
    current = previous;
  }
}

export type SampledInput =
  | { readonly ok: true; readonly field: SampledField; readonly unverified: boolean }
  | {
      readonly ok: false;
      readonly code: 'IMP_INPUT_NOT_FOUND' | 'IMP_INPUT_TOO_LARGE';
      readonly message: string;
      readonly ids: readonly string[];
    };

const missing = (message: string, ids: readonly string[]): SampledInput => ({ ok: false, code: 'IMP_INPUT_NOT_FOUND', message, ids });

/** Tetrahedra the FE input holds at most (the data travels inside the field program and its content hash). */
const MAX_TETRAHEDRA = 500_000;

const PLANE_AXES = { XY: [0, 1, 2], XZ: [0, 2, 1], YZ: [1, 2, 0] } as const;

/** The float32 density field of a topology artifact, or null when it is not `nx * ny * nz` values in [0, 1]. */
function decodeDensity(artifact: FeTopologyArtifact): number[] | null {
  const { nx, ny, nz } = artifact.grid;
  const bytes = base64ToUint8Array(artifact.xPhys);
  if (bytes === null || bytes.length !== 4 * nx * ny * nz) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let i = 0; i < nx * ny * nz; i += 1) {
    const value = view.getFloat32(4 * i, true);
    if (!(value >= -1e-6 && value <= 1 + 1e-6)) return null;
    values.push(Math.min(1, Math.max(0, value)));
  }
  return values;
}

/**
 * The density of study `studyId` as a cell-centred grid in world axes (a 2D study on XZ or YZ is permuted; its out-of-plane axis has one voxel, held outside).
 * @failure unknown study, no verified result, no artifact store or artifact, malformed field -> IMP_INPUT_NOT_FOUND
 */
export function topologyDensityInput(doc: CadDocument, studyId: string): SampledInput {
  const cases = doc.analysis?.cases ?? {};
  const study = Object.values(cases)
    .map((analysisCase) => analysisCase.topology?.[studyId])
    .find((candidate) => candidate !== undefined);
  if (study === undefined) return missing(`no topology study '${studyId}'`, [studyId]);
  const result = study.result;
  if (result === undefined || result.verified === false)
    return missing(`topology study '${studyId}' has no verified result: run the study (topology_solve) and record it first`, [studyId]);
  const artifact = current?.get(result.fieldHash) ?? null;
  if (artifact === null || artifact.kind !== 'fe_topology')
    return missing(`the artifact store holds no density field ${result.fieldHash.slice(0, 12)} of study '${studyId}'`, [studyId]);
  const density = decodeDensity(artifact);
  if (density === null) return missing(`the density field of study '${studyId}' is not nx*ny*nz values in [0, 1]`, [studyId]);
  const { grid } = artifact;
  const axes = grid.plane === undefined ? [0, 1, 2] : PLANE_AXES[grid.plane];
  const sizes = [grid.nx, grid.ny, grid.nz];
  const worldNodes: [number, number, number] = [1, 1, 1];
  axes.forEach((world, a) => (worldNodes[world] = sizes[a] as number));
  const values = new Array<number>(density.length);
  for (let k = 0; k < grid.nz; k += 1)
    for (let j = 0; j < grid.ny; j += 1)
      for (let i = 0; i < grid.nx; i += 1) {
        const at = [0, 0, 0];
        [i, j, k].forEach((index, a) => (at[axes[a] as number] = index));
        values[(at[0] as number) + worldNodes[0] * ((at[1] as number) + worldNodes[1] * (at[2] as number))] = density[
          i + grid.nx * (j + grid.ny * k)
        ] as number;
      }
  const field: GridSamples = {
    kind: 'grid',
    nodes: worldNodes,
    origin: [grid.origin[0], grid.origin[1], grid.origin[2]],
    voxel: grid.voxel,
    values,
  };
  return { ok: true, field, unverified: result.unverified };
}

const METRES_PER_ANALYSIS_LENGTH: Readonly<Record<UnitSystem, number>> = { 'N-mm-t-s': 0.001, 'N-m-kg-s': 1, 'lbf-in-slinch-s': 0.0254 };

/** von Mises equivalent of [Sxx, Syy, Szz, Sxy, Syz, Szx]. */
function vonMises(stress: readonly number[]): number {
  const [xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0] = stress;
  return Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (xy ** 2 + yz ** 2 + zx ** 2));
}

const QUANTITIES = {
  von_mises: { field: 'STRESS', scalar: vonMises },
  u_mag: { field: 'DISP', scalar: (values: readonly number[]) => Math.hypot(...values.slice(0, 3)) },
} as const;

export type FeQuantity = keyof typeof QUANTITIES;

/**
 * A result field of analysis `caseId` as tetrahedra with node values, in document units of length (corner nodes of C3D4 and C3D10 elements). `step` is the
 * solver step number (load case index + 1); default: the lowest step that holds the field, its last written increment.
 * @failure unknown case, no verified mesh or results, artifacts missing, no tetrahedral element, field absent or missing at a node -> IMP_INPUT_NOT_FOUND; too many tetrahedra -> IMP_INPUT_TOO_LARGE
 */
export function feResultInput(doc: CadDocument, caseId: string, quantity: FeQuantity, step: number | undefined): SampledInput {
  const analysisCase = doc.analysis?.cases[caseId];
  if (analysisCase === undefined) return missing(`no analysis case '${caseId}'`, [caseId]);
  const results = analysisCase.results;
  const meshSummary = analysisCase.meshSummary;
  if (results === undefined || results.verified === false || meshSummary === undefined || meshSummary.verified === false)
    return missing(`analysis '${caseId}' has no verified mesh and results: mesh and solve it first`, [caseId]);
  const mesh = current?.get(meshSummary.meshHash) ?? null;
  const set = current?.get(results.resultsHash) ?? null;
  if (mesh === null || mesh.kind !== 'fe_mesh' || set === null || set.kind !== 'fe_results')
    return missing(`the artifact store holds no mesh and results of analysis '${caseId}'`, [caseId]);
  const { field: fieldName, scalar } = QUANTITIES[quantity];
  const candidates = set.steps.filter((entry) => entry.fields[fieldName] !== undefined && (step === undefined || entry.step === step));
  const wanted = step ?? Math.min(...candidates.map((entry) => entry.step));
  const chosen = candidates.filter((entry) => entry.step === wanted).at(-1);
  const field = chosen?.fields[fieldName];
  if (chosen === undefined || field === undefined)
    return missing(`the results of analysis '${caseId}' have no ${fieldName} field${step === undefined ? '' : ` in step ${step}`}`, [
      caseId,
    ]);
  const tets = mesh.blocks.filter((block) => block.type === 'C3D4' || block.type === 'C3D10').flatMap((block) => block.elements);
  if (tets.length === 0) return missing(`the mesh of analysis '${caseId}' has no tetrahedral (C3D4 / C3D10) element`, [caseId]);
  if (tets.length > MAX_TETRAHEDRA)
    return {
      ok: false,
      code: 'IMP_INPUT_TOO_LARGE',
      message: `${tets.length} tetrahedra exceed the limit of ${MAX_TETRAHEDRA}`,
      ids: [caseId],
    };
  const toDocument = METRES_PER_ANALYSIS_LENGTH[analysisCase.unitSystem] / toMetres(doc, 1);
  const position = new Map<number, Vec3>(
    mesh.nodes.map((node): [number, Vec3] => [node[0], [node[1] * toDocument, node[2] * toDocument, node[3] * toDocument]]),
  );
  const index = new Map<number, number>();
  const points: number[] = [];
  const values: number[] = [];
  const corners: number[] = [];
  for (const element of tets) {
    for (const id of element.slice(1, 5)) {
      let at = index.get(id);
      if (at === undefined) {
        const p = position.get(id);
        const raw = field.values[String(id)];
        const value = raw === undefined ? Number.NaN : scalar(raw);
        if (p === undefined || !Number.isFinite(value))
          return missing(`node ${id} of analysis '${caseId}' has no ${quantity} value`, [caseId]);
        at = index.size;
        index.set(id, at);
        points.push(p[0], p[1], p[2]);
        values.push(value);
      }
      corners.push(at);
    }
  }
  const tetField: TetSamples = { kind: 'tets', points, tets: corners, values };
  return { ok: true, field: tetField, unverified: set.binding === 'imported-unbound' };
}
