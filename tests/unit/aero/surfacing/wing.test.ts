import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type LoftEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { sectionChain, sectionRing } from '@core/geometry/sectionChain';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import { aeroDocument } from '@aero/surfacing/aeroDocument';
import { resolvePlanform } from '@aero/surfacing/planform';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';

const empty = createEmptyDocument();
const withAirfoil = (designation = '0012', trailingEdge = 'open', points = 161): { doc: CadDocument; id: string } => {
  const result = execute(empty, 'airfoil_from_naca', { designation, trailingEdge, points });
  return { doc: result.document, id: result.affected[0]! };
};
const loftOf = (doc: CadDocument, id: string): LoftEntity => doc.entities[id] as LoftEntity;
type Data = Record<string, number | boolean | string | number[]>;

const trapezoid = (extra: Record<string, unknown> = {}): { doc: CadDocument; wing: string; ids: string[] } => {
  const { doc, id } = withAirfoil();
  const result = execute(doc, 'create_wing', {
    sections: [
      { airfoilId: id, span: 0, chord: 2 },
      { airfoilId: id, span: 5, chord: 1 },
    ],
    ...extra,
  });
  return { doc: result.document, wing: result.affected[0]!, ids: result.affected };
};

describe('create_wing', () => {
  it('lofts the exact placed sections of a trapezoid (VC-SRF-11 geometry)', () => {
    const { doc, wing, ids } = trapezoid();
    expect(ids).toHaveLength(1);
    const loft = loftOf(doc, ids[0]!);
    expect(loft.kind).toBe('loft');
    expect(loft.ruled).toBe(true);
    expect(loft.sections).toHaveLength(2);
    expect(loft.rings).toHaveLength(2);
    expect(doc.aero!.wings[wing]).toMatchObject({ id: wing, mirror: false, loft: 'linear', twistLocation: 0.25, entityIds: ids });
    expect(doc.order.slice(-1)).toEqual(ids);
    const [root, tip] = loft.sections!;
    // right half: curve reversed (lower trailing edge first), chord 2 at y = 0 and chord 1 at y = 5
    const rootEnds = [evaluateCurve(root!, 0), evaluateCurve(root!, 1)];
    expect(rootEnds.map((p) => p[0].toFixed(6))).toEqual(['2.000000', '2.000000']);
    expect(Math.abs(rootEnds[0]![2] - rootEnds[1]![2])).toBeCloseTo(2 * 0.00252, 6);
    expect(evaluateCurve(tip!, 0)[1]).toBe(5);
    const leRoot = root!.poles.reduce((best, p) => (p[0] < best[0] ? p : best));
    expect(leRoot[0]).toBeCloseTo(0, 3);
  });

  it('gives one chain of exact Bezier spans plus the closing edge per section, equal across sections', () => {
    const { doc, ids } = trapezoid();
    const [root, tip] = loftOf(doc, ids[0]!).sections!;
    const [a, b] = [sectionChain(root!)!, sectionChain(tip!)!];
    expect(a).toHaveLength(b.length);
    expect(a[a.length - 1]!.type).toBe('line');
    expect(a.slice(0, -1).every((segment) => segment.type === 'bezier')).toBe(true);
    // the Bezier chain IS the curve: its start and end points and a mid span point coincide with the NURBS curve
    const first = a[0]!;
    expect(first.points[0]).toEqual(evaluateCurve(root!, 0));
    const lastBezier = a[a.length - 2]!;
    const end = evaluateCurve(root!, 1);
    for (let i = 0; i < 3; i++) expect(lastBezier.points[3]![i]).toBeCloseTo(end[i]!, 12);
    expect(sectionRing(root!).length).toBe(sectionRing(tip!).length);
  });

  it('applies sweep at a chord fraction, dihedral and twist about the twist axis', () => {
    const { doc, id } = withAirfoil();
    const result = execute(doc, 'create_wing', {
      sections: [
        { airfoilId: id, span: 0, chord: 4 },
        { airfoilId: id, span: 10, chord: 2, twistDeg: 5 },
      ],
      segments: [{ sweepDeg: 30, sweepLocation: 0.25, dihedralDeg: 5 }],
      origin: [1, 2, 3],
    });
    const loft = loftOf(result.document, result.affected[0]!);
    expect(loft.position).toEqual([1, 2, 3]);
    const tip = loft.sections![1]!;
    const sections = tip.poles;
    // tip quarter-chord point sits dy * tan(30) behind the root quarter chord: x_c/4(tip) = 1 + 10 tan30 = 6.7735 (before twist, pivot is c/4)
    const pivotX = Math.min(...sections.map((p) => p[0])) + 0;
    expect(pivotX).toBeLessThan(6.5);
    const zs = sections.map((p) => p[2]);
    expect(Math.max(...zs)).toBeGreaterThan(10 * Math.tan((5 * Math.PI) / 180));
    // nose-up twist: the leading edge (smallest x) is above the trailing edge
    const le = sections.reduce((best, p) => (p[0] < best[0] ? p : best));
    const te = sections.reduce((best, p) => (p[0] > best[0] ? p : best));
    expect(le[2]).toBeGreaterThan(te[2]);
  });

  it('mirror adds the left half with sections at negative span', () => {
    const { doc, wing, ids } = trapezoid({ mirror: true });
    expect(ids).toHaveLength(2);
    const left = loftOf(doc, ids[1]!);
    expect(left.sections![1]!.poles.every((p) => p[1] === -5)).toBe(true);
    expect(doc.aero!.wings[wing]!.entityIds).toEqual(ids);
  });

  it('smooth loft and a planform with explicit sections (VC-SRF-10 inputs) are accepted', () => {
    const { doc, id } = withAirfoil();
    const result = execute(doc, 'create_wing', {
      planform: { semiSpan: 63.63, rootChord: 21.941, taper: 0.45, sweepDeg: 45, sweepLocation: 0.25, dihedralDeg: 0 },
      sections: [
        { airfoilId: id, span: 0 },
        { airfoilId: id, span: 30 },
        { airfoilId: id, span: 63.63 },
      ],
      loft: 'smooth',
      mirror: true,
    });
    expect(result.affected).toHaveLength(2);
    const wing = result.document.aero!.wings[result.affected[0]!]!;
    expect(wing.loft).toBe('smooth');
    expect(wing.sections.map((s) => s.chord)[2]).toBeCloseTo(9.87345, 9);
    expect(wing.segments).toHaveLength(2);
    expect(wing.segments[1]).toMatchObject({ sweepDeg: 45, sweepLocation: 0.25 });
  });

  it('one segment applies to every panel; a layer and colour are honoured', () => {
    const { doc, id } = withAirfoil();
    const result = execute(doc, 'create_wing', {
      sections: [0, 2, 4].map((span) => ({ airfoilId: id, span, chord: 1 })),
      segments: [{ sweepDeg: 10 }],
      color: '#112233',
      layerId: 'nope',
    });
    const wing = result.document.aero!.wings[result.affected[0]!]!;
    expect(wing.segments).toEqual([
      { sweepDeg: 10, sweepLocation: 0, dihedralDeg: 0 },
      { sweepDeg: 10, sweepLocation: 0, dihedralDeg: 0 },
    ]);
    expect(loftOf(result.document, result.affected[0]!).color).toBe('#112233');
    expect(loftOf(result.document, result.affected[0]!).layerId).toBe('layer-default');
  });

  it('is pure', () => {
    const { doc, id } = withAirfoil();
    expectPure(doc, () =>
      execute(doc, 'create_wing', {
        sections: [
          { airfoilId: id, span: 0, chord: 1 },
          { airfoilId: id, span: 1, chord: 1 },
        ],
      }),
    );
  });

  it('survives a save and load, and the stored sections stay exact', () => {
    const { doc, wing, ids } = trapezoid({ mirror: true });
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.aero!.wings[wing]).toEqual(doc.aero!.wings[wing]);
    expect(loftOf(loaded, ids[0]!).sections).toEqual(loftOf(doc, ids[0]!).sections);
    expect(aeroDocument.validate(JSON.parse(JSON.stringify(doc)) as Record<string, unknown>)).toEqual([]);
  });

  it('a file saved after deleting a referenced loft or airfoil curve still reopens, without the dangling definitions', () => {
    const { doc, wing, ids } = trapezoid();
    const noWing = execute(doc, 'delete_entities', { ids });
    const loadedNoWing = deserializeDocument(serializeDocument(noWing.document));
    expect(loadedNoWing.aero!.wings[wing]).toBeUndefined();
    expect(Object.keys(loadedNoWing.aero!.airfoils)).toHaveLength(1);
    const airfoilId = Object.values(doc.aero!.airfoils)[0]!.entityId;
    const noAirfoil = execute(doc, 'delete_entities', { ids: [airfoilId] });
    const loaded = deserializeDocument(serializeDocument(noAirfoil.document));
    expect(loaded.aero!.airfoils).toEqual({});
    expect(loaded.aero!.wings[wing]).toBeUndefined();
    expect(loaded.entities[ids[0]!]).toBeDefined();
  });

  it('scale_entity scales the exact sections together with the rings', () => {
    const { doc, ids } = trapezoid();
    const scaled = execute(doc, 'scale_entity', { id: ids[0]!, factor: 2 });
    const [before, after] = [loftOf(doc, ids[0]!), loftOf(scaled.document, ids[0]!)];
    expect(after.sections![1]!.poles[3]![1]).toBeCloseTo(before.sections![1]!.poles[3]![1] * 2, 12);
    expect(after.rings[1]![3]![0]).toBeCloseTo(before.rings[1]![3]![0] * 2, 12);
  });

  const base = (id: string): { airfoilId: string; span: number; chord: number }[] => [
    { airfoilId: id, span: 0, chord: 2 },
    { airfoilId: id, span: 5, chord: 1 },
  ];
  it.each<[string, (id: string) => Record<string, unknown>, string]>([
    ['one section', (id) => ({ sections: base(id).slice(0, 1) }), 'SRF_LOFT_SECTIONS_TOO_FEW'],
    [
      'more than 40 sections',
      (id) => ({ sections: Array.from({ length: 41 }, (_, i) => ({ airfoilId: id, span: i, chord: 1 })) }),
      'AERO_PARAM_INVALID',
    ],
    ['non-increasing span', (id) => ({ sections: [base(id)[1], base(id)[0]] }), 'AERO_SPAN_NOT_INCREASING'],
    ['unknown airfoil', () => ({ sections: base('nope') }), 'AERO_AIRFOIL_NOT_FOUND'],
    ['missing chord', (id) => ({ sections: [{ airfoilId: id, span: 0 }, base(id)[1]] }), 'AERO_PARAM_INVALID'],
    ['bad twist location', (id) => ({ sections: base(id), twistLocation: 2 }), 'AERO_PARAM_INVALID'],
    ['segment count mismatch', (id) => ({ sections: base(id), segments: [{}, {}] }), 'AERO_PARAM_INVALID'],
    ['sweep location out of range', (id) => ({ sections: base(id), segments: [{ sweepLocation: 1.5 }] }), 'AERO_PARAM_INVALID'],
    ['dihedral of 90 degrees', (id) => ({ sections: base(id), segments: [{ dihedralDeg: 90 }] }), 'AERO_PARAM_INVALID'],
    [
      'planform with two values',
      (id) => ({ sections: base(id), planform: { semiSpan: 5, rootChord: 2 } }),
      'AERO_PLANFORM_UNDERDETERMINED',
    ],
    [
      'planform with four values',
      (id) => ({ sections: base(id), planform: { semiSpan: 5, rootChord: 2, tipChord: 1, taper: 0.5 } }),
      'AERO_PLANFORM_OVERDETERMINED',
    ],
    [
      'planform root not at 0',
      (id) => ({
        sections: [
          { airfoilId: id, span: 1 },
          { airfoilId: id, span: 5 },
        ],
        planform: { semiSpan: 5, rootChord: 2, tipChord: 1 },
      }),
      'AERO_PARAM_INVALID',
    ],
    [
      'planform tip not at the semi-span',
      (id) => ({
        sections: [
          { airfoilId: id, span: 0 },
          { airfoilId: id, span: 4 },
        ],
        planform: { semiSpan: 5, rootChord: 2, tipChord: 1 },
      }),
      'AERO_PARAM_INVALID',
    ],
  ])('%s is refused with a code', (_label, params, code) => {
    const { doc, id } = withAirfoil();
    const result = execute(doc, 'create_wing', params(id));
    expectNoOp(result, doc);
    expect(result.error?.code).toBe(code);
  });

  it('refuses airfoils that cannot be lofted together and deleted airfoil curves', () => {
    const open = withAirfoil('0012', 'open');
    const closed = execute(open.doc, 'airfoil_from_naca', { designation: '0012', trailingEdge: 'closed' });
    const mixed = execute(closed.document, 'create_wing', {
      sections: [
        { airfoilId: open.id, span: 0, chord: 1 },
        { airfoilId: closed.affected[0]!, span: 1, chord: 1 },
      ],
    });
    expect(mixed.error?.code).toBe('AERO_SECTIONS_INCOMPATIBLE');
    expect(mixed.error?.paths).toEqual(['params.sections.1.airfoilId']);
    const fewer = execute(open.doc, 'airfoil_from_naca', { designation: '0012', points: 81 });
    const counts = execute(fewer.document, 'create_wing', {
      sections: [
        { airfoilId: open.id, span: 0, chord: 1 },
        { airfoilId: fewer.affected[0]!, span: 1, chord: 1 },
      ],
    });
    expect(counts.error?.code).toBe('AERO_SECTIONS_INCOMPATIBLE');
    const curveId = open.doc.aero!.airfoils[open.id]!.entityId;
    const without = execute(open.doc, 'delete_entities', { ids: [curveId] }).document;
    const gone = execute(without, 'create_wing', { sections: base(open.id) });
    expect(gone.error?.code).toBe('AERO_AIRFOIL_NOT_FOUND');
  });
});

