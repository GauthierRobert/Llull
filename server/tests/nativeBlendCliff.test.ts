/**
 * BLD M4/M5 on the native OCCT kernel (docs/design/06-variable-blends, TECHNICAL_SPEC 13.28): fillet_faces `cliff`, the blend that stops at the far edge
 * of a face narrower than the tangent contact distance. The oracle is the closed form of the section (a ball tangent to one face and touching the cliff
 * edge) times the length. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
interface Face {
  readonly name?: string;
  readonly area: number;
  readonly surface?: string;
}

const DEPTH = 10;
const LEDGE = 2;

/** Section of the cliff blend at a right angle: ball radius r touching a cliff edge `w` off the corner and tangent to the other face. */
function section(r: number, w: number): { reach: number; theta: number; area: number } {
  const reach = Math.sqrt(r * r - (r - w) * (r - w));
  const chord = Math.hypot(w, reach);
  const theta = 2 * Math.asin(chord / (2 * r));
  const area = (w * reach) / 2 - (r * r * (theta - Math.sin(theta))) / 2;
  return { reach, theta, area };
}

/**
 * Section of the cliff blend at the wedge angle `alpha` (radians) between the cliff face and the other face: P at `w` along the cliff face, Q at
 * `reach` along the other face, ball centre (reach, r). `area` is the triangle corner-Q-P minus the circular segment under the chord PQ;
 * `edgeAngle` the angle (degrees) at P between the blend's outward normal and the face beyond the cliff edge (whose normal runs along the cliff face).
 */
function sectionAt(
  r: number,
  w: number,
  alpha: number,
  convex: boolean,
): { reach: number; theta: number; area: number; edgeAngle: number } {
  const height = w * Math.sin(alpha);
  const reach = w * Math.cos(alpha) + Math.sqrt(r * r - (r - height) * (r - height));
  const chord = Math.hypot(w * Math.cos(alpha) - reach, height);
  const theta = 2 * Math.asin(chord / (2 * r));
  const area = (w * reach * Math.sin(alpha)) / 2 - (r * r * (theta - Math.sin(theta))) / 2;
  const away = [(w * Math.cos(alpha) - reach) / r, (height - r) / r] as const;
  const cosine = (convex ? 1 : -1) * (away[0] * Math.cos(alpha) + away[1] * Math.sin(alpha));
  return { reach, theta, area, edgeAngle: (Math.acos(cosine) * 180) / Math.PI };
}

