/** Pure feature recognition (07 FTR §5.6) over face graphs captured from the live OCC kernel. */
import { describe, expect, it } from 'vitest';
import { recognizeFeatures } from '@core/geometry/recognition/recognize';
import type { Recognition, RecognizeOptions } from '@core/geometry/recognition/types';
import { countersinkDepth } from '@lib/holeMath';
import { type FixtureName, RECOGNIZE_DEFAULTS, loadFixture, orientationOf } from '../../helpers/recognitionFixture';

const recognize = (name: FixtureName, options: Partial<RecognizeOptions> = {}, withOrientation = true): Recognition => {
  const fixture = loadFixture(name);
  return recognizeFeatures(
    fixture.graph,
    fixture.topology,
    { ...RECOGNIZE_DEFAULTS, ...options },
    withOrientation ? orientationOf(fixture) : undefined,
  );
};

const close = (actual: number | undefined, expected: number, tolerance = 1e-6): void => {
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThan(tolerance);
};

describe.each([
  ['with the kernel orientation', true],
  ['from the raw face flags', false],
])('the machined plate STEP (%s)', (_label, withOrientation) => {
  const found = recognize('machinedPlate', {}, withOrientation);

  it('has 4 countersinks, 2 counterbores, 1 blind drilled hole and 1 pocket, nothing else', () => {
    expect(found.holes.map((hole) => hole.subtype)).toEqual(
      ['counterbore', 'counterbore', 'countersink', 'countersink', 'countersink', 'countersink', 'simple'].sort(
        (a, b) => ['simple', 'counterbore', 'countersink'].indexOf(a) - ['simple', 'counterbore', 'countersink'].indexOf(b),
      ),
    );
    expect(found.pockets).toHaveLength(1);
    expect([found.fillets, found.chamfers, found.bends, found.unclassified]).toEqual([[], [], [], []]);
  });

  it('countersinks: diameter, cone diameter, included angle and depth (VC-FTR-17)', () => {
    const csk = found.holes.filter((hole) => hole.subtype === 'countersink');
    expect(csk.map((hole) => hole.axisPoint.slice(0, 2))).toEqual([
      [10, 10],
      [10, 50],
      [90, 10],
      [90, 50],
    ]);
    for (const hole of csk) {
      close(hole.diameter, 4.8);
      close(hole.cskDiameter, 9);
      close(hole.cskAngleDeg, 100, 1e-6);
      close(hole.cskDepth, countersinkDepth(4.8, 9, 100).value);
      expect(hole).toMatchObject({ through: true, axis: [0, 0, -1], confidence: 'exact' });
      expect(hole.axisPoint[2]).toBe(10);
      expect(hole.depth).toBeUndefined();
    }
  });

  it('counterbores and the blind hole with its drill point', () => {
    const bores = found.holes.filter((hole) => hole.subtype === 'counterbore');
    expect(bores.map((hole) => hole.axisPoint.slice(0, 2))).toEqual([
      [30, 30],
      [70, 30],
    ]);
    for (const hole of bores) {
      close(hole.diameter, 5.5);
      close(hole.cboreDiameter, 10);
      close(hole.cboreDepth, 5.5);
    }
    const blind = found.holes.find((hole) => !hole.through);
    expect(blind).toMatchObject({ subtype: 'simple', axis: [0, 0, -1], axisPoint: [50, 15, 10] });
    close(blind?.diameter, 6);
    close(blind?.depth, 6);
    close(blind?.drillPointAngleDeg, 118, 1e-6);
  });

  it('the pocket: floor height, depth, corner radius, no floor fillet, closed', () => {
    const [pocket] = found.pockets;
    expect(pocket).toMatchObject({ open: false, normal: [0, 0, 1] });
    close(pocket?.floorZ, 6);
    close(pocket?.depth, 4);
    close(pocket?.cornerRadius, 3);
    expect(pocket?.floorFillet).toBe(0);
    expect(pocket?.faceIndices.length).toBeGreaterThanOrEqual(9);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(recognize('machinedPlate', {}, withOrientation))).toBe(JSON.stringify(found));
  });
});

