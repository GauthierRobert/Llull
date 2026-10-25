/**
 * 02 SWG code export, executed (DES-2c): the CadQuery / build123d / FreeCAD code generated for sweeps (laws, frames, rails, helices, bores, closed
 * paths, mitres) and lofts (end conditions, centreline, coupling, thru-sections) is run in Python; every solid's volume is compared to the
 * validation pack's exact value, placement (rotated + moved) to llull's triangles, and (CadQuery / build123d) the recorded LLULL_TRACE is
 * imported back (import_code round trip). Each library is skipped when its python is not configured (CI).
 *
 *   LLULL_TEST_CADQUERY_PYTHON=<python with cadquery> LLULL_TEST_BUILD123D_PYTHON=<python with build123d>  *   LLULL_TEST_FREECAD_PYTHON=<FreeCAD bin/python.exe> npx vitest run tests/sweepLoftCodeExecution.integration.test.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// each case starts a CAD kernel in Python (several times for the round trip): well past the default 30 s on a loaded machine
vi.setConfig({ testTimeout: 300_000 });
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { entityTrianglePositions } from '@core/geometry/entityTriangles';
import { relError, runSwgPlan, swgCase, swgPlan, swgValue, type PlanStep } from '../../tests/helpers/swgPack';
import { BUILD123D_PYTHON, CADQUERY_PYTHON, probePython } from './exchangeTestSupport';

const OCP_DRIVER = `
import sys, json
namespace = {"__name__": "llull_script"}
exec(compile(open(sys.argv[1], encoding="utf8").read(), sys.argv[1], "exec"), namespace)


def box(shape):
    if hasattr(shape, "BoundingBox"):
        b = shape.BoundingBox()
        return [[b.xmin, b.ymin, b.zmin], [b.xmax, b.ymax, b.zmax]]
    b = shape.bounding_box()
    return [[b.min.X, b.min.Y, b.min.Z], [b.max.X, b.max.Y, b.max.Z]]


solids = [solid.shape for solid in namespace["LLULL_LIVE"].values()]
volumes = [shape.volume if hasattr(shape, "volume") else shape.Volume() for shape in solids]
centers = [list(shape.Center().toTuple()) if hasattr(shape, "Center") and hasattr(shape, "BoundingBox") else [shape.center().X, shape.center().Y, shape.center().Z] for shape in solids]
print(json.dumps({"volumes": volumes, "boxes": [box(shape) for shape in solids], "centers": centers, "trace": namespace["LLULL_TRACE"]}))
`;

const FREECAD_DRIVER = `
import sys, os, json
bin_dir = os.path.dirname(sys.executable)
sys.path.append(bin_dir)
if hasattr(os, "add_dll_directory"):
    os.add_dll_directory(bin_dir)
namespace = {"__name__": "llull_script"}
exec(compile(open(sys.argv[1], encoding="utf8").read(), sys.argv[1], "exec"), namespace)
objects = namespace["doc"].Objects
boxes = [[[b.XMin, b.YMin, b.ZMin], [b.XMax, b.YMax, b.ZMax]] for b in (o.Shape.optimalBoundingBox() for o in objects)]
print(json.dumps({"volumes": [o.Shape.Volume for o in objects], "boxes": boxes, "centers": [list(o.Shape.Solids[0].CenterOfMass) for o in objects], "trace": None}))
`;

const FREECAD_PYTHON = process.env['LLULL_TEST_FREECAD_PYTHON'];
const freecadWorks =
  FREECAD_PYTHON !== undefined &&
  spawnSync(FREECAD_PYTHON, ['-c', 'import sys, os; sys.path.append(os.path.dirname(sys.executable)); import FreeCAD, Part'], {
    timeout: 120_000,
  }).status === 0;

const backends = [
  { language: 'cadquery', python: CADQUERY_PYTHON, driver: OCP_DRIVER, available: probePython(CADQUERY_PYTHON).cadquery !== null },
  {
    language: 'build123d',
    python: BUILD123D_PYTHON ?? CADQUERY_PYTHON,
    driver: OCP_DRIVER,
    available: probePython(BUILD123D_PYTHON ?? CADQUERY_PYTHON).build123d !== null,
  },
  { language: 'freecad', python: FREECAD_PYTHON ?? '', driver: FREECAD_DRIVER, available: freecadWorks },
] as const;

type Box = readonly [readonly [number, number, number], readonly [number, number, number]];

interface Run {
  readonly volumes: number[];
  readonly boxes: Box[];
  readonly centers: Array<readonly [number, number, number]>;
  readonly trace: Record<string, unknown> | null;
  readonly stderr: string;
}

/**
 * Runs the generated script: the live solids' volumes and bounding boxes in document order, the recorded LLULL_TRACE (OCP backends) and stderr.
 * An unedited script must not warn SWG_CODEGEN_STALE (`edited` runs assert their own warnings).
 */
