/** record_topology_result: store the summary of a host-produced optimisation, validated against the artifact store (05 4.1), and derive the iso-surface. */

import type { TopologyResultSummary, TopologyStudy } from '@core/model/topology';
import type { CadDocument, Entity, MeshSolidEntity } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { nextId } from '@lib/id';
import { fetchArtifact } from '../shared/trust';
import { verifyAndRecord } from '../shared/verifyRecord';
import { decodeField, topologySummary } from './artifact';
import { refuseTopology } from './codes';
import { deriveTopologyMesh } from './derive';
import { topologyInputHash, topologySettingsHash } from './hash';
import { findStudy, withStudy } from './model';
import { studyIdSchema } from './schemas';

const TOPOLOGY_LAYER_ID = 'layer-topology';
const TOPOLOGY_COLOR = '#7fa6c9';

const hasTextHash = (summary: Record<string, unknown>): boolean => typeof summary['inputHash'] === 'string';

/** `doc` with the iso-surface entity `entity` placed (kept in its draw-order slot when it exists) and the topology layer present. */
function withDerivedEntity(doc: CadDocument, entity: Entity): CadDocument {
  const known = Object.hasOwn(doc.entities, entity.id);
  const hasLayer = Object.hasOwn(doc.layers, TOPOLOGY_LAYER_ID);
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: known ? doc.order : [...doc.order, entity.id],
    layers: hasLayer
      ? doc.layers
      : {
          ...doc.layers,
          [TOPOLOGY_LAYER_ID]: { id: TOPOLOGY_LAYER_ID, name: 'topology', visible: true, locked: false, color: TOPOLOGY_COLOR },
        },
    layerOrder: hasLayer ? doc.layerOrder : [...doc.layerOrder, TOPOLOGY_LAYER_ID],
  };
}

function withoutDerivedEntity(doc: CadDocument, entityId: string): CadDocument {
  if (!Object.hasOwn(doc.entities, entityId)) return doc;
  const { [entityId]: removed, ...entities } = doc.entities;
  void removed;
  return { ...doc, entities, order: doc.order.filter((id) => id !== entityId), selection: doc.selection.filter((id) => id !== entityId) };
}

/**
 * @affects doc.analysis.cases[a].topology[studyId].result (set) and derivedEntityId; creates / replaces the iso-surface mesh entity
 *   (layer `layer-topology`, read-only)
 * @invariant the artifact exists in the store and hashes to fieldHash, was built for the current inputs and settings, and the stored summary is
 *   the one recomputed from it (an agent cannot supply numbers); a summary given by the caller must equal the recomputed one; WITHOUT the
 *   artifact (replay on another machine) a given summary is kept flagged `verified: false` - state `missing`, never read as numbers
 * @failure unknown study -> TOP_STUDY_NOT_FOUND; artifact absent and no summary -> TOP_ARTIFACT_NOT_FOUND; hash, field or summary differ ->
 *   TOP_SUMMARY_MISMATCH; artifact built for other inputs / settings -> TOP_RESULT_STALE (all refusals, unchanged doc)
 */
