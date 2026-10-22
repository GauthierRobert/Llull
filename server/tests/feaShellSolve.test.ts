/**
 * Shell idealization (05 FEA-REST part 3) through the real Netgen (llull-mesh) + CalculiX 2.21: the expansion mapping of the .frd (ccx writes the shell results on
 * the expanded 3D nodes; llull maps them back to the 2D mesh nodes), the pressure sign on shells, the composite shell section on S8R and the frame of
 * its fibre stresses, and the *HEADING binding marker in the .frd. Closed forms (box plate 100 x 20, cantilever along x, clamped at x = 0):
 * - isotropic t = 2, E 70 GPa, nu 0.3, tip force 10 N: the tip deflection lies between the plate (E / (1 - nu^2)) and the beam value P L^3 / (3 E I)
 *   (measured 3.503 mm, beam 3.571 mm); the top fibre is in tension at the root (hogging);
 * - pressure 0.001 MPa on the top face pushes the plate down, on the bottom face up (q L^4 / (8 E I) = 0.268 mm, beam);
 * - [90/0/0/90] CFRP (E1 140, E2 10, G12 5 GPa, nu12 0.3, ply 0.25), tip force 1 N: classical laminate theory with My = 0 (narrow strip) gives at
 *   x = 50 the top-fibre stresses sigma_x = 5.694, sigma_y = -0.226 MPa (90-degree outer ply, GLOBAL frame) and u_z = -2.371 mm.
 * Skipped without llull-mesh or CalculiX.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { defaultFeArtifactStore } from '../src/fea/artifactStore';
import { FEA_TOOL_ENV, HAS_CCX, HAS_MESHER } from './feaTestSupport';

type Step = Record<string, unknown>;

const LENGTH = 100;
const WIDTH = 20;

let work = '';

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'llull-fea-shell-'));
  process.env['LLULL_FEA_CACHE'] = path.join(work, 'cache');
  setGeometryKernel(await createManifoldKernel());
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  rmSync(work, { recursive: true, force: true });
});

const dataOf = (json: Record<string, unknown>): Record<string, unknown> => (isRecord(json['data']) ? json['data'] : {});

class ShellCase {
  readonly docPath: string;
  analysisId = '';
  constructor(readonly name: string) {
    this.docPath = path.join(work, `${name}.llull.json`);
  }

  async cli(...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
    const out: string[] = [];
    const io: CliIo = {
      stdout: (text) => out.push(text),
      stderr: () => undefined,
      readStdin: () => Promise.resolve(''),
      env: { ...FEA_TOOL_ENV, LLULL_FEA_KEEP: '1' },
      prepareKernel: () => Promise.resolve(),
    };
    const code = await runCli([...argv, '--doc', this.docPath, '--json'], io);
    const parsed: unknown = JSON.parse(out.join('') || '{}');
    return { code, json: isRecord(parsed) ? parsed : {} };
  }

  /** Runs the plan, meshes and solves; returns the mesh, the results and the kept ccx job directory. */
  async solve(plan: Step[]): Promise<{ mesh: FeMeshArtifact; results: FeResultsArtifact; jobDirectory: string }> {
    const planPath = path.join(work, `${this.name}.plan.json`);
    writeFileSync(planPath, JSON.stringify(plan));
    const ran = await this.cli('run', planPath);
    expect(ran.code, String(ran.json['summary'])).toBe(EXIT_OK);
    this.analysisId = Object.keys(deserializeDocument(readFileSync(this.docPath, 'utf8')).analysis?.cases ?? {})[0] ?? '';
    const meshed = await this.cli('fea_mesh', `analysisId=${this.analysisId}`);
    expect(meshed.code, String(meshed.json['summary'])).toBe(EXIT_OK);
    const solved = await this.cli('fea_solve', `analysisId=${this.analysisId}`, 'timeoutS=300');
    expect(solved.code, String(solved.json['summary'])).toBe(EXIT_OK);
    const store = defaultFeArtifactStore();
    return {
      mesh: store.get(String(dataOf(meshed.json)['meshHash'])) as FeMeshArtifact,
      results: store.get(String(dataOf(solved.json)['resultsHash'])) as FeResultsArtifact,
      jobDirectory: String(dataOf(solved.json)['jobDirectory']),
    };
  }
}

