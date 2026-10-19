/**
 * VC-KRN-25 (01 KRN TR-KRN-05), analytic and probe half: the native `llull-kernel` (OCCT 7.9.2) against the OCP 7.9.3.1 numbers of the
 * validation pack — the 10 solids of `occt_crosscheck.json` (closed-form cases incl. the two at body station x = 70 m) and the measured
 * behaviours of `occt_behaviour_probe.json` (inertia vs coordinate offset, fuzzy fuse, plate-minus-cylinder face signature, fillet
 * history). Tolerances: VC-KRN-01 (volume / area / inertia rel 1e-9, centroid abs 1e-6 mm), VC-KRN-02 (inertia rel 1e-12 at 70 m).
 * NIST STEP corpus: nativeKernelReferenceNist.test.ts. Skipped with the reason logged when the binary is not built.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { ShapeTopology } from '@core/geometry/kernel';
import type { ExactMassProperties, FaceDetail } from '@core/geometry/kernelPorts';
import type { CurveSegment } from '@core/model/curve';
import type { ShapeRecipe, Vec2, Vec3 } from '@core/model/types';
import { sampleProfile } from '@core/geometry/curveSegments';
import { booleanRecipe, box, leaf } from './kernelTestSupport';
import { entity } from './nativeParitySupport';
import {
  faceSignature,
  nativeKernelBinary,
  nativeReferenceHarness,
  readReference,
  relative,
  WorstDeviations,
} from './nativeReferenceSupport';

interface Measured {
  readonly volume_mm3: number;
  readonly area_mm2: number;
  readonly centroid_mm: Vec3;
  readonly inertia_rho1_mm5: Vec3 | null;
}
interface CrossCheck {
  readonly ocp: string;
  readonly cases: readonly { readonly id: string; readonly valid: boolean; readonly occt: Measured }[];
}
interface Probe {
  readonly inertia_vs_offset: readonly { readonly x_mm: number; readonly iyy_rel_err: number }[];
  readonly part_frame_at_70m: Readonly<Record<string, number>>;
  readonly fuzzy_fuse: { readonly runs: readonly { readonly fuzzy: number; readonly solids: number; readonly faces: number }[] };
  readonly determinism_same_process: { readonly run1: { readonly faces: number; readonly sha256_16: string } };
  readonly fillet_history: {
    readonly faces_generated_from_edge: number;
    readonly input_faces_modified: number;
    readonly input_faces: number;
  };
}

const harness = nativeReferenceHarness();
const crossCheck = readReference<CrossCheck>('occt_crosscheck.json');
const analytic = readReference<{ cases: readonly ({ id: string } & Measured)[] }>('analytic_solids.json');
const probe = readReference<Probe>('occt_behaviour_probe.json');
const worst = new WorstDeviations();
afterAll(() => worst.report('analytic solids and probe'));

const STATION_X = 70_000;
/** Axis-aligned box from its min corner (the reference builds `BRepPrimAPI_MakeBox(corner, a, b, c)`). */
const boxAt = (corner: Vec3, size: Vec3): ShapeRecipe =>
  leaf(box([corner[0] + size[0] / 2, corner[1] + size[1] / 2, corner[2] + size[2] / 2], size));
/** llull cylinders are centred: base on z = `base`, axis +Z. */
const cylinder = (radius: number, height: number, base: Vec3 = [0, 0, 0]): ShapeRecipe =>
  leaf(entity('cylinder', { radius, height }, [base[0], base[1], base[2] + height / 2]));
const plateHole = (dx: number): ShapeRecipe =>
  booleanRecipe('subtract', boxAt([dx, 0, 0], [80, 60, 10]), cylinder(12, 12, [dx + 40, 30, -1]));
const POCKET = { blank: boxAt([0, 0, 0], [300, 120, 25]), pocket: boxAt([20, 20, 5], [260, 80, 21]) };

/** Rib: blank − square pocket, then the 4 vertical pocket edges filleted r 10 (the reference rounds the pocket outline with MakeFillet2d). */
async function ribPocket(): Promise<ShapeRecipe> {
  const cut = booleanRecipe('subtract', POCKET.blank, POCKET.pocket);
  const topology = (await harness.on('topology', cut)) as ShapeTopology;
  const corner = (value: number, a: number, b: number): boolean => Math.abs(value - a) < 1e-6 || Math.abs(value - b) < 1e-6;
  const edges = topology.edges
    .filter(({ mid }) => corner(mid[0], 20, 280) && corner(mid[1], 20, 100) && Math.abs(mid[2] - 15) < 1e-6)
    .map(({ index }) => index);
  expect(edges, 'the four vertical pocket corner edges').toHaveLength(4);
  return { op: 'fillet', source: cut, edges, size: 10 };
}

