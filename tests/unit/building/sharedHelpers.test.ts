import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { failingRows, maxUtilisation } from '@aec/industrial/common/utilisation';
import { horneAlphaCritical } from '@aec/industrial/steelDesign/steelDesign';
import { weightKnPerMetre, GRAVITY } from '@aec/shared/numeric';
import { GAMMA_CRANE } from '@aec/shared/loadFactors';
import { commitBuilding } from '@aec/building/evaluate/evaluateElements';
import { getBuilding, levelElementsOf } from '@aec/building/model';
import { batterLevel } from '@aec/civil/earthworks/batter';
import { entityPlanPoint } from '@core/geometry/entityFrame';
import { stationText } from '@aec/civil/model';
import { planAreaM2 } from '@aec/shared/planArea';
import { svgText } from '@aec/shared/sheetFrame';
import { deflectionCheckLine, shearCheckLine } from '@aec/industrial/steelDesign/steelMemberRows';
import { run } from '../../helpers/runFixtures';

describe('utilisation reductions', () => {
  it('maxUtilisation is the largest value, 0 when empty', () => {
    expect(maxUtilisation([{ utilisation: 0.4 }, { utilisation: 1.2 }, { utilisation: 0.9 }])).toBe(
      1.2,
    );
    expect(maxUtilisation([])).toBe(0);
  });

  it('failingRows keeps only utilisation above 1', () => {
    const rows = [{ utilisation: 1 }, { utilisation: 1.01 }, { utilisation: 0.2 }];
    expect(failingRows(rows)).toEqual([{ utilisation: 1.01 }]);
    expect(failingRows([])).toEqual([]);
  });
});

describe('horneAlphaCritical', () => {
  it('takes the lowest h / (200 drift) over compressed, drifting storeys', () => {
    const result = horneAlphaCritical([
      { id: 'a', height: 4000, drift: 10, compression: 5 },
      { id: 'b', height: 3000, drift: 10, compression: 5 },
      { id: 'c', height: 1000, drift: 10, compression: 0 },
      { id: 'd', height: 1000, drift: 0, compression: 5 },
    ]);
    expect(result).toEqual({ alpha: 1.5, id: 'b' });
  });

  it('is Infinity with no id when nothing sways under compression', () => {
    expect(horneAlphaCritical([])).toEqual({ alpha: Infinity, id: null });
  });
});

describe('load helpers', () => {
  it('converts kg/m to kN/m and shares the crane factor', () => {
    expect(weightKnPerMetre(100)).toBeCloseTo((100 * GRAVITY) / 1000, 12);
    expect(GAMMA_CRANE).toBe(1.35);
  });
});

describe('commitBuilding', () => {
  it('accepts a summary callback that sees the regenerated document', () => {
    let doc = run(createEmptyDocument(), 'add_level', { name: 'L0' });
    doc = run(doc, 'add_column', { location: [1000, 1000] });
    const building = getBuilding(doc);
    const ids = Object.keys(building.elements);
    const result = commitBuilding(
      doc,
      building,
      ids,
      (document) => `has ${Object.keys(document.building?.elements ?? {}).length}`,
    );
    expect(result.summary).toBe(`has ${ids.length}`);
    expect(result.affected).toEqual(expect.arrayContaining(ids));
    expect(result.data).toBeUndefined();
  });
});

describe('levelElementsOf', () => {
  it('lists the elements of a category on one level only', () => {
    let doc = run(createEmptyDocument(), 'add_level', { name: 'L0' });
    doc = run(doc, 'add_column', { location: [1000, 1000] });
    const building = getBuilding(doc);
    const levelId = building.levelOrder[0] as string;
    expect(levelElementsOf(building, 'column', levelId)).toHaveLength(1);
    expect(levelElementsOf(building, 'column', 'missing')).toHaveLength(0);
    expect(levelElementsOf(building, 'wall', levelId)).toHaveLength(0);
  });
});

describe('civil helpers', () => {
  it('batterLevel rises in cut and falls in fill', () => {
    expect(batterLevel(10, 4, 'cut', 2, 3)).toBe(12);
    expect(batterLevel(10, 6, 'fill', 2, 3)).toBe(8);
  });

  it('entityPlanPoint rotates about Z then translates', () => {
    const point = entityPlanPoint({ position: [10, 20, 0], rotation: [0, 0, Math.PI / 2] }, [1, 0]);
    expect(point[0]).toBeCloseTo(10, 12);
    expect(point[1]).toBeCloseTo(21, 12);
  });

  it('stationText formats a document-unit station', () => {
    expect(stationText({ units: 'mm' }, 1_234_500)).toBe('1+234.50');
  });
});

describe('second-pass shared helpers', () => {
  it('planAreaM2 converts a document-unit outline to m²', () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [2000, 0],
      [2000, 3000],
      [0, 3000],
    ];
    expect(planAreaM2(createEmptyDocument(), square)).toBeCloseTo(6);
    expect(planAreaM2(createEmptyDocument(), [])).toBe(0);
  });

  it('svgText escapes content and rotates only when asked', () => {
    expect(svgText(1, 2, 3, 'middle', 'a<b')).toBe(
      '<text x="1" y="2" font-size="3" text-anchor="middle">a&lt;b</text>',
    );
    expect(svgText(1, 2, 3, 'start', 'x', 90)).toContain('transform="rotate(90 1 2)"');
  });

  it('shear and deflection check lines carry utilisation and detail', () => {
    const shear = shearCheckLine('B1', 'ULS 1', 0.5, 50, 100);
    expect(shear).toMatchObject({ name: 'shear (§6.2.6)', utilisation: 0.5, combination: 'ULS 1' });
    expect(shear.detail).toBe('B1: V 50.0 kN ≤ Vpl,Rd 100 kN');
    const deflection = deflectionCheckLine('B1', 'L/250', 30, 20);
    expect(deflection).toMatchObject({ name: 'deflection (L/250)', utilisation: 1.5 });
    expect(deflection.detail).toBe('B1: δ 30.0 mm ≤ L/250 = 20.0 mm');
  });
});
