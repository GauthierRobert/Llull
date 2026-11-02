/** Plant 01 PSC M4: `buildShape` on synthetic rows: every refusal and every named simplification of the shape builders (the command tests cover the catalogue rows). */

import { describe, expect, it } from 'vitest';
import { buildShape } from '@aec/plant/catalog/shapes/build';
import type { ComponentShape, ShapeOutcome, ShapeSource } from '@aec/plant/catalog/shapes/shared';
import type { ComponentType } from '@aec/plant/catalog/types';

const source = (type: ComponentType, dims: Record<string, number>, over: Partial<ShapeSource> = {}): ShapeSource => ({
  type,
  standard: 'ASME B16.9',
  npsValue: 4,
  dims,
  pipeOdMm: 114.3,
  ...over,
});
const built = (outcome: ShapeOutcome): ComponentShape => {
  expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.shape;
};
const refusal = (outcome: ShapeOutcome, code: string): string => {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected a refusal');
  expect(outcome.code).toBe(code);
  return outcome.message;
};

describe('buildShape: pipes and elbows', () => {
  it('needs an outside diameter and a positive length for a pipe, and draws it solid without a wall', () => {
    refusal(buildShape(source('pipe', {}, { pipeOdMm: undefined, lengthMm: 100 })), 'PSC_SHAPE_UNSUPPORTED');
    refusal(buildShape(source('pipe', {}, { lengthMm: 0 })), 'PSC_SHAPE_UNSUPPORTED');
    refusal(buildShape(source('pipe', {})), 'PSC_SHAPE_UNSUPPORTED');
    const solid = built(buildShape(source('pipe', {}, { lengthMm: 500 })));
    expect(solid.hollow).toBe(false);
    expect(solid.notes).toEqual(['no wall: drawn solid']);
    expect(built(buildShape(source('pipe', { outsideDiameter: 60.3 }, { pipeOdMm: undefined, lengthMm: 500, wallMm: 3.9 }))).hollow).toBe(
      true,
    );
  });

  it('refuses an elbow without centre-to-end or outside diameter, and a bend not larger than the pipe', () => {
    expect(refusal(buildShape(source('elbow90', {})), 'PSC_CATALOG_ROW_MISSING')).toContain('centreToEnd');
    refusal(buildShape(source('elbow90', { centreToEnd: 100 }, { pipeOdMm: undefined })), 'PSC_SHAPE_UNSUPPORTED');
    refusal(buildShape(source('elbow90', { centreToEnd: 50 })), 'PSC_CATALOG_DIM_MISMATCH');
  });

  it('takes the OD from the row (bodyOd for forged fittings) and marks a socket-weld elbow SW', () => {
    const elbow = built(buildShape(source('elbow90', { centreToEnd: 38.1, bodyOd: 33.4, socketDepth: 12.7 }, { pipeOdMm: undefined })));
    expect(elbow.ports.map((port) => port.endType)).toEqual(['SW', 'SW']);
    expect(elbow.bounds.max[2]).toBeCloseTo(16.7, 9);
  });

  it('derives the radius from the centre-to-end when the bend radius or NPS is unknown (no straight ends), and from the factor otherwise', () => {
    const noRadius = built(buildShape(source('elbow45', { centreToEnd: 63.5 }, { radius: undefined })));
    expect(noRadius.notes.filter((note) => note.startsWith('straight ends'))).toEqual([]);
    expect(noRadius.frame).toContain('bend radius 153.3');
    const noNps = built(buildShape(source('elbow45', { centreToEnd: 63.5 }, { radius: 'LR', npsValue: null })));
    expect(noNps.frame).toContain('bend radius 153.3');
    const factor = built(buildShape(source('elbow45', { centreToEnd: 63.5 }, { radius: 'LR' })));
    expect(factor.frame).toContain('bend radius 152.400');
    const shortBy = built(buildShape(source('elbow45', { centreToEnd: 62.9 }, { radius: 'LR' })));
    expect(shortBy.notes.some((note) => note.includes('short of'))).toBe(true);
    expect(shortBy.ports[0]?.position[1]).toBe(0);
  });

  it('refuses straight ends longer than three diameters', () => {
    refusal(buildShape(source('elbow45', { centreToEnd: 500 }, { radius: 'LR' })), 'PSC_CATALOG_DIM_MISMATCH');
  });
});

