/**
 * fatigue_field / fea_map_field transports (RS1 RS-7) end to end with the real `llull-compute` when it is built (cargo build --release in
 * solver/), else skipped with a logged reason; the missing-binary paths always run. VC-FAT-43 / VC-TMC-10: native vs TypeScript reference.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { FeaHost } from '@mcp/index';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary } from '@cae/results/summary';
import { resolveTemperatureField, temperatureMappingRequest } from '@cae/thermomech/field';
import { mapNodalField } from '@cae/thermomech/mapping';
import type { MappingRequest } from '@cae/thermomech/mappedField';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { createComputeRunner } from '../src/native/computeJob';
import { runFatigueField } from '../src/native/fatigueField';
import { nativeMappingStep, runMapField } from '../src/native/mapField';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { isNativeTool, runNativeTool } from '../src/native/tools';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { feFatigue } from '../../tests/unit/cae/fatigue/feFixtures';
import { gridMesh } from '../../tests/unit/cae/gridMesh';
import { thermoFixture, withThermalSource } from '../../tests/unit/cae/thermomech/fixtures';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('nativeTransports: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;

let dir = '';
let store: FeArtifactCache;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-native-store-'));
  store = createFeArtifactStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function hostOf(doc: CadDocument): FeaHost {
  return {
    getDoc: () => doc,
    applyCommand: (name, params) => {
      const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
    },
  };
}

type Json = Record<string, unknown>;

describe('fatigue_field', () => {
  function fixtureInStore(seed: number): ReturnType<typeof feFatigue> {
    const fixture = feFatigue({ cells: [6, 3, 3], steps: 200, seed });
    store.put(fixture.mesh);
    store.put(fixture.results);
    return fixture;
  }

  it('without the binary answers NATIVE_TOOL_MISSING and compute_fatigue keeps refusing the FE case', async () => {
    const fixture = fixtureInStore(1);
    const result = await runFatigueField(fixture.caseId, {}, hostOf(fixture.doc), { store, runner: createComputeRunner({}, null) });
    expect(result).toMatchObject({ isError: true, data: { code: 'NATIVE_TOOL_MISSING' } });
    expect(result.summary).toContain('FAT_RESULTS_MISSING');
    expect(hostOf(fixture.doc).applyCommand('compute_fatigue', { caseId: fixture.caseId }).summary).toContain('FAT_RESULTS_MISSING');
    const unknown = await runFatigueField('nope', {}, hostOf(fixture.doc), { store, runner: createComputeRunner({}, null) });
    expect(unknown).toMatchObject({ isError: true, data: { code: 'FAT_CASE_NOT_FOUND' } });
  });

  native('damages every node natively, bit-identical to the TypeScript reference (VC-FAT-43), then ranks hot spots', async () => {
    const fixture = fixtureInStore(2);
    const runner = createComputeRunner({}, BINARY);
    const result = await runFatigueField(fixture.caseId, { verify: true }, hostOf(fixture.doc), { store, runner });
    expect(result.isError).toBe(false);
    const data = result.data as Json;
    expect(data).toMatchObject({
      nodes: 112,
      engine: 'native-cpu',
      deterministic: true,
      verification: { identical: true, largestRelativeDifference: 0 },
    });
    const rows = (data['computeFatigue'] as Json)['rows'] as Json[];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row['damagePerBlock']).toBe(row['nativeDamagePerBlock']);
    const again = await runFatigueField(fixture.caseId, {}, hostOf(fixture.doc), { store, runner });
    expect((again.data as Json)['fieldHash']).toBe(data['fieldHash']);
    const viaCli = await runNativeTool('fatigue_field', { caseId: fixture.caseId, timeoutS: 60 }, hostOf(fixture.doc), { store, runner });
    expect(viaCli).toMatchObject({ isError: false, changed: false });
  });
});

const asMesh = (grid: ReturnType<typeof gridMesh>, entityId: string, inputHash = ''): FeMeshArtifact => ({
  kind: 'fe_mesh',
  unitSystem: 'N-mm-t-s',
  mesher: 'test',
  mesherVersion: '1',
  inputHash,
  nodes: grid.nodes,
  blocks: [{ type: 'C3D4', entityId, elements: grid.elements.map((nodes, i) => [i + 1, ...nodes]) }],
  nodeSets: {},
  faceSets: {},
  targets: {},
});

describe('fea_map_field', () => {
  function mappedCase(): { doc: CadDocument; analysisId: string; target: FeMeshArtifact; thermal: [FeMeshArtifact, FeResultsArtifact] } {
    const base = thermoFixture();
    const source = withThermalSource(base, { mesh: asMesh(gridMesh({ cells: [6, 5, 4], size: [10, 10, 10] }), base.boxId) });
    store.put(source.thermalMesh);
    store.put(source.results as FeResultsArtifact);
    const { analysisId } = base;
    let doc = execute(source.fixture.doc, 'set_temperature_field', {
      analysisId,
      source: { kind: 'thermal_result', analysisId: source.thermalId, time: 'last', mapping: 'interpolate' },
    }).document;
    const target = asMesh(
      gridMesh({ cells: [9, 7, 6], size: [10.4, 10.2, 10.2], origin: [-0.2, -0.1, -0.1], firstNodeId: 5000 }),
      base.boxId,
      analysisInputHash(doc, analysisId, 'mesh'),
    );
    const targetHash = store.put(target);
    doc = execute(
      doc,
      'record_fe_mesh',
      { analysisId, summary: meshSummary(target, targetHash) },
      { ...defaultContext(), feaArtifacts: store },
    ).document;
    return { doc, analysisId, target, thermal: [source.thermalMesh, source.results] };
  }

  it('refuses without the binary, without an interpolate field and for unknown analyses', async () => {
    const { doc, analysisId } = mappedCase();
    const missing = await runMapField(analysisId, {}, hostOf(doc), { store, runner: createComputeRunner({}, null) });
    expect(missing).toMatchObject({ isError: true, data: { code: 'NATIVE_TOOL_MISSING' } });
    const uniform = execute(doc, 'set_temperature_field', {
      analysisId,
      source: { kind: 'uniform', value: { value: 50, unit: 'degC' } },
    }).document;
    const none = await runMapField(analysisId, {}, hostOf(uniform), { store, runner: createComputeRunner({}, null) });
    expect(none).toMatchObject({ isError: true, data: { code: expect.stringMatching(/TMC_FIELD_SOURCE_INVALID|FEA_MESH_STALE/) } });
    expect((await runMapField('nope', {}, hostOf(doc), { store, runner: createComputeRunner({}, null) })).isError).toBe(true);
    expect(isNativeTool('fea_map_field')).toBe(true);
    expect(await runNativeTool('export_step', {}, hostOf(doc))).toBeNull();
    expect(await runNativeTool('fea_map_field', {}, hostOf(doc))).toMatchObject({ isError: true });
    expect(await runNativeTool('fatigue_field', {}, hostOf(doc))).toMatchObject({ isError: true });
    const skip = nativeMappingStep({ store, runner: createComputeRunner({}, null) }, {});
    expect(await skip(doc, analysisId, mappedCase().target)).toBeNull();
  });

  native('maps natively with the same element, distance and temperature per node as the TypeScript mapping (VC-TMC-10)', async () => {
    const { doc, analysisId, target } = mappedCase();
    const runner = createComputeRunner({}, BINARY);
    const request = temperatureMappingRequest(doc, analysisId, target, store) as MappingRequest;
    const reference = mapNodalField(request.source, request.values, target);
    if (!reference.ok) throw new Error(reference.message);
    const result = await runMapField(analysisId, {}, hostOf(doc), { store, runner });
    expect(result.isError).toBe(false);
    expect((result.data as Json)['report']).toEqual(reference.report);
    const stored = store.get(request.key);
    const rows = stored?.kind === 'fe_results' ? stored.steps[0]?.fields['MAPPED']?.values : undefined;
    target.nodes.forEach(([id], index) =>
      expect(rows?.[String(id)]).toEqual([reference.values[index], reference.elements[index], reference.distances[index]]),
    );
    const field = resolveTemperatureField(doc, analysisId, target, store);
    expect(field.ok && field.description).toContain('native llull-compute post map');
    expect(field.ok && field.values).toEqual(reference.values);
    const cached = await runMapField(analysisId, {}, hostOf(doc), { store, runner });
    expect(cached).toMatchObject({ isError: false, data: { cached: true } });
    const step = nativeMappingStep({ store, runner }, { LLULL_NATIVE_MAP_MIN_NODES: '0' });
    expect(await step(doc, analysisId, target)).toBeNull();
  });

  native('fea_solve pre-step maps a fresh request natively from the node threshold', async () => {
    const { doc, analysisId, target, thermal } = mappedCase();
    const fresh = createFeArtifactStore(mkdtempSync(path.join(dir, 'fresh-')));
    for (const artifact of [target, ...thermal]) fresh.put(artifact);
    const runner = createComputeRunner({}, BINARY);
    const high = nativeMappingStep({ store: fresh, runner }, { LLULL_NATIVE_MAP_MIN_NODES: '1000000' });
    expect(await high(doc, analysisId, target)).toBeNull();
    const step = nativeMappingStep({ store: fresh, runner }, { LLULL_NATIVE_MAP_MIN_NODES: '0' });
    expect(await step(doc, analysisId, target)).toMatch(/mapped natively/);
    const field = resolveTemperatureField(doc, analysisId, target, fresh);
    expect(field.ok && field.description).toContain('native');
  });
});

describe('llull CLI', () => {
  it('describes the native transports and runs them on a local document', async () => {
    const out: string[] = [];
    const io: CliIo = {
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
    };
    const file = path.join(dir, 'cli.llull.json');
    expect(await runCli(['new', '--doc', file], io)).toBe(EXIT_OK);
    expect(await runCli(['fatigue_field', 'caseId=nope', '--doc', file], io)).toBe(EXIT_COMMAND_ERROR);
    expect(out.join('\n')).toContain('FAT_CASE_NOT_FOUND');
    expect(await runCli(['describe', 'fea_map_field'], io)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('llull-compute');
  });
});