function runScript(text: string, python: string, driver: string, edited = false): Run {
  const dir = mkdtempSync(path.join(tmpdir(), 'llull-swg-'));
  try {
    const script = path.join(dir, 'model.py');
    writeFileSync(script, text, 'utf8');
    const run = spawnSync(python, ['-c', driver, script], { encoding: 'utf8', timeout: 240_000, maxBuffer: 256 * 1024 * 1024 });
    if (run.status !== 0) throw new Error('generated code failed: ' + run.stderr.slice(-2500));
    const parsed = JSON.parse(run.stdout.trim().split(/\r?\n/).pop() as string) as Omit<Run, 'stderr'>;
    if (!edited) expect(run.stderr, 'an unedited script warns nothing').not.toContain('SWG_CODEGEN_STALE');
    return { ...parsed, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codeOf = (doc: CadDocument, language: string): string => (execute(doc, 'export_code', { language }).data as { text: string }).text;

/** Aliases of the plan's solids in document order (the entities sweeps and lofts create). */
const solidAliases = (actions: readonly PlanStep[]): string[] =>
  actions
    .filter((a) => ['sweep_profile', 'loft_sections', 'add_coil'].includes(a.command) && a.as !== undefined)
    .map((a) => a.as as string);

function created(doc: CadDocument, command: string, params: unknown): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return { doc: result.document, id: result.affected[0] as string };
}

/** Volume centroid of an entity's closed display triangles. */
function centroidOf(doc: CadDocument, id: string): [number, number, number] {
  const p = entityTrianglePositions(doc.entities[id] as Entity, doc);
  let volume = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i + 8 < p.length; i += 9) {
    const [a, b, c] = [p.slice(i, i + 3), p.slice(i + 3, i + 6), p.slice(i + 6, i + 9)] as [number[], number[], number[]];
    const v =
      ((a[0] as number) * ((b[1] as number) * (c[2] as number) - (b[2] as number) * (c[1] as number)) -
        (a[1] as number) * ((b[0] as number) * (c[2] as number) - (b[2] as number) * (c[0] as number)) +
        (a[2] as number) * ((b[0] as number) * (c[1] as number) - (b[1] as number) * (c[0] as number))) /
      6;
    volume += v;
    for (let k = 0; k < 3; k++) sum[k] = (sum[k] as number) + (v * ((a[k] as number) + (b[k] as number) + (c[k] as number))) / 4;
  }
  return [(sum[0] as number) / volume, (sum[1] as number) / volume, (sum[2] as number) / volume];
}

/** Bounds of an entity's display triangles (exact for polygon sections along straight paths). */
function boundsOf(doc: CadDocument, id: string): Box {
  const positions = entityTrianglePositions(doc.entities[id] as Entity, doc);
  const axis = (k: number): number[] => positions.filter((_, i) => i % 3 === k);
  const [xs, ys, zs] = [axis(0), axis(1), axis(2)];
  return [
    [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
    [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
  ];
}

for (const { language, python, driver, available } of backends)
  describe.skipIf(!available)(`sweep and loft code runs in ${language}`, () => {
    const volumesOf = (doc: CadDocument): number[] => runScript(codeOf(doc, language), python, driver).volumes;
    const check = (actions: PlanStep[], expected: Record<string, readonly [number, number]>): void => {
      const plan = runSwgPlan(actions);
      const aliases = solidAliases(actions);
      const volumes = volumesOf(plan.document);
      expect(volumes).toHaveLength(aliases.length);
      for (const [alias, [reference, tolerance]] of Object.entries(expected)) {
        const at = aliases.indexOf(alias);
        expect(relError(volumes[at] as number, reference), `${language} ${alias}`).toBeLessThan(tolerance);
      }
    };

    it('twist, scale, area, stations and frame laws (VC-03, 05, 07, 09, 10, 11, 15)', () => {
      check(
        swgPlan('target_twist_scale_orientation').filter((a) => a.command !== 'check_sweep_loft' && a.command !== 'inspect_sweep'),
        {
          bar90: [swgValue('VC-SWG-03', 'linear_0_to_90deg'), 1e-6],
          bar360: [swgValue('VC-SWG-03', 'linear_0_to_360deg'), 1e-6],
          barS: [swgValue('VC-SWG-03', 'scurve_0_to_180deg'), 1e-6],
          cone: [swgValue('VC-SWG-05', 'linear_1_to_0.5_straight'), 1e-6],
          wavy: [swgValue('VC-SWG-07', 'expression_1_plus_0.25sin2pit'), 1e-6],
          areaLaw: [swgValue('VC-SWG-10', 'area_law_linear_100_to_25'), 1e-6],
          vane: [swgValue('VC-SWG-09', 'linear_1_to_0.5_quarter_arc_square'), 1e-6],
          oblique: [swgValue('VC-SWG-15', 'fixed_plane_oblique'), 1e-6],
          linearStations: [swgValue('VC-SWG-11', 'linear_1_to_0.5_straight'), 5e-4],
        },
      );
    });

    it('rails: two rails (VC-16), maintainHeight (VC-17), one rail (VC-35)', () => {
      const actions = swgPlan('target_rails_and_surface_mode').filter(
        (a) => !['sweep_surface', 'check_sweep_loft', 'measure_area', 'add_helix'].includes(a.command),
      );
      check(actions, {
        twoRail: [swgValue('VC-SWG-16', 'two_rails_uniform_scale'), 1e-6],
        twoRailHeight: [swgValue('VC-SWG-17', 'two_rails_maintain_height'), 1e-6],
        oneRail: [swgValue('VC-SWG-35', 'linear_1_to_0.5_straight'), 1e-6],
      });
    });

    it('helical tube, screw sections, cone helix and coil (VC-12, 13, 14)', () => {
      const actions = swgPlan('target_helix_spring_thread').filter((a) => !['check_sweep_loft', 'inspect_sweep'].includes(a.command));
      check(actions, {
        tube: [swgValue('VC-SWG-12', 'round_tube_on_helix'), 1e-6],
        screw10: [swgValue('VC-SWG-13', 'screw_rectangle_pitch10'), 1e-6],
        screw5: [swgValue('VC-SWG-13', 'screw_rectangle_pitch5'), 1e-6],
        conicalTube: [swgValue('VC-SWG-14', 'conical_helix_tube'), 1e-6],
        coil: [swgValue('VC-SWG-12', 'round_tube_on_helix'), 1e-6],
      });
    }, 400_000);

    it('lofts: normal ends (VC-21, 22), twisted ruled circles (VC-19), centreline elbow (VC-22)', () => {
      const twisted = swgCase('VC-SWG-19').values as Record<string, number>;
      check(
        swgPlan('target_loft_conditions_alignment').filter((a) => a.command !== 'check_sweep_loft'),
        {
          bottle: [swgValue('VC-SWG-21', 'normal_both_ends_m1'), 1e-6],
          bottle2: [swgValue('VC-SWG-22', 'normal_both_ends_m2'), 1e-6],
          hyperboloid90: [twisted['ruled_circles_twist_90deg'] as number, 1e-6],
          cylinderAligned: [twisted['ruled_circles_twist_0deg'] as number, 1e-6],
          elbowLoft: [swgValue('VC-SWG-22', 'centreline_quarter_arc'), 1e-4],
        },
      );
    });

    it('a moved and rotated sweep and loft land where llull puts them (centroid 1e-6, bounding box 1e-3)', () => {
      const rect = (w: number): number[][] => [
        [-w, -2],
        [w, -2],
        [w, 2],
        [-w, 2],
      ];
      const sweep = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [0, 0, 40],
        ],
        section: rect(3),
      });
      const loft = created(sweep.doc, 'loft_sections', {
        sections: [
          { center: [20, 0, 0], section: rect(3) },
          { center: [20, 4, 30], section: rect(3).map(([x, y]) => [(x as number) * 1.5, (y as number) * 1.5]) },
        ],
        ruled: true,
      });
      let doc = loft.doc;
      for (const id of [sweep.id, loft.id]) {
        doc = created(doc, 'rotate_entity', { id, delta: [0.3, 0.2, 0.5] }).doc;
        doc = created(doc, 'move_entities', { ids: [id], delta: [10, -5, 7] }).doc;
      }
      const run = runScript(codeOf(doc, language), python, driver);
      [sweep.id, loft.id].forEach((id, k) => {
        const expected = boundsOf(doc, id);
        const seen = run.boxes[k] as Box;
        for (const end of [0, 1] as const)
          for (const axis of [0, 1, 2] as const)
            expect(Math.abs((seen[end][axis] as number) - (expected[end][axis] as number)), language + ' box ' + id).toBeLessThan(1e-3);
        const centroid = centroidOf(doc, id);
        for (const axis of [0, 1, 2] as const)
          expect(Math.abs((run.centers[k]?.[axis] as number) - (centroid[axis] as number)), language + ' centroid ' + id).toBeLessThan(
            1e-6,
          );
      });
    });

    it.skipIf(language === 'freecad')('export -> import_code: the sweep and loft come back as editable steps with their parameters', () => {
      const built = execute(createEmptyDocument(), 'build_project', {
        actions: [
          { command: 'set_parameter', params: { name: 'r', expression: '4' } },
          {
            command: 'sweep_profile',
            params: {
              path: [
                [0, 0, 0],
                [0, 0, 50],
              ],
              radius: '=r',
            },
          },
          {
            command: 'loft_sections',
            params: {
              sections: [
                {
                  center: [30, 0, 0],
                  section: [
                    [-3, -3],
                    [3, -3],
                    [3, 3],
                    [-3, 3],
                  ],
                },
                {
                  center: [30, 0, 20],
                  section: [
                    [-4, -4],
                    [4, -4],
                    [4, 4],
                    [-4, 4],
                  ],
                },
              ],
              ruled: true,
            },
          },
        ],
      });
      const doc = built.document;
      expect(doc.order, built.summary).toHaveLength(2);
      const imported = (text: string): CadDocument => {
        const trace = runScript(text, python, driver).trace as Record<string, unknown>;
        const result = execute(createEmptyDocument(), 'apply_code_trace', { trace });
        expect(result.affected.length, result.summary).toBe(2);
        return result.document;
      };
      const volume = (rebuilt: CadDocument, id: string): number =>
        (execute(rebuilt, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
      const text = codeOf(doc, language);
      expect(text).toContain('r = param("r", 4)');
      expect(text).toMatch(/sweep = sweep_profile\(\("pipe", [^\n]*path=\[\[0, 0, 0\], \[0, 0, 50\]\], radius=r/);
      const rebuilt = imported(text);
      expect(rebuilt.featureHistory.map((step) => step.name)).toEqual(['sweep_profile', 'loft_sections']);
      expect(rebuilt.parameters['r']?.expression).toBe('4');
      expect(rebuilt.featureHistory[0]?.params).toMatchObject({ radius: '=r' });
      const [pipe, frustum] = rebuilt.order;
      expect(relError(volume(rebuilt, pipe as string), Math.PI * 16 * 50)).toBeLessThan(1e-9);
      expect(relError(volume(rebuilt, frustum as string), volume(doc, doc.order[1] as string))).toBeLessThan(1e-9);
      // edit the parameter in the code: the built solid and the imported step both follow
      const edited = text.replace('r = param("r", 4)', 'r = param("r", 6)');
      expect(relError(runScript(edited, python, driver).volumes[0] as number, Math.PI * 36 * 50)).toBeLessThan(1e-6);
      const regenerated = imported(edited);
      expect(relError(volume(regenerated, regenerated.order[0] as string), Math.PI * 36 * 50)).toBeLessThan(1e-9);
    });

    it('library constructions on more paths: a polygon pipe on a bent planar path, a closed smooth round ring, an asymmetric mitre on a non-planar polyline', () => {
      const triangle = [
        [-4, -2],
        [2, -2],
        [2, 4],
      ];
      const bent = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [0, 0, 50],
          [40, 0, 90],
        ],
        section: triangle,
      });
      const ring = created(bent.doc, 'sweep_profile', {
        path: [
          [120, 20, 0],
          [100, 40, 0],
          [80, 20, 0],
          [100, 0, 0],
        ],
        smooth: true,
        closed: true,
        radius: 2,
      });
      const mitred = created(ring.doc, 'sweep_profile', {
        path: [
          [0, 200, 0],
          [40, 200, 0],
          [40, 230, 20],
          [40, 230, 60],
        ],
        section: triangle,
        corners: 'miter',
      });
      const doc = mitred.doc;
      const length = (id: string): number => (execute(doc, 'inspect_sweep', { id, samples: 2 }).data as { pathLength: number }).pathLength;
      const run = runScript(codeOf(doc, language), python, driver);
      expect(relError(run.volumes[0] as number, 18 * length(bent.id)), language + ' polygon pipe').toBeLessThan(1e-6);
      expect(relError(run.volumes[1] as number, Math.PI * 4 * length(ring.id)), language + ' closed ring').toBeLessThan(1e-4);
      const expected = (execute(doc, 'mass_properties', { entityId: mitred.id }).data as { volume: number }).volume;
      expect(relError(run.volumes[2] as number, expected), language + ' mitre volume').toBeLessThan(1e-6);
      const box = boundsOf(doc, mitred.id);
      for (const end of [0, 1] as const)
        for (const axis of [0, 1, 2] as const)
          expect(Math.abs(((run.boxes[2] as Box)[end][axis] as number) - (box[end][axis] as number)), language + ' mitre box').toBeLessThan(
            1e-3,
          );
    });

    it('an edited keyword that only import_code applies warns SWG_CODEGEN_STALE; a live radius does not', () => {
      const twisted = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [0, 0, 40],
        ],
        section: [
          [-3, -2],
          [3, -2],
          [3, 2],
          [-3, 2],
        ],
        twist: { type: 'linear', start: 0, end: 1 },
      });
      const text = codeOf(twisted.doc, language);
      expect(runScript(text, python, driver).stderr).not.toContain('SWG_CODEGEN_STALE');
      const stale = runScript(text.replace('"end": 1}', '"end": 2}'), python, driver, true);
      expect(stale.stderr).toContain("SWG_CODEGEN_STALE: sweep 'swp-1.1': twist changed; the solid here is the exported one");
      const pipe = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [0, 0, 50],
        ],
        radius: 4,
      });
      const pipeText = codeOf(pipe.doc, language);
      const live = runScript(pipeText.replace('radius=4', 'radius=5'), python, driver);
      expect(live.stderr).not.toContain('SWG_CODEGEN_STALE');
      expect(relError(live.volumes[0] as number, Math.PI * 25 * 50)).toBeLessThan(1e-9);
      const movedText = pipeText.replace('[0, 0, 50]]', '[0, 0, 60]]');
      const moved = runScript(movedText, python, driver, true);
      expect(moved.stderr).toContain("SWG_CODEGEN_STALE: sweep 'swp-1.1': path changed");
      // the warning points at the user's edited call, not at a runtime frame
      const reported = /model\.py:(\d+): \w*Warning: SWG_CODEGEN_STALE/.exec(moved.stderr);
      const callLine = movedText.split(/\r?\n/).findIndex((line) => line.startsWith('sweep = sweep_profile(')) + 1;
      expect(Number(reported?.[1]), language + ' warning location').toBe(callLine);
      // a keyword added in the code is ignored by the script but applied by import_code; a removed live keyword falls back to the exported number
      const added = runScript(pipeText.replace('radius=4', 'radius=4, twist={"type": "constant", "value": 0}'), python, driver, true);
      expect(added.stderr).toContain("SWG_CODEGEN_STALE: sweep 'swp-1.1': twist was added");
      const removed = runScript(pipeText.replace(', radius=4', ''), python, driver, true);
      expect(removed.stderr).toContain("SWG_CODEGEN_STALE: sweep 'swp-1.1': radius was removed");
      const boreAdded = runScript(pipeText.replace('radius=4', 'radius=4, innerRadius=2'), python, driver, true);
      expect(boreAdded.stderr).toContain("SWG_CODEGEN_STALE: sweep 'swp-1.1': innerRadius was added");
    });

    it('radius is live on a bent path only with an explicit bendRadius; otherwise the bends were resolved at the exported radius and an edit warns', () => {
      const bent = [
        [0, 0, 0],
        [0, 0, 50],
        [30, 0, 80],
      ];
      const implicit = created(createEmptyDocument(), 'sweep_profile', { path: bent, radius: 2 });
      const implicitText = codeOf(implicit.doc, language);
      const exportedRun = runScript(implicitText, python, driver);
      const edited = runScript(implicitText.replace('radius=2', 'radius=3'), python, driver, true);
      expect(edited.stderr).toContain("SWG_CODEGEN_STALE: sweep 'swp-1.1': radius changed");
      expect(relError(edited.volumes[0] as number, exportedRun.volumes[0] as number), language + ' stays the exported solid').toBeLessThan(
        1e-9,
      );
      const explicit = created(createEmptyDocument(), 'sweep_profile', { path: bent, radius: 2, bendRadius: 10 });
      const explicitText = codeOf(explicit.doc, language);
      const base = runScript(explicitText, python, driver);
      const live = runScript(explicitText.replace('radius=2', 'radius=3'), python, driver);
      expect(live.stderr).not.toContain('SWG_CODEGEN_STALE');
      expect(
        relError(live.volumes[0] as number, ((base.volumes[0] as number) * 9) / 4),
        language + ' live radius on fixed bends',
      ).toBeLessThan(1e-6);
    });

    it('a live radius that sweep_profile would refuse (bend not wider than the section, mitre reach over a leg, bore over radius) raises a coded error', () => {
      const bent = [
        [0, 0, 0],
        [0, 0, 50],
        [30, 0, 80],
      ];
      const explicit = created(createEmptyDocument(), 'sweep_profile', { path: bent, radius: 2, bendRadius: 10 });
      const explicitText = codeOf(explicit.doc, language);
      expect(() => runScript(explicitText.replace('radius=2', 'radius=10'), python, driver, true)).toThrow(
        /SWG_CODEGEN_UNSUPPORTED: sweep 'swp-1.1': radius 10(\.0)? reaches/,
      );
      const mitred = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [60, 0, 0],
          [60, 60, 0],
        ],
        radius: 5,
        corners: 'miter',
      });
      const mitreText = codeOf(mitred.doc, language);
      expect(() => runScript(mitreText.replace('radius=5', 'radius=70'), python, driver, true)).toThrow(
        /SWG_CODEGEN_UNSUPPORTED: sweep 'swp-1.1': radius 70(\.0)? reaches 60/,
      );
      const ok = runScript(mitreText.replace('radius=5', 'radius=20'), python, driver);
      expect(relError(ok.volumes[0] as number, Math.PI * 400 * 120), language + ' mitre within its reach').toBeLessThan(1e-6);
      const tube = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [0, 0, 50],
        ],
        radius: 5,
        innerRadius: 3,
      });
      expect(() => runScript(codeOf(tube.doc, language).replace('innerRadius=3', 'innerRadius=6'), python, driver, true)).toThrow(
        /SWG_CODEGEN_UNSUPPORTED: sweep 'swp-1.1': radius 5(\.0)? \/ innerRadius 6/,
      );
    });

    it('the exported limits are exactly where sweep_profile refuses: a binding middle mitre leg, a bend radius', () => {
      const legs = [
        [0, 0, 0],
        [60, 0, 0],
        [60, 30, 0],
        [0, 30, 0],
      ];
      const mitred = created(createEmptyDocument(), 'sweep_profile', { path: legs, radius: 5, corners: 'miter' });
      const text = codeOf(mitred.doc, language);
      // legs 60 / 30 / 60 at 90 degrees: the middle leg carries both reaches, 2 r < 30. At exactly 15 sweep_profile's floating point
      // (15 * tan(pi / 4) = 14.999999999999998) still accepts while the script refuses (conservative): bracket the limit with 15.001 and 14.9
      expect(() => runScript(text.replace('radius=5', 'radius=15.001'), python, driver, true)).toThrow('radius 15.001 reaches 15 (');
      const refused = execute(createEmptyDocument(), 'sweep_profile', { path: legs, radius: 15.001, corners: 'miter' });
      expect(refused.affected).toHaveLength(0);
      expect(refused.error?.code).toBe('SWG_SELF_INTERSECTION_LOCAL');
      const edge = runScript(text.replace('radius=5', 'radius=14.9'), python, driver);
      const built = created(createEmptyDocument(), 'sweep_profile', { path: legs, radius: 14.9, corners: 'miter' });
      const expected = (execute(built.doc, 'mass_properties', { entityId: built.id }).data as { volume: number }).volume;
      expect(relError(edge.volumes[0] as number, Math.PI * 14.9 ** 2 * 150), language + ' mitre just inside its limit').toBeLessThan(1e-6);
      expect(relError(edge.volumes[0] as number, expected), language + ' agrees with the llull solid').toBeLessThan(2e-3);

      const bent = [
        [0, 0, 0],
        [0, 0, 50],
        [30, 0, 80],
      ];
      const elbow = created(createEmptyDocument(), 'sweep_profile', { path: bent, radius: 2, bendRadius: 10 });
      const elbowText = codeOf(elbow.doc, language);
      const base = runScript(elbowText, python, driver);
      const inside = runScript(elbowText.replace('radius=2', 'radius=9.9'), python, driver);
      expect(
        relError(inside.volumes[0] as number, ((base.volumes[0] as number) * 9.9 ** 2) / 4),
        language + ' bend just inside its limit',
      ).toBeLessThan(1e-6);
      const same = execute(createEmptyDocument(), 'sweep_profile', { path: bent, radius: 10, bendRadius: 10 });
      expect(same.error?.code).toBe('SWG_SELF_INTERSECTION_LOCAL');
      expect(execute(createEmptyDocument(), 'sweep_profile', { path: bent, radius: 9.9, bendRadius: 10 }).affected).toHaveLength(1);
    });

    it('a mitre (VC-38), a bored tube, a torus with a wobbling radius and a thru-sections loft', () => {
      let doc = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [100, 0, 0],
          [100, 100, 0],
        ],
        radius: 5,
        corners: 'miter',
      }).doc;
      doc = created(doc, 'sweep_profile', {
        path: [
          [0, 300, 0],
          [0, 300, 50],
        ],
        radius: 5,
        innerRadius: 3,
      }).doc;
      const ring = created(doc, 'draw_arc', { center: [0, 0], radius: 50, position: [0, 600, 0] });
      doc = created(ring.doc, 'sweep_profile', {
        pathId: ring.id,
        radius: 5,
        scale: { type: 'expression', expression: '1 + 0.25*sin(2*pi*t)' },
      }).doc;
      doc = created(doc, 'loft_sections', {
        sections: [
          { center: [0, 900, 0], radius: 1 },
          { center: [0, 900, 4], radius: 2 },
        ],
        ruled: true,
      }).doc;
      const [mitre, bored, torus, frustum] = volumesOf(doc) as [number, number, number, number];
      expect(relError(mitre, 15707.9632679)).toBeLessThan(1e-6);
      expect(relError(bored, Math.PI * (25 - 9) * 50)).toBeLessThan(1e-6);
      expect(relError(torus, 2 * Math.PI * 50 * Math.PI * 25 * (1 + 0.25 ** 2 / 2))).toBeLessThan(1e-5);
      expect(relError(frustum, (Math.PI * 4 * 7) / 3)).toBeLessThan(5e-4);
    });
  });