describe('buildShape: tees, reducers, olets', () => {
  it('refuses tees without the run or branch length or the diameters, and a reducing tee without the branch diameter', () => {
    expect(refusal(buildShape(source('tee', {})), 'PSC_CATALOG_ROW_MISSING')).toContain('centreToEndRun');
    expect(refusal(buildShape(source('reducingTee', { centreToEndRun: 105 })), 'PSC_CATALOG_ROW_MISSING')).toContain('centreToEndBranch');
    refusal(buildShape(source('tee', { centreToEndRun: 105 }, { pipeOdMm: undefined })), 'PSC_SHAPE_UNSUPPORTED');
    refusal(buildShape(source('reducingTee', { centreToEndRun: 105, centreToEndBranch: 100 })), 'PSC_SHAPE_UNSUPPORTED');
  });

  it('draws a tee solid without a wall and an equal tee with the run value on the branch', () => {
    const tee = built(buildShape(source('tee', { centreToEnd: 105 })));
    expect(tee.hollow).toBe(false);
    expect(tee.notes).toContain('no wall: drawn solid');
    expect(tee.notes).toContain('equal tee: branch centre-to-end equals the run value');
  });

  it('draws a reducing tee hollow with a note on the assumed branch wall', () => {
    const tee = built(
      buildShape(
        source('reducingTee', { centreToEndRun: 143, centreToEndBranch: 137, smallOutsideDiameter: 114.3 }, { wallMm: 6, pipeOdMm: 168.3 }),
      ),
    );
    expect(tee.hollow).toBe(true);
    expect(tee.notes).toContain('branch wall assumed equal to the run wall');
  });

  it('refuses eccentric reducers and reducers without length or end diameters; draws a solid one without a wall', () => {
    refusal(buildShape(source('reducerEccentric', { length: 100 })), 'PSC_SHAPE_UNSUPPORTED');
    refusal(buildShape(source('reducerConcentric', {})), 'PSC_CATALOG_ROW_MISSING');
    refusal(buildShape(source('reducerConcentric', { length: 102 })), 'PSC_SHAPE_UNSUPPORTED');
    const reducer = built(buildShape(source('reducerConcentric', { length: 102 }, { smallPipeOdMm: 60.3 })));
    expect(reducer.hollow).toBe(false);
    expect(reducer.notes).toEqual(['no wall: drawn solid']);
  });

  it('draws an olet from the outlet distance, solid without a bore, at the branch pipe diameter when the row has no body OD', () => {
    refusal(buildShape(source('weldolet', {})), 'PSC_CATALOG_ROW_MISSING');
    refusal(buildShape(source('weldolet', { centreToOutlet: 144 })), 'PSC_SHAPE_UNSUPPORTED');
    const olet = built(buildShape(source('sockolet', { centreToOutlet: 50 }, { smallPipeOdMm: 33.4 })));
    expect(olet.hollow).toBe(false);
    expect(olet.ports[0]).toMatchObject({ endType: 'SW', outsideDiameterMm: 33.4 });
    expect(olet.notes.join(' ')).toContain('no bodyOd');
  });
});

describe('buildShape: flanges, gaskets, valves, the rest', () => {
  const flange = { outsideDiameter: 228.6, thickness: 22.4 };

  it('refuses flanges without OD, thickness or pipe OD', () => {
    expect(refusal(buildShape(source('flangeWeldNeck', {})), 'PSC_CATALOG_ROW_MISSING')).toContain('outsideDiameter');
    refusal(buildShape(source('flangeWeldNeck', flange, { pipeOdMm: undefined })), 'PSC_SHAPE_UNSUPPORTED');
  });

  it('draws a blind flange solid with one port, and a socket-weld flange with its pipe-side end type', () => {
    const blind = built(buildShape(source('flangeBlind', flange, { standard: 'ASME B16.5', ratingClass: 150, facing: 'RF' })));
    expect(blind.ports).toHaveLength(1);
    expect(blind.hollow).toBe(false);
    expect(blind.notes.join(' ')).toContain('bolt holes not drawn');
    const socket = built(buildShape(source('flangeSocketWeld', flange)));
    expect(socket.ports[1]?.endType).toBe('SW');
    expect(socket.notes).toContain('no pipe wall: bore taken as the pipe outside diameter');
  });

  it('names a raised face it cannot draw, and draws a hub when the row and the wall allow it', () => {
    const noFaceDiameter = built(buildShape(source('flangeWeldNeck', flange, { standard: 'ASME B16.5', ratingClass: 150, facing: 'RF' })));
    expect(noFaceDiameter.notes.join(' ')).toContain('raised face not drawn');
    const hub = built(
      buildShape(
        source(
          'flangeWeldNeck',
          { ...flange, hubOd: 140, lengthThroughHub: 60, raisedFaceDiameter: 157.2, boltCircle: 190.5, boltCount: 8, boltHole: 19.05 },
          { standard: 'ASME B16.5', ratingClass: 150, facing: 'RF', wallMm: 6 },
        ),
      ),
    );
    expect(hub.notes).toEqual([]);
    expect(hub.bounds.max[2]).toBeCloseTo(60, 9);
    expect(hub.bounds.min[2]).toBeCloseTo(-1.6, 9);
    expect(hub.ports[1]?.position[2]).toBeCloseTo(60, 9);
    expect(hub.stats.leaves).toBe(9);
  });

  it('refuses ring-joint gaskets and gaskets without ring diameters, and assumes sheet-gasket thickness openly', () => {
    refusal(buildShape(source('gasketRing', { innerRingId: 100, centeringRingOd: 150 })), 'PSC_SHAPE_UNSUPPORTED');
    refusal(buildShape(source('gasketSpiralWound', {}, { pipeOdMm: undefined })), 'PSC_SHAPE_UNSUPPORTED');
    refusal(buildShape(source('gasketSpiralWound', { innerRingId: 200, centeringRingOd: 150 })), 'PSC_SHAPE_UNSUPPORTED');
    const sheet = built(buildShape(source('gasketSheet', { outsideDiameter: 190 }, { wallMm: 6 })));
    expect(sheet.bounds.max[2]).toBeCloseTo(1.6, 9);
    expect(sheet.notes[0]).toContain('ASSUMED');
    const listed = built(buildShape(source('gasketSpiralWound', { innerRingId: 106.4, centeringRingOd: 174.8, thickness: 3.2 })));
    expect(listed.notes).toEqual([]);
  });

  it('refuses valves without face-to-face or flange diameter, and any type without a recipe', () => {
    expect(refusal(buildShape(source('valveGate', {})), 'PSC_CATALOG_ROW_MISSING')).toContain('faceToFace');
    refusal(buildShape(source('valveBall', { faceToFace: 229 })), 'PSC_SHAPE_UNSUPPORTED');
    const valve = built(buildShape(source('valveBall', { faceToFace: 229, flangeOutsideDiameter: 230 }, { pipeOdMm: undefined })));
    expect(valve.bounds.max[0]).toBe(115);
    for (const type of ['cap', 'coupling', 'union', 'swage', 'boltSet', 'reducerEccentric'] as const)
      refusal(buildShape(source(type, { length: 50, centreToEnd: 50 })), 'PSC_SHAPE_UNSUPPORTED');
  });
});

