/**
 * @layer server/tests
 *
 * Real CAD-exchange round trips through the Python bridge (CadQuery / build123d on OpenCascade).
 * Skipped when the configured python has no CadQuery (CI). build123d tests additionally need
 * LLULL_TEST_BUILD123D_PYTHON=<python with build123d>.
 *
 *   LLULL_TEST_BUILD123D_PYTHON=/path/to/venv/bin/python npx vitest run tests/cadExchange.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { entityToTriangles } from '@core/commands/export';
import type { PythonLanguage } from '@mcp/index';
import { installGeometryKernel } from '../src/geometryKernel';
import { createPythonExchangePort } from '../src/pythonExchange';
import {
  BRIDGE_SCRIPT,
  BUILD123D_PYTHON,
  CADQUERY_PYTHON,
  probePython,
} from './exchangeTestSupport';

const cadqueryProbe = probePython(CADQUERY_PYTHON);
const build123dProbe = BUILD123D_PYTHON === undefined ? null : probePython(BUILD123D_PYTHON);
const hasCadQuery = cadqueryProbe.cadquery !== null;
const hasBuild123d = build123dProbe?.build123d != null;

const port = createPythonExchangePort({
  python: CADQUERY_PYTHON,
  build123dPython: BUILD123D_PYTHON ?? CADQUERY_PYTHON,
  timeoutMs: 120_000,
  bridgeScript: BRIDGE_SCRIPT,
  exchangeDir: null,
});

// ---------------------------------------------------------------------------
// Fixture model
// ---------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];
interface Box3 {
  readonly min: Vec3;
  readonly max: Vec3;
}

const PROFILE_RING = [
  [10, 0],
  [20, 0],
  [20, 15],
  [10, 15],
];

/** [name, command, params, curved] — every solid gets a unique name so STEP bodies can be matched. */
const PRIMITIVES: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ['Cylinder', 'add_cylinder', { radius: 8, height: 30, position: [100, 0, 15] }],
  ['Cone', 'add_cone', { radius: 10, height: 20, position: [60, 0, 0], rotation: [0.2, 0.4, 0.1] }],
  [
    'Torus',
    'add_torus',
    { ringRadius: 15, tubeRadius: 4, position: [-60, 0, 10], rotation: [0.5, 0, 0] },
  ],
  ['Wedge', 'add_wedge', { size: [20, 10, 15], position: [0, 50, 0] }],
  ['Pyramid', 'add_pyramid', { baseWidth: 12, baseDepth: 8, height: 20, position: [0, -50, 0] }],
  ['Sphere', 'add_sphere', { radius: 7, position: [-100, 20, 7] }],
  [
    'Extrusion',
    'extrude_profile',
    {
      profile: [
        [0, 0],
        [30, 0],
        [30, 10],
        [10, 25],
        [0, 10],
      ],
      depth: 12,
      position: [5, 5, 5],
    },
  ],
  [
    'Revolve Y quarter',
    'revolve_profile',
    { profile: PROFILE_RING, axis: 'y', angle: Math.PI / 2, position: [30, 30, 30] },
  ],
  [
    'Revolve X quarter',
    'revolve_profile',
    { profile: PROFILE_RING, axis: 'x', angle: Math.PI / 2, position: [-30, 30, 30] },
  ],
  [
    'Revolve Z half',
    'revolve_profile',
    { profile: PROFILE_RING, axis: 'z', angle: Math.PI, position: [30, -30, 0] },
  ],
  [
    'Revolve Y full',
    'revolve_profile',
    { profile: PROFILE_RING, axis: 'y', position: [70, 40, 0] },
  ],
  [
    'Rotated box',
    'add_box',
    { size: [10, 20, 30], position: [10, 70, 5], rotation: [0.3, 0.5, 0.7] },
  ],
  [
    'Rotated wedge',
    'add_wedge',
    { size: [20, 10, 15], position: [-20, 70, 5], rotation: [0.3, 0.5, 0.7] },
  ],
  [
    'Rotated pyramid',
    'add_pyramid',
    { baseWidth: 12, baseDepth: 8, height: 20, position: [40, 70, 5], rotation: [0.3, 0.5, 0.7] },
  ],
];

const alias = (name: string): string => name.replace(/[^A-Za-z0-9]/g, '');

