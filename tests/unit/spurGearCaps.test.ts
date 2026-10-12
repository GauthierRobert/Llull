import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { ExtrusionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { polygonArea } from '@core/lib/polygon';
import { isWatertight, signedVolume, triArea2D } from './gearTestUtils';

describe('add_spur_gear end caps (regression)', () => {
  for (const teeth of [12, 20, 42]) {
    it(`teeth=${teeth}: caps cover exactly the profile area and the solid is watertight`, () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'add_spur_gear', { module: 2, teeth, faceWidth: 5 });
      const gear = result.document.entities[result.affected[0]!] as ExtrusionEntity;
      const tris = entityToTriangles(gear, result.document);
      const area = polygonArea(gear.profile);
      const bottom = tris.filter((t) => t.every((v) => v[2] === 0));
      const top = tris.filter((t) => t.every((v) => v[2] === 5));
      expect(bottom.reduce((s, t) => s + triArea2D(t), 0)).toBeCloseTo(area, 6);
      expect(top.reduce((s, t) => s + triArea2D(t), 0)).toBeCloseTo(area, 6);
      expect(isWatertight(tris)).toBe(true);
      expect(signedVolume(tris)).toBeCloseTo(area * 5, 4);
    });
  }
});
