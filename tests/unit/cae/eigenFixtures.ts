/**
 * Modal / buckling fixtures: eigenvalue tables in the layout CalculiX 2.21 writes to the `.dat` of `*FREQUENCY` / `*BUCKLE` steps (headings spaced out
 * by the solver; eigenvalue and buckling-factor tables as in beamf.dat.ref / beamb.dat.ref of the CalculiX test suite; the mass tables follow the same
 * layout, hand-built here), a structured tetrahedral bar and the helpers that record mesh and results through the commands.
 */
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseDat } from '@cae/results/datReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { barDocument, barMesh, hashOf, portOf, X0_NODES, type Bar } from './deckFixtures';
import { gridMesh } from './gridMesh';

const EIGEN_HEAD = `
     E I G E N V A L U E   O U T P U T

 MODE NO    EIGENVALUE                       FREQUENCY
                                     REAL PART            IMAGINARY PART
                           (RAD/TIME)      (CYCLES/TIME     (RAD/TIME)
`;

/** ccx (arpack.f) prints six components per row: x / y / z translation, then x / y / z rotation (zero here: the bar fixtures are translational). */
const ROTATIONS = [0, 0, 0] as const;

const row = (mode: number, ...values: number[]): string =>
  `${String(mode).padStart(7)}${values.map((value) => value.toExponential(7).toUpperCase().padStart(16)).join('')}`;

/** Modal `.dat` text: frequencies in Hz (rad/s derived), optional participation factors and effective modal masses per mode, optional total mass. */
export function modalDat(
  frequencies: readonly number[],
  participation?: readonly (readonly [number, number, number])[],
  effective?: readonly (readonly [number, number, number])[],
  total?: readonly [number, number, number],
): string {
  const lines = [EIGEN_HEAD];
  frequencies.forEach((hz, index) => {
    const omega = 2 * Math.PI * hz;
    lines.push(row(index + 1, omega * omega, omega, hz, 0));
  });
  if (participation !== undefined) {
    lines.push(
      '',
      '     P A R T I C I P A T I O N   F A C T O R S',
      '',
      ' MODE NO.       X-COMPONENT       Y-COMPONENT       Z-COMPONENT       X-ROTATION        Y-ROTATION        Z-ROTATION',
      '',
    );
    participation.forEach((values, index) => lines.push(row(index + 1, ...values, ...ROTATIONS)));
  }
  if (effective !== undefined) {
    lines.push(
      '',
      '     E F F E C T I V E   M O D A L   M A S S',
      '',
      ' MODE NO.       X-COMPONENT       Y-COMPONENT       Z-COMPONENT       X-ROTATION        Y-ROTATION        Z-ROTATION',
      '',
    );
    effective.forEach((values, index) => lines.push(row(index + 1, ...values, ...ROTATIONS)));
  }
  if (total !== undefined)
    lines.push(
      '',
      '     T O T A L   E F F E C T I V E   M A S S',
      '',
      `${' '.repeat(7)}${[...total, ...ROTATIONS].map((value) => value.toExponential(7).toUpperCase().padStart(16)).join('')}`,
    );
  return `${lines.join('\n')}\n`;
}

/** Buckling `.dat` text: one factor per mode. */
export const bucklingDat = (factors: readonly number[]): string =>
  [
    '',
    '     B U C K L I N G   F A C T O R   O U T P U T',
    '',
    ' MODE NO       BUCKLING',
    '                FACTOR',
    '',
    ...factors.map((factor, index) => row(index + 1, factor)),
    '',
  ].join('\n');

export interface EigenCase {
  readonly bar: Bar;
  readonly doc: CadDocument;
  readonly mesh: FeMeshArtifact;
  readonly meshHash: string;
  readonly ctx: ExecutionContext;
  /** Document with the mesh recorded (and the results when `dat` was given). */
  readonly recorded: CadDocument;
  readonly port: FeArtifactPort;
  /** The results artifact (null when no `dat` was given). */
  readonly results: FeResultsArtifact | null;
}

export interface EigenOptions {
  readonly type: 'modal' | 'buckling';
  /** face (default): x = 0 face fixed; point: node 1 fixed (3 of 6 rigid-body motions); none: free. */
  readonly support?: 'face' | 'point' | 'none';
  readonly load?: boolean;
  /** Fine structured mesh (768 tets, about 3 edges across the thinnest side) instead of the 6-tet bar. */
  readonly fine?: boolean;
  readonly dat?: string;
}

/** A modal / buckling bar with its mesh recorded; the results too when `options.dat` is given. */
export function eigenCase(options: EigenOptions): EigenCase {
  const bar = barDocument({ analysisType: options.type, supports: false });
  let doc = bar.doc;
  const support = options.support ?? 'face';
  const sets: Record<string, number[]> = {};
  let nodes: FeMeshArtifact['nodes'];
  let elements: number[][];
  if (options.fine === true) {
    const grid = gridMesh({ cells: [8, 4, 4], size: [2, 1, 1] });
    nodes = grid.nodes;
    elements = grid.elements.map((tet, index) => [index + 1, ...tet]);
  } else {
    const probe = barMesh(doc, bar.analysisId, bar.boxId, {});
    nodes = probe.nodes;
    elements = probe.blocks[0]?.elements.map((element) => [...element]) ?? [];
  }
  if (support !== 'none') {
    const fixed = execute(doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'fix',
      kind: 'fixed',
      target: { entityId: bar.boxId, ...(support === 'face' ? { facesNear: [[0, 0.5, 0.5]] } : { pointsNear: [[0, 0, 0]] }) },
    });
    doc = fixed.document;
    const face = options.fine === true ? nodes.filter((node) => node[1] === 0).map((node) => node[0]) : X0_NODES;
    sets[`C_${fixed.affected[0]}`] = support === 'point' ? [1] : face;
  }
  if (options.load === true) {
    const load = execute(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'P',
      kind: 'force',
      vector: [-100, 0, 0],
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    doc = load.document;
    sets[`L_${load.affected[0]}`] = nodes.filter((node) => node[1] === 2).map((node) => node[0]);
  }
  const mesh: FeMeshArtifact = {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, bar.analysisId, 'mesh'),
    nodes,
    blocks: [{ type: 'C3D4', entityId: bar.boxId, elements }],
    nodeSets: sets,
    faceSets: {},
    targets: {},
  };
  const meshHash = hashOf(mesh);
  const results: FeResultsArtifact | null =
    options.dat === undefined
      ? null
      : {
          kind: 'fe_results',
          meshHash,
          inputHash: analysisInputHash(doc, bar.analysisId, 'full'),
          solver: 'calculix',
          solverVersion: '2.21',
          steps: [{ step: 1, time: 1, fields: {} }],
          dat: parseDat(options.dat),
        };
  const port = results === null ? portOf(mesh) : portOf(mesh, results);
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: port };
  let recorded = mustRunWith(doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(mesh, meshHash) }, ctx);
  if (results !== null)
    recorded = mustRunWith(
      recorded,
      'record_fea_results',
      { analysisId: bar.analysisId, summary: resultsSummary(doc, bar.analysisId, mesh, results, hashOf(results)) },
      ctx,
    );
  return { bar, doc, mesh, meshHash, ctx, recorded, port, results };
}

function mustRunWith(doc: CadDocument, command: string, params: Record<string, unknown>, ctx: ExecutionContext): CadDocument {
  const result = execute(doc, command, params, ctx);
  if (result.rejected === true) throw new Error(`${command}: ${result.summary}`);
  return result.document;
}
