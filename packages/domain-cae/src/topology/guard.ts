/** Derivation guard and document extension of the topology plugin: the iso-surface is read-only geometry derived from a recorded result (L8). */

import type { DerivationGuard } from '@core/commands/derivation';
import type { TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import type { DocumentExtension } from '@core/plugins/plugin';
import { canonicalJson } from '@lib/canonicalJson';
import { isRecord } from '@lib/isRecord';
import { analysisOf } from '../shared/access';
import { findStudy, studiesOf, topologyErrors } from './model';

const studiesIn = (doc: CadDocument): TopologyStudy[] =>
  analysisOf(doc).caseOrder.flatMap((id) => {
    const analysisCase = analysisOf(doc).cases[id];
    return analysisCase === undefined ? [] : studiesOf(analysisCase);
  });

/**
 * @invariant a study's derived entity changes only together with the study's recorded result (record_topology_result) or is removed with the study
 *   (delete_topology_study); every other edit of it - move, delete, modify, replace - is refused with TOP_DERIVED_READ_ONLY
 */
export const topologyGuard: DerivationGuard = {
  domain: 'topology',
  check(previous: CadDocument, next: CadDocument): string | null {
    for (const study of studiesIn(previous)) {
      const derived = study.derivedEntityId;
      if (derived === undefined || !Object.hasOwn(previous.entities, derived)) continue;
      const after = findStudy(next, study.id)?.study;
      const regenerated = after === undefined || after.derivedEntityId !== derived || after.result?.fieldHash !== study.result?.fieldHash;
      if (regenerated) {
        if (after === undefined && Object.hasOwn(next.entities, derived))
          return `TOP_DERIVED_READ_ONLY — study '${study.id}' was removed but its iso-surface '${derived}' remains; use delete_topology_study`;
        continue;
      }
      const before = previous.entities[derived];
      const now = Object.hasOwn(next.entities, derived) ? next.entities[derived] : undefined;
      if (now === undefined || (now !== before && canonicalJson(now) !== canonicalJson(before)))
        return `TOP_DERIVED_READ_ONLY — '${derived}' is the iso-surface of topology study '${study.id}' and is read-only; rebuild the part with suggest_rebuild and ordinary commands`;
    }
    return null;
  },
};

/** `derivedEntityId` of every study of a raw (unvalidated) document. */
function rawDerivedIds(raw: Record<string, unknown>): string[] {
  const analysis = raw['analysis'];
  const cases = isRecord(analysis) && isRecord(analysis['cases']) ? Object.values(analysis['cases']) : [];
  return cases.flatMap((analysisCase) =>
    isRecord(analysisCase) && isRecord(analysisCase['topology'])
      ? Object.values(analysisCase['topology']).flatMap((study) =>
          isRecord(study) && typeof study['derivedEntityId'] === 'string' ? [study['derivedEntityId']] : [],
        )
      : [],
  );
}

/**
 * The slice is definition data plus the derived iso-surface ids. The mesh is omitted from saved files and NOT restored on load (restore has
 * no artifact store; it only drops the omitted ids from the draw order and selection): the study keeps its recorded result and `derivedEntityId`, and the surface is derived again when `record_topology_result`
 * runs (replay_history) on a machine that holds the artifact.
 */
export const topologyDocument: DocumentExtension = {
  validate: topologyErrors,
  derivedEntityIds: (doc) =>
    new Set(studiesIn(doc).flatMap((study) => (study.derivedEntityId === undefined ? [] : [study.derivedEntityId]))),
  restore: (raw) => {
    const entities = isRecord(raw['entities']) ? raw['entities'] : {};
    const missing = new Set(rawDerivedIds(raw).filter((id) => !Object.hasOwn(entities, id)));
    if (missing.size === 0) return raw;
    const without = (value: unknown): unknown => (Array.isArray(value) ? value.filter((id) => !missing.has(String(id))) : value);
    return { ...raw, order: without(raw['order']), selection: without(raw['selection']) };
  },
};
