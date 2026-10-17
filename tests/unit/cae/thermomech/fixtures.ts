/** PHY-04 FE fixtures: a thermo_static case on a box with a hand-built two-tetrahedron mesh artifact. */
import { execute } from '@core/commands/registry';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { buildDeckContext, type DeckContext } from '@cae/decks/context';
import { strainModel, withModel } from '../../physics/thermomech/thermomechFixtures';

const REF = { value: 20, unit: 'degC' };

function mesh2Tets(entityId: string): FeMeshArtifact {
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '0',
    inputHash: 'h',
    nodes: [
      [1, 0, 0, 0],
      [2, 10, 0, 0],
      [3, 0, 10, 0],
      [4, 0, 0, 10],
      [5, 10, 10, 10],
    ],
    blocks: [
      {
        type: 'C3D4',
        entityId,
        elements: [
          [1, 1, 2, 3, 4],
          [2, 2, 3, 4, 5],
        ],
      },
    ],
    nodeSets: {},
    faceSets: {},
    targets: {},
  };
}

export function portOf(artifacts: Record<string, FeMeshArtifact | FeResultsArtifact>): FeArtifactPort {
  return { get: (hash) => (Object.hasOwn(artifacts, hash) ? (artifacts[hash] ?? null) : null) };
}

export interface Fixture {
  readonly doc: CadDocument;
  readonly boxId: string;
  readonly analysisId: string;
  readonly mesh: FeMeshArtifact;
}

/** Box with material `mat` (thermalStrain model, alpha 1.2e-5) in a thermo_static case with reference 20 degC and a uniform 120 degC field. */
export function thermoFixture(
  options: {
    /** null = a material without any property model. */
    model?: Record<string, unknown> | null;
    field?: Record<string, unknown> | null;
  } = {},
): Fixture {
  let doc = createEmptyDocument();
  const box = execute(doc, 'add_box', { size: [10, 10, 10] });
  const boxId = box.affected[0] ?? '';
  doc = box.document;
  const model = options.model === undefined ? strainModel(1.2e-5) : options.model;
  doc =
    model === null
      ? execute(doc, 'create_material', { name: 'mat', density: 0.0078, color: '#999999', metalness: 1, roughness: 0.4 }).document
      : withModel(doc, 'mat', model);
  doc = execute(doc, 'assign_material', { materialName: 'mat', entityIds: [boxId] }).document;
  const created = execute(doc, 'create_analysis', { name: 'T', analysisType: 'thermo_static', referenceTemperature: REF });
  const analysisId = created.affected[0] ?? '';
  doc = execute(created.document, 'set_part_idealization', { analysisId, entityId: boxId }).document;
  const field = options.field === undefined ? { kind: 'uniform', value: { value: 120, unit: 'degC' } } : options.field;
  if (field !== null) doc = execute(doc, 'set_temperature_field', { analysisId, source: field }).document;
  return { doc, boxId, analysisId, mesh: mesh2Tets(boxId) };
}

export function deckContext(fixture: Fixture, artifacts: FeArtifactPort | null = null): DeckContext {
  const context = buildDeckContext(fixture.doc, fixture.analysisId, fixture.mesh, artifacts);
  if (context === null) throw new Error('no deck context');
  return context;
}

import { analysisInputHash } from '@cae/hash/inputHash';
import { withCase } from '@cae/shared/access';
import type { AnalysisCase } from '@core/model/analysis';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';

export const hashOf = (artifact: FeMeshArtifact | FeResultsArtifact): string => sha256Hex(canonicalJson(artifact));

export interface ThermalSource {
  readonly fixture: Fixture;
  readonly thermalId: string;
  readonly resultsHash: string;
  /** The mesh artifact the thermal case was solved on (recorded on it). */
  readonly thermalMesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
  /** Store holding the thermal mesh and results. */
  readonly artifacts: FeArtifactPort;
}

/**
 * A solved heat_steady case (NDTEMP 100 + node id, time 5) that the thermo_static case of `fixture` reads (time `last`). Its mesh and
 * results are recorded with the real summarisers, so they verify against `artifacts`. `mesh` is the discretisation it was solved on (default:
 * the mesh of `base`).
 */
export function withThermalSource(base: Fixture, options: { mesh?: FeMeshArtifact; scale?: 'degC' | 'K' } = {}): ThermalSource {
  const created = execute(base.doc, 'create_analysis', {
    name: 'H',
    analysisType: 'heat_steady',
    ...(options.scale !== undefined ? { temperatureScale: options.scale } : {}),
  });
  const thermalId = created.affected[0] ?? '';
  let doc = execute(created.document, 'set_part_idealization', { analysisId: thermalId, entityId: base.boxId }).document;
  const thermalMesh: FeMeshArtifact = { ...(options.mesh ?? base.mesh), inputHash: analysisInputHash(doc, thermalId, 'mesh') };
  const meshHash = hashOf(thermalMesh);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash,
    inputHash: analysisInputHash(doc, thermalId, 'full'),
    solver: 'ccx',
    solverVersion: '2.21',
    steps: [
      {
        step: 1,
        time: 5,
        fields: { NDTEMP: { components: ['T'], values: Object.fromEntries(thermalMesh.nodes.map(([id]) => [String(id), [100 + id]])) } },
      },
    ],
  };
  const resultsHash = hashOf(results);
  const heat = doc.analysis?.cases[thermalId] as AnalysisCase;
  doc = withCase(doc, {
    ...heat,
    meshSummary: meshSummary(thermalMesh, meshHash),
    results: resultsSummary(doc, thermalId, thermalMesh, results, resultsHash),
  });
  doc = execute(doc, 'set_temperature_field', {
    analysisId: base.analysisId,
    source: { kind: 'thermal_result', analysisId: thermalId, time: 'last' },
  }).document;
  return {
    fixture: { ...base, doc },
    thermalId,
    resultsHash,
    thermalMesh,
    results,
    artifacts: portOf({ [resultsHash]: results, [meshHash]: thermalMesh }),
  };
}

/** The document of `source` with its thermal results replaced by `results` (recorded with the real summariser) and a store serving them. */
export function withRecordedResults(
  source: ThermalSource,
  results: FeResultsArtifact,
): { readonly doc: CadDocument; readonly artifacts: FeArtifactPort } {
  const { doc } = source.fixture;
  const heat = doc.analysis?.cases[source.thermalId] as AnalysisCase;
  const hash = hashOf(results);
  return {
    doc: withCase(doc, { ...heat, results: resultsSummary(doc, source.thermalId, source.thermalMesh, results, hash) }),
    artifacts: portOf({ [hash]: results, [hashOf(source.thermalMesh)]: source.thermalMesh }),
  };
}
