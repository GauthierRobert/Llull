/** OP2 tables -> `FeResultsArtifact` (05 §4 `fea_import_results`): the same field names the FRD reader writes, so every reader of results (summaries, margins, plots) works on it. */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '../hash/inputHash';
import { largest } from '../shared/largest';
import { caseOf } from '../shared/access';
import { firstNonFinite } from './frdReader';
import { bindingOf, mismatchMessage, UNBOUND_WARNING } from './inputBinding';
import type { Op2Displacements, Op2SolidStress, Op2Tables } from './op2Reader';

type Steps = FeResultsArtifact['steps'];
type Field = Steps[number]['fields'][string];

export type Op2Import =
  | { readonly artifact: FeResultsArtifact; readonly warnings: readonly string[] }
  | { readonly code: string; readonly message: string };

/** The titles `datReader` stores these tables under (readers match their prefixes). */
const EIGENVALUE_TITLE = 'eigenvalues (mode, eigenvalue, real part rad/time, frequency cycles/time, imaginary part)';
const BUCKLING_TITLE = 'buckling factors (mode, factor)';

const refuse = (code: string, message: string): { code: string; message: string } => ({ code, message });

function displacementField(set: Op2Displacements, known: ReadonlySet<number>): Field {
  return {
    components: ['D1', 'D2', 'D3'],
    values: Object.fromEntries(
      [...set.nodes].filter(([node]) => known.has(node)).map(([node, values]) => [String(node), values.slice(0, 3)]),
    ),
  };
}

/** Nodal STRESS from the element rows: corner rows averaged over the elements that share the node; a centroid-only element gives its value to its corner nodes. */
function stressField(set: Op2SolidStress, corners: ReadonlyMap<number, readonly number[]>): Field {
  const sums = new Map<number, { sum: number[]; count: number }>();
  const add = (node: number, stress: readonly number[]): void => {
    const entry = sums.get(node) ?? { sum: [0, 0, 0, 0, 0, 0], count: 0 };
    stress.forEach((value, index) => void (entry.sum[index] = (entry.sum[index] ?? 0) + value));
    entry.count++;
    sums.set(node, entry);
  };
  for (const [element, rows] of set.elements) {
    const atCorners = rows.filter((row) => row.grid > 0);
    if (atCorners.length > 0) for (const row of atCorners) add(row.grid, row.stress);
    else {
      const centroid = rows[0];
      if (centroid !== undefined) for (const node of corners.get(element) ?? []) add(node, centroid.stress);
    }
  }
  return {
    components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'],
    values: Object.fromEntries([...sums].map(([node, { sum, count }]) => [String(node), sum.map((value) => value / count)])),
  };
}

/**
 * Results artifact of an OP2 written by Nastran for the BDF of `analysisId` (grid ids = mesh node ids). static: one step per subcase (subcase order = load
 * case order) with DISP and, when the file has CTETRA stresses, STRESS; modal: one step per mode (`time` = frequency in Hz) with DISP and the eigenvalue table in
 * `dat`; buckling: one step per buckled mode (`time` = factor) with DISP and the factor table.
 * @invariant a file whose `llull inputHash` marker (BDF SUBTITLE) differs from the current input hash is refused; one without a marker is imported with
 *   `binding: 'imported-unbound'` and a FEA_RESULTS_UNBOUND warning (check_analysis flags it)
 * @invariant the artifact carries the CURRENT mesh hash and analysis input hash: the caller has checked that the OP2 was computed on this mesh (every mesh node
 *   has a displacement; grid ids above the mesh ids are the reference grids of moment loads and are dropped)
 * @failure unknown analysis / type -> FEA_ANALYSIS_NOT_FOUND / FEA_ANALYSIS_TYPE_UNSUPPORTED; no displacement table of the right kind -> FEA_OP2_NO_RESULTS; a mesh
 *   node without a displacement or a grid below the mesh ids that the mesh lacks -> FEA_OP2_MESH_MISMATCH; marker of another set-up -> FEA_RESULTS_INPUT_MISMATCH; non-finite values -> FEA_SOLVER_FAILED
 */