describe('split periodic faces (mergeSplitFaces)', () => {
  it('two half cylinders and two half cones are one blind hole with a 118 degree point', () => {
    const found = recognize('splitBlind');
    expect(found.holes).toHaveLength(1);
    const [hole] = found.holes;
    close(hole?.diameter, 6);
    close(hole?.depth, 6);
    close(hole?.drillPointAngleDeg, 118);
    expect(hole?.faceIndices.length).toBeGreaterThanOrEqual(4);
    expect(hole?.through).toBe(false);
  });

  it('without merging the halves are not full bores', () => {
    const found = recognize('splitBlind', { mergeSplitFaces: false });
    expect(found.holes).toEqual([]);
    expect(found.unclassified.length).toBeGreaterThan(0);
  });
});

describe('pockets', () => {
  it('a closed pocket with a floor fillet reports corner radius and fillet radius (PK-02 geometry)', () => {
    const [pocket, ...others] = recognize('pocketFillet').pockets;
    expect(others).toEqual([]);
    close(pocket?.depth, 5);
    close(pocket?.cornerRadius, 4);
    close(pocket?.floorFillet, 1.5);
    expect(pocket?.open).toBe(false);
  });

  it('a corner notch is an open pocket with two walls', () => {
    const [pocket] = recognize('openPocket').pockets;
    expect(pocket).toMatchObject({ open: true, cornerRadius: 0, floorFillet: 0 });
    close(pocket?.floorZ, 6);
    close(pocket?.depth, 4);
  });
});

describe('holes the plate does not have', () => {
  it('a flat-bottom blind hole and an ambiguous shallow countersink', () => {
    const { holes } = recognize('flatAndShallow');
    const flat = holes.find((hole) => !hole.through);
    expect(flat).toMatchObject({ subtype: 'simple', confidence: 'exact' });
    expect(flat?.drillPointAngleDeg).toBeUndefined();
    close(flat?.depth, 6);
    const shallow = holes.find((hole) => hole.through);
    expect(shallow).toMatchObject({ subtype: 'countersink', confidence: 'ambiguous' });
    close(shallow?.cskDepth, countersinkDepth(4.8, 5.4, 90).value);
  });
});

describe('fillets, chamfers and bends', () => {
  it('a convex fillet and a chamfer on a block', () => {
    const found = recognize('filletChamfer');
    expect(found.fillets).toHaveLength(1);
    expect(found.fillets[0]).toMatchObject({ convex: true });
    close(found.fillets[0]?.radius, 3);
    expect(found.chamfers).toHaveLength(1);
    close(found.chamfers[0]?.distance, 2);
    expect(found.holes).toEqual([]);
  });

  it('the bracket is one bend pair: inside radius, thickness, angle', () => {
    const { bends, fillets } = recognize('bracketL');
    expect(fillets).toEqual([]);
    expect(bends).toHaveLength(1);
    close(bends[0]?.innerRadius, 4.8);
    close(bends[0]?.thickness, 1.6);
    close(bends[0]?.angleDeg, 90, 1e-6);
  });

  it('the joggle strip has two bends', () => {
    const { bends } = recognize('joggleStrip');
    expect(bends).toHaveLength(2);
    for (const bend of bends) {
      close(bend.innerRadius, 1.6);
      close(bend.thickness, 1.6);
      close(bend.angleDeg, 20, 1e-6);
    }
  });
});

describe('kinds filter', () => {
  it('reports only the requested kinds', () => {
    const holesOnly = recognize('machinedPlate', { kinds: ['hole'] });
    expect(holesOnly.holes).toHaveLength(7);
    expect(holesOnly.pockets).toEqual([]);
    const pocketsOnly = recognize('machinedPlate', { kinds: ['pocket'] });
    expect(pocketsOnly.holes).toEqual([]);
    expect(pocketsOnly.pockets).toHaveLength(1);
  });
});