function fixtureActions(): unknown[] {
  const actions: unknown[] = [
    { command: 'set_parameter', params: { name: 'width', expression: '80' } },
    { command: 'set_parameter', params: { name: 'thickness', expression: 'width / 10' } },
    {
      command: 'add_box',
      as: 'plate',
      params: { size: ['=width', 40, '=thickness'], position: [0, 0, '=thickness / 2'] },
    },
    {
      command: 'add_cylinder',
      as: 'hole',
      params: { radius: 6, height: 30, position: [40, 20, 4] },
    },
    { command: 'boolean_subtract', as: 'cut', params: { a: '$plate', b: '$hole' } },
    { command: 'set_entity_name', params: { id: '$cut', name: 'Base plate' } },
  ];
  for (const [name, command, params] of PRIMITIVES) {
    actions.push({ command, as: alias(name), params: { ...params, color: '#336699' } });
    actions.push({ command: 'set_entity_name', params: { id: `$${alias(name)}`, name } });
  }
  return actions;
}

function buildFixture(): CadDocument {
  const result = execute(createEmptyDocument(), 'build_project', { actions: fixtureActions() });
  if (result.affected.length === 0) throw new Error(`fixture failed: ${result.summary}`);
  return result.document;
}

function solidsByName(doc: CadDocument): Map<string, Entity> {
  const byName = new Map<string, Entity>();
  for (const entity of Object.values(doc.entities)) {
    if (entity.name !== undefined) byName.set(entity.name, entity);
  }
  return byName;
}

function boxOf(points: ReadonlyArray<Vec3>): Box3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, p[axis]!);
      max[axis] = Math.max(max[axis]!, p[axis]!);
    }
  }
  return { min, max };
}

function llullBox(entity: Entity, doc: CadDocument): Box3 {
  return boxOf(entityToTriangles(entity, doc).flatMap((triangle) => [...triangle]));
}

function stepBox(positions: readonly number[]): Box3 {
  const points: Vec3[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    points.push([positions[i]!, positions[i + 1]!, positions[i + 2]!]);
  }
  return boxOf(points);
}

function maxDeviation(a: Box3, b: Box3): number {
  let worst = 0;
  for (let axis = 0; axis < 3; axis++) {
    worst = Math.max(
      worst,
      Math.abs(a.min[axis]! - b.min[axis]!),
      Math.abs(a.max[axis]! - b.max[axis]!),
    );
  }
  return worst;
}

function sizeOf(box: Box3): number {
  return Math.max(...[0, 1, 2].map((axis) => box.max[axis]! - box.min[axis]!));
}

interface StepBody {
  name?: string;
  color?: string;
  positions: number[];
}

function exportedCode(doc: CadDocument, language: PythonLanguage): string {
  const result = execute(doc, 'export_code', { language, name: 'model' });
  const text = (result.data as { text?: string } | undefined)?.text;
  if (text === undefined) throw new Error(result.summary);
  return text;
}

const deviationTable: Array<{
  language: string;
  name: string;
  deviation: number;
  tolerance: number;
}> = [];

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