describe('wing_properties (VC-SRF-10, VC-SRF-11, VC-SRF-28)', () => {
  it('trapezoid NACA 0012: area, MAC and the open-TE volume 0.959117 m3 per half', () => {
    const { doc, wing } = trapezoid();
    const result = execute(doc, 'wing_properties', { id: wing });
    expect(result.document).toBe(doc);
    const data = result.data as Data;
    expect(data['areaPerSide']).toBeCloseTo(7.5, 9);
    expect(data['mac']).toBeCloseTo(1.5555555556, 9);
    expect(data['semiSpan']).toBe(5);
    expect(data['span']).toBe(10);
    expect(data['areaRef']).toBeCloseTo(15, 9);
    expect(data['aspectRatio']).toBeCloseTo(100 / 15, 9);
    expect(data['taper']).toBe(0.5);
    expect(Math.abs((data['volumePerSide'] as number) / 0.9591166667 - 1)).toBeLessThan(1e-4);
    expect(data['volume']).toBe(data['volumePerSide']);
    expect(data['unverified']).toBe(false);
    expect(data['areaUnit']).toBe('mm^2');
    expect(result.summary).toContain(wing);
  });

  it('TR-1208 planform: 2024.35 in2, MAC 16.6701 in, AR 8.000', () => {
    const { doc, id } = withAirfoil();
    const created = execute(doc, 'create_wing', {
      planform: { semiSpan: 63.63, rootChord: 21.941, taper: 0.45, sweepDeg: 45, sweepLocation: 0.25, dihedralDeg: 0 },
      sections: [
        { airfoilId: id, span: 0 },
        { airfoilId: id, span: 63.63 },
      ],
      mirror: true,
    });
    const data = execute(created.document, 'wing_properties', { id: created.affected[0]! }).data as Data;
    expect(Math.abs((data['areaRef'] as number) - 2024.3535)).toBeLessThan(0.01);
    expect(Math.abs((data['mac'] as number) - 16.6701)).toBeLessThan(0.005);
    expect(Math.abs((data['aspectRatio'] as number) - 8.0001)).toBeLessThan(0.03);
    expect(Math.abs((data['yMac'] as number) - 27.7924)).toBeLessThan(0.005);
    expect(data['sweepC4Deg']).toBeCloseTo(45, 9);
    expect(data['volume']).toBeCloseTo((data['volumePerSide'] as number) * 2, 6);
  });

  it('sweeping a constant-chord wing keeps its area and gives the leading-edge sweep', () => {
    const { doc, id } = withAirfoil();
    const make = (sweepDeg: number): Data => {
      const created = execute(doc, 'create_wing', {
        sections: [
          { airfoilId: id, span: 0, chord: 2 },
          { airfoilId: id, span: 6, chord: 2 },
        ],
        segments: [{ sweepDeg, sweepLocation: 0 }],
      });
      return execute(created.document, 'wing_properties', { id: created.affected[0]! }).data as Data;
    };
    const [straight, swept] = [make(0), make(30)];
    expect(swept['areaPerSide']).toBeCloseTo(straight['areaPerSide'] as number, 9);
    expect(swept['sweepLeDeg']).toBeCloseTo(30, 9);
    expect(swept['sweepC4Deg']).toBeCloseTo(30, 9);
    expect(swept['sweepTeDeg']).toBeCloseTo(30, 9);
    expect(swept['xLeMac']).toBeCloseTo(3 * Math.tan((30 * Math.PI) / 180), 9);
  });

  it('flags UNVERIFIED imported airfoils', () => {
    const text = `x\n1 0\n0.5 0.05\n0 0\n0.5 -0.05\n1 0\n`;
    const imported = execute(empty, 'import_airfoil', { text, format: 'selig' });
    const id = imported.affected[0]!;
    const wing = execute(imported.document, 'create_wing', {
      sections: [
        { airfoilId: id, span: 0, chord: 1 },
        { airfoilId: id, span: 1, chord: 1 },
      ],
    });
    const result = execute(wing.document, 'wing_properties', { id: wing.affected[0]! });
    expect((result.data as Data)['unverified']).toBe(true);
    expect(result.summary).toContain('UNVERIFIED');
  });

  it('refuses unknown wings and wings whose airfoil curve was deleted', () => {
    const { doc, wing } = trapezoid();
    expect(execute(doc, 'wing_properties', { id: 'nope' }).error?.code).toBe('AERO_WING_NOT_FOUND');
    const curveId = Object.values(doc.aero!.airfoils)[0]!.entityId;
    const broken = execute(doc, 'delete_entities', { ids: [curveId] }).document;
    expect(execute(broken, 'wing_properties', { id: wing }).error?.code).toBe('AERO_AIRFOIL_NOT_FOUND');
  });
});

