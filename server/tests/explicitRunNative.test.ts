/**
 * explicit_run end to end with the real `llull-compute` (cargo build --profile compute -p llull-compute in solver/); skipped with a logged reason
 * when it is absent. VC-EXP-67 (bar plan): the 10 x 10 x 200 mm steel-like bar of exp_bar_rigid_wall at 10 m/s on a rigid wall, set up through
 * commands with a structured 2.5 mm hex mesh: wall force plateau rho c0 v A = 39 623 N and contact 2L/c0 = 79.2 us within the pack's 3 %
 * (VC-EXP-50), normal termination, energy error < 2 %, recorded through record_explicit_results and read back by explicit_report; two runs give the
 * same artifact hash (AF-13).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExplicitResultsSummary, FeExplicitArtifact } from '@core/model/explicit';
import type { FeaHost } from '@protocol/index';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { runExplicitRun } from '../src/native/explicitRun';
import { barModel, must, replayPlan } from '../../tests/unit/cae/explicit/support';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('explicitRunNative: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): skipped');
const native = BINARY === null ? it.skip : it;

let dir = '';
let store: FeArtifactCache;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-explicit-native-'));
  store = createFeArtifactStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const C0 = Math.sqrt(200_000 / 7.85e-9);
const FORCE = 7.85e-9 * C0 * 10_000 * 100;
const DURATION = 400 / C0;

describe('explicit_run with the real llull-compute', () => {
  native(
    'bar on a rigid wall matches rho c0 v and 2L/c0 (VC-EXP-67 / VC-EXP-50) and is deterministic',
    async () => {
      const model = barModel({ size: 2.5 });
      const solveOnce = async (): Promise<{ hash: string; doc: ReturnType<FeaHost['getDoc']> }> => {
        let doc = model.doc;
        const host: FeaHost = {
          getDoc: () => doc,
          applyCommand: (name, params) => {
            const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
            if (result.rejected !== true) doc = result.document;
            return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
          },
        };
        const lines: string[] = [];
        const result = await runExplicitRun(model.analysisId, { timeoutS: 300 }, host, {
          store,
          runner: createComputeRunner({}, BINARY),
          onProgress: (line) => lines.push(line),
        });
        expect(result.isError, result.summary).toBe(false);
        expect(lines.length).toBeGreaterThan(10);
        return { hash: (result.data as { artifactHash: string }).artifactHash, doc };
      };
      const first = await solveOnce();
      const artifact = store.get(first.hash) as FeExplicitArtifact;
      expect(artifact.termination).toBe('normal');
      expect(artifact.solver).toMatchObject({ name: 'llull-explicit', device: 'cpu', deterministic: true });
      expect(artifact.elements).toEqual({ hex8: 4 * 4 * 80, tet4: 0, shell4: 0 });
      const wall = artifact.walls[0];
      if (wall === undefined) throw new Error('no wall history');
      const peak = Math.max(...wall.force);
      const on = wall.force.map((force, index) => (force > 0.01 * peak ? index : -1)).filter((index) => index >= 0);
      const start = (on[0] ?? 0) === 0 ? 0 : (wall.t[(on[0] ?? 1) - 1] ?? 0);
      const end = wall.t[on[on.length - 1] ?? 0] ?? 0;
      const window = on.filter(
        (index) => (wall.t[index] ?? 0) > start + 0.15 * (end - start) && (wall.t[index] ?? 0) < start + 0.85 * (end - start),
      );
      const plateau = window.reduce((sum, index) => sum + (wall.force[index] ?? 0), 0) / window.length;
      expect(Math.abs(plateau / FORCE - 1)).toBeLessThan(0.03);
      expect(Math.abs((end - start) / DURATION - 1)).toBeLessThan(0.03);
      const summary = first.doc.analysis?.cases[model.analysisId]?.explicit?.results as ExplicitResultsSummary;
      expect(summary.artifactHash).toBe(first.hash);
      expect(Math.abs(summary.energy.errorMaxAbs)).toBeLessThan(0.02);
      expect(summary.walls['anvil']?.impulse).toBeGreaterThan(0);
      const report = execute(first.doc, 'explicit_report', { analysisId: model.analysisId }, { ...defaultContext(), feaArtifacts: store });
      expect((report.data as { state: string }).state).toBe('solved');
      const second = await solveOnce();
      expect(second.hash).toBe(first.hash);
    },
    300_000,
  );
  native(
    'Johnson-Cook failure erodes the elements at the wall and the summary counts them (RS-8b, TR-EXP-21)',
    async () => {
      const model = barModel({ plastic: true, size: 5 });
      let doc = execute(model.doc, 'set_initial_velocity', {
        analysisId: model.analysisId,
        entityId: model.barId,
        velocity: { vector: [0, 0, -100], unit: 'm/s' },
      }).document;
      doc = execute(doc, 'set_johnson_cook_failure', {
        analysisId: model.analysisId,
        material: 'steel_like',
        D: [0.05, 0, 0, 0, 0],
        source: 'synthetic test input (failure at eps_p = 0.05), not a material claim',
      }).document;
      const host: FeaHost = {
        getDoc: () => doc,
        applyCommand: (name, params) => {
          const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
          if (result.rejected !== true) doc = result.document;
          return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
        },
      };
      const result = await runExplicitRun(model.analysisId, { timeoutS: 300 }, host, { store, runner: createComputeRunner({}, BINARY) });
      expect(result.isError, result.summary).toBe(false);
      const summary = doc.analysis?.cases[model.analysisId]?.explicit?.results as ExplicitResultsSummary;
      expect(summary.failedElements).toBeGreaterThan(0);
      expect(summary.maxPlasticStrain.value).toBeGreaterThanOrEqual(0.05);
      expect(summary.maxPlasticStrain.at[2]).toBeLessThan(20);
    },
    300_000,
  );
  native(
    'device gpu runs the wgpu kernels (or falls back with EXP_GPU_FALLBACK) and matches the CPU twin (RS-8b)',
    async () => {
      const model = barModel({ size: 2.5 });
      const solve = async (device: 'cpu' | 'gpu'): Promise<{ hash: string; warnings: string }> => {
        let doc = model.doc;
        const host: FeaHost = {
          getDoc: () => doc,
          applyCommand: (name, params) => {
            const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
            if (result.rejected !== true) doc = result.document;
            return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
          },
        };
        const result = await runExplicitRun(model.analysisId, { timeoutS: 300, device }, host, {
          store,
          runner: createComputeRunner({}, BINARY),
        });
        expect(result.isError, result.summary).toBe(false);
        const data = result.data as { artifactHash: string; warnings?: { code: string }[] };
        return { hash: data.artifactHash, warnings: (data.warnings ?? []).map((warning) => warning.code).join(',') };
      };
      const cpu = store.get((await solve('cpu')).hash) as FeExplicitArtifact;
      const first = await solve('gpu');
      const gpu = store.get(first.hash) as FeExplicitArtifact;
      if (first.warnings.includes('EXP_GPU_FALLBACK')) {
        console.warn('explicitRunNative: llull-compute without GPU kernels or without a SHADER_F64 adapter: the CPU twin ran');
        expect(gpu.solver.device).toBe('cpu');
        return;
      }
      expect(gpu.solver).toMatchObject({ device: 'gpu', deterministic: true });
      const cpuForce = cpu.walls[0]?.force ?? [];
      const peak = Math.max(...cpuForce);
      const gap = Math.max(...(gpu.walls[0]?.force ?? []).map((force, index) => Math.abs(force - (cpuForce[index] ?? 0)) / peak));
      expect(gap).toBeLessThan(1e-7);
      expect((await solve('gpu')).hash).toBe(first.hash);
    },
    300_000,
  );
  native(
    'drop-test template on the own solver: first contact at sqrt(2h/g) and kinetic energy m g h before it (VC-EXP-51 / 67b)',
    async () => {
      const { doc: start, aliases } = replayPlan('exp_drop_box_llull');
      const analysisId = aliases['an'] ?? '';
      let doc = start;
      const host: FeaHost = {
        getDoc: () => doc,
        applyCommand: (name, params) => {
          const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
          if (result.rejected !== true) doc = result.document;
          return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
        },
      };
      const result = await runExplicitRun(analysisId, { timeoutS: 600 }, host, { store, runner: createComputeRunner({}, BINARY) });
      expect(result.isError, result.summary).toBe(false);
      const artifact = store.get((result.data as { artifactHash: string }).artifactHash) as FeExplicitArtifact;
      expect(artifact.termination).toBe('normal');
      const wall = artifact.walls[0];
      if (wall === undefined) throw new Error('no floor history');
      const first = wall.force.findIndex((force) => force > 0);
      const contact = Math.sqrt((2 * 1200) / 9806.65);
      expect(Math.abs((wall.t[first] ?? 0) - contact)).toBeLessThan(0.005 * contact);
      const before = artifact.energy.filter((row) => row.t < contact - 0.001).at(-1);
      if (before === undefined) throw new Error('no energy row');
      const mass = 2.7e-9 * 50 ** 3;
      const expected = 0.5 * mass * (9806.65 * before.t) ** 2;
      expect(Math.abs(before.kinetic / expected - 1)).toBeLessThan(0.005);
      expect(Math.abs(before.externalWork / expected - 1)).toBeLessThan(0.005);
    },
    600_000,
  );
  native(
    'two boxes colliding through add_contact transmit rho c0 v / 2 into the struck bar (RS-8c, through commands)',
    async () => {
      const model = barModel({ size: 2.5 });
      // Bar B on top of the bar of the model, 0.5 mm above it; the wall goes, bar A keeps its -10 m/s, B starts at rest.
      const box = must(model.doc, 'add_box', { size: [10, 10, 200], position: [0, 0, -200.5], anchor: 'min' });
      const struck = box.affected[0] ?? '';
      let doc = must(box.document, 'assign_material', { materialName: 'steel_like', entityIds: [struck] }).document;
      doc = must(doc, 'set_part_idealization', { analysisId: model.analysisId, entityId: struck }).document;
      doc = must(doc, 'delete_rigid_wall', { analysisId: model.analysisId, wallId: model.wallId }).document;
      const c0 = Math.sqrt(200_000 / 7.85e-9);
      const end = 0.5 / 10_000 + 200 / c0;
      doc = must(doc, 'set_explicit_controls', {
        analysisId: model.analysisId,
        endTime: { value: end, unit: 's' },
        historyInterval: { value: 1e-6, unit: 's' },
        mesh: { kind: 'structured_hex', size: 2.5 },
      }).document;
      doc = must(doc, 'add_contact', {
        analysisId: model.analysisId,
        name: 'impact',
        kind: 'surface_to_surface',
        a: [model.barId],
        b: [struck],
      }).document;
      const host: FeaHost = {
        getDoc: () => doc,
        applyCommand: (name, params) => {
          const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
          if (result.rejected !== true) doc = result.document;
          return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
        },
      };
      const result = await runExplicitRun(model.analysisId, { timeoutS: 600 }, host, { store, runner: createComputeRunner({}, BINARY) });
      expect(result.isError, result.summary).toBe(false);
      const artifact = store.get((result.data as { artifactHash: string }).artifactHash) as FeExplicitArtifact;
      // Stresses in the struck bar (z < -0.5): the plateau half a contact time after impact.
      const struckStress = artifact.vonMises.filter((_, element) => (artifact.centroids[3 * element + 2] ?? 0) < -0.5);
      const plateau =
        struckStress.filter((value) => value > 50).reduce((sum, value) => sum + value, 0) /
        struckStress.filter((value) => value > 50).length;
      const expected = (7.85e-9 * c0 * 10_000) / 2;
      expect(Math.abs(plateau / expected - 1)).toBeLessThan(0.1);
      const summary = doc.analysis?.cases[model.analysisId]?.explicit?.results as ExplicitResultsSummary;
      expect(Math.abs(summary.energy.errorMaxAbs)).toBeLessThan(0.03);
    },
    600_000,
  );
  native(
    'a shell plate falling flat on the rigid floor gives the wall an impulse m v (Belytschko-Tsay shells, RS-8c)',
    async () => {
      const { doc: start, aliases } = replayPlan('exp_shell_plate_llull');
      const analysisId = aliases['an'] ?? '';
      let doc = start;
      const host: FeaHost = {
        getDoc: () => doc,
        applyCommand: (name, params) => {
          const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
          if (result.rejected !== true) doc = result.document;
          return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
        },
      };
      const result = await runExplicitRun(analysisId, { timeoutS: 600 }, host, { store, runner: createComputeRunner({}, BINARY) });
      expect(result.isError, result.summary).toBe(false);
      const summary = doc.analysis?.cases[analysisId]?.explicit?.results as ExplicitResultsSummary;
      expect(summary.elements).toEqual({ hex8: 0, tet4: 0, shell4: 25 });
      const mass = 7.85e-9 * 50 * 50 * 2;
      expect(Math.abs((summary.walls['floor']?.impulse ?? 0) / (mass * 1000) - 1)).toBeLessThan(0.02);
    },
    600_000,
  );
});