function describeLanguage(language: PythonLanguage, enabled: boolean): void {
  describe.skipIf(!enabled)(`${language} exchange against the real bridge`, () => {
    let doc: CadDocument;
    let bodies: StepBody[];

    beforeAll(async () => {
      expect(await installGeometryKernel()).toBe(true);
      doc = buildFixture();
      const code = exportedCode(doc, language);
      const run = await port.runProgram({ language, source: code, step: true });
      expect(run.traced).toBe(true);
      expect(typeof run.stepBase64).toBe('string');
      bodies = (await port.importStep(run.stepBase64 as string)).bodies as StepBody[];
    }, 180_000);

    it('exports one STEP body per llull solid', () => {
      const solidCount = Object.values(doc.entities).filter((e) => e.name !== undefined).length;
      expect(solidCount).toBe(PRIMITIVES.length + 1);
      expect(bodies).toHaveLength(solidCount);
    });

    it('rebuilds an editable parametric history from the generated code trace', async () => {
      const run = await port.runProgram({
        language,
        source: exportedCode(doc, language),
        step: false,
      });
      expect(run.traced).toBe(true);
      const applied = execute(createEmptyDocument(), 'apply_code_trace', { trace: run.trace });
      expect(applied.affected.length).toBe(PRIMITIVES.length + 1);
      expect(JSON.stringify(applied.document.featureHistory)).toContain('=width');
      const changed = execute(applied.document, 'set_parameter', {
        name: 'width',
        expression: '120',
      });
      const replayed = execute(changed.document, 'replay_history', {});
      const plate = Object.values(replayed.document.entities).find((e) => e.name === 'Base plate');
      const box = llullBox(plate!, replayed.document);
      expect(box.max[0]! - box.min[0]!).toBeCloseTo(120, 3);
    }, 120_000);

    it('keeps STEP names and colours', () => {
      const plate = bodies.find((b) => b.name === 'Base plate');
      expect(plate).toBeDefined();
      const cylinder = bodies.find((b) => b.name === 'Cylinder');
      expect(cylinder?.color?.toLowerCase()).toBe('#336699');
    });

    it('matches llull bounding boxes per solid (position / rotation / axis / sweep conventions)', () => {
      const entities = solidsByName(doc);
      for (const [name, entity] of entities) {
        const body = bodies.find((b) => b.name === name);
        expect(body, `STEP body "${name}"`).toBeDefined();
        const expected = llullBox(entity, doc);
        const actual = stepBox(body!.positions);
        const deviation = maxDeviation(expected, actual);
        const tolerance = 0.03 * sizeOf(expected) + 1e-3;
        deviationTable.push({ language, name, deviation, tolerance });
        expect(
          deviation,
          `${name}: llull ${JSON.stringify(expected)} vs STEP ${JSON.stringify(actual)}`,
        ).toBeLessThanOrEqual(tolerance);
      }
    });
  });
}

afterAll(() => setGeometryKernel(null));

describeLanguage('cadquery', hasCadQuery);
describeLanguage('build123d', hasBuild123d);

describe.skipIf(!hasCadQuery)('parametric round trip (cadquery)', () => {
  let doc: CadDocument;
  let code: string;
  let traced: unknown;

  beforeAll(async () => {
    expect(await installGeometryKernel()).toBe(true);
    doc = buildFixture();
    code = exportedCode(doc, 'cadquery');
    const run = await port.runProgram({ language: 'cadquery', source: code, step: false });
    expect(run.traced).toBe(true);
    traced = run.trace;
  }, 120_000);

  it('code declares parameters and expressions', () => {
    expect(code).toContain('width = param("width", 80)');
    expect(code).toContain('thickness = param("thickness", width / 10)');
  });

  it('apply_code_trace rebuilds a feature history that keeps =expr dimensions', () => {
    const applied = execute(createEmptyDocument(), 'apply_code_trace', { trace: traced });
    expect(applied.affected.length).toBeGreaterThan(0);
    expect(applied.document.parameters['width']?.value).toBe(80);
    expect(applied.document.parameters['thickness']?.value).toBe(8);
    const history = JSON.stringify(applied.document.featureHistory);
    expect(history).toContain('=width');
    expect(history).toContain('thickness');
  });

  it('set_parameter width=120 + replay_history makes the plate 120 wide', () => {
    const applied = execute(createEmptyDocument(), 'apply_code_trace', { trace: traced });
    const changed = execute(applied.document, 'set_parameter', {
      name: 'width',
      expression: '120',
    });
    const replayed = execute(changed.document, 'replay_history', {});
    expect(replayed.document.parameters['width']?.value).toBe(120);
    expect(replayed.document.parameters['thickness']?.value).toBe(12);
    const plate = Object.values(replayed.document.entities).find((e) => e.name === 'Base plate');
    expect(plate).toBeDefined();
    const box = llullBox(plate!, replayed.document);
    expect(box.max[0]! - box.min[0]!).toBeCloseTo(120, 3);
    expect(box.max[2]! - box.min[2]!).toBeCloseTo(12, 3);
    expect(box.max[1]! - box.min[1]!).toBeCloseTo(40, 3);
  });

  it('export_code of the rebuilt model reproduces the parameter declaration', () => {
    const applied = execute(createEmptyDocument(), 'apply_code_trace', { trace: traced });
    const changed = execute(applied.document, 'set_parameter', {
      name: 'width',
      expression: '120',
    });
    const replayed = execute(changed.document, 'replay_history', {});
    const again = exportedCode(replayed.document, 'cadquery');
    expect(again).toContain('width = param("width", 120)');
    expect(again).toContain('thickness = param("thickness", width / 10)');
  });
});

