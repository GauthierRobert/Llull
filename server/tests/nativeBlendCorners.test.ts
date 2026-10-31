/**
 * BLD M3 on the native OCCT kernel (docs/design/06-variable-blends, validation pack): setback corners of fillet_edge on a cube (VC-BLD-12) and at
 * a pyramid apex (VC-BLD-13), BLD_SETBACK_TOO_SHORT (VC-BLD-21), persistent vertex names (VC-BLD-22). Skipped when the llull-kernel binary is
 * not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

interface Face {
  readonly name?: string;
  readonly area?: number;
  readonly surface: string;
  readonly axis?: { readonly span?: readonly [number, number] };
}
interface CornerRow {
  readonly kind: string;
  readonly contacts: ReadonlyArray<{ readonly g0Gap: number; readonly g1AngleRad: number; readonly g1EndAngleRad: number }>;
}

describeNative('BLD M3: setback corners and persistent vertex names (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const cube = (size = 10): { doc: CadDocument; id: string } => {
    const made = execute(createEmptyDocument(), 'add_box', { size: [size, size, size] });
    return { doc: made.document, id: made.affected[0] as string };
  };
  const faces = (doc: CadDocument, id: string): Face[] => (execute(doc, 'inspect_topology', { id }).data as { faces: Face[] }).faces;
  const volume = (doc: CadDocument, id: string): number =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const rounded = (size: number, setback: number): { doc: CadDocument; id: string } => {
    const { doc, id } = cube(size);
    const done = execute(doc, 'fillet_edge', { id, radius: 1, corners: [{ all: true, type: 'setback', setback }] });
    expect(done.error).toBeUndefined();
    return { doc: done.document, id: done.affected[0] as string };
  };
  const spans = (list: Face[]): number[] =>
    list.filter((face) => face.surface === 'cylinder').map((face) => (face.axis?.span?.[1] ?? 0) - (face.axis?.span?.[0] ?? 0));

  it('VC-BLD-12: a 10-cube with all edges r 1 and setback 2 at the 8 corners: every blend cylinder spans 6, the volume lies in the bounds, the patches are G1', () => {
    const { doc, id } = rounded(10, 2);
    const list = faces(doc, id);
    // 6 planes, 12 blend cylinders and, at each of the 8 corners, a star of 6 exact sub-patches (06 BLD 13.21)
    expect(list).toHaveLength(66);
    const cylinderSpans = spans(list);
    expect(cylinderSpans).toHaveLength(12);
    for (const span of cylinderSpans) expect(Math.abs(span - 6)).toBeLessThan(1e-6);
    expect(list.filter((face) => face.name?.startsWith('blend(v:'))).toHaveLength(48);
    const solid = volume(doc, id);
    expect(solid).toBeGreaterThan(920.548667765);
    expect(solid).toBeLessThan(984.548667765);
    // golden (the thin-plate fill gave 969.73; the exact stars agree to 1e-5)
    expect(Math.abs(solid - 969.73)).toBeLessThan(0.05);
    const checked = execute(doc, 'check_blends', { ids: [id] });
    const data = checked.data as { status: string; blends: CornerRow[] };
    expect(data.status).toBe('pass');
    const patches = data.blends.filter((blend) => blend.kind === 'corner');
    expect(patches).toHaveLength(48);
    for (const patch of patches) {
      // the edge it shares with a blend or a flat face and its two spokes
      expect(patch.contacts).toHaveLength(3);
      for (const contact of patch.contacts) {
        expect(contact.g1AngleRad).toBeLessThan(0.01);
        expect(contact.g1EndAngleRad).toBeLessThan(0.01);
        // the default g0 (1e-6 x the diagonal), not the 5x of the thin-plate fill
        expect(contact.g0Gap).toBeLessThan(0.2e-6 * Math.sqrt(3) * 10);
      }
    }
  });

  it('a longer setback makes the blends shorter and the corners larger: span = edge - 2 x setback', () => {
    const { doc, id } = rounded(20, 3);
    for (const span of spans(faces(doc, id))) expect(Math.abs(span - 14)).toBeLessThan(1e-6);
    const per = cube();
    const done = execute(per.doc, 'fillet_edge', {
      id: per.id,
      radius: 1,
      corners: [{ all: true, setback: 2, setbacks: [{ near: [0, -5, -5], distance: 3 }] }],
    });
    expect(done.summary).not.toContain('no-op');
    expect(done.error).toBeUndefined();
    const lengths = spans(faces(done.document, done.affected[0] as string)).map((span) => Math.round(span * 1e6) / 1e6);
    expect(lengths.filter((span) => span === 4)).toHaveLength(1);
    expect(lengths.filter((span) => span === 6)).toHaveLength(11);
  });

  it('VC-BLD-13: the 4-edge apex of a pyramid takes a setback corner of 1.5 and stays a valid solid with tangent blends', () => {
    const made = execute(createEmptyDocument(), 'add_pyramid', { baseWidth: 10, baseDepth: 10, height: 10 });
    const id = made.affected[0] as string;
    const lateral = [
      [2.5, 2.5, 5],
      [-2.5, 2.5, 5],
      [-2.5, -2.5, 5],
      [2.5, -2.5, 5],
    ];
    const plain = execute(made.document, 'fillet_edge', { id, edgesNear: lateral, radius: 0.5 });
    expect(plain.error).toBeUndefined();
    const done = execute(made.document, 'fillet_edge', {
      id,
      edgesNear: lateral,
      radius: 0.5,
      corners: [{ near: [0, 0, 10], type: 'setback', setback: 1.5 }],
    });
    expect(done.error).toBeUndefined();
    const result = done.affected[0] as string;
    const list = faces(done.document, result);
    expect(list).toHaveLength(18);
    expect(list.filter((face) => face.name?.startsWith('blend(v:'))).toHaveLength(8);
    const checked = execute(done.document, 'check_blends', { ids: [result] }).data as { status: string; blends: CornerRow[] };
    expect(checked.status).not.toBe('fail');
    const patchRows = checked.blends.filter((blend) => blend.kind === 'corner');
    expect(patchRows).toHaveLength(8);
    for (const contact of patchRows.flatMap((row) => row.contacts)) expect(contact.g1AngleRad).toBeLessThan(0.01);
    expect(volume(done.document, result)).toBeLessThan(volume(plain.document, plain.affected[0] as string) + 1);
  });

  it('VC-BLD-21: a setback that does not exceed the distance the blends reach is BLD_SETBACK_TOO_SHORT with the minimum, the document unchanged', () => {
    const { doc, id } = cube();
    const refused = execute(doc, 'fillet_edge', { id, radius: 1, corners: [{ near: [5, 5, 5], type: 'setback', setback: 0.5 }] });
    expect(refused.document).toBe(doc);
    expect(refused.rejected).toBe(true);
    expect(refused.error).toMatchObject({ code: 'BLD_SETBACK_TOO_SHORT', ids: [id], paths: ['corners'] });
    expect(refused.summary).toContain('must exceed 1');
    expect(refused.error?.remediation).toContain('minimum');
    const equal = execute(doc, 'fillet_edge', { id, radius: 1, corners: [{ all: true, setback: 1 }] });
    expect(equal.error?.code).toBe('BLD_SETBACK_TOO_SHORT');
  });

  it('refuses what this build does not make with BLD_CORNER_UNSUPPORTED or BLD_CORNER_FAILED: an unrounded edge at the vertex, a concave edge, setbacks that leave no span', () => {
    const { doc, id } = cube();
    const lone = execute(doc, 'fillet_edge', { id, edgesNear: [[0, -5, -5]], radius: 1, corners: [{ near: [-5, -5, -5], setback: 2 }] });
    expect(lone.document).toBe(doc);
    expect(lone.error?.code).toBe('BLD_CORNER_UNSUPPORTED');
    expect(lone.summary).toContain('is not rounded');
    const crowded = execute(doc, 'fillet_edge', { id, radius: 1, corners: [{ all: true, setback: 6 }] });
    expect(crowded.document).toBe(doc);
    expect(crowded.error?.code).toBe('BLD_CORNER_FAILED');
    expect(crowded.summary).toContain('leave no length');
  });

  /** A cube of side 10 s with the octant [0, 6 s]^3 cut away: the inner vertex is at the origin of the document, the cube is centred on it. */
  const notched = (scale: number): { doc: CadDocument; id: string } => {
    const base = cube(10 * scale);
    const tool = execute(base.doc, 'add_box', { size: [6 * scale, 6 * scale, 6 * scale], position: [3 * scale, 3 * scale, 3 * scale] });
    const done = execute(tool.document, 'boolean', { op: 'subtract', a: base.id, b: tool.affected[0] as string });
    expect(done.error).toBeUndefined();
    return { doc: done.document, id: done.affected[0] as string };
  };

  for (const scale of [0.1, 1, 100]) {
    it(`a concave inner corner (a notch in a cube of ${10 * scale}) takes a setback corner that adds material and passes check_blends`, () => {
      const { doc, id } = notched(scale);
      const before = volume(doc, id);
      const inner = execute(doc, 'fillet_edge', {
        id,
        edgesNear: [
          [2.5 * scale, 0, 0],
          [0, 2.5 * scale, 0],
          [0, 0, 2.5 * scale],
        ],
        radius: 0.5 * scale,
        corners: [{ near: [0, 0, 0], type: 'setback', setback: 1.2 * scale }],
      });
      expect(inner.error).toBeUndefined();
      const resultId = inner.affected[0] as string;
      const list = faces(inner.document, resultId);
      expect(list.filter((face) => face.name?.startsWith('blend(v:'))).toHaveLength(6);
      expect(list.filter((face) => face.surface === 'cylinder')).toHaveLength(3);
      // three prisms of area r^2 (1 - pi / 4) over 5 s - 1.2 s, plus the patch region (measured 0.339 s^3, under a quarter of the cube of the setback)
      const prisms = 3 * 0.25 * scale ** 2 * (1 - Math.PI / 4) * 3.8 * scale;
      const added = volume(inner.document, resultId) - before;
      expect(added).toBeGreaterThan(prisms);
      expect(added).toBeLessThan(prisms + 0.4 * scale ** 3);
      const check = execute(inner.document, 'check_blends', { ids: [resultId] });
      expect(check.error).toBeUndefined();
      expect((check.data as { status: string }).status).toBe('pass');
    });
  }

  it('a vertex of convex and concave edges takes a setback corner (06 BLD 13.18); a concave setback keeps the names of split faces and replays', () => {
    const { doc, id } = notched(1);
    // the rim vertex (0, 0, 5) of the notch: two convex top edges and the concave edge down the notch, whose other end is the inner vertex (0, 0, 0)
    const mixed = execute(doc, 'fillet_edge', {
      id,
      edgesNear: [
        [2.5, 0, 0],
        [0, 2.5, 0],
        [0, 0, 2.5],
        [2.5, 0, 5],
        [0, 2.5, 5],
      ],
      radius: 0.5,
      corners: [
        { near: [0, 0, 0], type: 'setback', setback: 1.2 },
        { near: [0, 0, 5], type: 'setback', setback: 1.2 },
      ],
    });
    expect(mixed.error, mixed.summary).toBeUndefined();
    const mixedFaces = faces(mixed.document, mixed.affected[0] as string);
    expect(mixedFaces.filter((face) => face.name?.startsWith('blend(v:'))).toHaveLength(13); // a star of 7 at the rim, of 6 at the inner vertex
    expect(volume(mixed.document, mixed.affected[0] as string)).toBeGreaterThan(volume(doc, id));
    const checked = execute(mixed.document, 'check_blends', { ids: [mixed.affected[0] as string] }).data as { status: string };
    expect(checked.status).toBe('pass');
    // the same rim vertex without a corner at the inner vertex: the concave edge ends at (0, 0, 0), a vertex with no setback corner whose closing face is oblique to the edge
    const open = execute(doc, 'fillet_edge', {
      id,
      edgesNear: [
        [0, 0, 2.5],
        [2.5, 0, 5],
        [0, 2.5, 5],
      ],
      radius: 0.5,
      corners: [{ near: [0, 0, 5], type: 'setback', setback: 1.2 }],
    });
    expect(open.document).toBe(doc);
    expect(open.error?.code).toBe('BLD_CORNER_UNSUPPORTED');
    expect(open.summary).toContain('the face closing the rounded edge at [0, 0, 0] is too oblique to the edge');
    // split the face x = -5 (far from the notch) in two: its halves must come out of the concave setback with their names
    const split = execute(doc, 'split_face', { id, facesNear: [[-5, 0, 0]], plane: { origin: [0, 0, -2], normal: [0, 0, 1] } });
    expect(split.error).toBeUndefined();
    const splitId = split.affected[0] as string;
    const halves = faces(split.document, splitId).filter(
      (face) => face.name !== undefined && face.area !== undefined && face.area < 70 && face.area > 20,
    );
    expect(halves.length).toBeGreaterThanOrEqual(2);
    const done = execute(split.document, 'fillet_edge', {
      id: splitId,
      edgesNear: [
        [2.5, 0, 0],
        [0, 2.5, 0],
        [0, 0, 2.5],
      ],
      radius: 0.5,
      corners: [{ near: [0, 0, 0], type: 'setback', setback: 1.2 }],
    });
    expect(done.error).toBeUndefined();
    const after = faces(done.document, done.affected[0] as string).map((face) => face.name);
    for (const half of halves) expect(after).toContain(half.name);
    const replayed = execute(done.document, 'replay_history', {});
    expect(replayed.rejected).not.toBe(true);
    expect(replayed.error).toBeUndefined();
  });

  for (const size of [1, 10, 1000]) {
    it(`a radius linear from 0.08 to 0.12 x ${size} along every edge of a cube with setback size / 4 builds tangent patches; check_blends reads 0.09 to 0.11 x size over the blends`, () => {
      const { doc, id } = cube(size);
      const edges = Array.from({ length: 12 }, (_, index) => ({
        index,
        size: 0.08 * size,
        sizeEnd: 0.12 * size,
        interpolation: 'linear' as const,
      }));
      const done = execute(doc, 'fillet_edge', { id, edges, corners: [{ all: true, type: 'setback', setback: size / 4 }] });
      expect(done.error).toBeUndefined();
      const result = done.affected[0] as string;
      const list = faces(done.document, result);
      expect(list).toHaveLength(66);
      expect(list.filter((face) => face.name?.startsWith('blend(v:'))).toHaveLength(48);
      const checked = execute(done.document, 'check_blends', { ids: [result] }).data as {
        status: string;
        findings: Array<{ code: string }>;
        blends: Array<{ kind: string; lawChecked?: boolean; radius?: { min: number; max: number; at: Array<{ value: number }> } }>;
      };
      expect(checked.status).toBe('pass');
      expect(checked.findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_RADIUS_LAW');
      const rows = checked.blends.filter((row) => row.kind === 'edge');
      expect(rows).toHaveLength(12);
      for (const row of rows) {
        // the blend stops size / 4 from both ends of the edge (length size): its radius there is size x (0.08 + 0.04 x 0.25) at one end, x 0.75 at the other
        expect(row.lawChecked).toBe(true);
        expect((row.radius?.min ?? 0) / size).toBeCloseTo(0.09, 5);
        expect((row.radius?.max ?? 0) / size).toBeCloseTo(0.11, 5);
        const ends = [row.radius?.at[0]?.value ?? 0, row.radius?.at[(row.radius?.at.length ?? 1) - 1]?.value ?? 0].sort((x, y) => x - y);
        expect((ends[0] ?? 0) / size).toBeCloseTo(0.09, 5);
        expect((ends[1] ?? 0) / size).toBeCloseTo(0.11, 5);
      }
    });
  }

  it('a radius linear from 0.8 to 1.2 on a cube of 10 with setback 2.5 takes more material than r 1.2 and less than r 0.8', () => {
    const { doc, id } = cube();
    const edges = Array.from({ length: 12 }, (_, index) => ({ index, size: 0.8, sizeEnd: 1.2, interpolation: 'linear' as const }));
    const done = execute(doc, 'fillet_edge', { id, edges, corners: [{ all: true, type: 'setback', setback: 2.5 }] });
    expect(done.error).toBeUndefined();
    const constant = execute(doc, 'fillet_edge', { id, radius: 1.2, corners: [{ all: true, type: 'setback', setback: 2.5 }] });
    const smallest = execute(doc, 'fillet_edge', { id, radius: 0.8, corners: [{ all: true, type: 'setback', setback: 2.5 }] });
    const tapered = volume(done.document, done.affected[0] as string);
    expect(tapered).toBeGreaterThan(volume(constant.document, constant.affected[0] as string));
    expect(tapered).toBeLessThan(volume(smallest.document, smallest.affected[0] as string));
  });

  it('VC-BLD-22: the corners are recorded by vertex name; resizing the cube upstream re-runs the same corners; a gone vertex name is REF_LOST', () => {
    const { doc, id } = rounded(10, 2);
    const step = doc.featureHistory[1];
    const recorded = (step?.params as { corners: Array<{ name: string; setback: number }> }).corners;
    expect(recorded).toHaveLength(8);
    expect(recorded.every((entry) => entry.name.startsWith(`v(e(${id.replace(/\.\d+$/, '')}`) || entry.name.startsWith('v(e(box-'))).toBe(
      true,
    );
    expect(recorded.every((entry) => entry.setback === 2)).toBe(true);
    const boxStep = doc.featureHistory[0];
    const edited = execute(doc, 'edit_step_params', { stepId: boxStep?.id, params: { size: [30, 30, 30] } });
    expect(edited.rejected).not.toBe(true);
    const result = edited.document.order[0] as string;
    for (const span of spans(faces(edited.document, result))) expect(Math.abs(span - 26)).toBeLessThan(1e-6);
    const fresh = cube();
    const lost = execute(fresh.doc, 'fillet_edge', { id: fresh.id, radius: 1, corners: [{ name: 'v(e(gone))', setback: 2 }] });
    expect(lost.error?.code).toBe('REF_LOST');
    expect(lost.affected).toHaveLength(0);
  });

  it('VC-BLD-25: a setback fillet replays to the identical recipe and ids', () => {
    const { doc } = rounded(10, 2);
    const replayed = execute(doc, 'replay_history', {});
    expect(replayed.rejected).not.toBe(true);
    expect(Object.keys(replayed.document.entities)).toEqual(Object.keys(doc.entities));
    const recipe = (document: CadDocument): unknown => (document.entities[document.order[0] as string] as MeshSolidEntity).brep;
    expect(JSON.stringify(recipe(replayed.document))).toBe(JSON.stringify(recipe(doc)));
  });

  it('setbacks overrides survive replay_history and an upstream edit: the fillet is rebuilt with the same recipe, not dropped', () => {
    const { doc, id } = cube();
    const done = execute(doc, 'fillet_edge', {
      id,
      radius: 1,
      corners: [{ all: true, setback: 2, setbacks: [{ near: [0, -5, -5], distance: 3 }] }],
    });
    expect(done.error).toBeUndefined();
    const result = done.affected[0] as string;
    const recipe = (document: CadDocument): unknown => (document.entities[document.order[0] as string] as MeshSolidEntity).brep;
    const replayed = execute(done.document, 'replay_history', {});
    expect(replayed.rejected).not.toBe(true);
    expect(JSON.stringify(recipe(replayed.document))).toBe(JSON.stringify(recipe(done.document)));
    expect((recipe(replayed.document) as { op: string }).op).toBe('fillet');
    const lengths = (document: CadDocument): number[] =>
      spans(faces(document, document.order[0] as string)).map((span) => Math.round(span * 1e6) / 1e6);
    expect(lengths(replayed.document).sort()).toEqual(lengths(done.document).sort());
    const edited = execute(done.document, 'edit_step_params', {
      stepId: done.document.featureHistory[0]?.id,
      params: { size: [20, 20, 20] },
    });
    expect(edited.rejected).not.toBe(true);
    expect((recipe(edited.document) as { op: string }).op).toBe('fillet');
    const resized = lengths(edited.document);
    expect(resized.filter((span) => span === 14)).toHaveLength(1);
    expect(resized.filter((span) => span === 16)).toHaveLength(11);
    expect(result).toBeDefined();
  });

  it('works at every size: the patch is valid and G0 / G1 pass check_blends from a 1 mm to a 1000 mm cube (radius a tenth, setback twice the radius)', () => {
    for (const size of [1, 10, 100, 1000]) {
      const { doc, id } = cube(size);
      const done = execute(doc, 'fillet_edge', { id, radius: size / 10, corners: [{ all: true, setback: size / 5 }] });
      expect(done.error, `size ${size}`).toBeUndefined();
      const result = done.affected[0] as string;
      const checked = execute(done.document, 'check_blends', { ids: [result] }).data as {
        status: string;
        findings: Array<{ severity: string }>;
      };
      expect(
        checked.findings.filter((finding) => finding.severity === 'fail'),
        `size ${size}`,
      ).toEqual([]);
      expect(checked.status, `size ${size}`).not.toBe('fail');
    }
    const small = cube(1000);
    const tiny = execute(small.doc, 'fillet_edge', { id: small.id, radius: 1, corners: [{ all: true, setback: 2 }] });
    expect(tiny.error, 'a small corner on a large part').toBeUndefined();
    const tinyChecked = execute(tiny.document, 'check_blends', { ids: [tiny.affected[0] as string] }).data as {
      findings: Array<{ severity: string }>;
    };
    expect(tinyChecked.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);
    const thick = cube(10);
    const done = execute(thick.doc, 'fillet_edge', { id: thick.id, radius: 3, corners: [{ all: true, setback: 4 }] });
    expect(done.error).toBeUndefined();
    const checked = execute(done.document, 'check_blends', { ids: [done.affected[0] as string] }).data as {
      findings: Array<{ severity: string }>;
    };
    expect(checked.findings.filter((finding) => finding.severity === 'fail')).toEqual([]);
  }, 240_000);

  it('works for a part far from the origin (offset 1e5): the vertices are found and the corners built', () => {
    const made = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10], position: [1e5, 1e5, 1e5] });
    const done = execute(made.document, 'fillet_edge', { id: made.affected[0] as string, radius: 1, corners: [{ all: true, setback: 2 }] });
    expect(done.error).toBeUndefined();
    const result = done.affected[0] as string;
    expect(faces(done.document, result)).toHaveLength(66);
    for (const span of spans(faces(done.document, result))) expect(Math.abs(span - 6)).toBeLessThan(1e-5);
  });
});