export function op2ToResults(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, meshHash: string, op2: Op2Tables): Op2Import {
  const analysis = caseOf(doc, analysisId);
  if (analysis === undefined) return refuse('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`);
  if (analysis.type !== 'static' && analysis.type !== 'modal' && analysis.type !== 'buckling')
    return refuse(
      'FEA_ANALYSIS_TYPE_UNSUPPORTED',
      `OP2 results are imported for static, modal and buckling analyses, not '${analysis.type}'`,
    );
  const inputHash = analysisInputHash(doc, analysisId, 'full');
  const binding = bindingOf(op2.inputHashes, inputHash);
  if (binding.kind === 'mismatch') return refuse('FEA_RESULTS_INPUT_MISMATCH', mismatchMessage(binding.found));
  const wanted = analysis.type === 'static' ? 1 : analysis.type === 'modal' ? 2 : 8;
  const displacements = op2.displacements.filter((set) => set.analysisCode === wanted);
  if (displacements.length === 0)
    return refuse(
      'FEA_OP2_NO_RESULTS',
      `the OP2 has no displacement table of the kind a ${analysis.type} analysis needs (analysis code ${wanted})`,
    );
  const known = new Set(mesh.nodes.map((node) => node[0]));
  const highest = largest(known);
  for (const set of displacements) {
    for (const node of set.nodes.keys())
      if (!known.has(node) && node <= highest)
        return refuse(
          'FEA_OP2_MESH_MISMATCH',
          `grid ${node} of the OP2 is not a node of the current mesh: the OP2 was computed on another mesh`,
        );
    const missing = [...known].find((node) => !set.nodes.has(node));
    if (missing !== undefined)
      return refuse('FEA_OP2_MESH_MISMATCH', `mesh node ${missing} has no displacement in the OP2: the OP2 was computed on another mesh`);
  }
  const cornerNodes = new Map<number, readonly number[]>();
  for (const block of mesh.blocks) for (const element of block.elements) cornerNodes.set(element[0] ?? -1, element.slice(1, 5));
  const warnings = [...op2.warnings, ...(binding.kind === 'unbound' ? [UNBOUND_WARNING] : [])];
  const steps: Steps[number][] = [];
  const stressOf = (subcase: number, mode: number | undefined): Op2SolidStress | undefined =>
    op2.stresses.find((set) => set.analysisCode === wanted && set.subcase === subcase && set.mode === mode);
  let dat: FeResultsArtifact['dat'];
  if (analysis.type === 'static') {
    const subcases = [...new Set(displacements.map((set) => set.subcase))].sort((a, b) => a - b);
    subcases.forEach((subcase, index) => {
      const set = displacements.find((candidate) => candidate.subcase === subcase);
      if (set === undefined) return;
      const stress = stressOf(subcase, undefined);
      if (stress === undefined) warnings.push(`subcase ${subcase} has no CTETRA stress table: only DISP is imported for it`);
      steps.push({
        step: index + 1,
        time: 1,
        fields: { DISP: displacementField(set, known), ...(stress === undefined ? {} : { STRESS: stressField(stress, cornerNodes) }) },
      });
    });
  } else {
    const modes = [...displacements].sort((a, b) => (a.mode ?? 0) - (b.mode ?? 0));
    const lama = new Map(op2.eigenvalues.map((row) => [row.mode, row]));
    const rows = modes.map((set) => {
      const mode = set.mode ?? 0;
      const row = lama.get(mode);
      const eigenvalue = row?.eigenvalue ?? set.eigenvalue ?? Number.NaN;
      const hertz = analysis.type === 'modal' ? (row?.cycles ?? Math.sqrt(Math.max(0, eigenvalue)) / (2 * Math.PI)) : Number.NaN;
      return { set, mode, eigenvalue, hertz, radians: row?.radians ?? Math.sqrt(Math.max(0, eigenvalue)) };
    });
    for (const { set, eigenvalue, hertz } of rows)
      steps.push({ step: 1, time: analysis.type === 'modal' ? hertz : eigenvalue, fields: { DISP: displacementField(set, known) } });
    dat = {
      tables: [
        analysis.type === 'modal'
          ? { title: EIGENVALUE_TITLE, time: 0, rows: rows.map((row) => [row.mode, row.eigenvalue, row.radians, row.hertz, 0]) }
          : { title: BUCKLING_TITLE, time: 0, rows: rows.map((row) => [row.mode, row.eigenvalue]) },
      ],
    };
  }
  const nonFinite = firstNonFinite(steps);
  if (nonFinite !== null || (dat?.tables ?? []).some((table) => table.rows.some((row) => row.some((value) => !Number.isFinite(value)))))
    return refuse('FEA_SOLVER_FAILED', `the OP2 holds non-finite values (${nonFinite ?? 'eigenvalue table'}); the solution is not usable`);
  return {
    artifact: {
      kind: 'fe_results',
      meshHash,
      inputHash,
      solver: 'nastran',
      solverVersion: op2.producer === '' ? 'op2' : op2.producer,
      ...(binding.kind === 'unbound' ? { binding: 'imported-unbound' as const } : {}),
      steps,
      ...(dat === undefined ? {} : { dat }),
    },
    warnings,
  };
}
