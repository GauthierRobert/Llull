/** A hand-solved two-film case (VC-THM-01 values) recorded into a document, for the report / check / limit / disposition tests. */
import type { FeArtifactPort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import {
  addBc,
  hashOf,
  portOf,
  recorded,
  resultsFor,
  thermalFixture,
  twoTetMesh,
  type FixtureOptions,
  type ThermalFixture,
} from './fixtures';

/** VC-THM-01 analytic hot-face temperature: 200 - q / h1 with q = 180 / (1/50 + 0.05/15 + 1/10). */
export const HOT_T = 200 - 180 / (1 / 50 + 0.05 / 15 + 1 / 10) / 50;
const AREA_HALF = 0.5;
const AREA_COLD = Math.sqrt(3) / 2;
/** Face (1,2,3) of tet A (area 1/2) and face (3,5,4) of tet B (area sqrt(3)/2). */
const HOT_FACE: readonly [number, number][] = [[1, 1]];
const COLD_FACE: readonly [number, number][] = [[2, 3]];

/** What `solvedWall` takes from a set-up callback: the edited document and any node sets the mesh must carry. */
interface Prepared {
  readonly doc: CadDocument;
  readonly nodeSets?: Record<string, readonly number[]>;
}

export interface SolvedWall extends ThermalFixture {
  readonly hotId: string;
  readonly coldId: string;
  readonly mesh: ReturnType<typeof twoTetMesh>;
  readonly results: ReturnType<typeof resultsFor>;
  readonly resultsHash: string;
  readonly port: FeArtifactPort;
  /** Document with the mesh and results recorded. */
  readonly solved: CadDocument;
}

/**
 * Films 50 W/(m2 K) / 200 degC and 10 W/(m2 K) / 20 degC on two faces of the two-tet mesh; node temperatures chosen so that the film flows
 * cancel exactly (steady, no other path): hot face at HOT_T, cold-face nodes solved from the balance. `imbalance` scales the cold film flow; `peak` overrides the temperature of node 5; `prepare` edits the set-up before it is solved (limits enter the input hash).
 */
export function solvedWall(
  options: FixtureOptions = {},
  imbalance = 1,
  peak?: number,
  prepare?: (fixture: ThermalFixture) => Prepared,
): SolvedWall {
  const base = thermalFixture(options);
  const source = { citation: 'test input of VC-THM-01' };
  const hot = addBc(base, {
    name: 'hot_film',
    kind: 'film',
    filmCoefficient: { value: 50, unit: 'W/(m^2*K)' },
    sinkTemperature: { value: 200, unit: 'degC' },
    source,
    target: { entityId: base.boxId, facesNear: [[0.5, 0.5, 0]] },
  });
  const cold = addBc(
    { ...base, doc: hot.doc },
    {
      name: 'cold_film',
      kind: 'film',
      filmCoefficient: { value: 10, unit: 'W/(m^2*K)' },
      sinkTemperature: { value: 20, unit: 'degC' },
      source,
      target: { entityId: base.boxId, facesNear: [[0.5, 0.5, 0.05]] },
    },
  );
  const prepared = prepare === undefined ? { doc: cold.doc } : prepare({ ...base, doc: cold.doc });
  const fixture: ThermalFixture = { ...base, doc: prepared.doc };
  const mesh = twoTetMesh(fixture, {
    nodeSets: prepared.nodeSets ?? {},
    faceSets: { [`B_${hot.id}`]: HOT_FACE, [`B_${cold.id}`]: COLD_FACE },
  });
  const flow = 50 * AREA_HALF * (200 - HOT_T) * imbalance;
  const coldMean = 20 + flow / (10 * AREA_COLD);
  const coldNode = (3 * coldMean - HOT_T) / 2;
  const results = resultsFor(fixture, mesh, [{ time: 1, temperature: { 1: HOT_T, 2: HOT_T, 3: HOT_T, 4: coldNode, 5: peak ?? coldNode } }]);
  const solved = recorded(fixture, mesh, results);
  return { ...fixture, hotId: hot.id, coldId: cold.id, mesh, results, resultsHash: hashOf(results), port: portOf(mesh, results), solved };
}
