/**
 * TypeScript reference outputs the native crates must reproduce bit for bit (RS1 §2 rule 4): this suite recomputes them from the TS code and
 * compares with the committed JSON fixtures that `cargo test` reads (solver/crates/<crate>/tests/fixtures). A TS change that moves a
 * reference number fails here; regenerate with LLULL_WRITE_NATIVE_FIXTURES=1 and the Rust tests then say whether the port still agrees.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import { isEvaluationFailure } from '@cae/fatigue/evaluate';
import { fatigueFieldInput, fatigueFieldReference } from '@cae/fatigue/feField';
import { countCycles, type CountingMethod, type ResidueRule } from '@cae/fatigue/rainflow';
import { mapNodalField } from '@cae/thermomech/mapping';
import { feFatigue } from '../cae/fatigue/feFixtures';
import { gridMesh, seeded } from '../cae/gridMesh';

const SOLVER = path.resolve(__dirname, '../../../solver/crates');
const WRITE = process.env['LLULL_WRITE_NATIVE_FIXTURES'] === '1';

function fixture(relative: string, value: unknown): void {
  const file = path.join(SOLVER, relative);
  const text = `${JSON.stringify(value)}\n`;
  if (WRITE) writeFileSync(file, text);
  expect(readFileSync(file, 'utf8') === text, `${relative} is out of date: run with LLULL_WRITE_NATIVE_FIXTURES=1`).toBe(true);
}

function jsmathCases(): Record<string, number[][]> {
  const random = seeded(2026);
  const pow: number[][] = [];
  const log10: number[][] = [];
  const hypot: number[][] = [];
  const round: number[][] = [];
  for (let i = 0; i < 300; i += 1) {
    const x = random() * 3000 + 1e-4;
    const y = (random() - 0.7) * 3;
    const e = random() * 40 - 20;
    pow.push([x, y, x ** y], [10, e, 10 ** e], [x / 1000, 1 / (y - 3.1), (x / 1000) ** (1 / (y - 3.1))]);
    log10.push([x, Math.log10(x)], [x * 1e-9, Math.log10(x * 1e-9)]);
    const [a, b, c] = [(random() - 0.5) * 1e3, (random() - 0.5) * 1e-2, random() * 7];
    hypot.push([a, b, c, Math.hypot(a, b, c)]);
    round.push([a * 3.7, Math.round(a * 3.7)]);
  }
  pow.push(
    [-8, 3, (-8) ** 3],
    [2, 0.5, 2 ** 0.5],
    [1e-310, 0.5, 1e-310 ** 0.5],
    [3, -1100, 3 ** -1100],
    [1.0000001, 1e9, 1.0000001 ** 1e9],
  );
  log10.push([5e-324, Math.log10(5e-324)], [1, 0]);
  round.push([0.49999999999999994, 0], [-2.5, -2], [2.5, 3]);
  return { pow, log10, hypot, round };
}

function rainflowCases(): unknown[] {
  const random = seeded(17);
  const series = [
    [-2, 1, -3, 5, -1, 3, -4, 4, -2],
    [0, 1, 1, 2, 0, 0, -3, 4, -3],
    Array.from({ length: 300 }, () => Math.round((random() - 0.5) * 200) / 4),
    Array.from({ length: 500 }, () => (random() - 0.4) * 300),
  ];
  const rules: Array<[CountingMethod, ResidueRule, number]> = [
    ['rainflow_3pt', 'half_cycles', 0],
    ['rainflow_4pt', 'half_cycles', 0],
    ['rainflow_3pt', 'repeat', 0],
    ['rainflow_repeating', 'half_cycles', 0],
    ['rainflow_3pt', 'half_cycles', 30],
    ['rainflow_4pt', 'half_cycles', 12.5],
  ];
  return series.flatMap((values) =>
    rules.map(([method, residue, gate]) => ({
      series: values,
      method,
      residue,
      gate,
      cycles: countCycles(values, method, residue, gate).map((cycle) => [cycle.from, cycle.to, cycle.range, cycle.mean, cycle.count]),
    })),
  );
}

function fatigueJobCases(): unknown[] {
  const variants: Array<[string, Record<string, unknown>]> = [
    ['basquin_goodman_signed_von_mises', {}],
    ['basquin_gerber_formula', { meanStress: 'gerber', factors: { scatter: { value: 3, source: 't' }, compressiveMean: 'formula' } }],
    ['basquin_walker_repeat', { meanStress: { walker: 0.6 }, counting: { method: 'rainflow_3pt', residue: 'repeat' } }],
    [
      'basquin_morrow_modifiers',
      {
        meanStress: 'morrow',
        factors: { scatter: { value: 3, source: 't' }, modifiers: [{ name: 'surface', value: 0.8, justification: 't' }] },
      },
    ],
    [
      'power_law_notch_component',
      { material: { recordId: 'steel', modelId: 'sn2' }, measure: { component: 'sxy' }, notch: { kt: 2, q: 0.9, feIncludesKt: false } },
    ],
    [
      'table_soderberg_4pt_gate',
      {
        material: { recordId: 'steel', modelId: 'sn3' },
        meanStress: 'soderberg',
        counting: { method: 'rainflow_4pt', residue: 'half_cycles', gate: 5 },
      },
    ],
    [
      'strain_swt_max_principal',
      {
        method: 'strain_life',
        material: { recordId: 'steel', modelId: 'en1', cyclicModelId: 'ro1' },
        meanStress: 'swt',
        measure: 'max_principal',
      },
    ],
    [
      'strain_morrow_neuber',
      {
        method: 'strain_life',
        material: { recordId: 'steel', modelId: 'en1', cyclicModelId: 'ro1' },
        meanStress: 'morrow',
        notch: { kt: 2.4, q: 0.98, feIncludesKt: false },
      },
    ],
  ];
  return variants.map(([name, caseParams]) => {
    const local = feFatigue({ cells: [3, 2, 1], steps: 60, seed: name.length, caseParams });
    const input = fatigueFieldInput(local.doc, local.caseId, local.store);
    if (isEvaluationFailure(input)) throw new Error(`${name}: ${input.message}`);
    return { name, job: input.job, tensors: Array.from(input.tensors), field: Array.from(fatigueFieldReference(input)) };
  });
}

const asMesh = (grid: ReturnType<typeof gridMesh>): FeMeshArtifact => ({
  kind: 'fe_mesh',
  unitSystem: 'N-mm-t-s',
  mesher: 'test',
  mesherVersion: '1',
  inputHash: '',
  nodes: grid.nodes,
  blocks: [
    {
      type: grid.elements[0]?.length === 10 ? 'C3D10' : 'C3D4',
      entityId: 'p',
      elements: grid.elements.map((nodes, i) => [i + 1, ...nodes]),
    },
  ],
  nodeSets: {},
  faceSets: {},
  targets: {},
});

function mapCases(): unknown[] {
  const value = ([, x, y, z]: readonly number[]): number =>
    20 + 80 * Math.sin((x ?? 0) * 1.3) * Math.cos((y ?? 0) * 0.7) + 5 * (z ?? 0) ** 2;
  const cases: Array<[string, ReturnType<typeof gridMesh>, ReturnType<typeof gridMesh>]> = [
    [
      'linear_offset_target',
      gridMesh({ cells: [4, 3, 2], size: [4, 3, 2] }),
      gridMesh({ cells: [5, 4, 3], size: [4.4, 3.2, 2.2], origin: [-0.2, -0.1, -0.1] }),
    ],
    ['quadratic_source', gridMesh({ cells: [3, 2, 2], size: [3, 2, 2], quadratic: true }), gridMesh({ cells: [6, 4, 3], size: [3, 2, 2] })],
    [
      'coincident_nodes',
      gridMesh({ cells: [2, 2, 2], size: [1, 1, 1] }),
      gridMesh({ cells: [4, 4, 4], size: [1, 1, 1], firstNodeId: 1000 }),
    ],
  ];
  return cases.map(([name, source, target]) => {
    const sourceValues = new Map(source.nodes.map((node) => [node[0], value(node)] as [number, number]));
    const mapped = mapNodalField(asMesh(source), sourceValues, asMesh(target));
    if (!mapped.ok) throw new Error(mapped.message);
    return {
      name,
      sourceNodes: source.nodes,
      sourceElements: source.elements,
      sourceValues: [...sourceValues.entries()],
      targetNodes: target.nodes,
      values: mapped.values,
      elements: mapped.elements,
      distances: mapped.distances,
      report: mapped.report,
    };
  });
}

describe('native reference fixtures (TS = oracle)', () => {
  it('V8 Math samples for llull-jsmath', () => fixture('llull-jsmath/tests/fixtures/jsmath.json', jsmathCases()));
  it('rainflow cycles for llull-post', () => fixture('llull-post/tests/fixtures/rainflow.json', rainflowCases()));
  it('all-node fatigue fields for llull-post (VC-FAT-43 at crate level)', () =>
    fixture('llull-post/tests/fixtures/fatigue_jobs.json', fatigueJobCases()));
  it('mesh mappings for llull-post (VC-TMC-10 at crate level)', () => fixture('llull-post/tests/fixtures/map.json', mapCases()));
});
