/** 09 VIS §5.6 / §12.17: the plant default material class of an entity (derived at render time, no document write) and its use by render_view. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { surfaceShadingOf } from '@core/commands/render/surfaceShading';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { defaultClassOfElement, defaultClassOfRunPart } from '@aec/plant/display/defaultMaterialClass';
import type { BuildingElement } from '@aec/building/types';
import { apply } from '../../../helpers/commandAssertions';
import { gratedFrame } from '../structures/accessFixtures';
import { valveScene } from '../piping/rteFixtures';

const defaultsOf = (doc: CadDocument): Record<string, string[]> => {
  const ctx = defaultContext();
  const byClass: Record<string, string[]> = {};
  for (const id of doc.order) {
    const value = ctx.properties?.(doc, id)['defaultMaterialClass'];
    if (typeof value === 'string') (byClass[value] ??= []).push(id);
  }
  return byClass;
};

describe('plant default material classes', () => {
  it('gives plant gratings the grating class and steel frame members painted steel, by element category', () => {
    const { doc, ids } = gratedFrame();
    const byClass = defaultsOf(doc);
    const gratingEntities = ids.flatMap((id) => doc.building?.elements[id]?.entityIds ?? []);
    expect(gratingEntities.length).toBeGreaterThan(0);
    expect(byClass['grating']).toEqual(expect.arrayContaining(gratingEntities));
    expect(byClass['grating']).toHaveLength(gratingEntities.length);
    expect(byClass['structural_steel_painted']?.length).toBeGreaterThan(0);
  });

  it('gives a plant valve the cast steel valve class and the rest of the line carbon steel pipe', () => {
    const { doc, runId } = valveScene();
    const byClass = defaultsOf(doc);
    expect(byClass['cast_steel_valve']?.every((id) => id.startsWith(`${runId}/valve-`))).toBe(true);
    expect(byClass['cast_steel_valve']?.length).toBeGreaterThan(0);
    expect(byClass['carbon_steel_pipe_painted']?.length).toBeGreaterThan(0);
  });

  it('maps categories, materials and part kinds as documented and leaves other categories without a class', () => {
    const element = (category: string, material = ''): BuildingElement => ({ category, material }) as unknown as BuildingElement;
    expect(defaultClassOfElement(element('railing'))).toBe('galvanized_steel');
    expect(defaultClassOfElement(element('ladder'))).toBe('galvanized_steel');
    expect(defaultClassOfElement(element('steelStair'))).toBe('galvanized_steel');
    expect(defaultClassOfElement(element('equipment'))).toBe('structural_steel_painted');
    expect(defaultClassOfElement(element('column', 'Steel S355'))).toBe('structural_steel_painted');
    expect(defaultClassOfElement(element('slab', 'Concrete C30'))).toBe('concrete');
    expect(defaultClassOfElement(element('column', 'timber'))).toBeUndefined();
    expect(defaultClassOfElement(element('wall', 'steel'))).toBeUndefined();
    expect(defaultClassOfElement(element('toString'))).toBeUndefined();
    expect(defaultClassOfRunPart('valve')).toBe('cast_steel_valve');
    expect(defaultClassOfRunPart('elbow')).toBe('carbon_steel_pipe_painted');
    expect(defaultClassOfRunPart(undefined)).toBe('carbon_steel_pipe_painted');
  });

  it('shades a plant grating by default, an explicit assignment overrides it, and no document write happens', () => {
    const { doc, ids } = gratedFrame();
    const entity = doc.building?.elements[ids[0] as string]?.entityIds[0] as string;
    expect(doc.display?.materialClassOf).toBeUndefined();
    expect(surfaceShadingOf(doc, defaultContext())?.get(entity)).toEqual({ metalness: 0.7, roughness: 0.5 });
    const assigned = apply(doc, 'assign_material_class', { entityIds: [entity], classId: 'frp' });
    expect(surfaceShadingOf(assigned, defaultContext())?.get(entity)).toEqual({ metalness: 0, roughness: 0.7 });
    expect(surfaceShadingOf(doc, undefined)?.has(entity)).toBeFalsy();
  });

  it('renders an existing plant document (no assignment) with the default highlight: the picture differs from one without defaults', () => {
    const { doc } = gratedFrame();
    const view = { view: 'iso', width: 240, height: 180 };
    const withDefault = (execute(doc, 'render_view', view).data as { svgSha256: string }).svgSha256;
    const without = (execute(doc, 'render_view', view, { ...defaultContext(), properties: () => ({}) }).data as { svgSha256: string })
      .svgSha256;
    expect(withDefault).not.toBe(without);
  });

  it('draws no highlight and reports no class for a plain 3D document', () => {
    const plain = apply(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    expect(surfaceShadingOf(plain, defaultContext())).toBeUndefined();
  });
});
