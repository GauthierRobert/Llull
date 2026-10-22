/** Input and settings hashes of a topology study (TR-TOP-07): equal hashes <=> the same optimisation problem. */

import type { TopologySettings, TopologyStudy } from '@core/model/topology';
import type { CadDocument, Entity } from '@core/model/types';
import { geometryKey } from '@core/geometry/shapeRecipe';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { elasticConstants, isElasticRefusal, ROOM_TEMPERATURE_K } from '../decks/elastic';
import { caseOf } from '../shared/access';

const geometryHashes = new WeakMap<Entity, string>();

function geometryHash(entity: Entity): string {
  let hash = geometryHashes.get(entity);
  if (hash === undefined) {
    hash = sha256Hex(geometryKey(entity));
    geometryHashes.set(entity, hash);
  }
  return hash;
}

/** Hash of the solver settings (values only: sources and `defaulted` flags are provenance, not input). */
export function topologySettingsHash(settings: TopologySettings): string {
  const { penal, eminRatio, move, changeTol, maxIterations, filter, threshold, optimizer, projection } = settings;
  return sha256Hex(
    canonicalJson({
      penal: penal.value,
      eminRatio: eminRatio.value,
      move: move.value,
      changeTol: changeTol.value,
      maxIterations: maxIterations.value,
      filter: { kind: filter.kind, radius: filter.radius.value },
      threshold: threshold.value,
      optimizer,
      // absent when the study does not project, so hashes of earlier studies are unchanged
      ...(projection === undefined
        ? {}
        : {
            projection: {
              beta: projection.beta.value,
              eta: projection.eta.value,
              betaStart: projection.betaStart.value,
              betaEvery: projection.betaEvery.value,
            },
          }),
    }),
  );
}

function domainInputs(doc: CadDocument, study: TopologyStudy): unknown[] {
  const analysisCase = caseOf(doc, study.analysisId);
  return study.designDomain.map((entityId) => {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    const material =
      entity?.materialId !== undefined && Object.hasOwn(doc.materials, entity.materialId) ? doc.materials[entity.materialId] : undefined;
    const elastic = material === undefined ? null : elasticConstants(material, entity?.materialId ?? '', ROOM_TEMPERATURE_K);
    return {
      entityId,
      geometry: entity === undefined ? null : geometryHash(entity),
      materialId: entity?.materialId ?? null,
      elastic: elastic === null ? null : isElasticRefusal(elastic) ? elastic.code : { E: elastic.E, nu: elastic.nu },
      idealization: analysisCase !== undefined && Object.hasOwn(analysisCase.parts, entityId) ? analysisCase.parts[entityId] : null,
    };
  });
}

/**
 * Hash of what a solve reads: the design domain (geometry, material E / nu, idealization), the study definition without its settings, the
 * case's constraints and loads (names excluded), the unit system and the document unit.
 * @failure unknown study -> '' (never equal to an artifact's inputHash, so it reads as stale)
 */
export function topologyInputHash(doc: CadDocument, study: TopologyStudy): string {
  const analysisCase = caseOf(doc, study.analysisId);
  if (analysisCase === undefined) return '';
  const strip = <T extends { readonly name: string }>(record: T): Omit<T, 'name'> => {
    const { name, ...rest } = record;
    void name;
    return rest;
  };
  return sha256Hex(
    canonicalJson({
      scope: 'topology',
      documentUnit: doc.units,
      unitSystem: analysisCase.unitSystem,
      domain: domainInputs(doc, study),
      study: {
        dimension: study.dimension,
        plane: study.plane ?? null,
        voxel: study.voxel,
        volumeFraction: study.volumeFraction,
        objective: study.objective,
        keepIn: study.keepIn,
        keepOut: study.keepOut,
        manufacturing: study.manufacturing,
        protectLoadSupport: study.settings.protectLoadSupport.value,
      },
      constraints: analysisCase.constraintOrder.flatMap((id) => {
        const constraint = analysisCase.constraints[id];
        return constraint === undefined ? [] : [strip(constraint)];
      }),
      loads: analysisCase.loadOrder.flatMap((id) => {
        const load = analysisCase.loads[id];
        return load === undefined ? [] : [strip(load)];
      }),
    }),
  );
}
