/** Faulty or partial field engines and malformed nodes: every query reports a coded refusal or a stated gap instead of a wrong number. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FieldEngine } from '@core/geometry/field/engineTypes';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { type CadDocument } from '@core/model/types';
import { empty, ok } from './helpers';

const contextWith = (engine: FieldEngine): Parameters<typeof execute>[3] => ({
  kernel: null,
  ids: { next: (p: string) => `${p}-x` },
  registry: () => undefined,
  projectDepth: 0,
  recipeDepth: 0,
  replayCache: null,
  fieldEngine: engine,
});
const provenance = { engine: 'fake', device: 'cpu', deterministic: true, voxel: 1 };
const withMeasure = (measure: FieldEngine['measure']): FieldEngine => ({ ...tsFieldEngine, name: 'fake', measure });

const sphereBody = (): { doc: CadDocument; field: string; body: string } => {
  const s = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
  const b = ok(s.doc, 'create_implicit_body', { field: s.id, voxel: 0.5 });
  return { doc: b.doc, field: s.id, body: b.id };
};

describe('implicit_properties with a faulty engine', () => {
  it('refuses an unexpected volume answer and keeps a refused coarse pass', () => {
    const { doc, body } = sphereBody();
    const wrong = withMeasure(() => ({ ok: true, kind: 'quantile', values: [0], samples: 1, provenance }));
    expect(execute(doc, 'implicit_properties', { id: body }, contextWith(wrong)).error?.code).toBe('IMP_ENGINE_FAILED');
    let calls = 0;
    const flaky = withMeasure((program, grid, region, request) => {
      calls += 1;
      return calls === 2 && request.kind === 'volume'
        ? { ok: false, code: 'IMP_GRID_BUDGET', message: 'coarse refused' }
        : tsFieldEngine.measure(program, grid, region, request);
    });
    const answer = execute(doc, 'implicit_properties', { id: body }, contextWith(flaky));
    expect(answer.error).toBeUndefined();
    expect((answer.data as { errorEstimate: { value: number } }).errorEstimate.value).toBeGreaterThanOrEqual(0);
  });

  it('reports components as unavailable when the components answer has another kind', () => {
    const { doc, body } = sphereBody();
    const odd = withMeasure((program, grid, region, request) =>
      request.kind === 'components'
        ? { ok: true, kind: 'quantile', values: [], samples: 0, provenance }
        : tsFieldEngine.measure(program, grid, region, request),
    );
    const data = execute(doc, 'implicit_properties', { id: body }, contextWith(odd)).data as {
      components: unknown;
      componentsNote: string;
    };
    expect(data.components).toBeNull();
    expect(data.componentsNote).toContain('unavailable');
  });

  it('fails cleanly when a field or region no longer compiles (source solid removed)', () => {
    const box = ok(empty(), 'add_box', { size: [2, 2, 2] });
    const f = ok(box.doc, 'field_from_solid', { entityId: box.id });
    const sphere = ok(f.doc, 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const broken: CadDocument = { ...sphere.doc, entities: {}, order: [] };
    expect(execute(broken, 'implicit_properties', { id: f.id }).error?.code).toBe('IMP_ENTITY_NOT_FOUND');
    expect(execute(broken, 'implicit_properties', { id: sphere.id, region: f.id }).error?.code).toBe('IMP_ENTITY_NOT_FOUND');
  });
});

describe('add_tpms_lattice density inversion with a faulty engine', () => {
  const params = { kind: 'gyroid', form: 'sheet', relativeDensity: 0.3, cellSize: 10 };
  it.each([
    ['a refusal', () => ({ ok: false as const, code: 'IMP_GRID_BUDGET' as const, message: 'no budget' })],
    ['another measure kind', () => ({ ok: true as const, kind: 'components' as const, solids: [], voids: [], samples: 0, provenance })],
    ['a non-finite quantile', () => ({ ok: true as const, kind: 'quantile' as const, values: [Number.NaN], samples: 1, provenance })],
  ])('is refused with IMP_TPMS_CONTROL_RANGE on %s', (_name, answer) => {
    const result = execute(empty(), 'add_tpms_lattice', params, contextWith(withMeasure(answer)));
    expect(result.error?.code).toBe('IMP_TPMS_CONTROL_RANGE');
    expect(result.document.implicit).toBeUndefined();
  });
});

describe('frames and malformed nodes', () => {
  it('a cylindrical map about the x axis is continuous at its seam', () => {
    const map = { kind: 'cylindrical', origin: [0, 0, 0], axis: [1, 0, 0], cellsAround: 6, radialCellSize: 10 };
    const lattice = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0, cellSize: 10, map });
    const ring = (theta: number): number[] => [3, 25 * Math.cos(theta), 25 * Math.sin(theta)];
    const values = ok(lattice.doc, 'evaluate_field', { field: lattice.id, points: [ring(Math.PI - 1e-9), ring(-Math.PI + 1e-9)] }).data[
      'values'
    ] as number[];
    expect(Math.abs((values[0] ?? 0) - (values[1] ?? 1))).toBeLessThan(1e-6);
  });

  it('a primitive with missing dimensions compiles to a degenerate shape instead of throwing', () => {
    const node = (shape: string): Record<string, unknown> => ({
      id: 'p',
      op: 'primitive',
      shape,
      dims: {},
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    for (const shape of ['sphere', 'box', 'cylinder', 'plane']) {
      const doc: CadDocument = { ...empty(), implicit: { version: 1, fields: { p: node(shape) as never }, bodies: {} } };
      expect(execute(doc, 'evaluate_field', { field: 'p', points: [[1, 1, 1]] }).error).toBeUndefined();
    }
  });
});