function isotropicPlate(thickness: number, loads: Step[]): Step[] {
  return [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [LENGTH, WIDTH, thickness], position: [0, 0, 0], anchor: 'min' }, as: 'plate' },
    { command: 'create_material', params: { name: 'al', density: 0.0027 } },
    {
      command: 'add_material_model',
      params: {
        material: 'al',
        id: 'elastic',
        model: { kind: 'elastic_isotropic', E: { value: 70, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
        basis: 'company',
        source: { citation: 'test input' },
      },
    },
    { command: 'define_constitutive_set', params: { material: 'al', set: { id: 'set', elastic: 'elastic' }, makeDefault: true } },
    { command: 'assign_material', params: { materialName: 'al', entityIds: ['$plate'] } },
    { command: 'create_analysis', params: { name: 'shell', analysisType: 'static' }, as: 'an' },
    { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$plate', idealization: 'shell' } },
    clamp(thickness),
    ...loads,
    { command: 'set_mesh_controls', params: { analysisId: '$an', globalSize: 2.5, order: 2, elementFamily: 'shell_quad' } },
  ];
}

function clamp(thickness: number): Step {
  return {
    command: 'add_fea_constraint',
    params: { analysisId: '$an', name: 'fix', kind: 'fixed', target: { entityId: '$plate', facesNear: [[0, WIDTH / 2, thickness / 2]] } },
  };
}

const tipForce = (thickness: number, fz: number): Step => ({
  command: 'add_fea_load',
  params: {
    analysisId: '$an',
    name: 'tip',
    kind: 'force',
    vector: [0, 0, fz],
    target: { entityId: '$plate', facesNear: [[LENGTH, WIDTH / 2, thickness / 2]] },
  },
});

const pressure = (z: number, magnitude: number): Step => ({
  command: 'add_fea_load',
  params: {
    analysisId: '$an',
    name: 'p',
    kind: 'pressure',
    magnitude,
    target: { entityId: '$plate', facesNear: [[LENGTH / 2, WIDTH / 2, z]] },
  },
});

/** Field component of the mesh node nearest to (x, y) on the midsurface. */
function valueAt(mesh: FeMeshArtifact, results: FeResultsArtifact, field: string, component: string, x: number, y: number): number {
  let best = mesh.nodes[0];
  for (const node of mesh.nodes)
    if (best === undefined || Math.hypot(node[1] - x, node[2] - y) < Math.hypot(best[1] - x, best[2] - y)) best = node;
  const data = results.steps.at(-1)?.fields[field];
  const index = data?.components.indexOf(component) ?? -1;
  const value = best === undefined ? undefined : data?.values[String(best[0])]?.[index];
  if (value === undefined) throw new Error(`no ${field}.${component} at (${x}, ${y})`);
  return value;
}

const EI = (70000 * WIDTH * 2 ** 3) / 12;

describe.skipIf(!HAS_MESHER || !HAS_CCX)('shell solves (netgen + ccx 2.21)', () => {
  it('maps the expanded .frd back to the 2D nodes: plate cantilever deflection and fibre signs, *HEADING binding in the .frd', async () => {
    const shell = new ShellCase('iso-tip');
    const { mesh, results, jobDirectory } = await shell.solve(isotropicPlate(2, [tipForce(2, -10)]));
    expect(mesh.blocks[0]?.type).toBe('S8');
    const tip = valueAt(mesh, results, 'DISP', 'D3', LENGTH, WIDTH / 2);
    const beam = (10 * LENGTH ** 3) / (3 * EI);
    expect(-tip).toBeLessThan(beam * 1.005);
    expect(-tip).toBeGreaterThan(beam * (1 - 0.3 ** 2));
    // hogging: the top fibre is stretched along x, the bottom one compressed, and the membrane (mean) stress is about zero
    const top = valueAt(mesh, results, 'STRESS_TOP', 'SXX', LENGTH / 2, WIDTH / 2);
    const bottom = valueAt(mesh, results, 'STRESS_BOT', 'SXX', LENGTH / 2, WIDTH / 2);
    const sigma = (10 * (LENGTH / 2) * 1) / ((WIDTH * 2 ** 3) / 12);
    expect(top).toBeGreaterThan(sigma * 0.95);
    expect(top).toBeLessThan(sigma * 1.05);
    expect(bottom).toBeLessThan(-sigma * 0.95);
    expect(Math.abs(valueAt(mesh, results, 'STRESS', 'SXX', LENGTH / 2, WIDTH / 2))).toBeLessThan(sigma * 0.01);
    // ccx copies the *HEADING line into the .frd header (1U record), so a re-import of the solver's own file binds to the set-up
    const frd = path.join(jobDirectory, readdirSync(jobDirectory).find((file) => file.endsWith('.frd')) ?? 'job.frd');
    expect(readFileSync(frd, 'utf8')).toMatch(/^\s+1Ullull inputHash [0-9a-f]{16}/m);
    const imported = await shell.cli('fea_import_results', `analysisId=${shell.analysisId}`, 'format=frd', `file=${frd}`);
    expect(imported.code, String(imported.json['summary'])).toBe(EXIT_OK);
    expect(JSON.stringify(imported.json)).not.toContain('FEA_RESULTS_UNBOUND');
    rmSync(jobDirectory, { recursive: true, force: true });
  }, 300_000);

  it('applies a positive shell pressure into the material: the top face pushes the plate down, the bottom face up', async () => {
    const beam = (0.001 * WIDTH * LENGTH ** 4) / (8 * EI);
    for (const [name, z, sign] of [
      ['p-top', 2, -1],
      ['p-bottom', 0, 1],
    ] as const) {
      const { mesh, results, jobDirectory } = await new ShellCase(name).solve(isotropicPlate(2, [pressure(z, 0.001)]));
      const tip = valueAt(mesh, results, 'DISP', 'D3', LENGTH, WIDTH / 2);
      expect(Math.sign(tip), name).toBe(sign);
      expect(Math.abs(tip)).toBeLessThan(beam * 1.005);
      expect(Math.abs(tip)).toBeGreaterThan(beam * (1 - 0.3 ** 2));
      rmSync(jobDirectory, { recursive: true, force: true });
    }
  }, 300_000);

  it('solves a [90/0/0/90] composite shell on S8R; the fibre stresses are the outer plies in the GLOBAL frame (CLT within 1 %)', async () => {
    const plan: Step[] = [
      { command: 'set_units', params: { units: 'mm' } },
      { command: 'add_box', params: { size: [LENGTH, WIDTH, 1], position: [0, 0, 0], anchor: 'min' }, as: 'plate' },
      {
        command: 'create_lamina_material',
        params: {
          name: 'tape',
          form: 'ud_tape',
          E1: 140000,
          E2: 10000,
          G12: 5000,
          nu12: 0.3,
          G13: 5000,
          G23: 3500,
          plyThickness: 0.25,
          density: 0.0016,
          basis: 'mean',
          source: 'test input',
        },
      },
      { command: 'define_rosette', params: { name: 'R0', origin: [0, 0, 1], axis0: [1, 0, 0], normal: [0, 0, 1] } },
      {
        command: 'create_composite_part',
        params: {
          name: 'skin',
          toolSurface: { entityId: '$plate', faceNear: [50, 10, 1] },
          rosette: 'R0',
          laminateSide: 'positive_normal',
        },
        as: 'cp',
      },
      ...[90, 0, 0, 90].map((orientation, index) => ({
        command: 'add_ply',
        params: { part: 'skin', name: `P${index + 1}`, material: 'tape', orientation, boundary: { kind: 'whole_face' } },
      })),
      { command: 'create_analysis', params: { name: 'comp', analysisType: 'static' }, as: 'an' },
      {
        command: 'set_part_idealization',
        params: { analysisId: '$an', entityId: '$plate', idealization: 'shell', compositePartId: '$cp' },
      },
      clamp(1),
      tipForce(1, -1),
      { command: 'set_mesh_controls', params: { analysisId: '$an', globalSize: 2.5, order: 2, elementFamily: 'shell_quad' } },
    ];
    const { mesh, results, jobDirectory } = await new ShellCase('composite').solve(plan);
    expect(mesh.blocks[0]?.type).toBe('S8');
    const deck = readFileSync(path.join(jobDirectory, 'job.inp'), 'utf8');
    expect(deck).toContain('TYPE=S8R');
    expect(deck).toContain('*SHELL SECTION, ELSET=P_box_2_1, COMPOSITE');
    // CLT of the strip, My = 0: d = inverse(D), kappa = d M with M = P (L - x) / b, sigma = Qbar kappa z
    const q11 = 140000 / (1 - 0.3 * 0.3 * (10000 / 140000));
    const q22 = (10000 / 140000) * q11;
    const q12 = 0.3 * q22;
    const outer = (0.5 ** 3 - 0.25 ** 3) * (2 / 3);
    const inner = 0.25 ** 3 * (2 / 3);
    const d11 = outer * q22 + inner * q11;
    const d22 = outer * q11 + inner * q22;
    const d12 = q12 / 12;
    const det = d11 * d22 - d12 * d12;
    const x = 50;
    const moment = (LENGTH - x) / WIDTH;
    const kx = (d22 / det) * moment;
    const ky = (-d12 / det) * moment;
    const sigmaX = (q22 * kx + q12 * ky) * 0.5;
    const sigmaY = (q12 * kx + q11 * ky) * 0.5;
    const stiffness = WIDTH * (det / d22);
    const deflection = -(x * x * (3 * LENGTH - x)) / (6 * stiffness);
    expect(valueAt(mesh, results, 'STRESS_TOP', 'SXX', x, WIDTH / 2) / sigmaX - 1).toBeCloseTo(0, 2);
    expect(valueAt(mesh, results, 'STRESS_TOP', 'SYY', x, WIDTH / 2) / sigmaY - 1).toBeCloseTo(0, 1);
    expect(valueAt(mesh, results, 'STRESS_BOT', 'SXX', x, WIDTH / 2) / -sigmaX - 1).toBeCloseTo(0, 2);
    expect(valueAt(mesh, results, 'DISP', 'D3', x, WIDTH / 2) / deflection - 1).toBeCloseTo(0, 2);
    rmSync(jobDirectory, { recursive: true, force: true });
  }, 300_000);
});
