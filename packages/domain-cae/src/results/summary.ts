/** Summaries of artifacts (05 §4.1): what `record_fe_mesh` / `record_fea_results` recompute and compare with the agent's summary. */

import type { FeMeshArtifact, FeResultsArtifact, MeshSummary, ResultsSummary } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { loadCasesOf } from '../decks/context';
import { caseOf } from '../shared/access';
import { thermalResultsSummary } from '../thermal/summary';
import { maxOverNodes, magnitude, nodeCoordinates, nodeEntities, stepOfLoadCase, vonMises } from './fields';
import { meshQuality } from './meshQuality';

/**
 * Summary of a mesh artifact: node and element counts per type, tet quality and inverted-element warning.
 * @invariant deterministic and pure; `faceMap` is empty (the face-to-surface map is a mesher-side product, not stored in the artifact)
 */
export function meshSummary(mesh: FeMeshArtifact, meshHash: string): MeshSummary {
  const elements: Record<string, number> = {};
  for (const block of mesh.blocks) elements[block.type] = (elements[block.type] ?? 0) + block.elements.length;
  const quality = meshQuality(mesh);
  return {
    meshHash,
    inputHash: mesh.inputHash,
    mesher: mesh.mesher,
    mesherVersion: mesh.mesherVersion,
    nodes: mesh.nodes.length,
    elements,
    quality,
    warnings: quality.inverted > 0 ? [`FEA_MESH_INVERTED: ${quality.inverted} element(s) with scaled Jacobian <= 0`] : [],
    faceMap: [],
  };
}

/**
 * Summary of a results artifact. Static and thermo_static: per load case (CalculiX step n = load case n, `loadCasesOf` order) the maximum
 * von Mises stress and the maximum displacement magnitude, each with its node position (analysis units) and, for stress, the owning
 * entity; a load case whose step lacks DISP or STRESS is omitted. heat_*: `thermal` from the thermal lane, no load cases.
 * @invariant deterministic and pure; an unknown analysis gives no load cases
 */
export function resultsSummary(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  resultsHash: string,
): ResultsSummary {
  const base = {
    resultsHash,
    inputHash: results.inputHash,
    solver: results.solver,
    solverVersion: results.solverVersion,
    units: mesh.unitSystem,
  };
  const analysis = caseOf(doc, analysisId);
  if (analysis === undefined) return { ...base, loadCases: [] };
  if (analysis.type === 'heat_steady' || analysis.type === 'heat_transient')
    return { ...base, loadCases: [], thermal: thermalResultsSummary(doc, analysisId, mesh, results) };
  const coordinates = nodeCoordinates(mesh);
  const entities = nodeEntities(mesh);
  const at = (node: number): Vec3 => coordinates.get(node) ?? [0, 0, 0];
  const loadCases: ResultsSummary['loadCases'][number][] = [];
  loadCasesOf(analysis).forEach(({ name, category }, index) => {
    const step = stepOfLoadCase(results, index);
    const stress = maxOverNodes(step?.fields.STRESS, vonMises);
    const displacement = maxOverNodes(step?.fields.DISP, magnitude);
    if (stress === null || displacement === null) return;
    loadCases.push({
      name,
      category,
      maxVonMises: { value: stress.value, at: at(stress.node), entityId: entities.get(stress.node) ?? '' },
      maxDisplacement: { value: displacement.value, at: at(displacement.node) },
    });
  });
  return { ...base, loadCases };
}
