/**
 * 03 WRP M3 commands on a fake exact kernel: emboss_on_face (emboss / deboss / scribe, text, the refusal codes of the pack) and check_wrap. The fake kernel's
 * emboss volume is the closed form, so these tests prove the commands' own bookkeeping; the kernel itself is proved in server/tests/nativeWrap*.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { setFontProvider } from '@core/commands/fontPort';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { CadDocument, ShapeRecipe } from '@core/model/types';
import { fakeWrapKernel } from '../../helpers/fakeWrapKernel';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { cone, cylinder, emptyDoc, FACE, labelOn, make, meshOf, rectangleOn, sphere, useFakeKernel } from './support';
import { firaProvider } from './fixtures';

const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;

describe('emboss_on_face (VC-WRP-10, 14, 16)', () => {
  useFakeKernel();

  const rectangle = (): { doc: CadDocument; solid: string; profile: string } => {
    const base = cylinder();
    const rect = rectangleOn(base.doc, 30, 10);
    return { doc: rect.doc, solid: base.id, profile: rect.id };
  };

  it('embosses a 30 x 10 rectangle 1 mm on r 20: +307.5 mm3, one mesh with the exact emboss recipe, the profile kept, the face name recorded', () => {
    const { doc, solid, profile } = rectangle();
    const result = execute(doc, 'emboss_on_face', {
      id: solid,
      face: FACE,
      profileIds: [profile],
      mode: 'emboss',
      depth: 1,
      placement: { method: 'develop' },
    });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    const mesh = meshOf(result.document, result.affected[0] as string);
    expect(mesh.brep?.op).toBe('emboss');
    expect(result.document.entities[solid]).toBeUndefined();
    expect(result.document.entities[profile]).toBeDefined();
    expect(result.document.order).toContain(mesh.id);
    expect(relative(data(result)['volumeDelta'] as number, 307.5)).toBeLessThan(1e-12);
    expect(relative(data(result)['expectedVolumeDelta'] as number, 307.5)).toBeLessThan(1e-12);
    expect(data(result)).toMatchObject({
      regions: 1,
      loops: 1,
      mode: 'emboss',
      depth: 1,
      method: 'develop',
      faceKind: 'cylinder',
      convex: true,
      volumeUnit: 'mm^3',
      unverified: false,
    });
    expect(relative(data(result)['regionArea'] as number, 300)).toBeLessThan(1e-12);
    expect(data(result)['angularSpanRad']).toBeCloseTo(1.5, 9);
    expect(data(result)['defaults']).toEqual([
      expect.objectContaining({ name: 'fitTolerance' }),
      expect.objectContaining({ name: 'maxLengthStrain', value: 0.02 }),
    ]);
    expect(result.document.featureHistory.at(-1)?.params).toMatchObject({ face: { faceName: `${solid}:side` } });
    expect(result.summary).toContain('+307.500000');
    expectPure(doc, () => execute(doc, 'emboss_on_face', { id: solid, face: FACE, profileIds: [profile], mode: 'emboss', depth: 1 }));
  });

  it('debosses (-292.5), scribes (no material, faces kept) and records the same regions', () => {
    const { doc, solid, profile } = rectangle();
    const sunk = execute(doc, 'emboss_on_face', { id: solid, face: FACE, profileIds: [profile], mode: 'deboss', depth: 1 });
    expect(relative(data(sunk)['volumeDelta'] as number, -292.5)).toBeLessThan(1e-12);
    const scribed = execute(doc, 'emboss_on_face', { id: solid, face: FACE, profileIds: [profile], mode: 'scribe' });
    expect(scribed.rejected, scribed.summary).toBeUndefined();
    expect(data(scribed)['volumeDelta']).toBeCloseTo(0, 12);
    expect(data(scribed)['expectedVolumeDelta']).toBe(0);
    expect(relative(data(scribed)['regionArea'] as number, 300)).toBeLessThan(1e-12);
    expect((meshOf(scribed.document, scribed.affected[0] as string).brep as { mode: string }).mode).toBe('scribe');
  });

  it('embosses LLULL (5 regions) and a letter with a hole (outer + hole loop) from the bundled font; replay reproduces the document', () => {
    const base = cylinder();
    const label = labelOn(base.doc, 'LLULL');
    const text = execute(label.doc, 'emboss_on_face', { id: base.id, face: FACE, profileIds: [label.id], mode: 'emboss', depth: 1 });
    expect(data(text)).toMatchObject({ regions: 5, loops: 5 });
    expect(relative(data(text)['regionArea'] as number, 104.8862209)).toBeLessThan(1e-9);
    expect(relative(data(text)['volumeDelta'] as number, 107.5083764)).toBeLessThan(1e-7);
    const letter = labelOn(base.doc, 'O');
    const hole = execute(letter.doc, 'emboss_on_face', { id: base.id, face: FACE, profileIds: [letter.id], mode: 'deboss', depth: 1 });
    expect(data(hole)).toMatchObject({ regions: 1, loops: 2 });
    const node = meshOf(hole.document, hole.affected[0] as string).brep as Extract<ShapeRecipe, { op: 'emboss' }>;
    expect(node.regions[0]?.holes).toHaveLength(1);
    const replayed = execute(text.document, 'replay_history', {});
    expect(replayed.rejected, replayed.summary).toBeUndefined();
    expect(JSON.stringify(replayed.document.entities)).toBe(JSON.stringify(text.document.entities));
  });

  it('works on a cone (Steiner closed form), a planar face (A d) and a bore (inward normal)', () => {
    const base = cone();
    const rect = rectangleOn(base.doc, 4, 4);
    const placement = { anchor: { chart: [0, 0], on: [10, 0, 20] } };
    const onCone = execute(rect.doc, 'emboss_on_face', {
      id: base.id,
      face: { faceNear: [10, 0, 20] },
      profileIds: [rect.id],
      mode: 'emboss',
      depth: 1,
      placement,
    });
    expect(onCone.rejected, onCone.summary).toBeUndefined();
    expect(data(onCone)['faceKind']).toBe('cone');
    expect(data(onCone)['angularSpanRad']).toBeGreaterThan(0);
    expect(data(onCone)['volumeDelta']).toBeGreaterThan(16);
    const flat = make(emptyDoc(), 'add_box', { size: [60, 40, 10] });
    const patch = make(flat.doc, 'draw_rectangle', { width: 10, height: 6, position: [-5, -3, 0] });
    const onPlane = execute(patch.doc, 'emboss_on_face', {
      id: flat.id,
      face: { faceNear: [0, 0, 5] },
      profileIds: [patch.id],
      mode: 'emboss',
      depth: 2,
    });
    expect(relative(data(onPlane)['volumeDelta'] as number, 120)).toBeLessThan(1e-12);
    expect(data(onPlane)['angularSpanRad']).toBeUndefined();
  });

  it('refuses a missing, zero, negative or non-finite depth (WRP_DEPTH_INVALID) except for scribe', () => {
    const { doc, solid, profile } = rectangle();
    for (const depth of [undefined, 0, -1]) {
      const params = { id: solid, face: FACE, profileIds: [profile], mode: 'deboss', ...(depth === undefined ? {} : { depth }) };
      expectRefusal(doc, 'emboss_on_face', params, 'WRP_DEPTH_INVALID', 'depth');
    }
    expect(execute(doc, 'emboss_on_face', { id: solid, face: FACE, profileIds: [profile], mode: 'scribe' }).rejected).toBeUndefined();
  });

  it('refuses open profiles, self-crossing loops, solids and text without a font', () => {
    const { doc, solid, profile } = rectangle();
    const open = make(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 5],
      ],
    });
    expectRefusal(
      open.doc,
      'emboss_on_face',
      { id: solid, face: FACE, profileIds: [open.id], mode: 'emboss', depth: 1 },
      'WRP_PROFILE_OPEN',
      'profileIds.0',
    );
    expectRefusal(open.doc, 'emboss_on_face', { id: solid, face: FACE, profileIds: [open.id], mode: 'scribe' }, 'WRP_PROFILE_OPEN');
    const bowTie = make(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [4, 4],
        [4, 0],
        [0, 4],
      ],
      closed: true,
    });
    expectRefusal(
      bowTie.doc,
      'emboss_on_face',
      { id: solid, face: FACE, profileIds: [bowTie.id], mode: 'emboss', depth: 1 },
      'WRP_PROFILE_SELF_INTERSECT',
    );
    expectRefusal(doc, 'emboss_on_face', { id: solid, face: FACE, profileIds: [solid], mode: 'emboss', depth: 1 }, 'WRP_PROFILE_EMPTY');
    const note = make(doc, 'add_text', { content: 'note', position: [0, 0, 0], height: 3 });
    expectRefusal(
      note.doc,
      'emboss_on_face',
      { id: solid, face: FACE, profileIds: [note.id], mode: 'emboss', depth: 1 },
      'WRP_TEXT_NO_FONT',
    );
    expectRefusal(
      doc,
      'emboss_on_face',
      { id: solid, face: FACE, profileIds: ['nope'], mode: 'emboss', depth: 1 },
      'WRP_ENTITY_NOT_FOUND',
      'profileIds.0',
    );
    expectRefusal(
      doc,
      'emboss_on_face',
      { id: 'nope', face: FACE, profileIds: [profile], mode: 'emboss', depth: 1 },
      'WRP_ENTITY_NOT_FOUND',
      'id',
    );
  });

  it('refuses a wrap beyond one turn, a region off the face, a deboss as deep as the radius (data.maxDepth), a sphere and the unbuilt methods', () => {
    const { doc, solid, profile } = rectangle();
    const wide = rectangleOn(doc, 130, 10);
    const overlap = expectRefusal(
      wide.doc,
      'emboss_on_face',
      { id: solid, face: FACE, profileIds: [wide.id], mode: 'emboss', depth: 1 },
      'WRP_WRAP_OVERLAP',
      'profileIds',
    );
    expect(overlap.data).toMatchObject({ fullWrapChartWidth: expect.closeTo(125.6637, 3) });
    const deep = expectRefusal(
      doc,
      'emboss_on_face',
      { id: solid, face: FACE, profileIds: [profile], mode: 'deboss', depth: 25 },
      'WRP_DEPTH_EXCEEDS_SOLID',
      'depth',
    );
    expect(deep.data).toMatchObject({ maxDepth: 20 });
    expect(
      execute(doc, 'emboss_on_face', { id: solid, face: FACE, profileIds: [profile], mode: 'emboss', depth: 25 }).rejected,
    ).toBeUndefined();
    const placement = { method: 'project' };
    expectRefusal(
      doc,
      'emboss_on_face',
      { id: solid, face: FACE, profileIds: [profile], mode: 'emboss', depth: 1, placement },
      'WRP_METHOD_UNAVAILABLE',
    );
    const ball = sphere();
    const small = rectangleOn(ball.doc, 4, 4);
    const near = { faceNear: [0, 0, 25] };
    expectRefusal(
      small.doc,
      'emboss_on_face',
      { id: ball.id, face: near, profileIds: [small.id], mode: 'emboss', depth: 1 },
      'WRP_FACE_NOT_DEVELOPABLE',
    );
    setGeometryKernel(fakeWrapKernel({ outside: (point) => point[2] > 3 }));
    expectRefusal(
      doc,
      'emboss_on_face',
      { id: solid, face: FACE, profileIds: [profile], mode: 'emboss', depth: 1, placement: { anchor: { chart: [0, 0], on: [20, 0, 5] } } },
      'WRP_OUTSIDE_FACE',
    );
  });

  it('refuses when the exact kernel cannot build the result, has no emboss, or is absent; a cone deboss as deep as its local radius', () => {
    const { doc, solid, profile } = rectangle();
    setGeometryKernel(fakeWrapKernel({ refuseEmboss: true }));
    expectRefusal(
      doc,
      'emboss_on_face',
      { id: solid, face: FACE, profileIds: [profile], mode: 'emboss', depth: 1 },
      'WRP_KERNEL_BUILD_FAILED',
    );
    setGeometryKernel(fakeWrapKernel({ noFaceQuery: true }));
    expectRefusal(
      doc,
      'emboss_on_face',
      { id: solid, face: FACE, profileIds: [profile], mode: 'emboss', depth: 1 },
      'CMD_KERNEL_UNAVAILABLE',
    );
    setGeometryKernel(null);
    expect(execute(doc, 'emboss_on_face', { id: solid, face: FACE, profileIds: [profile], mode: 'emboss', depth: 1 }).error?.code).toBe(
      'CMD_KERNEL_UNAVAILABLE',
    );
    setGeometryKernel(fakeWrapKernel());
    const base = cone();
    const rect = rectangleOn(base.doc, 2, 2);
    const result = execute(rect.doc, 'emboss_on_face', {
      id: base.id,
      face: { faceNear: [10, 0, 20] },
      profileIds: [rect.id],
      mode: 'deboss',
      depth: 10,
      placement: { anchor: { chart: [0, 0], on: [10, 0, 20] } },
    });
    expect(result.error?.code).toBe('WRP_DEPTH_EXCEEDS_SOLID');
    expectNoOp(execute(doc, 'emboss_on_face', { id: solid, face: FACE, profileIds: [], mode: 'emboss', depth: 1 }), doc);
  });

  it('limits a cone deboss by the part of the profile nearest the apex, and reports the azimuth span next to the developed sector', () => {
    const base = cone();
    const placement = { anchor: { chart: [0, 0], on: [10, 0, 20] } };
    const limitFor = (height: number): number => {
      const rect = rectangleOn(base.doc, 2, height);
      const result = execute(rect.doc, 'emboss_on_face', {
        id: base.id,
        face: { faceNear: [10, 0, 20] },
        profileIds: [rect.id],
        mode: 'deboss',
        depth: 1000,
        placement,
      });
      expect(result.error?.code).toBe('WRP_DEPTH_EXCEEDS_SOLID');
      return (result.data as { maxDepth: number }).maxDepth;
    };
    expect(limitFor(16)).toBeLessThan(limitFor(2) - 1);
    const rect = rectangleOn(base.doc, 4, 4);
    const done = execute(rect.doc, 'emboss_on_face', {
      id: base.id,
      face: { faceNear: [10, 0, 20] },
      profileIds: [rect.id],
      mode: 'emboss',
      depth: 1,
      placement,
    });
    const azimuth = data(done)['angularSpanRad'] as number;
    const sector = data(done)['developedSectorRad'] as number;
    expect(sector).toBeLessThan(azimuth);
    expect(sector / azimuth).toBeCloseTo(20 / Math.hypot(20, 40), 6);
  });

  it('marks an unpinned font unverified and pins the limits it used', () => {
    const imported = execute(emptyDoc(), 'import_font', {
      base64: Buffer.from(firaProvider().bytes('fira-sans-regular') as Uint8Array).toString('base64'),
    });
    const base = make(imported.document, 'add_cylinder', { radius: 20, height: 40 });
    const label = labelOn(base.doc, 'L', { font: imported.affected[0] });
    const result = execute(label.doc, 'emboss_on_face', {
      id: base.id,
      face: FACE,
      profileIds: [label.id],
      mode: 'emboss',
      depth: 1,
      maxLengthStrain: 0.05,
      fitTolerance: 1e-4,
    });
    expect(data(result)['unverified']).toBe(true);
    expect(data(result)['defaults']).toEqual([]);
    expect((data(result)['provenance'] as { font: { family: string } }).font.family).toBe('Fira Sans');
    expect(result.summary).toContain('unverified font');
  });
});

describe('check_wrap (VC-WRP-28, 29)', () => {
  useFakeKernel();

  const embossed = (): { doc: CadDocument; mesh: string; solid: string } => {
    const base = cylinder();
    const label = labelOn(base.doc, 'LL');
    const done = make(label.doc, 'emboss_on_face', { id: base.id, face: FACE, profileIds: [label.id], mode: 'emboss', depth: 1 });
    return { doc: done.doc, mesh: done.id, solid: base.id };
  };

  it('passes an embossed solid and a wrapped curve, warning that the strain limit was a default', () => {
    const { doc, mesh } = embossed();
    const base = cylinder();
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [-5, 0],
        [5, 0],
      ],
    });
    const wrapped = make(line.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [line.id] });
    const merged: CadDocument = {
      ...wrapped.doc,
      entities: { ...wrapped.doc.entities, ...doc.entities },
      order: [...wrapped.doc.order, mesh],
    };
    const result = execute(merged, 'check_wrap', {});
    expect(result.rejected, result.summary).toBeUndefined();
    const info = data(result);
    expect(info['status']).toBe('warn');
    expect((info['findings'] as Array<{ code: string }>).map((f) => f.code)).toEqual(['WRP_CHECK_LIMIT_DEFAULTED']);
    expect((info['limits'] as Record<string, { defaulted: boolean; value: number }>)['maxLengthStrain']).toMatchObject({
      defaulted: true,
      value: 0.02,
    });
    expect(info['checked']).toMatchObject({ curves: 1, volumes: 1 });
    expect(info['unverified']).toBe(false);
    const pinned = data(execute(merged, 'check_wrap', { maxLengthStrain: 0.05 }));
    expect(pinned['status']).toBe('pass');
    expect(pinned['findings']).toEqual([]);
    expectPure(merged, () => execute(merged, 'check_wrap', {}));
  });

  it('with nothing to check the answer is a pass with no findings', () => {
    const result = execute(cylinder().doc, 'check_wrap', {});
    expect(data(result)['status']).toBe('pass');
    expect(data(result)['findings']).toEqual([]);
  });

  it('fails a stretched projection against the strain limit (WRP_CHECK_DISTORTION) and passes it under a raised limit', () => {
    const base = cylinder();
    const plane = make(base.doc, 'create_sketch_plane', { plane: 'yz', offset: 30 });
    const chord = make(plane.doc, 'draw_polyline', {
      points: [
        [-15, 0],
        [15, 0],
      ],
    });
    const placed = make(chord.doc, 'place_on_sketch_plane', { ids: [chord.id], plane: plane.id });
    const projected = execute(placed.doc, 'project_to_face', { id: base.id, entityIds: [chord.id], direction: [-1, 0, 0] });
    const curveId = projected.affected[0] as string;
    expect(data(execute(projected.document, 'check_wrap', { ids: [curveId] }))['status']).toBe('fail');
    expect(data(execute(projected.document, 'check_wrap', { ids: [curveId], maxLengthStrain: 5 }))['status']).toBe('pass');
    const doc: CadDocument = {
      ...projected.document,
      entities: {
        ...projected.document.entities,
        [curveId]: {
          ...(projected.document.entities[curveId] as never as { onFace: { chartLength: number } }),
          onFace: { ...(projected.document.entities[curveId] as never as { onFace: object }).onFace, chartLength: 20 },
        } as never,
      },
    };
    const failing = execute(doc, 'check_wrap', { ids: [curveId], maxLengthStrain: 0.02 });
    expect(data(failing)['status']).toBe('fail');
    expect((data(failing)['findings'] as Array<{ code: string; value: number }>)[0]).toMatchObject({
      code: 'WRP_CHECK_DISTORTION',
      ids: [curveId],
    });
    expect(failing.summary).toContain('WRP_CHECK_DISTORTION');
    expect(data(execute(doc, 'check_wrap', { ids: [curveId], maxLengthStrain: 5 }))['status']).toBe('pass');
  });

  it('fails an emboss whose kernel volume disagrees with the closed form (WRP_CHECK_VOLUME_MISMATCH) and a deboss as deep as the radius (WRP_CHECK_DEPTH)', () => {
    const { doc, mesh } = embossed();
    setGeometryKernel(fakeWrapKernel({ embossSkew: 1.01 }));
    const mismatch = data(execute(doc, 'check_wrap', { ids: [mesh], maxLengthStrain: 0.02 }));
    expect((mismatch['findings'] as Array<{ code: string }>).map((f) => f.code)).toEqual(['WRP_CHECK_VOLUME_MISMATCH']);
    setGeometryKernel(fakeWrapKernel());
    const entity = meshOf(doc, mesh);
    const node = entity.brep as Extract<ShapeRecipe, { op: 'emboss' }>;
    const deep: CadDocument = {
      ...doc,
      entities: { ...doc.entities, [mesh]: { ...entity, brep: { ...node, mode: 'deboss', depth: 25 } } },
    };
    const codes = (data(execute(deep, 'check_wrap', { ids: [mesh], maxLengthStrain: 0.02 }))['findings'] as Array<{ code: string }>).map(
      (f) => f.code,
    );
    expect(codes).toContain('WRP_CHECK_DEPTH');
  });

  it('checks the stroke width only when a process limit is named, and skips the volumes without a kernel', () => {
    const { doc, mesh } = embossed();
    const none = data(execute(doc, 'check_wrap', { ids: [mesh], maxLengthStrain: 0.02 }));
    expect(none['findings']).toEqual([]);
    const thin = data(execute(doc, 'check_wrap', { ids: [mesh], maxLengthStrain: 0.02, minFeatureSize: 5 }));
    expect((thin['findings'] as Array<{ code: string }>)[0]?.code).toBe('WRP_CHECK_THIN_FEATURE');
    expect((thin['limits'] as Record<string, unknown>)['minFeatureSize']).toMatchObject({ value: 5, defaulted: false });
    expect(data(execute(doc, 'check_wrap', { ids: [mesh], maxLengthStrain: 0.02, minFeatureSize: 0.1 }))['findings']).toEqual([]);
    setGeometryKernel(null);
    const skipped = data(execute(doc, 'check_wrap', { ids: [mesh], maxLengthStrain: 0.02 }));
    expect(skipped['checked']).toMatchObject({ volumes: 0, volumesSkipped: 1 });
  });

  it('warns about unpinned fonts and unmapped characters, and refuses unknown ids', () => {
    const imported = execute(emptyDoc(), 'import_font', {
      base64: Buffer.from(firaProvider().bytes('fira-sans-regular') as Uint8Array).toString('base64'),
    });
    const base = make(imported.document, 'add_cylinder', { radius: 20, height: 40 });
    const label = labelOn(base.doc, 'A\u{1F600}', { font: imported.affected[0] });
    const done = make(label.doc, 'emboss_on_face', { id: base.id, face: FACE, profileIds: [label.id], mode: 'emboss', depth: 1 });
    const result = execute(done.doc, 'check_wrap', { ids: [done.id], maxLengthStrain: 0.02 });
    const info = data(result);
    expect(info['unverified']).toBe(true);
    expect((info['findings'] as Array<{ code: string }>).map((f) => f.code)).toEqual([
      'WRP_CHECK_FONT_UNVERIFIED',
      'WRP_CHECK_GLYPH_MISSING',
    ]);
    expect(info['status']).toBe('warn');
    expectRefusal(done.doc, 'check_wrap', { ids: ['nope'] }, 'WRP_ENTITY_NOT_FOUND', 'ids.0');
    setFontProvider(null);
  });
});