describe('buildShape: hostile rows', () => {
  it('draws no bolt holes for a count outside 1 to 128 (the recipe stays bounded) and says so', () => {
    const row = { outsideDiameter: 228.6, thickness: 22.4, boltCircle: 190.5, boltHole: 19.05 };
    for (const boltCount of [1e9, 129, 0, 2.5]) {
      const flange = built(
        buildShape(source('flangeWeldNeck', { ...row, boltCount }, { standard: 'ASME B16.5', ratingClass: 150, facing: 'RF' })),
      );
      expect(flange.stats.leaves).toBe(1);
      expect(flange.notes.join(' ')).toContain('bolt holes not drawn');
    }
    expect(built(buildShape(source('flangeWeldNeck', { ...row, boltCount: 128 }))).stats.leaves).toBe(129);
  });

  it('refuses a zero dimension as a degenerate shape instead of building an empty solid', () => {
    refusal(buildShape(source('reducerConcentric', { length: 0 }, { smallPipeOdMm: 60.3 })), 'PSC_CATALOG_DIM_MISMATCH');
    refusal(buildShape(source('flangeBlind', { outsideDiameter: 0, thickness: 22.4 })), 'PSC_CATALOG_DIM_MISMATCH');
    refusal(buildShape(source('valveGate', { faceToFace: 0, flangeOutsideDiameter: 230 })), 'PSC_CATALOG_DIM_MISMATCH');
  });
});

describe('buildShape: inconsistent flange rows', () => {
  const row = { outsideDiameter: 228.6, thickness: 22.4, raisedFaceDiameter: 157.2, boltCircle: 190.5, boltCount: 8, boltHole: 19.05 };
  const ctx = { standard: 'ASME B16.5', ratingClass: 150, facing: 'RF' };
  const mismatch = (dims: Record<string, number>, over: Partial<ShapeSource> = {}): void => {
    refusal(buildShape(source('flangeWeldNeck', dims, { ...ctx, ...over })), 'PSC_CATALOG_DIM_MISMATCH');
  };

  it('refuses a wall that leaves no bore (wall at or above the pipe radius)', () => {
    mismatch(row, { wallMm: 57.15 });
    mismatch(row, { wallMm: 1e9 });
    expect(built(buildShape(source('flangeWeldNeck', row, { ...ctx, wallMm: 6 }))).hollow).toBe(true);
  });

  it('refuses a bore wider than the flange, a raised face or hub beyond the flange, and a hub inside the bore', () => {
    mismatch({ ...row, outsideDiameter: 100 });
    mismatch({ ...row, raisedFaceDiameter: 300 });
    mismatch({ ...row, hubOd: 300, lengthThroughHub: 60 }, { wallMm: 6 });
    mismatch({ ...row, hubOd: 100, lengthThroughHub: 60 }, { wallMm: 6 });
  });

  it('refuses bolt holes that run past the flange edge or into the bore', () => {
    mismatch({ ...row, boltCircle: 300 });
    mismatch({ ...row, boltCircle: 100 });
  });
});