const RECIPES: Readonly<Record<string, () => ShapeRecipe | Promise<ShapeRecipe>>> = {
  'box-100x50x20': () => boxAt([0, 0, 0], [100, 50, 20]),
  'cyl-r10-h40': () => cylinder(10, 40),
  'tube-ro25-ri20-h100': () => booleanRecipe('subtract', cylinder(25, 100), cylinder(20, 102, [0, 0, -1])),
  'sphere-r25': () => leaf(entity('sphere', { radius: 25 })),
  'cone-r20-h60': () => leaf(entity('cone', { radius: 20, height: 60 })),
  'torus-R40-r8': () => leaf(entity('torus', { ringRadius: 40, tubeRadius: 8 })),
  'plate-hole-80x60x10-r12': () => plateHole(0),
  'rib-pocket-300x120x25': ribPocket,
  'box-station-70m': () => boxAt([STATION_X, 0, 0], [100, 50, 20]),
  'plate-hole-station-70m': () => plateHole(STATION_X),
};

/** Diagonal of the native inertia tensor ([Ixx, Iyy, Izz, Ixy, Ixz, Iyz]). */
const diagonal = (mass: ExactMassProperties): Vec3 => [mass.inertiaAtCentroid[0], mass.inertiaAtCentroid[1], mass.inertiaAtCentroid[2]];
const maxRelative = (actual: readonly number[], expected: readonly number[]): number =>
  Math.max(...expected.map((value, index) => relative(actual[index]!, value)));
const maxAbsolute = (actual: readonly number[], expected: readonly number[]): number =>
  Math.max(...expected.map((value, index) => Math.abs(actual[index]! - value)));

describe.skipIf(nativeKernelBinary === null)(
  'VC-KRN-25: native kernel vs the OCP 7.9.3 analytic cross-check (occt_crosscheck.json)',
  () => {
    it('covers every reference case', () => {
      expect(crossCheck.ocp).toBe('7.9.3.1');
      expect(Object.keys(RECIPES).sort()).toEqual(crossCheck.cases.map(({ id }) => id).sort());
    });

    it.each(crossCheck.cases.map((reference) => [reference.id, reference] as const))('%s', async (id, reference) => {
      const recipe = await RECIPES[id]!();
      const mass = (await harness.on('massProperties', recipe)) as ExactMassProperties;
      const analysis = (await harness.on('analyze', recipe)) as { valid: boolean; lumps: readonly { volume: number; area: number }[] };
      const closedForm = analytic.cases.find((item) => item.id === id)!;
      const ref = reference.occt;
      expect(analysis.valid, `${id} valid`).toBe(reference.valid);
      expect(analysis.lumps, `${id} one solid`).toHaveLength(1);
      // Like for like with the reference's default BRepGProp: `analyze` integrates the lump the same way.
      expect(worst.record('volume (raw BRepGProp)', relative(analysis.lumps[0]!.volume, ref.volume_mm3), id)).toBeLessThan(1e-9);
      expect(worst.record('area (raw BRepGProp)', relative(analysis.lumps[0]!.area, ref.area_mm2), id)).toBeLessThan(1e-9);
      expect(worst.record('volume', relative(mass.volume, ref.volume_mm3), id)).toBeLessThan(1e-9);
      expect(worst.record('area', relative(mass.area, ref.area_mm2), id)).toBeLessThan(1e-9);
      expect(worst.record('centroid (mm)', maxAbsolute(mass.centroid, ref.centroid_mm), id)).toBeLessThan(1e-6);
      expect(maxAbsolute(mass.centroid, closedForm.centroid_mm), `${id} centroid vs closed form`).toBeLessThan(1e-6);
      expect(relative(mass.volume, closedForm.volume_mm3), `${id} volume vs closed form`).toBeLessThan(1e-9);
      if (ref.inertia_rho1_mm5 === null || closedForm.inertia_rho1_mm5 === null) return;
      // The native kernel integrates in the part frame (TR-KRN-41): at 70 m it is closer to the closed form than raw BRepGProp
      // (whose 1.2e-9 cancellation error the reference records), so it is held to VC-KRN-02's 1e-12 against the closed form there.
      const far = id.includes('station-70m');
      const vsClosedForm = maxRelative(diagonal(mass), closedForm.inertia_rho1_mm5);
      worst.record(far ? 'inertia at 70 m vs closed form' : 'inertia vs closed form', vsClosedForm, id);
      expect(vsClosedForm, `${id} inertia vs closed form`).toBeLessThan(far ? 1e-12 : 1e-9);
      const vsReference = maxRelative(diagonal(mass), ref.inertia_rho1_mm5);
      worst.record(far ? 'inertia at 70 m vs reference (raw OCP error)' : 'inertia', vsReference, id);
      const referenceError = maxRelative(ref.inertia_rho1_mm5, closedForm.inertia_rho1_mm5);
      expect(vsReference, `${id} inertia vs reference`).toBeLessThan(far ? referenceError + 1e-12 : 1e-9);
    });
  },
);

