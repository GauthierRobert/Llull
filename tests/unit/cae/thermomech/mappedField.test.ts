/** PHY-04 TR-TMC-24: the deck reads a native mapped-field artifact only when it is bound to the same request and the same target mesh. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { resolveTemperatureField, temperatureMappingRequest } from '@cae/thermomech/field';
import { mapNodalField } from '@cae/thermomech/mapping';
import { mappedFieldArtifact, mappingJobBuffers, readMappedField, type MappingRequest } from '@cae/thermomech/mappedField';
import { thermoFixture, withThermalSource } from './fixtures';

const CUBE: FeMeshArtifact = {
  kind: 'fe_mesh',
  unitSystem: 'N-mm-t-s',
  mesher: 'test',
  mesherVersion: '0',
  inputHash: 'h',
  nodes: [
    [1, 0, 0, 0],
    [2, 10, 0, 0],
    [3, 0, 10, 0],
    [4, 0, 0, 10],
    [5, 10, 10, 10],
    [6, 10, 10, 0],
    [7, 10, 0, 10],
    [8, 0, 10, 10],
  ],
  blocks: [
    {
      type: 'C3D4',
      entityId: 'box',
      elements: [
        [1, 1, 2, 6, 5],
        [2, 1, 2, 7, 5],
        [3, 1, 3, 6, 5],
        [4, 1, 3, 8, 5],
        [5, 1, 4, 7, 5],
        [6, 1, 4, 8, 5],
      ],
    },
  ],
  nodeSets: {},
  faceSets: {},
  targets: {},
};

function interpolated(): {
  doc: ReturnType<typeof thermoFixture>['doc'];
  analysisId: string;
  target: FeMeshArtifact;
  artifacts: FeArtifactPort;
} {
  const source = withThermalSource(thermoFixture(), { mesh: CUBE });
  const { doc, analysisId, mesh } = source.fixture;
  const set = execute(doc, 'set_temperature_field', {
    analysisId,
    source: { kind: 'thermal_result', analysisId: source.thermalId, time: 'last', mapping: 'interpolate' },
  });
  return { doc: set.document, analysisId, target: mesh, artifacts: source.artifacts };
}

/** The TS mapping of a request written as the native job would write it. */
function nativeLike(request: MappingRequest, shift = 0): Float64Array {
  const mapped = mapNodalField(request.source, request.values, request.target);
  if (!mapped.ok) throw new Error(mapped.message);
  return Float64Array.from(mapped.values.flatMap((value, i) => [value + shift, mapped.elements[i] ?? 0, mapped.distances[i] ?? 0]));
}

const withAlias = (port: FeArtifactPort, key: string, artifact: FeResultsArtifact): FeArtifactPort => ({
  get: (hash) => (hash === key ? artifact : port.get(hash)),
});

describe('native mapped field (TR-TMC-24)', () => {
  it('builds the request of an interpolate field and the job buffers; other fields have none', () => {
    const { doc, analysisId, target, artifacts } = interpolated();
    const request = temperatureMappingRequest(doc, analysisId, target, artifacts);
    if (request === null || !('key' in request)) throw new Error('no request');
    expect(request.key).toMatch(/^[0-9a-f]{64}$/);
    expect(request.values.size).toBe(8);
    const buffers = mappingJobBuffers(request);
    expect(buffers['source_nodes.f64']).toHaveLength(32);
    expect(buffers['source_elements.f64']).toHaveLength(30);
    expect(buffers['source_values.f64']).toHaveLength(16);
    expect(buffers['target_nodes.f64']).toHaveLength(target.nodes.length * 4);
    const uniform = execute(doc, 'set_temperature_field', { analysisId, source: { kind: 'uniform', value: { value: 50, unit: 'degC' } } });
    expect(temperatureMappingRequest(uniform.document, analysisId, target, artifacts)).toBeNull();
    expect(temperatureMappingRequest(doc, analysisId, target, { get: () => null })).toMatchObject({ ok: false });
  });

  it('the deck uses a bound native artifact and says so; a mis-bound one is ignored (TS path)', () => {
    const { doc, analysisId, target, artifacts } = interpolated();
    const request = temperatureMappingRequest(doc, analysisId, target, artifacts) as MappingRequest;
    const reference = resolveTemperatureField(doc, analysisId, target, artifacts);
    expect(reference.ok && reference.description).not.toContain('native');
    const artifact = mappedFieldArtifact(request, nativeLike(request), 'test') as FeResultsArtifact;
    const native = resolveTemperatureField(doc, analysisId, { ...target }, withAlias(artifacts, request.key, artifact));
    expect(native.ok && native.description).toContain('native llull-compute post map');
    expect(native.ok && reference.ok && native.values).toEqual(reference.ok ? reference.values : []);
    expect(native.ok && native.mapping).toEqual(reference.ok ? reference.mapping : undefined);
    const shifted = mappedFieldArtifact(request, nativeLike(request, 0), 'test') as FeResultsArtifact;
    const otherMesh = withAlias(artifacts, request.key, { ...shifted, meshHash: '0'.repeat(64) });
    const ignored = resolveTemperatureField(doc, analysisId, { ...target }, otherMesh);
    expect(ignored.ok && ignored.description).not.toContain('native');
  });

  it('rejects malformed fields', () => {
    const { doc, analysisId, target, artifacts } = interpolated();
    const request = temperatureMappingRequest(doc, analysisId, target, artifacts) as MappingRequest;
    expect(mappedFieldArtifact(request, new Float64Array(2), 'x')).toMatch(/expected/);
    const bad = nativeLike(request);
    bad[0] = Number.NaN;
    expect(mappedFieldArtifact(request, bad, 'x')).toMatch(/non-finite/);
    const artifact = mappedFieldArtifact(request, nativeLike(request), 'x') as FeResultsArtifact;
    const holes = { ...artifact, steps: [{ step: 1, time: 0, fields: { MAPPED: { components: ['T'], values: {} } } }] };
    expect(readMappedField(withAlias(artifacts, request.key, holes), request)).toBeNull();
    expect(readMappedField(withAlias(artifacts, request.key, { ...artifact, solver: 'other' }), request)).toBeNull();
    expect(readMappedField(null, request)).toBeNull();
  });
});
