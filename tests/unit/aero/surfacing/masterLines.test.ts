import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';

const empty = createEmptyDocument();
const packDir = join(process.cwd(), 'docs/aerospace/02-advanced-surfacing/validation/data');
const searsHaack = JSON.parse(readFileSync(join(packDir, 'sears_haack.json'), 'utf8')) as {
  volume: number;
  stations: Array<{ x: number; r: number }>;
};

/** Crown, keel and max-breadth master lines of the Sears-Haack body through its tabulated radii. */
const masterLines = (): { doc: CadDocument; crown: string; keel: string; breadth: string } => {
  const through = (doc: CadDocument, points: number[][]): { doc: CadDocument; id: string } => {
    const made = execute(doc, 'interpolate_curve', { points, degree: 3 });
    return { doc: made.document, id: made.affected[0]! };
  };
  const stations = searsHaack.stations;
  const crown = through(
    empty,
    stations.map(({ x, r }) => [x, 0, r]),
  );
  const keel = through(
    crown.doc,
    stations.map(({ x, r }) => [x, 0, -r]),
  );
  const breadth = through(
    keel.doc,
    stations.map(({ x, r }) => [x, r, 0]),
  );
  return { doc: breadth.doc, crown: crown.id, keel: keel.id, breadth: breadth.id };
};

describe('loft_fuselage_from_master_lines (FR-SRF-19)', () => {
  const lines = masterLines();
  const length = searsHaack.stations[searsHaack.stations.length - 1]!.x;
  const fsList = Array.from({ length: 41 }, (_, k) => (length * k) / 40);

  it('derives conic sections at any FS: the Sears-Haack body lofts to within 0.5 % of its volume', () => {
    const result = execute(lines.doc, 'loft_fuselage_from_master_lines', {
      crownId: lines.crown,
      keelId: lines.keel,
      breadthId: lines.breadth,
      stations: fsList,
    });
    expect(result.affected).toHaveLength(1);
    const data = result.data as { volume: number; closed: boolean };
    expect(data.closed).toBe(true);
    expect(Math.abs(data.volume / searsHaack.volume - 1)).toBeLessThan(0.005);
    const bodyId = result.affected[0]!;
    expect(result.document.aero!.bodies![bodyId]!.stations).toHaveLength(41);
    expect(result.summary).toContain('loft_fuselage_from_master_lines');
    const middle = execute(result.document, 'fuselage_section_at', { bodyId, fs: length / 2 }).data as { halfBreadth: number };
    expect(middle.halfBreadth).toBeCloseTo(0.5, 3);
  });

  it('follows rho laws along the length (a parabolic belly is fuller than a circular one)', () => {
    const base = { crownId: lines.crown, keelId: lines.keel, breadthId: lines.breadth, stations: fsList };
    const circular = execute(lines.doc, 'loft_fuselage_from_master_lines', base).data as { volume: number };
    const fuller = execute(lines.doc, 'loft_fuselage_from_master_lines', {
      ...base,
      rhoUpper: [
        [0, 0.5],
        [10, 0.5],
      ],
      rhoLower: [
        [0, 0.3],
        [5, 0.6],
        [10, 0.45],
      ],
    }).data as { volume: number };
    expect(Math.abs(fuller.volume - circular.volume)).toBeGreaterThan(1e-3);
  });

  it('refuses unusable input without changing the document; is pure', () => {
    const base = { crownId: lines.crown, keelId: lines.keel, breadthId: lines.breadth, stations: fsList };
    const refused = (patch: Record<string, unknown>, code: string): void =>
      expectNoOp(execute(lines.doc, 'loft_fuselage_from_master_lines', { ...base, ...patch }), lines.doc, code);
    refused({ stations: [0] }, 'SRF_LOFT_SECTIONS_TOO_FEW');
    refused({ stations: [0, 5, 4] }, 'AERO_FS_NOT_INCREASING');
    refused({ stations: [0, 5, 20] }, 'AERO_PARAM_INVALID');
    refused({ crownId: 'nope' }, 'SRF_NOT_NURBS');
    refused({ rhoUpper: [[0, 1.5]] }, 'SRF_CONIC_RHO_RANGE');
    refused(
      {
        rhoLower: [
          [5, 0.4],
          [3, 0.4],
        ],
      },
      'SRF_CONIC_RHO_RANGE',
    );
    refused({ stations: [0, 2, 0.5 * length, 10], crownId: lines.keel, keelId: lines.crown }, 'AERO_MASTER_INCONSISTENT');
    // an apex in the middle of the body is refused
    const waist = (sign: number, breadthLine: boolean): number[][] =>
      [0, 2.5, 5, 7.5, 10].map((x, i) => {
        const r = [0.5, 0.3, 0, 0.3, 0.5][i]!;
        return breadthLine ? [x, r, 0] : [x, 0, sign * r];
      });
    const crown = execute(empty, 'interpolate_curve', { points: waist(1, false) });
    const keel = execute(crown.document, 'interpolate_curve', { points: waist(-1, false) });
    const breadth = execute(keel.document, 'interpolate_curve', { points: waist(1, true) });
    expectNoOp(
      execute(breadth.document, 'loft_fuselage_from_master_lines', {
        crownId: crown.affected[0]!,
        keelId: keel.affected[0]!,
        breadthId: breadth.affected[0]!,
        stations: [0, 5, 10],
      }),
      breadth.document,
      'AERO_MASTER_INCONSISTENT',
    );
    expectPure(lines.doc, () => execute(lines.doc, 'loft_fuselage_from_master_lines', base));
  });
});