describe('planform resolution', () => {
  const root = 21.941;
  const tipChord = root * 0.45;
  const semiSpan = 63.63;
  const area = (root + tipChord) * semiSpan;
  const aspectRatio = (4 * semiSpan) / (root + tipChord);
  const truth = { semiSpan, rootChord: root, tipChord };
  const values: Record<string, number> = { semiSpan, rootChord: root, tipChord, taper: 0.45, area, aspectRatio };
  const combos = (names: string[], size: number): string[][] =>
    size === 0 ? [[]] : names.flatMap((name, i) => combos(names.slice(i + 1), size - 1).map((rest) => [name, ...rest]));

  it('every independent triple recovers the trapezoid and every dependent one is refused', () => {
    let solved = 0;
    for (const names of combos(Object.keys(values), 3)) {
      const input = Object.fromEntries(names.map((name) => [name, values[name]]));
      const result = resolvePlanform(input);
      if ('code' in result) {
        expect(['AERO_PLANFORM_UNDERDETERMINED', 'AERO_PLANFORM_OVERDETERMINED']).toContain(result.code);
        continue;
      }
      solved++;
      for (const key of ['semiSpan', 'rootChord', 'tipChord'] as const) expect(result[key]).toBeCloseTo(truth[key], 9);
    }
    // 20 triples; {cr, ct, taper}, {s, area, AR} and the three {area|AR, ...} families that stay dependent are refused
    expect(solved).toBeGreaterThanOrEqual(16);
  });

  it('refuses wrong counts, non-positive values and contradictory dependent sets', () => {
    expect(resolvePlanform({ semiSpan: 1, rootChord: 1 })).toMatchObject({ code: 'AERO_PLANFORM_UNDERDETERMINED' });
    expect(resolvePlanform({})).toMatchObject({ code: 'AERO_PLANFORM_UNDERDETERMINED' });
    expect(resolvePlanform({ semiSpan: 1, rootChord: 1, tipChord: 1, taper: 1 })).toMatchObject({ code: 'AERO_PLANFORM_OVERDETERMINED' });
    expect(resolvePlanform({ semiSpan: 1, rootChord: -1, tipChord: 1 })).toMatchObject({ code: 'AERO_PARAM_INVALID' });
    expect(resolvePlanform({ rootChord: 2, tipChord: 1, taper: 0.7 })).toMatchObject({ code: 'AERO_PLANFORM_UNDERDETERMINED' });
    expect(resolvePlanform({ semiSpan: 2, area: 1, rootChord: 5 })).toMatchObject({ code: 'AERO_PARAM_INVALID' });
    expect(resolvePlanform({ semiSpan: 2, area: 1, aspectRatio: 1 })).toMatchObject({ code: 'AERO_PLANFORM_UNDERDETERMINED' });
  });
});