describe.skipIf(nativeKernelBinary === null)('VC-KRN-25: the default Gauss rule on curved faces (closed form)', () => {
  // Ring: r from 1 to the arc through (2, 0), (2.5, 1), (2, 2) (centre r = 1.25, radius 1.25), h from 0 to 2, revolved about Z.
  // OCCT's adaptive Eps rule (the WASM kernel's) gives Ixx = 55.616 / Iyy = 55.586 here: 2.7e-4 off and not axisymmetric.
  const outer = (h: number): number => 1.25 + Math.sqrt(1.25 ** 2 - (h - 1) ** 2);
  const simpson = (f: (h: number) => number, n = 20_000): number => {
    let sum = f(0) + f(2);
    for (let i = 1; i < n; i++) sum += (i % 2 === 1 ? 4 : 2) * f((2 * i) / n);
    return (sum * 2) / n / 3;
  };
  const ring = (h: number): number => Math.PI * (outer(h) ** 2 - 1);
  const volume = simpson(ring);
  const centre = simpson((h) => h * ring(h)) / volume;
  const izz = simpson((h) => (Math.PI * (outer(h) ** 4 - 1)) / 2);
  const ixx = izz / 2 + simpson((h) => (h - centre) ** 2 * ring(h));

  it('arc-profile revolution about Z: volume and inertia at the closed form, Ixx = Iyy', async () => {
    const curves: CurveSegment<Vec2>[] = [
      {
        type: 'line',
        points: [
          [1, 0],
          [2, 0],
        ],
      },
      {
        type: 'arc',
        points: [
          [2, 0],
          [2.5, 1],
          [2, 2],
        ],
      },
      {
        type: 'line',
        points: [
          [2, 2],
          [1, 2],
        ],
      },
      {
        type: 'line',
        points: [
          [1, 2],
          [1, 0],
        ],
      },
    ];
    const solid = entity('revolution', { profile: sampleProfile(curves), curves, axis: [0, 0, 1], angle: 2 * Math.PI, segments: 32 });
    const mass = (await harness.on('massProperties', leaf(solid))) as ExactMassProperties;
    expect(worst.record('arc revolution volume vs closed form', relative(mass.volume, volume), 'ring')).toBeLessThan(1e-12);
    const inertia = maxRelative(diagonal(mass), [ixx, ixx, izz]);
    expect(worst.record('arc revolution inertia vs closed form', inertia, 'ring')).toBeLessThan(1e-12);
  });
});

