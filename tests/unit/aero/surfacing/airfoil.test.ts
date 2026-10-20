import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type NurbsCurveEntity, type Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import { sha256Hex } from '@lib/sha256';
import { aeroDocument } from '@aero/surfacing/aeroDocument';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';

const packDir = join(process.cwd(), 'docs/aerospace/02-advanced-surfacing/validation/data');
const empty = createEmptyDocument();

/** x,y rows of a validation CSV (81 cosine stations per surface, Selig order, chord 1). */
const readCsv = (name: string): Array<[number, number]> =>
  readFileSync(join(packDir, name), 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split(',').map(Number) as [number, number]);

const curveOf = (doc: CadDocument, airfoilId: string): NurbsCurveData =>
  (doc.entities[doc.aero!.airfoils[airfoilId]!.entityId] as NurbsCurveEntity).curve;

/** Distance from `point` to the curve: coarse sampling then golden-section refinement. */
function distanceToCurve(curve: NurbsCurveData, point: [number, number]): number {
  const at = (u: number): number => {
    const p = evaluateCurve(curve, u);
    return Math.hypot(p[0] - point[0], p[1] - point[1]);
  };
  const count = 4000;
  let best = 0;
  for (let i = 1; i <= count; i++) if (at(i / count) < at(best / count)) best = i;
  let [lo, hi] = [Math.max(0, (best - 1) / count), Math.min(1, (best + 1) / count)];
  for (let i = 0; i < 60; i++) {
    const [a, b] = [lo + (hi - lo) / 3, hi - (hi - lo) / 3];
    if (at(a) < at(b)) hi = b;
    else lo = a;
  }
  return at((lo + hi) / 2);
}

const made = (params: Record<string, unknown>): { doc: CadDocument; id: string; curveId: string } => {
  const result = execute(empty, 'airfoil_from_naca', params);
  return { doc: result.document, id: result.affected[0]!, curveId: result.affected[1]! };
};

describe('airfoil_from_naca (VC-SRF-01, VC-SRF-02)', () => {
  it.each([
    ['0012', 'open', 'naca_0012_selig_81.csv'],
    ['0012', 'closed', 'naca_0012_closed_te_selig_81.csv'],
    ['2412', 'open', 'naca_2412_selig_81.csv'],
    ['23012', 'open', 'naca_23012_selig_81.csv'],
  ])('NACA %s (%s TE) passes through the pinned ordinates within 1e-7 chord', (designation, trailingEdge, file) => {
    const { doc, id } = made({ designation, trailingEdge, points: 161 });
    const rows = readCsv(file);
    expect(rows).toHaveLength(161);
    const curve = curveOf(doc, id);
    const worst = Math.max(...rows.map((row) => distanceToCurve(curve, row)));
    expect(worst).toBeLessThan(1e-7);
  });

  it('creates the definition, a planar curve with the chord on +x and the leading edge at the origin', () => {
    const { doc, id, curveId } = made({ designation: 'NACA 0012', position: [1, 2, 3] });
    expect(doc.aero!.airfoils[id]).toMatchObject({
      id,
      entityId: curveId,
      normalize: 'none',
      source: { type: 'naca4', designation: 'NACA 0012', closedTrailingEdge: false, pointsPerSide: 80 },
      provenance: { verified: true },
    });
    const entity = doc.entities[curveId] as NurbsCurveEntity;
    expect(entity.position).toEqual([1, 2, 3]);
    expect(entity.curve.poles.every((pole) => pole[2] === 0)).toBe(true);
    expect(evaluateCurve(entity.curve, 0)[0]).toBeCloseTo(1, 12);
    expect(doc.order).toEqual([curveId]);
  });

  it('the fitted curve stays close to the analytic section between the ordinates', () => {
    const { doc, id } = made({ designation: '0012', points: 161 });
    const curve = curveOf(doc, id);
    const t = 0.12;
    const yt = (x: number): number => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
    let worst = 0;
    for (let i = 1; i < 99; i++) {
      const x = i / 100;
      worst = Math.max(worst, distanceToCurve(curve, [x, yt(x)]));
    }
    expect(worst).toBeLessThan(2e-6);
  });

  it('supports 5-digit 230-series, uniform spacing and a closed trailing edge', () => {
    const five = made({ designation: '23012' });
    expect(five.doc.aero!.airfoils[five.id]!.source).toMatchObject({ type: 'naca5' });
    const uniform = made({ designation: '4412', spacing: 'uniform', trailingEdge: 'closed', points: 41 });
    const curve = curveOf(uniform.doc, uniform.id);
    expect(evaluateCurve(curve, 0)[1]).toBeCloseTo(evaluateCurve(curve, 1)[1], 12);
  });

  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'airfoil_from_naca', { designation: '2412' }));
  });

  it.each([
    ['unknown series', { designation: '63-412' }, 'AERO_NACA_DESIGNATION_UNKNOWN'],
    ['unsupported 5-digit mean line', { designation: '24012' }, 'AERO_NACA_DESIGNATION_UNKNOWN'],
    ['zero thickness', { designation: '2400' }, 'AERO_NACA_DESIGNATION_UNKNOWN'],
    ['even point count', { designation: '0012', points: 160 }, 'AERO_PARAM_INVALID'],
    ['too few points', { designation: '0012', points: 11 }, 'AERO_PARAM_INVALID'],
  ])('%s is refused with a code', (_label, params, code) => {
    const result = execute(empty, 'airfoil_from_naca', params);
    expectNoOp(result, empty);
    expect(result.error?.code).toBe(code);
  });
});

