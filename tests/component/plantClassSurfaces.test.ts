/** VIS-M8f follow-up: plant bucket surfaces by namespaced class key; the material key ignores unrelated display changes. */
import { describe, expect, it } from 'vitest';
import type { Material } from '@core/model/types';
import { bucketSurface, classSurfacesKey, planClassSurfaces } from '@ui/viewport/3d/plant/plantClassSurfaces';

const material = { id: 'concrete', name: 'C', color: '#abcdef', metalness: 0.1, roughness: 0.95 } as unknown as Material;
const materials = { concrete: material };

describe('plantClassSurfaces', () => {
  it('a materialId equal to a class id is not taken for the class (and the class is not taken for the material)', () => {
    const classes = planClassSurfaces(['matclass:concrete', 'concrete'], undefined);
    expect(bucketSurface('matclass:concrete', materials, classes)).toEqual({ metalness: 0, roughness: 0.9 });
    expect(bucketSurface('concrete', materials, classes)).toBe(material);
    expect(bucketSurface('matclass:gone', materials, classes)).toBeUndefined();
    expect(bucketSurface('unassigned', materials, classes)).toBeUndefined();
  });

  it('keys on the used class surfaces only', () => {
    const keys = ['matclass:concrete', 'steel'];
    const base = classSurfacesKey(planClassSurfaces(keys, undefined));
    const otherClass = { colourProfiles: {}, materialClasses: { x: { id: 'x', name: 'x', colour: null, metalness: 1, roughness: 1 } } };
    const recoloured = {
      colourProfiles: {},
      materialClasses: { concrete: { id: 'concrete', name: 'C', colour: '#000000', metalness: 0, roughness: 0.9 } },
    };
    const reshaped = {
      colourProfiles: {},
      materialClasses: { concrete: { id: 'concrete', name: 'C', colour: null, metalness: 0.4, roughness: 0.2 } },
    };
    expect(classSurfacesKey(planClassSurfaces(keys, otherClass))).toBe(base);
    expect(classSurfacesKey(planClassSurfaces(keys, recoloured))).toBe(base);
    expect(classSurfacesKey(planClassSurfaces(keys, reshaped))).not.toBe(base);
  });
});