describe.skipIf(nativeKernelBinary === null)(
  'VC-KRN-25: native kernel vs the OCP 7.9.3 behaviour probe (occt_behaviour_probe.json)',
  () => {
    const [A, B, C] = [100, 50, 20];
    const IYY = (A * B * C * (A * A + C * C)) / 12;

    it('inertia far from the origin: the part-frame evaluation keeps Iyy at the closed form where raw BRepGProp drifts', async () => {
      const rows: string[] = [];
      for (const { x_mm, iyy_rel_err } of probe.inertia_vs_offset) {
        const mass = (await harness.on('massProperties', boxAt([x_mm, 0, 0], [A, B, C]))) as ExactMassProperties;
        const error = relative(mass.inertiaAtCentroid[1], IYY);
        rows.push(`x ${x_mm} mm: native ${error.toExponential(2)}, OCP raw ${iyy_rel_err.toExponential(2)}`);
        expect(error, `x = ${x_mm} mm`).toBeLessThanOrEqual(Math.max(iyy_rel_err, 1e-14));
        expect(error, `x = ${x_mm} mm (TR-KRN-41)`).toBeLessThan(1e-12);
      }
      console.warn(`[VC-KRN-25] Iyy relative error vs offset:\n  ${rows.join('\n  ')}`);
      // An origin-authored part placed at 70 m (the reference's best mitigation, 3.3e-14) is no worse.
      const placed: ShapeRecipe = { op: 'place', source: boxAt([0, 0, 0], [A, B, C]), position: [STATION_X, 0, 0], rotation: [0, 0, 0] };
      const mass = (await harness.on('massProperties', placed)) as ExactMassProperties;
      expect(relative(mass.inertiaAtCentroid[1], IYY)).toBeLessThanOrEqual(
        probe.part_frame_at_70m['authored_at_origin_placed_by_location']!,
      );
    });

    it('fuse of two cubes 1e-5 mm apart without fuzzy value: 2 solids, 12 faces, valid (the fuzzy 0 run)', async () => {
      const [plain] = probe.fuzzy_fuse.runs;
      const fused = booleanRecipe('union', boxAt([0, 0, 0], [10, 10, 10]), boxAt([10 + 1e-5, 0, 0], [10, 10, 10]));
      const topology = (await harness.on('topology', fused)) as ShapeTopology;
      const analysis = (await harness.on('analyze', fused)) as { valid: boolean; lumps: readonly unknown[] };
      expect([topology.solids, topology.faces.length, analysis.lumps.length]).toEqual([plain!.solids, plain!.faces, plain!.solids]);
      expect(analysis.valid).toBe(true);
    });

    // The fuzzy 2e-5 run (2 -> 1 solid, 10 faces) needs a fuzzy value on the boolean recipe node: TR-KRN-12 is not built on any kernel.
    it.todo('fuse with SetFuzzyValue(2e-5): 1 solid, 10 faces (needs a fuzzy field on the boolean ShapeRecipe, TR-KRN-12)');

    it('plate minus cylinder: 7 faces, the same per-face signature in two independent sidecar processes', async () => {
      const reference = probe.determinism_same_process.run1;
      const recipe = plateHole(0);
      const signatureOf = async (from: typeof harness): Promise<string> => {
        const faces = (await from.on('faceQuery.faceDetails', recipe, { samples: 1 })) as readonly FaceDetail[];
        expect(faces).toHaveLength(reference.faces);
        return faceSignature(faces, 9);
      };
      const first = await signatureOf(harness);
      expect(await signatureOf(harness.fresh()), 'cross-process determinism').toBe(first);
      console.warn(`[VC-KRN-25] plate-minus-cylinder signature: native ${first}, OCP 7.9.3 ${reference.sha256_16}`);
      expect(first).toBe(reference.sha256_16);
    });

    it('fillet of one box edge: 1 face generated, 4 input faces modified, valid (history counts read off the result faces)', async () => {
      const reference = probe.fillet_history;
      const cube = boxAt([0, 0, 0], [10, 10, 10]);
      const filleted: ShapeRecipe = { op: 'fillet', source: cube, edges: [0], size: 1 };
      const before = (await harness.on('faceQuery.faceDetails', cube, { samples: 1 })) as readonly FaceDetail[];
      const after = (await harness.on('faceQuery.faceDetails', filleted, { samples: 1 })) as readonly FaceDetail[];
      const analysis = (await harness.on('analyze', filleted)) as { valid: boolean };
      const same = (a: FaceDetail, b: FaceDetail): boolean =>
        Math.abs(a.area - b.area) < 1e-9 && a.centroid.every((value, k) => Math.abs(value - b.centroid[k]!) < 1e-9);
      const generated = after.filter((face) => face.surface === 'cylinder');
      const untouched = before.filter((face) => after.some((other) => same(face, other)));
      expect(before).toHaveLength(reference.input_faces);
      expect(generated.map((face) => face.radius)).toEqual(Array(reference.faces_generated_from_edge).fill(1));
      expect(after).toHaveLength(reference.input_faces + reference.faces_generated_from_edge);
      expect(before.length - untouched.length, 'input faces modified').toBe(reference.input_faces_modified);
      expect(analysis.valid).toBe(true);
    });
  },
);
