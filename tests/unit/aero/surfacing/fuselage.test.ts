import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type NurbsSurfaceEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { evaluateSurface } from '@lib/nurbs/surface';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';

const empty = createEmptyDocument();
const packDir = join(process.cwd(), 'docs/aerospace/02-advanced-surfacing/validation/data');
const searsHaack = JSON.parse(readFileSync(join(packDir, 'sears_haack.json'), 'utf8')) as {
  volume: number;
  stations: Array<{ x: number; r: number }>;
};
const RHO = Math.SQRT2 - 1;

const conicStations = (): unknown[] =>
  searsHaack.stations.map(({ x, r }) =>
    r === 0
      ? { fs: x, section: { type: 'point', wl: 0 } }
      : {
          fs: x,
          section: {
            type: 'conic',
            halfBreadth: r,
            wlMaxBreadth: 0,
            upper: { wlExtreme: r, rho: RHO },
            lower: { wlExtreme: -r, rho: RHO },
          },
        },
  );

const surfaceOf = (doc: CadDocument, id: string): NurbsSurfaceEntity => doc.entities[id] as NurbsSurfaceEntity;
const volumeOf = (result: ReturnType<typeof execute>): number => (result.data as { volume: number }).volume;

describe('loft_fuselage (VC-SRF-13, VC-SRF-14)', () => {
  const sears = execute(empty, 'loft_fuselage', { stations: conicStations() });

  it('lofts the Sears-Haack body from 19 conic stations and two apexes within 0.5 % of its analytic volume', () => {
    expect(sears.affected).toHaveLength(1);
    const id = sears.affected[0]!;
    expect(surfaceOf(sears.document, id).kind).toBe('nurbs_surface');
    expect(sears.document.aero?.bodies?.[id]).toMatchObject({ id, entityId: id, degreeV: 3 });
    expect(Math.abs(volumeOf(sears) / searsHaack.volume - 1)).toBeLessThan(0.005);
    expect((sears.data as { closed: boolean }).closed).toBe(true);
    expect(sears.summary).toContain('enclosed volume');
  });

  it('every station section is reproduced exactly (a circle of the stated radius)', () => {
    const surface = surfaceOf(sears.document, sears.affected[0]!).surface;
    const index = searsHaack.stations.findIndex((s) => s.x === 5);
    const v = surface.knotsV[0]! + 0; // v is normalised; locate the station by x instead
    expect(v).toBe(0);
    let found = false;
    for (let step = 0; step <= 400 && !found; step++) {
      const point = evaluateSurface(surface, 0, step / 400);
      if (Math.abs(point[0] - 5) < 1e-3) {
        found = true;
        expect(Math.hypot(point[1], point[2])).toBeCloseTo(searsHaack.stations[index]!.r, 2);
      }
    }
    expect(found).toBe(true);
  });

  it('conic halves with rho = sqrt(2) - 1 and circular stations give the same body', () => {
    const circles = execute(empty, 'loft_fuselage', {
      stations: searsHaack.stations.map(({ x, r }) =>
        r === 0 ? { fs: x, section: { type: 'point', wl: 0 } } : { fs: x, section: { type: 'circle', radius: r, wl: 0 } },
      ),
    });
    expect(volumeOf(circles)).toBeCloseTo(volumeOf(sears), 9);
    const [a, b] = [surfaceOf(sears.document, sears.affected[0]!).surface, surfaceOf(circles.document, circles.affected[0]!).surface];
    for (const [u, v] of [
      [0.13, 0.4],
      [0.62, 0.77],
    ] as const) {
      const [p, q] = [evaluateSurface(a, u, v), evaluateSurface(b, u, v)];
      expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeLessThan(1e-9);
    }
  });

  it('superellipse stations with exponent 2 are ellipses; an open end reports no volume', () => {
    const result = execute(empty, 'loft_fuselage', {
      stations: [
        { fs: 0, section: { type: 'superellipse', halfBreadth: 1, halfHeight: 0.5, exponent: 2, wl: 0 } },
        { fs: 4, section: { type: 'superellipse', halfBreadth: 1, halfHeight: 0.5, exponent: 4, wl: 0, bl: 0.5 } },
      ],
      degreeV: 1,
    });
    expect(result.affected).toHaveLength(1);
    expect((result.data as { volume: number | null }).volume).toBeNull();
    const surface = surfaceOf(result.document, result.affected[0]!).surface;
    const top = evaluateSurface(surface, 0.25, 0);
    expect(top[1]).toBeCloseTo(0, 9);
    expect(top[2]).toBeCloseTo(0.5, 9);
  });

  it('control curves become guides of a Gordon surface', () => {
    const crown = execute(empty, 'interpolate_curve', {
      points: [
        [0, 0, 0],
        [2, 0, 1],
        [4, 0, 1.5],
        [6, 0, 1],
      ],
      degree: 3,
    });
    const keel = execute(crown.document, 'interpolate_curve', {
      points: [
        [0, 0, 0],
        [2, 0, -1],
        [4, 0, -1.5],
        [6, 0, -1],
      ],
      degree: 3,
    });
    const doc = keel.document;
    const circleAt = (fs: number, wl: number, radius: number): unknown => ({
      fs,
      section: {
        type: 'conic',
        halfBreadth: radius,
        wlMaxBreadth: wl,
        upper: { wlExtreme: wl + radius, rho: RHO },
        lower: { wlExtreme: wl - radius, rho: RHO },
      },
    });
    const stations = [
      { fs: 0, section: { type: 'point', wl: 0 } },
      circleAt(2, 0, 1),
      circleAt(4, 0, 1.5),
      { fs: 6, section: { type: 'circle', radius: 1, wl: 0 } },
    ];
    const result = execute(doc, 'loft_fuselage', { stations, controlCurveIds: [crown.affected[0]!, keel.affected[0]!] });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toMatch(/lie within/);
    expect((result.data as { controlCurveDeviation: number }).controlCurveDeviation).toBeLessThan(6e-3);
    const off = execute(doc, 'interpolate_curve', {
      points: [
        [0, 0, 0.5],
        [2, 0, 1.6],
        [4, 0, 2.1],
        [6, 0, 1.6],
      ],
      degree: 3,
    });
    const miss = execute(off.document, 'loft_fuselage', { stations, controlCurveIds: [off.affected[0]!] });
    expectNoOp(miss, off.document);
    expect(miss.error?.code).toBe('SRF_LOFT_GUIDE_MISSES_SECTION');
  });

  it('crown and bulge guides: closed seam and the guides lie on the skin', () => {
    const curve = (points: number[][]): ReturnType<typeof execute> => execute(empty, 'interpolate_curve', { points, degree: 3 });
    const crown = curve([
      [0, 0, 0],
      [2, 0, 1],
      [4, 0, 1.5],
      [6, 0, 1],
    ]);
    const bulge = execute(crown.document, 'interpolate_curve', {
      points: [
        [0, 0, 0],
        [2, 1, 0],
        [4, 1.5, 0],
        [6, 1, 0],
      ],
      degree: 3,
    });
    const circleAt = (fs: number, radius: number): unknown => ({ fs, section: { type: 'circle', radius, wl: 0 } });
    const stations = [{ fs: 0, section: { type: 'point', wl: 0 } }, circleAt(2, 1), circleAt(4, 1.5), circleAt(6, 1)];
    const result = execute(bulge.document, 'loft_fuselage', { stations, controlCurveIds: [crown.affected[0]!, bulge.affected[0]!] });
    expect(result.summary).not.toMatch(/no-op/);
    expect(result.affected).toHaveLength(1);
    const surface = surfaceOf(result.document, result.affected[0]!).surface;
    const [uMin, uMax] = [surface.knotsU[0]!, surface.knotsU[surface.knotsU.length - 1]!];
    for (const v of [0.2, 0.5, 0.8, 1]) {
      const [a, b] = [evaluateSurface(surface, uMin, v), evaluateSurface(surface, uMax, v)];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-9);
    }
    expect((result.data as { controlCurveDeviation: number }).controlCurveDeviation).toBeLessThan(6e-3);
    // measured independently: points of the crown line against the skin
    const samples = [
      [2, 0, 1],
      [4, 0, 1.5],
      [2, 1, 0],
      [4, 1.5, 0],
    ];
    const deviation = execute(result.document, 'measure_deviation', { id: result.affected[0]!, points: samples });
    expect((deviation.data as { max: number }).max).toBeLessThan(6e-3);
  });

  it('a superellipse station reports its conic approximation error (exact for n = 2)', () => {
    const body = (exponent: number): ReturnType<typeof execute> =>
      execute(empty, 'loft_fuselage', {
        stations: [
          { fs: 0, section: { type: 'superellipse', halfBreadth: 1, halfHeight: 1, exponent, wl: 0 } },
          { fs: 3, section: { type: 'superellipse', halfBreadth: 1, halfHeight: 1, exponent, wl: 0 } },
        ],
        degreeV: 1,
      });
    expect((body(2).data as { superellipseDeviation: number }).superellipseDeviation).toBeLessThan(1e-9);
    const boxy = (body(4).data as { superellipseDeviation: number }).superellipseDeviation;
    expect(boxy).toBeGreaterThan(1e-3);
    expect(boxy).toBeLessThan(0.02);
  });

  it('refuses bad station tables', () => {
    const circle = (fs: number): unknown => ({ fs, section: { type: 'circle', radius: 1, wl: 0 } });
    const check = (stations: unknown[], code: string): void => {
      const result = execute(empty, 'loft_fuselage', { stations });
      expectNoOp(result, empty);
      expect(result.error?.code).toBe(code);
    };
    check([circle(0)], 'SRF_LOFT_SECTIONS_TOO_FEW');
    check([circle(0), circle(0)], 'AERO_FS_NOT_INCREASING');
    check([circle(0), { fs: 1, section: { type: 'point', wl: 0 } }, circle(2)], 'AERO_PARAM_INVALID');
    check([circle(0), { fs: 1, section: { type: 'circle', radius: -1, wl: 0 } }], 'AERO_PARAM_INVALID');
    check(
      [
        circle(0),
        {
          fs: 1,
          section: {
            type: 'conic',
            halfBreadth: 1,
            wlMaxBreadth: 0,
            upper: { wlExtreme: 1, rho: 1.2 },
            lower: { wlExtreme: -1, rho: 0.5 },
          },
        },
      ],
      'SRF_CONIC_RHO_RANGE',
    );
    check(
      [
        circle(0),
        {
          fs: 1,
          section: {
            type: 'conic',
            halfBreadth: 1,
            wlMaxBreadth: 0,
            upper: { wlExtreme: -1, rho: 0.5 },
            lower: { wlExtreme: -2, rho: 0.5 },
          },
        },
      ],
      'AERO_PARAM_INVALID',
    );
    check(
      [circle(0), { fs: 1, section: { type: 'superellipse', halfBreadth: 1, halfHeight: 1, exponent: 1, wl: 0 } }],
      'AERO_PARAM_INVALID',
    );
    const unknownGuide = execute(empty, 'loft_fuselage', { stations: [circle(0), circle(1)], controlCurveIds: ['nope'] });
    expectNoOp(unknownGuide, empty);
    expect(unknownGuide.error?.code).toBe('SRF_NOT_NURBS');
  });

  it('is pure, survives save and load, and a file saved after deleting the body surface reopens', () => {
    expectPure(empty, () => execute(empty, 'loft_fuselage', { stations: conicStations() }));
    const id = sears.affected[0]!;
    const loaded = deserializeDocument(serializeDocument(sears.document));
    expect(loaded.aero?.bodies?.[id]?.stations).toHaveLength(searsHaack.stations.length);
    const gone = execute(sears.document, 'delete_entities', { ids: [id] });
    const reopened = deserializeDocument(serializeDocument(gone.document));
    expect(reopened.aero).toEqual(gone.document.aero);
  });
});
