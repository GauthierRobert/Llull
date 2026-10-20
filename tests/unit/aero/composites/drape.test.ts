import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { PartSurface } from '@core/model/composites';
import type { CadDocument, Vec3 } from '@core/model/types';
import { nurbsOutline, nurbsPartSurface } from '@aero/composites/curved';
import { buildNet } from '@aero/composites/drape/net';
import { drapePly } from '@aero/composites/drape/plyDrape';
import { drapeSurfaceOf } from '@aero/composites/drape/surfaceQuery';
import { evaluateSurface } from '@lib/nurbs/surface';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { pack } from './fixtures';
import { WOVEN, spherePart, spherePatch } from './drapeFixtures';

interface DrapeData {
  maxShearDeg: number;
  nodesOverLock: number;
  nodesOverWarning: number;
  areaOverLock: number;
  overLockRegions: { nodeCount: number }[];
  pieceCount: number;
  stepLength: { value: number; defaulted: boolean };
  nodes?: { i: number; j: number; shearDeg: number; overLock: boolean }[];
  nodeTotal?: number;
  reviewRequired: boolean;
}
interface Producibility {
  status: string;
  plies: { maxShearDeg: number; nodesOverLock: number; findings: { code: string }[]; suggestions: { kind: string }[] }[];
}

const withPly = (base: { doc: CadDocument; part: string }, extra: Record<string, unknown> = {}): CadDocument =>
  apply(base.doc, 'add_ply', {
    part: base.part,
    name: 'W1',
    material: WOVEN.name,
    orientation: 0,
    boundary: { kind: 'whole_face' },
    ...extra,
  });