describe('airfoil_properties (VC-SRF-09)', () => {
  it('NACA 0012 open TE matches the reference metrics', () => {
    const { doc, id } = made({ designation: '0012', trailingEdge: 'open', points: 161 });
    const result = execute(doc, 'airfoil_properties', { airfoilId: id });
    expect(result.document).toBe(doc);
    const data = result.data as Record<string, number | number[] | boolean | string>;
    expect(Math.abs((data['tMax'] as number) - 0.120035)).toBeLessThan(1e-5);
    expect(Math.abs((data['xTMax'] as number) - 0.2998)).toBeLessThan(1e-3);
    expect(Math.abs((data['teThickness'] as number) - 0.00252)).toBeLessThan(1e-6);
    expect(Math.abs((data['leRadius'] as number) - 0.015867)).toBeLessThan(5e-4);
    expect(Math.abs((data['area'] as number) - 0.08221)).toBeLessThan(1e-5);
    expect(data['camberMax']).toBeCloseTo(0, 6);
    expect((data['centroid'] as number[])[0]).toBeGreaterThan(0.38);
    expect((data['centroid'] as number[])[0]).toBeLessThan(0.43);
    expect(data['unit']).toBe('chord');
    expect(data['unverified']).toBe(false);
    expect(data['teAngleDeg']).toBeGreaterThan(10);
    expect(result.summary).toContain(id);
  });

  it('NACA 2412 reports its 2 % camber at 40 % chord', () => {
    const { doc, id } = made({ designation: '2412', trailingEdge: 'closed' });
    const data = execute(doc, 'airfoil_properties', { airfoilId: id }).data as {
      camberMax: number;
      xCamberMax: number;
      tMax: number;
      teThickness: number;
    };
    expect(data.camberMax).toBeCloseTo(0.02, 4);
    expect(data.xCamberMax).toBeCloseTo(0.4, 1);
    expect(data.tMax).toBeCloseTo(0.12, 3);
    expect(data.teThickness).toBeLessThan(1e-9);
  });

  it('refuses unknown airfoils, deleted curves and curves that are not sections', () => {
    const { doc, id, curveId } = made({ designation: '0012' });
    expect(execute(doc, 'airfoil_properties', { airfoilId: 'nope' }).error?.code).toBe('AERO_AIRFOIL_NOT_FOUND');
    const without = execute(doc, 'delete_entities', { ids: [curveId] }).document;
    expect(execute(without, 'airfoil_properties', { airfoilId: id }).error?.code).toBe('AERO_AIRFOIL_NOT_FOUND');
    const line = execute(doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    const swapped: CadDocument = {
      ...line.document,
      aero: { ...doc.aero!, airfoils: { [id]: { ...doc.aero!.airfoils[id]!, entityId: line.affected[0]! } } },
    };
    expect(execute(swapped, 'airfoil_properties', { airfoilId: id }).error?.code).toBe('AERO_PARAM_INVALID');
  });
});

describe('import_airfoil (VC-SRF-03, VC-SRF-04, VC-SRF-31, VC-SRF-32)', () => {
  const selig = readCsv('naca_2412_selig_81.csv')
    .map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`)
    .join('\n');
  const seligText = `NACA 2412 (test file)\n${selig}\n`;

  it('imports a Selig file, keeps the raw points with their sha256 and marks it unverified', () => {
    const result = execute(empty, 'import_airfoil', { text: seligText });
    const id = result.affected[0]!;
    const def = result.document.aero!.airfoils[id]!;
    expect(def.source).toMatchObject({ type: 'points', format: 'selig', name: 'NACA 2412 (test file)', sha256: sha256Hex(seligText) });
    expect((def.source as unknown as { points: unknown[] }).points).toHaveLength(161);
    expect(def.provenance.verified).toBe(false);
    expect(result.summary).toContain('UNVERIFIED');
    const props = execute(result.document, 'airfoil_properties', { airfoilId: id });
    expect((props.data as { unverified: boolean }).unverified).toBe(true);
    expect(props.summary).toContain('UNVERIFIED');
  });

  it('a pinned hash marks the airfoil verified; a wrong hash is refused', () => {
    const ok = execute(empty, 'import_airfoil', {
      text: seligText,
      expectedSha256: sha256Hex(seligText).toUpperCase(),
      source: 'UIUC test',
    });
    expect(ok.document.aero!.airfoils[ok.affected[0]!]!.provenance).toMatchObject({ verified: true });
    expect(ok.document.aero!.airfoils[ok.affected[0]!]!.provenance.source).toContain('UIUC test');
    const bad = execute(empty, 'import_airfoil', { text: seligText, expectedSha256: 'abc' });
    expectNoOp(bad, empty);
    expect(bad.error?.code).toBe('AERO_AIRFOIL_HASH_MISMATCH');
  });

  it('normalising to the chord restores a rotated file to LE (0,0) and TE (1,0)', () => {
    const angle = 0.05;
    const rotated = readCsv('naca_2412_selig_81.csv')
      .map(([x, y]) => [2 * (x * Math.cos(angle) - y * Math.sin(angle)) + 3, 2 * (x * Math.sin(angle) + y * Math.cos(angle)) - 1])
      .map(([x, y]) => `${x} ${y}`)
      .join('\n');
    const result = execute(empty, 'import_airfoil', { text: `rotated\n${rotated}`, normalize: 'chord' });
    const curve = (result.document.entities[result.affected[1]!] as NurbsCurveEntity).curve;
    const mid = (a: Vec3, b: Vec3): number[] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const te = mid(evaluateCurve(curve, 0), evaluateCurve(curve, 1));
    expect(te[0]).toBeCloseTo(1, 9);
    expect(te[1]).toBeCloseTo(0, 9);
    const metrics = execute(result.document, 'airfoil_properties', { airfoilId: result.affected[0]! }).data as { tMax: number };
    expect(metrics.tMax).toBeCloseTo(0.12, 3);
  });

  it('reads Lednicer files (counts line, upper then lower leading edge first)', () => {
    const rows = readCsv('naca_0012_selig_81.csv');
    const upper = rows.slice(0, 81).reverse();
    const lower = rows.slice(80);
    const fmt = (list: Array<[number, number]>): string => list.map(([x, y]) => `${x} ${y}`).join('\n');
    const text = `NACA 0012 Lednicer\n81. 81.\n\n${fmt(upper)}\n\n${fmt(lower)}\n`;
    const result = execute(empty, 'import_airfoil', { text });
    const def = result.document.aero!.airfoils[result.affected[0]!]!;
    expect(def.source).toMatchObject({ format: 'lednicer' });
    expect((def.source as unknown as { points: unknown[] }).points).toHaveLength(161);
    const pure = execute(empty, 'airfoil_from_naca', { designation: '0012' });
    const a = curveOf(result.document, result.affected[0]!);
    const b = curveOf(pure.document, pure.affected[0]!);
    expect(Math.hypot(...(evaluateCurve(a, 0.37).map((v, i) => v - evaluateCurve(b, 0.37)[i]!) as number[]))).toBeLessThan(1e-6);
  });

  it('removes a repeated leading-edge point before fitting', () => {
    const rows = readCsv('naca_0012_selig_81.csv');
    const text = ['dup', ...rows.slice(0, 81).map(([x, y]) => `${x} ${y}`), ...rows.slice(80).map(([x, y]) => `${x} ${y}`)].join('\n');
    expect(execute(empty, 'import_airfoil', { text }).affected).toHaveLength(2);
  });

  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'import_airfoil', { text: seligText }));
  });

  it.each([
    ['empty text', { text: '' }, 'AERO_AIRFOIL_PARSE'],
    ['non-numeric line', { text: 'name\n1 0\n0.5 abc\n0 0\n0.5 -0.1\n1 0' }, 'AERO_AIRFOIL_PARSE'],
    ['three columns', { text: 'name\n1 0 0\n0.5 0.1 0\n0 0 0\n0.5 -0.1 0\n1 0 0' }, 'AERO_AIRFOIL_PARSE'],
    ['fewer than 5 points', { text: 'name\n1 0\n0 0\n1 0.1' }, 'AERO_AIRFOIL_PARSE'],
    ['Lednicer counts mismatch', { text: 'name\n3. 3.\n0 0\n0.5 0.1\n1 0\n0 0\n0.5 -0.1', format: 'lednicer' }, 'AERO_AIRFOIL_PARSE'],
    ['Lednicer without counts', { text: 'name\n1 0\n0.5 0.1\n0 0\n0.5 -0.1\n1 0', format: 'lednicer' }, 'AERO_AIRFOIL_PARSE'],
    ['Lednicer too few points', { text: 'name\n2. 2.\n0 0\n1 0\n0 0\n1 0', format: 'lednicer' }, 'AERO_AIRFOIL_PARSE'],
  ])('%s is refused', (_label, params, code) => {
    const result = execute(empty, 'import_airfoil', params);
    expectNoOp(result, empty);
    expect(result.error?.code).toBe(code);
  });

  it('refuses crossing surfaces and a requested closed trailing edge with a gap', () => {
    const rows = readCsv('naca_0012_selig_81.csv');
    const crossed = rows.map(([x, y], i) => `${x} ${i > 80 ? Math.abs(y) + 0.02 : y}`).join('\n');
    expect(execute(empty, 'import_airfoil', { text: `crossed\n${crossed}` }).error?.code).toBe('AERO_AIRFOIL_SELF_INTERSECT');
    const open = execute(empty, 'import_airfoil', { text: seligText, trailingEdge: 'closed' });
    expect(open.error?.code).toBe('AERO_AIRFOIL_TE_GAP');
    expect(open.error?.paths).toEqual(['params.trailingEdge']);
  });

  it('refuses more than 2000 points', () => {
    const many = Array.from({ length: 2001 }, (_, i) => `${1 - i / 2000} ${Math.sin(i / 100) * 0.01}`).join('\n');
    expect(execute(empty, 'import_airfoil', { text: `big\n${many}` }).error?.code).toBe('AERO_AIRFOIL_PARSE');
  });
});

describe('aero document extension', () => {
  const { doc, id } = made({ designation: '0012' });
  const raw = (): Record<string, unknown> => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;

  it('accepts a document with valid definitions and one without an aero slice', () => {
    expect(aeroDocument.validate(raw())).toEqual([]);
    expect(aeroDocument.validate({})).toEqual([]);
    expect(aeroDocument.derivedEntityIds(doc).size).toBe(0);
    const input = raw();
    expect(aeroDocument.restore(input)).toBe(input);
  });

  it('reports malformed airfoil definitions', () => {
    const bad = raw();
    const airfoils = (bad['aero'] as { airfoils: Record<string, Record<string, unknown>> }).airfoils;
    airfoils[id] = { id: 'other', source: { type: 'x' }, normalize: 'x', provenance: 3, entityId: 'missing' };
    const errors = aeroDocument.validate(bad);
    expect(errors.join('\n')).toMatch(/id must equal its key/);
    expect(errors.join('\n')).toMatch(/source.type/);
    expect(errors.join('\n')).toMatch(/normalize/);
    expect(errors.join('\n')).toMatch(/provenance/);
    expect(errors.join('\n')).not.toMatch(/missing/);
    expect(aeroDocument.validate({ aero: 3 })).toEqual(['aero must be { airfoils, wings }']);
    const raws = raw();
    (raws['aero'] as { airfoils: Record<string, unknown> }).airfoils[id] = 5;
    expect(aeroDocument.validate(raws)[0]).toContain('must be an object');
  });

  it('checks the stored points and generator fields of an airfoil source', () => {
    const imported = execute(empty, 'import_airfoil', { text: `x\n1 0\n0.5 0.1\n0 0\n0.5 -0.1\n1 0` });
    const rawImported = JSON.parse(JSON.stringify(imported.document)) as Record<string, unknown>;
    expect(aeroDocument.validate(rawImported)).toEqual([]);
    const key = imported.affected[0]!;
    const defs = (rawImported['aero'] as { airfoils: Record<string, { source: Record<string, unknown> }> }).airfoils;
    defs[key]!.source['points'] = [[1, 0]];
    defs[key]!.source['sha256'] = '';
    expect(aeroDocument.validate(rawImported).join('\n')).toMatch(/at least 5/);
    const generated = raw();
    const generatedDefs = (generated['aero'] as { airfoils: Record<string, { source: Record<string, unknown> }> }).airfoils;
    delete generatedDefs[id]!.source['designation'];
    expect(aeroDocument.validate(generated).join('\n')).toMatch(/designation and pointsPerSide/);
  });
});
