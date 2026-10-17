import { describe, expect, it } from 'vitest';
import { analysisInputHash, meshRequest } from '@cae/index';
import { keyedTargets } from '@cae/hash/targets';
import type { AnalysisCase, ThermalSetup } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { caseIn, modelWithAnalysis, run } from './helpers';

const patchCase = (doc: CadDocument, analysisId: string, patch: Partial<AnalysisCase>): CadDocument => ({
  ...doc,
  analysis: { ...doc.analysis!, cases: { ...doc.analysis!.cases, [analysisId]: { ...caseIn(doc, analysisId), ...patch } } },
});

const hashes = (doc: CadDocument, id: string): { mesh: string; full: string } => ({
  mesh: analysisInputHash(doc, id, 'mesh'),
  full: analysisInputHash(doc, id, 'full'),
});

describe('analysisInputHash', () => {
  it('is deterministic, hex sha256, and empty for an unknown analysis', () => {
    const { doc, analysisId } = modelWithAnalysis();
    expect(hashes(doc, analysisId)).toEqual(hashes(doc, analysisId));
    expect(hashes(doc, analysisId).mesh).toMatch(/^[0-9a-f]{64}$/);
    expect(analysisInputHash(doc, 'nope', 'full')).toBe('');
  });

  it('ignores names and recorded summaries', () => {
    const { doc, analysisId } = modelWithAnalysis();
    const before = hashes(doc, analysisId);
    const renamed = patchCase(doc, analysisId, { name: 'other' });
    expect(hashes(renamed, analysisId)).toEqual(before);
  });

  it('mesh scope follows controls, targets and geometry; load values only change the full scope', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const before = hashes(doc, analysisId);
    const target = { entityId: boxId, facesNear: [[5, 5, 10]] };
    const load = run(doc, 'add_fea_load', { analysisId, name: 'tip', kind: 'force', vector: [0, 0, -500], target });
    const afterLoad = hashes(load.document, analysisId);
    expect(afterLoad.full).not.toBe(before.full);
    expect(afterLoad.mesh).not.toBe(before.mesh); // a new target adds node/face sets to the mesh
    const stronger = run(load.document, 'update_fea_load', { analysisId, loadId: load.affected[0], vector: [0, 0, -900] });
    const afterStronger = hashes(stronger.document, analysisId);
    expect(afterStronger.full).not.toBe(afterLoad.full);
    expect(afterStronger.mesh).toBe(afterLoad.mesh);
    const finer = run(load.document, 'set_mesh_controls', { analysisId, globalSize: 1 });
    expect(hashes(finer.document, analysisId).mesh).not.toBe(afterLoad.mesh);
    const moved = run(load.document, 'move_entities', { ids: [boxId], delta: [5, 0, 0] });
    expect(hashes(moved.document, analysisId).mesh).not.toBe(afterLoad.mesh);
  });

  it('full scope follows materials (with their models), probes, factors and the thermal setups', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis('thermo_static', { referenceTemperature: { value: 20, unit: 'degC' } });
    const before = hashes(doc, analysisId).full;
    const material = run(doc, 'create_material', { name: 'steel', density: 0.00785, color: '#b0b0b0', metalness: 1, roughness: 0.5 });
    const assigned = run(material.document, 'assign_material', { entityIds: [boxId], materialName: 'steel' });
    const withMaterial = hashes(assigned.document, analysisId).full;
    expect(withMaterial).not.toBe(before);
    const model = run(assigned.document, 'define_property_model', {
      material: 'steel',
      model: {
        id: 'k1',
        property: 'k',
        unit: 'W/(m*K)',
        variables: [{ variable: 'T', unit: 'K' }],
        form: { kind: 'constant', value: 50 },
        validity: [{ variable: 'T', unit: 'K', data: [250, 400], equation: [200, 500] }],
        basis: 'typical',
        source: { citation: 'test' },
      },
    });
    expect(model.rejected).not.toBe(true);
    expect(hashes(model.document, analysisId).full).not.toBe(withMaterial);
    const probe = run(assigned.document, 'add_result_probe', { analysisId, name: 'p', point: [1, 1, 1], quantity: 'u_mag' });
    expect(hashes(probe.document, analysisId).full).not.toBe(withMaterial);
    const tweaked = patchCase(assigned.document, analysisId, {
      thermomech: { ...caseIn(assigned.document, analysisId).thermomech!, referenceTemperature: { value: 25, unit: 'degC' } },
    });
    expect(hashes(tweaked, analysisId).full).not.toBe(withMaterial);
    expect(hashes(tweaked, analysisId).mesh).toBe(hashes(assigned.document, analysisId).mesh);
    const missingMaterial = patchCase(assigned.document, analysisId, {});
    expect(hashes(missingMaterial, analysisId)).toEqual(hashes(assigned.document, analysisId));
    const dangling = { ...assigned.document, materials: {} };
    expect(hashes(dangling, analysisId).full).not.toBe(withMaterial);
  });

  it('a thermo-mechanical case becomes stale when the thermal source is re-solved', () => {
    const { doc, analysisId } = modelWithAnalysis('thermo_static', { referenceTemperature: { value: 20, unit: 'degC' } });
    const heat = run(doc, 'create_analysis', { name: 'h', analysisType: 'heat_steady' });
    const heatId = heat.affected[0] ?? '';
    const field = { kind: 'thermal_result' as const, analysisId: heatId, time: 'last' as const, mapping: 'same_mesh' as const };
    const linked = patchCase(heat.document, analysisId, { thermomech: { ...caseIn(heat.document, analysisId).thermomech!, field } });
    const first = hashes(linked, analysisId).full;
    const resultsOf = (resultsHash: string): Partial<AnalysisCase> => ({
      results: { resultsHash, inputHash: 'x', solver: 'ccx', solverVersion: '2', loadCases: [], units: 'N-mm-t-s' },
    });
    const solved = patchCase(linked, heatId, resultsOf('r1'));
    const second = hashes(solved, analysisId).full;
    const resolved = patchCase(solved, heatId, resultsOf('r2'));
    expect(second).not.toBe(first);
    expect(hashes(resolved, analysisId).full).not.toBe(second);
  });
});