describe.skipIf(!hasCadQuery)('non-llull scripts (cadquery)', () => {
  it('raw CadQuery is traced:false and imported as one mesh with the right bbox', async () => {
    const run = await port.runProgram({
      language: 'cadquery',
      source: 'import cadquery as cq\nresult = cq.Workplane().box(10,20,30)\n',
      step: false,
    });
    expect(run.traced).toBe(false);
    const applied = execute(createEmptyDocument(), 'apply_code_trace', { trace: run.trace });
    expect(applied.affected).toHaveLength(1);
    const entity = applied.document.entities[applied.affected[0]!]!;
    expect(entity.kind).toBe('mesh');
    const box = llullBox(entity, applied.document);
    expect(maxDeviation(box, { min: [-5, -10, -15], max: [5, 10, 15] })).toBeLessThan(1e-6);
  });

  it('script stdout cannot corrupt the JSON response and is returned as log', async () => {
    const run = await port.runProgram({
      language: 'cadquery',
      source:
        'import cadquery as cq\nprint("hello {not json}")\nresult = cq.Workplane().box(1,1,1)\n',
      step: false,
    });
    expect(run.traced).toBe(false);
    expect(run.log).toContain('hello {not json}');
  });

  it('a raising script surfaces its error message', async () => {
    await expect(
      port.runProgram({
        language: 'cadquery',
        source: 'import cadquery as cq\nraise ValueError("kaboom 42")\n',
        step: false,
      }),
    ).rejects.toThrow(/kaboom 42/);
  });

  it('a script without a result is rejected with a clear error', async () => {
    await expect(
      port.runProgram({ language: 'cadquery', source: 'x = 1\n', step: false }),
    ).rejects.toThrow(/.+/);
  });

  it('rejects a syntax error', async () => {
    await expect(
      port.runProgram({ language: 'cadquery', source: 'def (:\n', step: false }),
    ).rejects.toThrow(/SyntaxError|syntax/i);
  });

  it('importStep rejects garbage STEP data', async () => {
    await expect(
      port.importStep(Buffer.from('not a step file').toString('base64')),
    ).rejects.toThrow(/.+/);
  });
});

describe.skipIf(!hasCadQuery)('STEP names and colours (cadquery)', () => {
  it('set_entity_name survives export -> import as the body name; colour kept', async () => {
    expect(await installGeometryKernel()).toBe(true);
    let current = createEmptyDocument();
    const added = execute(current, 'add_box', { size: [10, 10, 10], color: '#aa3300' });
    current = execute(added.document, 'set_entity_name', {
      id: added.affected[0]!,
      name: 'Base plate',
    }).document;
    const run = await port.runProgram({
      language: 'cadquery',
      source: exportedCode(current, 'cadquery'),
      step: true,
    });
    const imported = await port.importStep(run.stepBase64 as string);
    const result = execute(createEmptyDocument(), 'import_mesh', { bodies: imported.bodies });
    expect(result.affected).toHaveLength(1);
    const entity = result.document.entities[result.affected[0]!]!;
    expect(entity.name).toBe('Base plate');
    expect(JSON.stringify(entity).toLowerCase()).toContain('#aa3300');
  }, 120_000);
});

describe.skipIf(!hasCadQuery)('probe op', () => {
  it('reports python and cadquery versions', () => {
    expect(cadqueryProbe.cadquery).toMatch(/\d/);
  });
});

describe.skipIf(!hasCadQuery)('fidelity summary', () => {
  it('prints the per-primitive deviation table', () => {
    const lines = deviationTable.map(
      (row) =>
        `${row.language.padEnd(9)} ${row.name.padEnd(20)} dev=${row.deviation.toFixed(4)} tol=${row.tolerance.toFixed(4)}`,
    );
    if (process.env['LLULL_TEST_PRINT_FIDELITY'] === '1') console.warn(lines.join('\n'));
    expect(deviationTable.every((row) => row.deviation <= row.tolerance)).toBe(true);
  });
});