export const recordTopologyResult = defineCommand({
  name: 'record_topology_result',
  description:
    'Record the result of a topology optimization run by the host (topology_solve transport) on a study and derive its iso-surface solid. Not for ' +
    'hand use: the summary is re-derived from the stored density field artifact, so numbers cannot be invented. `summary` is optional; when given it ' +
    'must equal the recomputed one exactly (the transport passes it so a replay without the artifact store keeps the record as unverified, state ' +
    'missing). Refused with TOP_ARTIFACT_NOT_FOUND (artifact absent), TOP_SUMMARY_MISMATCH (hash, field or summary differ), TOP_RESULT_STALE (the ' +
    'study, the analysis or the settings changed since the run: re-run topology_solve). The derived solid is a read-only concept shape on layer ' +
    'layer-topology; rebuild the part with suggest_rebuild and ordinary modelling commands.',
  params: z.object({
    studyId: studyIdSchema,
    fieldHash: z.string().describe('sha256 of the canonical topology artifact JSON, as returned by the topology_solve transport.'),
    summary: z
      .looseObject({ fieldHash: z.string().describe('Same as fieldHash.') })
      .optional()
      .describe('Exactly the summary returned by the transport (never hand-written): it is recomputed from the artifact and compared.'),
  }),
  run: (doc, { studyId, fieldHash, summary }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [studyId]): CommandResult =>
      refuseTopology(doc, 'record_topology_result', code, message, ids);
    const found = findStudy(doc, studyId);
    if (found === undefined) return fail('TOP_STUDY_NOT_FOUND', `no topology study '${studyId}'`);
    const { study } = found;
    const ids = [studyId, fieldHash];
    const verified = verifyAndRecord({
      fetched: fetchArtifact(ctx?.feaArtifacts, fieldHash, 'fe_topology'),
      summary,
      keepable: summary !== undefined && summary.fieldHash === fieldHash && hasTextHash(summary),
      mismatchCode: 'TOP_SUMMARY_MISMATCH',
      notFoundCode: 'TOP_ARTIFACT_NOT_FOUND',
      stale: (artifact) =>
        artifact.inputHash === topologyInputHash(doc, study) && artifact.settingsHash === topologySettingsHash(study.settings)
          ? null
          : { code: 'TOP_RESULT_STALE', message: 'the artifact was built for other inputs or settings than the current study' },
      recompute: (artifact) => topologySummary(doc, study, artifact, fieldHash),
      fail: (code, message) => fail(code, message, ids),
    });
    if (verified.outcome === 'refused') return verified.result;
    if (verified.outcome === 'unverified') {
      const flagged: TopologyStudy = { ...study, result: { ...summary, verified: false } as unknown as TopologyResultSummary };
      return changed(
        withStudy(doc, flagged),
        `record_topology_result: ${studyId} result ${fieldHash.slice(0, 12)} recorded UNVERIFIED (artifact not available on this machine): state missing, no number is used until topology_solve is run here.`,
        [studyId],
      );
    }
    const { artifact, expected } = verified;
    const field = decodeField(artifact);
    if (field === null) return fail('TOP_SUMMARY_MISMATCH', 'the density field of the artifact does not decode', ids);

    const mesh = deriveTopologyMesh(artifact, field, study.settings.threshold.value, study.manufacturing.symmetry);
    const hasMesh = mesh.indices.length > 0;
    const entityId = study.derivedEntityId ?? (hasMesh ? nextId('tp') : undefined);
    const { derivedEntityId: previous, ...rest } = study;
    void previous;
    const solved: TopologyStudy = {
      ...rest,
      result: expected,
      ...(hasMesh && entityId !== undefined ? { derivedEntityId: entityId } : {}),
    };
    const entity: MeshSolidEntity | null =
      hasMesh && entityId !== undefined
        ? {
            id: entityId,
            kind: 'mesh',
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            layerId: TOPOLOGY_LAYER_ID,
            color: TOPOLOGY_COLOR,
            name: `topology ${study.name}`,
            tags: [`topology:${study.id}`],
            mesh,
          }
        : null;
    const base = withStudy(doc, solved);
    const next =
      entity === null
        ? study.derivedEntityId === undefined
          ? base
          : withoutDerivedEntity(base, study.derivedEntityId)
        : withDerivedEntity(base, entity);
    const unit = expected.complianceUnit;
    return changed(
      next,
      `record_topology_result: ${studyId} solved — ${expected.iterations} iterations (${expected.status}), compliance ${significantNumber(expected.compliance, 6)} ${unit}, volume fraction ${significantNumber(expected.volumeFraction, 4)}, grey ${significantNumber(expected.grey, 3)}, solid volume ${significantNumber(expected.thresholdedVolume, 6)} ${expected.volumeUnit} (${expected.solver.job} ${expected.solver.version}, ${expected.solver.device}${expected.solver.deterministic ? ', deterministic' : ''}); ${entity === null ? 'no voxel reaches the threshold: no iso-surface' : `iso-surface ${entityId} (${mesh.indices.length / 3} triangles, concept, read-only)`}${expected.unverified ? '; UNVERIFIED material inputs' : ''}.`,
      entity === null ? [studyId] : [studyId, entity.id],
    );
  },
});