describe('keyedTargets / meshRequest', () => {
  it('keys constraints, loads, thermal BCs, refinements, probes and limits', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis('heat_steady');
    const target = { entityId: boxId, facesNear: [[5, 5, 0]] as const };
    const thermal: ThermalSetup = {
      ...caseIn(doc, analysisId).thermal!,
      bcOrder: ['tb-1.1', 'tb-1.2'],
      bcs: {
        'tb-1.1': { id: 'tb-1.1', name: 't', bc: { kind: 'temperature', value: { value: 20, unit: 'degC' }, target } },
        'tb-1.2': {
          id: 'tb-1.2',
          name: 'g',
          bc: { kind: 'heat_generation', value: { value: 5, unit: 'W' }, mode: 'total', entityId: boxId },
        },
      },
      limitOrder: ['tl-1.1', 'tl-1.2'],
      limits: {
        'tl-1.1': { id: 'tl-1.1', name: 'a', scope: { target }, max: { value: 80, unit: 'degC' }, source: { citation: 'ds' } },
        'tl-1.2': { id: 'tl-1.2', name: 'b', scope: { entityId: boxId }, max: { value: 80, unit: 'degC' }, source: { citation: 'ds' } },
      },
    };
    let current = patchCase(doc, analysisId, { thermal });
    current = run(current, 'add_fea_constraint', {
      analysisId,
      name: 'c',
      kind: 'fixed',
      target: { entityId: boxId, facesNear: [[0, 0, 0]] },
    }).document;
    const load = run(current, 'add_fea_load', { analysisId, name: 'g', kind: 'gravity', vector: [0, 0, -1] });
    current = load.document;
    current = run(current, 'set_mesh_controls', {
      analysisId,
      refinements: [{ target: { entityId: boxId, edgesNear: [[0, 0, 0]] }, size: 1 }],
    }).document;
    const probe = run(current, 'add_result_probe', { analysisId, name: 'p', point: [1, 2, 3], quantity: 'temperature' });
    current = probe.document;
    const keys = keyedTargets(caseIn(current, analysisId)).map((t) => t.key);
    const constraintId = caseIn(current, analysisId).constraintOrder[0];
    expect(keys).toEqual([`C_${constraintId}`, 'B_tb-1.1', 'R_0', `P_${probe.affected[0]}`, 'T_tl-1.1']);
    const request = meshRequest(current, analysisId);
    if ('code' in request) throw new Error(request.message);
    expect(request.entityIds).toEqual([boxId]);
    expect(request.unitSystem).toBe('N-mm-t-s');
    expect(request.documentUnit).toBe('mm');
    expect(request.lengthToAnalysis).toBe(1);
    expect(request.inputHash).toBe(analysisInputHash(current, analysisId, 'mesh'));
    expect(request.targets.find((t) => t.key.startsWith('P_'))).toMatchObject({ entityId: null, pointsNear: [[1, 2, 3]] });
    expect(request.controls.refinements).toHaveLength(1);
  });

  it('keys the thermal BCs of a coupled thermo-mechanical setup', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis('thermo_static', { referenceTemperature: { value: 20, unit: 'degC' } });
    const target = { entityId: boxId, facesNear: [[5, 5, 0]] as const };
    const base = caseIn(doc, analysisId);
    const coupled = patchCase(doc, analysisId, {
      thermomech: {
        ...base.thermomech!,
        thermal: {
          temperatureScale: 'degC',
          bcs: { 'tb-9.1': { id: 'tb-9.1', name: 't', bc: { kind: 'temperature', value: { value: 1, unit: 'degC' }, target } } },
          bcOrder: ['tb-9.1'],
          amplitudes: {},
          cavities: {},
          contacts: {},
          step: {},
          limits: {},
          limitOrder: [],
          dispositions: {},
        },
      },
    });
    expect(keyedTargets(caseIn(coupled, analysisId)).map((t) => t.key)).toEqual(['B_tb-9.1']);
  });

  it('scales document units to the analysis length unit and refuses unusable requests', () => {
    const scaled = (units: CadDocument['units']): number => {
      const { doc, analysisId } = modelWithAnalysis();
      const request = meshRequest({ ...doc, units }, analysisId);
      if ('code' in request) throw new Error(request.message);
      return request.lengthToAnalysis;
    };
    // the case keeps N-mm-t-s (created in mm), so a cm / m / in document is scaled to mm
    expect(scaled('cm')).toBeCloseTo(10);
    expect(scaled('m')).toBeCloseTo(1000);
    expect(scaled('in')).toBeCloseTo(25.4);
    const { doc, analysisId } = modelWithAnalysis();
    expect(meshRequest(doc, 'nope')).toMatchObject({ code: 'FEA_ANALYSIS_NOT_FOUND' });
    const noPart = patchCase(doc, analysisId, { parts: {} });
    expect(meshRequest(noPart, analysisId)).toMatchObject({ code: 'FEA_PART_INVALID' });
    const metre = run({ ...doc, units: 'm' }, 'create_analysis', { name: 'm', analysisType: 'static' });
    const metreId = metre.affected[0] ?? '';
    // the box is 10 document units wide whatever the label: a coarse mesh keeps the request under the element cap
    const withPart = patchCase(metre.document, metreId, {
      parts: { [Object.keys(caseIn(doc, analysisId).parts)[0] ?? '']: { kind: 'solid' } },
      mesh: { ...caseIn(metre.document, metreId).mesh, globalSize: 5 },
    });
    const request = meshRequest(withPart, metreId);
    if ('code' in request) throw new Error(request.message);
    expect(request).toMatchObject({ unitSystem: 'N-m-kg-s', lengthToAnalysis: 1 });
    const inches = run({ ...withPart, units: 'in' }, 'create_analysis', { name: 'i', analysisType: 'static' });
    const inchId = inches.affected[0] ?? '';
    const inchRequest = meshRequest(
      patchCase(inches.document, inchId, {
        parts: caseIn(withPart, metreId).parts,
        mesh: { ...caseIn(inches.document, inchId).mesh, globalSize: 5 },
      }),
      inchId,
    );
    if ('code' in inchRequest) throw new Error(inchRequest.message);
    expect(inchRequest.lengthToAnalysis).toBe(1);
  });
});
