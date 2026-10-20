import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type LoftEntity, type NurbsCurveEntity, type Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import { nacaOrdinates, parseNaca } from '@aero/aerodynamics/naca';
import { expectNoOp } from '../../../helpers/expectNoOp';

const empty = createEmptyDocument();
const naca = execute(empty, 'airfoil_from_naca', { designation: '0012' });
const airfoilId = naca.affected[0]!;
const curveId = naca.affected[1]!;

describe('create_wing section exactness', () => {
  it('refuses a degree-4 airfoil curve even for section 0 instead of silently lofting rings', () => {
    const raised = execute(naca.document, 'edit_nurbs', { id: curveId, operation: 'elevate_degree', by: 1 });
    const result = execute(raised.document, 'create_wing', {
      sections: [
        { airfoilId, span: 0, chord: 2 },
        { airfoilId, span: 3, chord: 1 },
      ],
    });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(raised.document);
    expect(result.error?.code).toBe('AERO_SECTIONS_INCOMPATIBLE');
    expect(result.summary).toContain('above degree 3');
  });

  it('normalises an airfoil imported with chord 2 away from the origin to the requested chord', () => {
    const rows = execute(naca.document, 'inspect_nurbs', { id: curveId });
    expect(rows.error).toBeUndefined();
    const scaled = (naca.document.entities[curveId] as NurbsCurveEntity).curve.poles.map(([x, y]) => `${2 * x + 5} ${2 * y - 1}`);
    const imported = execute(empty, 'import_airfoil', { text: `big\n${scaled.join('\n')}\n` });
    const id = imported.affected[0]!;
    const wing = execute(imported.document, 'create_wing', {
      sections: [
        { airfoilId: id, span: 0, chord: 1 },
        { airfoilId: id, span: 2, chord: 1 },
      ],
    });
    const loft = wing.document.entities[wing.affected[0]!] as LoftEntity;
    const xs = loft.sections![0]!.poles.map((p: Vec3) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0, 2);
    expect(Math.max(...xs)).toBeCloseTo(1, 2);
  });
});

describe('import_airfoil trailingEdge closed', () => {
  it('snaps the last point to the first so the curve closes at the trailing edge', () => {
    const sharp = execute(empty, 'airfoil_from_naca', { designation: '0012', trailingEdge: 'closed' });
    const rows = (sharp.document.entities[sharp.affected[1]!] as NurbsCurveEntity).curve.poles.map(([x, y]) => [x, y]);
    rows[rows.length - 1]![1]! += 5e-5;
    const text = `nearly closed\n${rows.map(([x, y]) => `${x} ${y}`).join('\n')}\n`;
    const ends = (doc: typeof empty, id: string): number => {
      const c = (doc.entities[id] as NurbsCurveEntity).curve;
      const [a, b] = [evaluateCurve(c, 0), evaluateCurve(c, 1)];
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    };
    const kept = execute(empty, 'import_airfoil', { text });
    const closed = execute(empty, 'import_airfoil', { text, trailingEdge: 'closed' });
    expect(ends(kept.document, kept.affected[1]!)).toBeGreaterThan(4e-5);
    expect(ends(closed.document, closed.affected[1]!)).toBeLessThan(1e-9);
    expect(closed.summary).toContain('Closed trailing edge');
    const wide = execute(empty, 'import_airfoil', {
      text: `blunt\n${(naca.document.entities[curveId] as NurbsCurveEntity).curve.poles.map(([x, y]) => `${x} ${y}`).join('\n')}\n`,
      trailingEdge: 'closed',
    });
    expectNoOp(wide, empty);
    expect(wide.error?.code).toBe('AERO_AIRFOIL_TE_GAP');
  });
});

describe('nacaOrdinates spacing', () => {
  it('uniform spacing has equally spaced stations, cosine clusters at the nose', () => {
    const section = parseNaca('0012');
    if (typeof section === 'string') throw new Error(section);
    const uniform = nacaOrdinates(section, 10, false, 'uniform');
    const upperX = uniform.slice(0, 11).map((p) => p[0]);
    expect(upperX[0]).toBeCloseTo(1, 12);
    expect(upperX[9]).toBeCloseTo(0.1, 1);
    const cosine = nacaOrdinates(section, 10, false);
    expect(cosine[9]![0]).toBeLessThan(0.03);
  });
});

describe('loft sections persistence guard', () => {
  const ring = (z: number): { degree: number; poles: number[][] } => ({
    degree: 3,
    poles: [
      [0, 0, z],
      [1, 1, z],
      [2, -1, z],
      [3, 0, z],
    ],
  });

  it('rejects a saved loft whose section is rational', () => {
    const first = execute(empty, 'create_nurbs_curve', ring(0));
    const second = execute(first.document, 'create_nurbs_curve', ring(1));
    const lofted = execute(second.document, 'loft_sections', { sectionIds: second.document.order });
    expect(lofted.affected).toHaveLength(1);
    expect(() => deserializeDocument(serializeDocument(lofted.document))).not.toThrow();
    const raw = JSON.parse(serializeDocument(lofted.document)) as {
      document: { entities: Record<string, { sections?: Array<{ weights?: number[] }> }> };
    };
    raw.document.entities[lofted.affected[0]!]!.sections![0]!.weights = [1, 1, 1, 2];
    expect(() => deserializeDocument(JSON.stringify(raw))).toThrow(/degree 1\.\.3/);
  });
});