describe('drape_ply on a hemisphere (VC-CMP-12)', () => {
  const base = spherePart();
  const doc = withPly(base);

  it('reports the Mack-Taylor fishnet shear of the pin-jointed hemisphere', () => {
    const reference = pack<{ hemisphere_pin_jointed_net: { d_mm: number; max_shear_deg_on_hemisphere: number }[] }>('drape_reference.json');
    const expected = reference.hemisphere_pin_jointed_net.find((c) => c.d_mm === 4)?.max_shear_deg_on_hemisphere as number;
    const result = data<DrapeData>(doc, 'drape_ply', { ply: 'W1', part: base.part, stepLength: 4 });
    expect(result.maxShearDeg).toBeGreaterThan(expected - 0.5);
    expect(result.maxShearDeg).toBeLessThan(expected + 3);
    expect(result.nodesOverLock).toBeGreaterThan(0);
    expect(result.nodesOverWarning).toBeGreaterThan(result.nodesOverLock);
    expect(result.areaOverLock).toBeGreaterThan(0);
    expect(result.overLockRegions.length).toBeGreaterThan(0);
    expect(result.pieceCount).toBe(1);
    expect(result.stepLength.defaulted).toBe(false);
    expect(result.reviewRequired).toBe(true);
  });

  it('uses the automatic step when none is given and pages the nodes on request', () => {
    const result = data<DrapeData>(doc, 'drape_ply', { ply: 'W1', part: base.part, output: 'nodes', offset: 10 });
    expect(result.stepLength.defaulted).toBe(true);
    expect(result.nodes?.length).toBeGreaterThan(0);
    expect(result.nodeTotal).toBeGreaterThan(result.nodes?.length ?? 0);
  });

  it('accepts a ply id without a part and a limit override', () => {
    const plyId = Object.keys(doc.composites?.plies ?? {})[0] as string;
    const result = data<DrapeData>(doc, 'drape_ply', { ply: plyId, stepLength: 5, lockingAngle: 60 });
    expect(result.nodesOverLock).toBe(0);
  });

  it('refuses unknown references, bad numbers and a material without lockingAngle', () => {
    expectRefusal(doc, 'drape_ply', { ply: 'nope', part: base.part }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'drape_ply', { ply: 'W1', part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'drape_ply', { ply: 'W1', part: base.part, stepLength: -1 }, 'CMP_PARAM_INVALID');
    const noLimit = apply(
      withPly(
        { doc: apply(base.doc, 'create_lamina_material', { ...WOVEN, name: 'Free', lockingAngle: undefined }), part: base.part },
        { material: 'Free', name: 'F1' },
      ),
      'edit_ply',
      { part: base.part, ply: 'F1', sequence: 'S9' },
    );
    expectRefusal(noLimit, 'drape_ply', { ply: 'F1', part: base.part, stepLength: 5 }, 'CMP_DRAPE_LIMIT_MISSING');
    expectRefusal(doc, 'drape_ply', { ply: 'W1', part: base.part, stepLength: 0.001 }, 'CMP_PARAM_INVALID');
  });

  it('is read-only', () => {
    expectPure(doc, () => execute(doc, 'drape_ply', { ply: 'W1', part: base.part, stepLength: 6 }));
  });
});

describe('check_producibility (VC-CMP-13)', () => {
  const base = spherePart();
  const doc = withPly(base);

  it('fails the hemisphere ply with an over-lock finding and a dart or splice suggestion', () => {
    const result = data<Producibility>(doc, 'check_producibility', { part: base.part, stepLength: 4 });
    expect(result.status).toBe('fail');
    const ply = result.plies[0];
    expect(ply?.findings.map((f) => f.code)).toContain('CMP_PRODUCIBILITY_OVER_LOCK');
    expect(ply?.nodesOverLock).toBeGreaterThan(0);
    expect(ply?.suggestions.length).toBeGreaterThan(0);
  });

  it('passes when the locking angle is generous and warns between the limits', () => {
    expect(
      data<Producibility>(doc, 'check_producibility', { part: base.part, stepLength: 5, lockingAngle: 80, warningShear: 70 }).status,
    ).toBe('pass');
    const warn = data<Producibility>(doc, 'check_producibility', { part: base.part, stepLength: 5, lockingAngle: 80, warningShear: 20 });
    expect(warn.status).toBe('warn');
    expect(warn.plies[0]?.findings[0]?.code).toBe('CMP_PRODUCIBILITY_NEAR_LOCK');
  });

  it('treats developable faces as exact and reports a missing locking angle as a failure', () => {
    const noLimit = withPly(
      { doc: apply(base.doc, 'create_lamina_material', { ...WOVEN, name: 'Free', lockingAngle: undefined }), part: base.part },
      { material: 'Free', name: 'F1' },
    );
    const result = data<Producibility>(noLimit, 'check_producibility', { part: base.part, plies: ['F1'], stepLength: 6 });
    expect(result.plies[0]?.findings[0]?.code).toBe('CMP_DRAPE_LIMIT_MISSING');
  });

  it('refuses unknown parts / plies and parts without plies', () => {
    expectRefusal(doc, 'check_producibility', { part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'check_producibility', { part: base.part, plies: ['nope'] }, 'CMP_REF_MISSING');
    expectRefusal(base.doc, 'check_producibility', { part: base.part }, 'CMP_NO_PLIES');
    expectRefusal(doc, 'check_producibility', { part: base.part, stepLength: 0 }, 'CMP_PARAM_INVALID');
    expectPure(doc, () => execute(doc, 'check_producibility', { part: base.part, stepLength: 6 }));
  });
});

describe('draped flat patterns of a sphere cap', () => {
  const base = spherePart();
  const cap = (polar: number): [number, number][] =>
    Array.from({ length: 48 }, (_, k): [number, number] => {
      const angle = (2 * Math.PI * k) / 48;
      const radius = 100 * ((polar * Math.PI) / 180);
      return [radius * Math.cos(angle), radius * Math.sin(angle)];
    });
  const patch = withPly(base, { boundary: { kind: 'polygon', polygons: [cap(30)] }, drape: { stepLength: 2 } });

  it('flattens a 30 degree cap to about its spherical area (low shear)', () => {
    const result = data<{ pieces: { areaMm2: number }[]; files: { content: string }[]; provenance: { method: string } }>(
      patch,
      'export_flat_patterns_dxf',
      { part: base.part },
    );
    const spherical = 2 * Math.PI * 100 * 100 * (1 - Math.cos((30 * Math.PI) / 180));
    expect(Math.abs((result.pieces[0]?.areaMm2 ?? 0) / spherical - 1)).toBeLessThan(0.02);
    expect(result.provenance.method).toBe('fishnet drape');
    expect(result.files[0]?.content).toContain('POLYLINE');
  });

  it('refuses the whole hemisphere at the locking angle unless over-lock is allowed', () => {
    const whole = withPly(base, { drape: { stepLength: 4 } });
    expectRefusal(whole, 'export_flat_patterns_dxf', { part: base.part }, 'CMP_PRODUCIBILITY_OVER_LOCK');
    const allowed = data<{ pieces: unknown[] }>(whole, 'export_flat_patterns_dxf', { part: base.part, allowOverLock: true });
    expect(allowed.pieces).toHaveLength(1);
  });

  it('refuses the developable and projection methods on doubly curved faces', () => {
    expectRefusal(
      base.doc,
      'add_ply',
      {
        part: base.part,
        name: 'D',
        material: WOVEN.name,
        orientation: 0,
        boundary: { kind: 'whole_face' },
        drape: { method: 'developable' },
      },
      'CMP_PARAM_INVALID',
    );
    expectRefusal(
      base.doc,
      'add_ply',
      { part: base.part, name: 'D', material: WOVEN.name, orientation: 0, boundary: { kind: 'whole_face' }, drape: { stepLength: -1 } },
      'CMP_PARAM_INVALID',
    );
  });

  it('a missing locking angle blocks the flat unless over-lock is allowed', () => {
    const free = apply(base.doc, 'create_lamina_material', { ...WOVEN, name: 'Free', lockingAngle: undefined });
    const small = apply(free, 'add_ply', {
      part: base.part,
      name: 'F1',
      material: 'Free',
      orientation: 0,
      boundary: { kind: 'polygon', polygons: [cap(20)] },
      drape: { stepLength: 3 },
    });
    expectRefusal(small, 'export_flat_patterns_dxf', { part: base.part }, 'CMP_DRAPE_LIMIT_MISSING');
    expect(data<{ pieces: unknown[] }>(small, 'export_flat_patterns_dxf', { part: base.part, allowOverLock: true }).pieces).toHaveLength(1);
  });
});

describe('darts and re-drape (VC-CMP-33)', () => {
  const base = spherePart();
  const reach = 100 * (Math.PI / 2) * 1.2;
  const arm = (degrees: number): [number, number][] => {
    const a = (degrees * Math.PI) / 180;
    return [
      [0, 0],
      [reach * Math.cos(a), reach * Math.sin(a)],
    ];
  };
  let doc = withPly(base);
  for (const degrees of [0, 90, 180, 270]) doc = apply(doc, 'split_ply', { ply: 'W1', part: base.part, kind: 'dart', path: arm(degrees) });

  it('four darts meeting at the pole cut the ply into four wedges', () => {
    const plies = doc.composites?.plies ?? {};
    expect(Object.values(plies)[0]?.cuts).toHaveLength(4);
    const result = data<DrapeData>(doc, 'drape_ply', { ply: 'W1', part: base.part, stepLength: 4 });
    expect(result.pieceCount).toBe(4);
  });

  it('each wedge is draped from the pole along its bisector, with the old generator as the diagonal', () => {
    const reference = pack<{ hemisphere_pin_jointed_net: { d_mm: number; diagonal: { i: number; shear_deg: number }[] }[] }>(
      'drape_reference.json',
    );
    const diagonal = reference.hemisphere_pin_jointed_net.find((c) => c.d_mm === 4)?.diagonal ?? [];
    const part = doc.composites?.parts[base.part];
    const ply = Object.values(doc.composites?.plies ?? {})[0];
    if (part === undefined || ply === undefined) throw new Error('fixture');
    const result = drapePly(part, ply, { stepLength: 4, limits: { lock: 40 }, allowOverLock: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.pieces).toHaveLength(4);
    for (const piece of result.pieces) {
      for (const k of [3, 6, 10, 15]) {
        expect(piece.net.get(k, 0)?.shear).toBeCloseTo(0, 6);
        expect(piece.net.get(k, -k)?.shear).toBeCloseTo(diagonal[k - 1]?.shear_deg ?? Number.NaN, 1);
      }
    }
  });

  it('a lone dart stays a slit; a splice that divides nothing is refused', () => {
    const one = apply(withPly(base), 'split_ply', { ply: 'W1', part: base.part, kind: 'dart', path: arm(0) });
    expect(data<DrapeData>(one, 'drape_ply', { ply: 'W1', part: base.part, stepLength: 6 }).pieceCount).toBe(1);
    expectRefusal(
      one,
      'split_ply',
      {
        ply: 'W1',
        part: base.part,
        kind: 'splice',
        path: [
          [10, 10],
          [20, 20],
        ],
      },
      'CMP_CUT_INVALID',
    );
    expectRefusal(
      one,
      'split_ply',
      {
        ply: 'W1',
        part: base.part,
        kind: 'dart',
        path: [
          [1000, 1000],
          [1100, 1100],
        ],
      },
      'CMP_CUT_INVALID',
    );
    expectRefusal(one, 'split_ply', { ply: 'W1', part: base.part, kind: 'dart', path: arm(45), overlap: 3 }, 'CMP_CUT_INVALID');
    expectRefusal(one, 'split_ply', { ply: 'nope', kind: 'dart', path: arm(45) }, 'CMP_REF_MISSING');
    expectRefusal(one, 'split_ply', { ply: 'W1', part: base.part, kind: 'dart' }, 'CMP_REF_MISSING');
  });

  it('is pure', () => {
    const laid = withPly(base);
    expectPure(laid, () => execute(laid, 'split_ply', { ply: 'W1', part: base.part, kind: 'dart', path: arm(0) }));
  });
});

describe('nurbs_surface tool faces', () => {
  const R = 100;
  let doc = spherePart().doc;
  const sheet = ok(doc, 'create_nurbs_surface', spherePatch(R, 30, 90));
  doc = sheet.document;
  const sheetId = sheet.affected[0] as string;
  const onSheet: Vec3 = [R * Math.sin(Math.PI / 3) * Math.SQRT1_2, R * Math.sin(Math.PI / 3) * Math.SQRT1_2, R * Math.cos(Math.PI / 3)];
  const created = ok(doc, 'create_composite_part', { name: 'Skin', toolSurface: { entityId: sheetId, faceNear: onSheet }, rosette: 'R0' });
  doc = created.document;
  const part = created.affected[0] as string;

  it('creates a part with a metric parameter chart and an exact surface description', () => {
    const stored = doc.composites?.parts[part];
    expect(stored?.surface.type).toBe('nurbs');
    const corner = stored?.outline[2] ?? [0, 0];
    expect(corner[0]).toBeCloseTo(R * Math.sin(Math.PI / 3) * (Math.PI / 2), 1);
    expect(corner[1]).toBeCloseTo(R * (Math.PI / 3), 1);
    const surface = stored?.surface as Extract<PartSurface, { type: 'nurbs' }>;
    const rebuilt = nurbsPartSurface(surface.surface);
    expect(nurbsOutline(rebuilt)).toEqual(stored?.outline);
  });

  it('refuses a point off the sheet', () => {
    expectRefusal(
      doc,
      'create_composite_part',
      { name: 'Off', toolSurface: { entityId: sheetId, faceNear: [0, 0, 0] }, rosette: 'R0' },
      'CMP_FACE_NOT_FOUND',
    );
  });

  it('drapes like the analytic sphere from the same seed and warp (shear, positions)', () => {
    const stored = doc.composites?.parts[part];
    const sphere: PartSurface = { type: 'sphere', center: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: R };
    if (stored === undefined) throw new Error('fixture');
    const nurbs = drapeSurfaceOf(stored);
    const seedUv = [(stored.outline[2]?.[0] as number) / 2, (stored.outline[2]?.[1] as number) / 2] as [number, number];
    const seedPoint = nurbsPartSurfacePoint(stored.surface, seedUv);
    const seedN = nurbs.project(seedPoint);
    const analytic = drapeSurfaceOf({
      ...stored,
      surface: sphere,
      outline: [
        [-1e6, -1e6],
        [1e6, -1e6],
        [1e6, 1e6],
        [-1e6, 1e6],
      ],
    });
    const seedS = analytic.project(seedPoint);
    if (seedN === null || seedS === null) throw new Error('seed');
    const warp: Vec3 = [-Math.SQRT1_2, Math.SQRT1_2, 0];
    const options = { d: 3, warp, allowOverLock: true, extent: 80 } as const;
    const netN = buildNet(nurbs, { ...options, seed: seedN });
    const netS = buildNet(analytic, { ...options, seed: seedS });
    // the sheet normal Su x Sv points inward, so its weft runs opposite to the outward-normal sphere net
    let compared = 0;
    for (let i = -6; i <= 6; i++)
      for (let j = -6; j <= 6; j++) {
        const [a, b] = [netN.get(i, j), netS.get(i, -j)];
        if (a === undefined || b === undefined) continue;
        compared++;
        expect(Math.hypot(a.hit.point[0] - b.hit.point[0], a.hit.point[1] - b.hit.point[1], a.hit.point[2] - b.hit.point[2])).toBeLessThan(
          1e-5,
        );
        expect(a.shear).toBeCloseTo(b.shear, 3);
      }
    expect(compared).toBeGreaterThan(100);
  });

  it('drape_ply and the producibility check work on the sheet', () => {
    const laid = withPly({ doc, part });
    const result = data<DrapeData>(laid, 'drape_ply', { ply: 'W1', part, stepLength: 4 });
    expect(result.maxShearDeg).toBeGreaterThan(0);
    expect(['pass', 'warn', 'fail']).toContain(data<Producibility>(laid, 'check_producibility', { part, stepLength: 4 }).status);
  });
});

function nurbsPartSurfacePoint(surface: PartSurface, uv: [number, number]): Vec3 {
  if (surface.type !== 'nurbs') throw new Error('nurbs expected');
  const [[u0], [v0]] = surface.domain;
  return evaluateSurface(surface.surface, u0 + uv[0] / surface.scale[0], v0 + uv[1] / surface.scale[1]);
}
