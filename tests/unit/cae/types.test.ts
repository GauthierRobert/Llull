import { describe, expect, it } from 'vitest';
import type {
  Amplitude,
  CavityRadiation,
  Decision,
  Disposition,
  FeElementType,
  FeMeshArtifact,
  FeResultsArtifact,
  FeSolver,
  FitDispositions,
  Idealization,
  MeshSummary,
  Named,
  QualitySummary,
  ResultsSummary,
  TableRef,
  TemperatureFieldSource,
  TemperatureLimit,
  ThermalBc,
  ThermalBcRecord,
  ThermalContact,
  ThermalResultsSummary,
  ThermalStep,
} from '@core/model/analysis';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';

/** Compile-time contract of the shared FE data shapes (the lanes build on them) plus JSON-serialisability. */
const target = { entityId: 'box-1.1', facesNear: [[0, 0, 0]] as const };
const q = (value: number, unit: string): { value: number; unit: string } => ({ value, unit });

describe('analysis data shapes', () => {
  it('thermal set-up types accept the PHY-03 vocabulary and survive a JSON round trip', () => {
    const table: TableRef = { csvSha256: 'ab', rows: 3 };
    const bcs: ThermalBc[] = [
      { kind: 'temperature', value: q(20, 'degC'), target },
      { kind: 'surface_flux', value: q(100, 'W/m^2'), target },
      { kind: 'heat_generation', value: q(5, 'W'), mode: 'total', entityId: 'box-1.1' },
      { kind: 'concentrated_flux', value: q(1, 'W'), target },
      { kind: 'film', filmCoefficient: { table }, sinkTemperature: q(20, 'degC'), target },
      { kind: 'radiation', emissivity: { fromProperty: 'emissivityIr' }, sinkTemperature: q(4, 'K'), target },
    ];
    const record: ThermalBcRecord = { id: 'tb-1.1', name: 'film', bc: bcs[4]!, amplitude: 'am-1.1', source: { citation: 'x' } };
    const amplitude: Amplitude = {
      id: 'am-1.1',
      name: 'a',
      points: [
        [0, 0],
        [1, 1],
      ],
      generatedFrom: { kind: 'ramp', params: { rate: 1 } },
    };
    const cavity: CavityRadiation = {
      id: 'cv-1.1',
      name: 'C1',
      environment: { kind: 'open', temperature: q(3, 'K') },
      faces: [{ target, emissivity: 0.8 }],
    };
    const contact: ThermalContact = { id: 'tc-1.1', name: 'c', master: target, slave: target, conductance: q(1000, 'W/(m^2*K)') };
    const step: ThermalStep = { endTimeS: 10, initialIncrementS: 1, fixedIncrements: false, outputTimesS: [5, 10] };
    const limit: TemperatureLimit = {
      id: 'tl-1.1',
      name: 'max',
      scope: { entityId: 'box-1.1' },
      max: q(80, 'degC'),
      source: { citation: 'ds' },
    };
    const disposition: Disposition = {
      decision: 'accepted' satisfies Decision,
      justification: 'ok',
      resultsHash: 'r',
      signer: 's',
      signatureId: 'i',
    };
    const all = { bcs, record, amplitude, cavity, contact, step, limit, disposition };
    expect(JSON.parse(JSON.stringify(all))).toEqual(all);
  });

  it('result, mesh and artifact shapes are plain JSON and hash stably', () => {
    const quality: QualitySummary = { metrics: { sjac: { min: 0.2, max: 1, p01: 0.3, p99: 1, outsideAcceptable: 0 } }, inverted: 0 };
    const mesh: MeshSummary = {
      meshHash: 'm',
      inputHash: 'i',
      mesher: 'netgen',
      mesherVersion: '4.15.2',
      nodes: 4,
      elements: { C3D4: 1 },
      quality,
      warnings: [],
      faceMap: [],
    };
    const constants: { stefanBoltzmann: Named; absoluteZero: Named } = {
      stefanBoltzmann: { value: 5.670374419e-8, unit: 'W/(m^2*K^4)', source: 'CODATA 2018', defaulted: true },
      absoluteZero: { value: -273.15, unit: 'degC', source: 'definition', defaulted: true },
    };
    const thermal: ThermalResultsSummary = {
      temperatureScale: 'degC',
      times: [0],
      maxT: { value: 80, at: [0, 0, 0], entityId: 'box-1.1', timeS: 0 },
      minT: { value: 20, at: [1, 0, 0], entityId: 'box-1.1', timeS: 0 },
      maxHeatFluxW_m2: { value: 1, at: [0, 0, 0], timeS: 0 },
      bcHeatFlowsW: [],
      heatBalance: { inW: 1, outW: 1, storedW: 0, residualRel: 0, timeS: 0 },
      probes: [],
      propertyRangeExceeded: [],
      fieldRefs: [],
      physicalConstants: constants,
    };
    const results: ResultsSummary = {
      resultsHash: 'r',
      inputHash: 'i',
      solver: 'ccx',
      solverVersion: '2.21',
      loadCases: [],
      units: 'N-mm-t-s',
      thermal,
    };
    const type: FeElementType = 'C3D4';
    const solver: FeSolver = 'calculix';
    expect(solver).toBe('calculix');
    const artifact: FeMeshArtifact = {
      kind: 'fe_mesh',
      unitSystem: 'N-mm-t-s',
      mesher: 'netgen',
      mesherVersion: '4.15.2',
      inputHash: 'i',
      nodes: [[1, 0, 0, 0]],
      blocks: [{ type, entityId: 'box-1.1', elements: [[1, 1, 2, 3, 4]] }],
      nodeSets: { C_fc: [1] },
      faceSets: { C_fc: [[1, 1]] },
      targets: { C_fc: { residual: 0 } },
    };
    const output: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash: 'm',
      inputHash: 'i',
      solver: 'ccx',
      solverVersion: '2.21',
      steps: [{ step: 1, time: 0, fields: { NDTEMP: { components: ['T'], values: { '1': [20] } } } }],
      dat: { tables: [{ title: 't', time: 0, rows: [[1, 2]] }] },
    };
    for (const value of [mesh, results, artifact, output]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
      expect(sha256Hex(canonicalJson(value))).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('PHY-04 field sources, idealizations and fit dispositions type-check', () => {
    const sources: TemperatureFieldSource[] = [
      { kind: 'thermal_result', analysisId: 'an-1.1', time: 'last', mapping: 'same_mesh' },
      { kind: 'uniform', value: q(77, 'K') },
      { kind: 'expression', expression: '20+x', coordinatesUnit: 'mm', temperatureUnit: 'degC' },
      { kind: 'table', csvSha256: 'ab', rows: 4, coordinatesUnit: 'mm', temperatureUnit: 'K' },
    ];
    const idealizations: Idealization[] = [
      { kind: 'solid' },
      { kind: 'plane_stress', thickness: 2, sourceFacesNear: [[0, 0, 0]] },
      { kind: 'shell', thickness: 'auto', offset: 'mid', midsurface: { maxThickness: 5, angularTolDeg: 1 } },
      { kind: 'beam', section: 'I' },
    ];
    const fits: FitDispositions = {
      'pmi-1|20': { decision: 'rejected', justification: 'j', inputsHash: 'h', signer: 's', signatureId: 'i' },
    };
    expect(JSON.parse(JSON.stringify({ sources, idealizations, fits }))).toEqual({ sources, idealizations, fits });
  });
});
