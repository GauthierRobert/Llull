/**
 * The FEA scenario of the performance gate: a 200 x 40 x 40 steel cantilever meshed with 47 040 C3D10 (68 121 nodes), clamped on x = 0 and
 * loaded on x = L, with a synthetic CalculiX result file (beam-theory displacement and stress fields) so the gate needs no solver.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeMeshArtifact } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import type { FeArtifactStore } from '../../src/fea/artifactStore';
import { caeHooks } from '../../src/fea/caeHooks';
import type { CcxRunner } from '../../src/fea/ccxProcess';
import { gridMesh } from '../../../tests/unit/cae/gridMesh';

const LENGTH = 200;
const SIDE = 40;
const CELLS = [40, 14, 14] as const;
const SOURCE = { citation: 'performance gate fixture', locator: 'server/tests/perf' };
/** CalculiX face labels of a tetrahedron by corner positions. */
const TET_FACES = [
  [0, 1, 2],
  [0, 3, 1],
  [1, 3, 2],
  [2, 3, 0],
] as const;

export interface FeaCase {
  readonly analysisId: string;
  readonly mesh: FeMeshArtifact;
  /** The document; `host.applyCommand` replaces it. */
  doc: CadDocument;
}

function must(
  doc: CadDocument,
  name: string,
  params: Record<string, unknown>,
  context?: ExecutionContext,
): { doc: CadDocument; id: string } {
  const result = context === undefined ? execute(doc, name, params) : execute(doc, name, params, context);
  if (result.rejected === true) throw new Error(`${name}: ${result.summary}`);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

/** The cantilever set-up and its mesh artifact (not stored, not recorded). */
export function buildFeaCase(): FeaCase {
  let doc = createEmptyDocument();
  const box = must(doc, 'add_box', { size: [LENGTH, SIDE, SIDE], position: [LENGTH / 2, SIDE / 2, SIDE / 2] });
  doc = must(box.doc, 'create_material', { name: 'steel', density: 0.00785, color: '#999999', metalness: 1, roughness: 0.4 }).doc;
  doc = must(doc, 'add_material_model', {
    material: 'steel',
    id: 'elastic',
    model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
    basis: 'unspecified',
    source: SOURCE,
  }).doc;
  doc = must(doc, 'define_constitutive_set', { material: 'steel', set: { id: 'linear', elastic: 'elastic' }, makeDefault: true }).doc;
  doc = must(doc, 'assign_material', { materialName: 'steel', entityIds: [box.id] }).doc;
  const analysis = must(doc, 'create_analysis', { name: 'cantilever', analysisType: 'static' });
  doc = must(analysis.doc, 'set_part_idealization', { analysisId: analysis.id, entityId: box.id }).doc;
  const clamp = must(doc, 'add_fea_constraint', {
    analysisId: analysis.id,
    name: 'clamp',
    kind: 'fixed',
    target: { entityId: box.id, facesNear: [[0, SIDE / 2, SIDE / 2]] },
  });
  const load = must(clamp.doc, 'add_fea_load', {
    analysisId: analysis.id,
    name: 'tip',
    kind: 'force',
    vector: [0, 0, -1000],
    target: { entityId: box.id, facesNear: [[LENGTH, SIDE / 2, SIDE / 2]] },
  });
  const probe = must(load.doc, 'add_result_probe', {
    analysisId: analysis.id,
    name: 'tip deflection',
    point: [LENGTH, SIDE / 2, SIDE / 2],
    quantity: 'u_z',
  });
  doc = probe.doc;

  const grid = gridMesh({ cells: CELLS, size: [LENGTH, SIDE, SIDE], quadratic: true });
  const x = new Map(grid.nodes.map((node) => [node[0], node[1]]));
  const nodesAt = (plane: number): number[] => grid.nodes.filter((node) => node[1] === plane).map((node) => node[0]);
  const facesAt = (plane: number): [number, number][] => {
    const faces: [number, number][] = [];
    grid.elements.forEach((element, index) =>
      TET_FACES.forEach((face, label) => {
        if (face.every((corner) => x.get(element[corner] ?? -1) === plane)) faces.push([index + 1, label + 1]);
      }),
    );
    return faces;
  };
  const tip = grid.nodes.find((node) => node[1] === LENGTH && node[2] === SIDE / 2 && node[3] === SIDE / 2) ?? grid.nodes[0];
  const mesh: FeMeshArtifact = {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'perf-fixture',
    mesherVersion: '1',
    inputHash: caeHooks.analysisInputHash(doc, analysis.id, 'mesh'),
    nodes: grid.nodes,
    blocks: [{ type: 'C3D10', entityId: box.id, elements: grid.elements.map((element, index) => [index + 1, ...element]) }],
    nodeSets: { [`C_${clamp.id}`]: nodesAt(0), [`L_${load.id}`]: nodesAt(LENGTH), [`P_${probe.id}`]: [tip?.[0] ?? 1] },
    faceSets: { [`C_${clamp.id}`]: facesAt(0), [`L_${load.id}`]: facesAt(LENGTH) },
    targets: {},
  };
  return { analysisId: analysis.id, mesh, doc };
}

/** A FRD value cell: 12 characters, `-1.31024E-19` style. */
function cell(value: number): string {
  const [mantissa = '0', exponent = '0'] = value.toExponential(5).split('e');
  const power = Number(exponent);
  return `${mantissa}E${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`.padStart(12, ' ');
}

/** The `.frd` text CalculiX would write for the mesh: DISP and STRESS of an end-loaded cantilever (Euler-Bernoulli, P = 1000 N). */
export function syntheticFrd(mesh: FeMeshArtifact): string {
  const inertia = SIDE ** 4 / 12;
  const load = 1000;
  const young = 210_000;
  const lines: string[] = ['    1C', '    1UPGM               CalculiX', '    1UVERSION           Version 2.21'];
  const block = (name: string, components: readonly string[], row: (xyz: readonly [number, number, number]) => number[]): void => {
    lines.push('    1PSTEP                         1           1           1');
    lines.push(`  100CL  101 1.000000000${String(mesh.nodes.length).padStart(12, ' ')}                     0    1           1`);
    lines.push(` -4  ${name.padEnd(8, ' ')}${String(components.length).padStart(5, ' ')}    1`);
    components.forEach((component, index) =>
      lines.push(` -5  ${component.padEnd(8, ' ')}    1    2${String(index + 1).padStart(5, ' ')}    0`),
    );
    for (const [id, x, y, z] of mesh.nodes) lines.push(` -1${String(id).padStart(10, ' ')}${row([x, y, z]).map(cell).join('')}`);
    lines.push(' -3');
  };
  block('DISP', ['D1', 'D2', 'D3'], ([x, , z]) => {
    const slope = (load * x * (2 * LENGTH - x)) / (2 * young * inertia);
    return [slope * (z - SIDE / 2), 0, (-load * x * x * (3 * LENGTH - x)) / (6 * young * inertia)];
  });
  block('STRESS', ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], ([x, , z]) => [
    (load * (LENGTH - x) * (z - SIDE / 2)) / inertia,
    0,
    0,
    0,
    0,
    (-load * (SIDE * SIDE - (2 * z - SIDE) ** 2)) / (8 * inertia),
  ]);
  lines.push(' 9999');
  return `${lines.join('\n')}\n`;
}

/** A solver stand-in: writes `frd` as the result file of the job at once. */
export function instantSolver(frd: string): CcxRunner {
  return {
    run: async (jobDirectory, jobName) => {
      await writeFile(path.join(jobDirectory, `${jobName}.frd`), frd);
      return { exitCode: 0, log: '', timedOut: false };
    },
    version: () => Promise.resolve('2.21'),
  };
}

/** The execution context of a host that owns `store`. */
export const contextOf = (store: FeArtifactStore): ExecutionContext => ({ ...defaultContext(), feaArtifacts: store });

/** The host of the FE transports over `feaCase` (commands run with `store` as the artifact port). */
export function hostOf(feaCase: FeaCase, store: FeArtifactStore): FeaHost {
  return {
    getDoc: () => feaCase.doc,
    applyCommand: (name, params) => {
      const result = execute(feaCase.doc, name, params, contextOf(store));
      feaCase.doc = result.document;
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true };
    },
  };
}