describeNative('BLD cliff edges of fillet_faces (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const made = (
    doc: Doc,
    command: string,
    params: Record<string, unknown>,
  ): { doc: Doc; id: string; result: ReturnType<typeof execute> } => {
    const result = execute(doc, command, params);
    return { doc: result.document, id: result.affected[0] as string, result };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const faces = (doc: Doc, id: string): Face[] => (execute(doc, 'inspect_topology', { id }).data as { faces: Face[] }).faces;
  // convex: block 10 x 3 with a ledge 2 wide, 5 high at its right: the top of the ledge (y = 5, x 8..10) is the cliff face, the wall x = 10 the other
  const ledge = (): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [10, 0],
        [10, 5],
        [8, 5],
        [8, 3],
        [0, 3],
      ],
      depth: DEPTH,
    });
  const convexSets = { facesA: { near: [[9, 5, 5]] }, facesB: { near: [[10, 2, 5]] } };
  // concave: wall x = 4 (y 2..10) over a ledge y = 2, x 4..6
  const step = (): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [6, 0],
        [6, 2],
        [4, 2],
        [4, 10],
        [0, 10],
      ],
      depth: DEPTH,
    });
  const concaveSets = { facesA: { near: [[5, 2, 5]] }, facesB: { near: [[4, 6, 5]] } };

  it('without cliff a ledge narrower than the contact distance is refused; with cliff the convex blend removes the closed-form section area', () => {
    const { doc, id } = ledge();
    expect(execute(doc, 'fillet_faces', { id, ...convexSets, radius: 3 }).error?.code).toBe('BLD_RADIUS_TOO_LARGE');
    const done = made(doc, 'fillet_faces', { id, ...convexSets, radius: 3, cliff: 'A' });
    expect(done.result.error).toBeUndefined();
    const { area, theta, reach } = section(3, LEDGE);
    expect(Math.abs(volume(doc, id) - volume(done.doc, done.id) - area * DEPTH)).toBeLessThan(1e-6);
    const data = done.result.data as {
      blends: Array<{ name: string }>;
      consumedFaces: string[];
      cliffEngaged: boolean;
      cliffEdgeAngle: number;
      cliffFace: string;
    };
    expect(data.blends).toHaveLength(1);
    expect(data.consumedFaces).toHaveLength(1);
    expect(data.cliffEngaged).toBe(true);
    expect(data.cliffFace).toBe(data.consumedFaces[0]);
    expect(data.cliffEdgeAngle).toBeCloseTo(sectionAt(3, LEDGE, Math.PI / 2, true).edgeAngle, 3);
    expect(done.result.summary).toContain(`sharp (${data.cliffEdgeAngle}°) at the cliff edge`);
    const blend = faces(done.doc, done.id).find((face) => face.name === data.blends[0]?.name);
    expect(blend?.surface).toBe('cylinder');
    expect(blend?.area).toBeCloseTo(3 * theta * DEPTH, 6);
    // the blend leaves the wall at 5 - reach: the wall lost exactly that much
    const wall = faces(done.doc, done.id).find((face) => face.area > 0 && Math.abs(face.area - (5 - reach) * DEPTH) < 1e-6);
    expect(wall).toBeDefined();
  });

  it('the cliff on facesB is the same blend with the sets swapped', () => {
    const { doc, id } = ledge();
    const onA = made(doc, 'fillet_faces', { id, ...convexSets, radius: 3, cliff: 'A' });
    const onB = made(doc, 'fillet_faces', { id, facesA: convexSets.facesB, facesB: convexSets.facesA, radius: 3, cliff: 'B' });
    expect(onB.result.error).toBeUndefined();
    expect(volume(onB.doc, onB.id)).toBeCloseTo(volume(onA.doc, onA.id), 9);
  });

  it('a concave cliff adds the same closed-form section area', () => {
    const { doc, id } = step();
    const done = made(doc, 'fillet_faces', { id, ...concaveSets, radius: 3, cliff: 'A' });
    expect(done.result.error).toBeUndefined();
    expect(Math.abs(volume(done.doc, done.id) - volume(doc, id) - section(3, LEDGE).area * DEPTH)).toBeLessThan(1e-6);
  });

  it('check_blends reads the cliff blend: one G1 contact against the other face, nothing failing (the cliff edge has no tangent support to judge)', () => {
    const { doc, id } = ledge();
    const done = made(doc, 'fillet_faces', { id, ...convexSets, radius: 3, cliff: 'A' });
    const checked = execute(done.doc, 'check_blends', {}).data as {
      status: string;
      blends: Array<{ contacts: Array<{ order: string; g1AngleRad: number }> }>;
      findings: Array<{ severity: string; code: string; value: number; message: string }>;
    };
    expect(checked.status).toBe('pass');
    expect(checked.blends).toHaveLength(1);
    expect(checked.blends[0]?.contacts.map((contact) => contact.order)).toEqual(['G1']);
    expect(checked.blends[0]?.contacts[0]?.g1AngleRad).toBeLessThan(1e-6);
    expect(checked.findings.every((finding) => finding.severity === 'info')).toBe(true);
    const row = checked.findings.find((finding) => finding.code === 'BLD_CHECK_CLIFF_EDGE');
    expect(row?.message).toContain('cliff edge, not a tangent contact (angle');
    expect((row?.value ?? 0) * (180 / Math.PI)).toBeCloseTo(sectionAt(3, LEDGE, Math.PI / 2, true).edgeAngle, 3);
  });

  it('a cliff that is not needed leaves the ordinary tangent blend (the face is wide enough)', () => {
    const { doc, id } = ledge();
    const ordinary = made(doc, 'fillet_faces', { id, ...convexSets, radius: 1.5 });
    const asked = made(doc, 'fillet_faces', { id, ...convexSets, radius: 1.5, cliff: 'A' });
    expect(ordinary.result.error).toBeUndefined();
    expect(asked.result.data).toMatchObject({ cliffEngaged: false });
    expect(asked.result.summary).toContain('plain tangent blend was built');
    expect(volume(asked.doc, asked.id)).toBeCloseTo(volume(ordinary.doc, ordinary.id), 9);
    expect(Math.abs(volume(doc, id) - volume(ordinary.doc, ordinary.id) - (1 - Math.PI / 4) * 1.5 * 1.5 * DEPTH)).toBeLessThan(1e-6);
  });

  it('refuses by name: a radius below the cliff height, a ball that leaves the other face, a cliff face that is not a band, a cliff with a law', () => {
    const { doc, id } = ledge();
    // fold 120 degrees (the wall leans in 60 degrees from the ledge): the cliff stands 2 sin 60 = 1.732 off the wall, more than a ball of 1.5
    const leaning = made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [10 - 5 / Math.tan(Math.PI / 3), 0],
        [10, 5],
        [8, 5],
        [8, 3],
        [0, 3],
      ],
      depth: DEPTH,
    });
    const leaningSets = { facesA: convexSets.facesA, facesB: { near: [[10 - 2.5 / Math.tan(Math.PI / 3), 2.5, 5]] } };
    const stands = execute(leaning.doc, 'fillet_faces', { id: leaning.id, ...leaningSets, radius: 1.5, cliff: 'A' });
    expect(stands.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['radius'] });
    expect(stands.summary).toContain('ball radius');
    expect(stands.document).toBe(leaning.doc);
    expect(execute(leaning.doc, 'fillet_faces', { id: leaning.id, ...leaningSets, radius: 2, cliff: 'A' }).error).toBeUndefined();
    const off = execute(doc, 'fillet_faces', { id, ...convexSets, radius: 20, cliff: 'A' });
    expect(off.error).toMatchObject({ code: 'BLD_FACE_FILLET_NO_SOLUTION' });
    const drilled = made(doc, 'add_hole', {
      target: id,
      face: { near: [9, 5, 5] },
      points: [[9, 5, 5]],
      pointsFrame: 'world',
      hole: { kind: 'simple', diameter: 1 },
      extent: { kind: 'through_all' },
    });
    const notBand = execute(drilled.doc, 'fillet_faces', {
      id: drilled.id,
      facesA: { near: [[8.2, 5, 1]] },
      facesB: convexSets.facesB,
      radius: 3,
      cliff: 'A',
    });
    expect(notBand.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(notBand.summary).toContain('band');
    const withLaw = execute(doc, 'fillet_faces', { id, ...convexSets, law: { expression: '3' }, cliff: 'A' });
    expect(withLaw.error).toMatchObject({ code: 'BLD_BLEND_PARAMS', paths: ['cliff'] });
  });
  // wedge angle alpha between the cliff face and the other face; convex: the ledge (w wide) of the block, its wall leaning so that the wedge is alpha
  const convexAt = (alpha: number, w: number): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [10 - 5 / Math.tan(alpha), 0],
        [10, 5],
        [10 - w, 5],
        [10 - w, 3],
        [0, 3],
      ],
      depth: DEPTH,
    });
  // concave: air wedge alpha above a ledge of width w whose wall (8 high) rises from the ledge's near edge
  const concaveAt = (alpha: number, w: number): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [-5, 0],
        [4 + w, 0],
        [4 + w, 2],
        [4, 2],
        [4 + 8 / Math.tan(alpha), 10],
        [-5, 10],
      ],
      depth: DEPTH,
    });

  it.each([
    ['convex, wall leaning in', 'convex', 60, 2, 2],
    ['convex, wall leaning out', 'convex', 120, 0.5, 2],
    ['concave, wall over the ledge', 'concave', 60, 2, 2],
    ['concave, wall leaning away', 'concave', 120, 0.5, 2],
  ] as const)(
    '%s: the volume change is the closed-form section area times the length, the angle at the cliff edge matches',
    (_label, kind, degrees, w, r) => {
      const alpha = (degrees * Math.PI) / 180;
      const convex = kind === 'convex';
      const { doc, id } = convex ? convexAt(alpha, w) : concaveAt(alpha, w);
      const sets = convex
        ? { facesA: { near: [[10 - w / 2, 5, 5]] }, facesB: { near: [[10 - 2.5 / Math.tan(alpha), 2.5, 5]] } }
        : { facesA: { near: [[4 + w / 2, 2, 5]] }, facesB: { near: [[4 + 3 * Math.cos(alpha), 2 + 3 * Math.sin(alpha), 5]] } };
      const done = made(doc, 'fillet_faces', { id, ...sets, radius: r, cliff: 'A' });
      expect(done.result.error).toBeUndefined();
      const expected = sectionAt(r, w, alpha, convex);
      const change = convex ? volume(doc, id) - volume(done.doc, done.id) : volume(done.doc, done.id) - volume(doc, id);
      expect(Math.abs(change - expected.area * DEPTH)).toBeLessThan(1e-5);
      const data = done.result.data as { cliffEngaged: boolean; cliffEdgeAngle: number; blends: Array<{ name: string }> };
      expect(data.cliffEngaged).toBe(true);
      expect(data.cliffEdgeAngle).toBeCloseTo(expected.edgeAngle, 3);
      const blend = faces(done.doc, done.id).find((face) => face.name === data.blends[0]?.name);
      expect(blend?.area).toBeCloseTo(r * expected.theta * DEPTH, 5);
    },
  );

  it('a cliff face that does not reach the corner line (a chamfer between) is refused by name, not cut with the material between', () => {
    const { doc, id } = ledge();
    const chamfered = made(doc, 'chamfer_edge', { id, edgesNear: [[10, 5, 5]], distance: 0.5 });
    expect(chamfered.result.error).toBeUndefined();
    const refused = execute(chamfered.doc, 'fillet_faces', { id: chamfered.id, ...convexSets, radius: 3, cliff: 'A' });
    expect(refused.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(refused.summary).toContain('reach the corner line');
    expect(refused.document).toBe(chamfered.doc);
  });

  it('a document with a cliff fillet survives save, load and replay: same recipe, same solid', () => {
    const { doc, id } = ledge();
    const done = made(doc, 'fillet_faces', { id, ...convexSets, radius: 3, cliff: 'A' });
    const loaded = deserializeDocument(serializeDocument(done.doc));
    const replayed = execute(loaded, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    const recipe = (document: Doc): unknown => (document.entities[done.id] as { brep?: unknown }).brep;
    expect(recipe(loaded)).toMatchObject({ op: 'faceBlend', cliff: 'A' });
    expect(recipe(replayed.document)).toEqual(recipe(done.doc));
    expect(volume(replayed.document, done.id)).toBeCloseTo(volume(done.doc, done.id), 9);
  });
});
