/** 09 VIS §5.6: material classes (define / delete / assign / list), their colour in render_view and render_walkthrough, properties, load checks. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import {
  DEFAULT_MATERIAL_CLASSES,
  effectiveMaterialClasses,
  materialClassIdOfPlanKey,
  materialClassPlanKey,
  resolveEntityColour,
  withMaterialClassColours,
} from '@core/geometry/materialClasses';
import { coreEntityProperties } from '@core/geometry/entityProperties';
import { planScene } from '@core/geometry/renderPlan';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { apply, data, expectRefusal, ok } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';

function scene(): CadDocument {
  let doc = createEmptyDocument();
  for (const x of [0, 3000]) doc = apply(doc, 'add_box', { size: [1000, 1000, 1000], position: [x, 0, 500], color: '#808080' });
  return doc;
}
const [A, B] = scene().order as [string, string];
const top = (doc: CadDocument, extra: Record<string, unknown> = {}): string =>
  (execute(doc, 'render_view', { view: 'top', mode: 'vector', width: 300, height: 200, ...extra }).data as { svg: string }).svg;

interface Listed {
  classes: { id: string; colour: string | null; source: string; assigned: number }[];
}

describe('list_material_classes', () => {
  it('lists the ten named defaults of matclass:llull-v1 with no assignment', () => {
    const result = ok(scene(), 'list_material_classes', {});
    const { classes } = result.data as Listed;
    expect(classes.map((c) => c.id)).toEqual(DEFAULT_MATERIAL_CLASSES.map((c) => c.id));
    expect(classes).toHaveLength(10);
    expect(classes.find((c) => c.id === 'galvanized_steel')).toMatchObject({
      colour: '#a5a8a6',
      metalness: 0.8,
      roughness: 0.45,
      source: 'default',
    });
    expect(classes.find((c) => c.id === 'structural_steel_painted')?.colour).toBeNull();
    expect(result.summary).toContain('0 in use');
  });
});

describe('define_material_class', () => {
  const params = { id: 'painted_rail', colour: '#AA2211', metalness: 0.2, roughness: 0.4 };

  it('stores a class (colour lower-cased), lists it as a document class and adds no feature step', () => {
    const doc = scene();
    const result = ok(doc, 'define_material_class', params);
    expect(result.affected).toEqual([]);
    expect(result.document.display?.materialClasses?.['painted_rail']).toEqual({
      id: 'painted_rail',
      name: 'painted_rail',
      colour: '#aa2211',
      metalness: 0.2,
      roughness: 0.4,
    });
    expect(result.document.featureHistory).toEqual(doc.featureHistory);
    expect(result.document.entities).toBe(doc.entities);
    const listed = data<Listed>(result.document, 'list_material_classes', {}).classes;
    expect(listed).toHaveLength(11);
    expect(listed.at(-1)).toMatchObject({ id: 'painted_rail', source: 'document' });
  });

  it('overrides a named default in place and delete_material_class restores it', () => {
    const doc = apply(scene(), 'define_material_class', { id: 'concrete', colour: '#101010', metalness: 0, roughness: 1 });
    const classes = effectiveMaterialClasses(doc.display);
    expect(classes).toHaveLength(10);
    expect(classes.find((c) => c.id === 'concrete')?.colour).toBe('#101010');
    const restored = ok(doc, 'delete_material_class', { id: 'concrete' });
    expect(restored.summary).toContain('Restored the default');
    expect(restored.document.display?.materialClasses).toBeUndefined();
    expect(effectiveMaterialClasses(restored.document.display).find((c) => c.id === 'concrete')?.colour).toBe('#9a9a96');
  });

  it('refuses a bad id, colour or number with VIS_MATERIAL_CLASS_INVALID and leaves the document alone', () => {
    const doc = scene();
    expectRefusal(doc, 'define_material_class', { ...params, id: 'Bad Id' }, 'VIS_MATERIAL_CLASS_INVALID', 'id');
    expectRefusal(doc, 'define_material_class', { ...params, colour: 'red' }, 'VIS_MATERIAL_CLASS_INVALID', 'colour');
    expectRefusal(doc, 'define_material_class', { ...params, metalness: 1.5 }, 'VIS_MATERIAL_CLASS_INVALID', 'metalness');
    expectRefusal(doc, 'define_material_class', { ...params, roughness: -0.1 }, 'VIS_MATERIAL_CLASS_INVALID', 'roughness');
    expect(doc.display).toBeUndefined();
  });

  it('is pure', () => {
    const doc = scene();
    expectPure(doc, () => execute(doc, 'define_material_class', params));
  });
});

describe('assign_material_class', () => {
  it('assigns a class to existing entities (affected = those ids), skips unknown ids and counts them in the listing', () => {
    const doc = scene();
    const result = ok(doc, 'assign_material_class', { classId: 'concrete', entityIds: [A, 'nope', A] });
    expect(result.affected).toEqual([A]);
    expect(result.summary).toContain('Skipped unknown id(s): nope');
    expect(result.document.order).toEqual(doc.order);
    expect(result.document.display?.materialClassOf).toEqual({ [A]: 'concrete' });
    const listed = data<Listed>(result.document, 'list_material_classes', {}).classes;
    expect(listed.find((c) => c.id === 'concrete')?.assigned).toBe(1);
  });

  it('clears an assignment with classId null and drops the empty map', () => {
    const doc = apply(scene(), 'assign_material_class', { classId: 'frp', entityIds: [A, B] });
    const half = apply(doc, 'assign_material_class', { classId: null, entityIds: [A] });
    expect(half.display?.materialClassOf).toEqual({ [B]: 'frp' });
    const none = apply(half, 'assign_material_class', { classId: null, entityIds: [B] });
    expect(none.display?.materialClassOf).toBeUndefined();
  });

  it('refuses an unknown class and an id list without any existing entity', () => {
    const doc = scene();
    expectRefusal(doc, 'assign_material_class', { classId: 'unobtainium', entityIds: [A] }, 'VIS_MATERIAL_CLASS_NOT_FOUND', 'classId');
    expectRefusal(doc, 'assign_material_class', { classId: 'frp', entityIds: ['nope'] }, 'VIS_MATERIAL_CLASS_INVALID', 'entityIds');
    expectRefusal(doc, 'assign_material_class', { classId: 'frp', entityIds: [] }, 'VIS_MATERIAL_CLASS_INVALID', 'entityIds');
  });

  it('is pure and survives colour-profile commands (activate, deactivate, delete)', () => {
    const doc = apply(scene(), 'assign_material_class', { classId: 'frp', entityIds: [A] });
    expectPure(doc, () => execute(doc, 'assign_material_class', { classId: 'concrete', entityIds: [A] }));
    const rule = { id: 'r', when: { property: 'kind', equals: 'box' }, colour: '#ff0000', legend: 'l' };
    const profile = apply(doc, 'define_colour_profile', { id: 'p', name: 'P', rules: [rule] });
    const active = apply(profile, 'set_active_colour_profile', { profileId: 'p' });
    expect(active.display?.materialClassOf).toEqual({ [A]: 'frp' });
    expect(apply(active, 'set_active_colour_profile', { profileId: null }).display?.materialClassOf).toEqual({ [A]: 'frp' });
    expect(apply(active, 'delete_colour_profile', { profileId: 'p' }).display?.materialClassOf).toEqual({ [A]: 'frp' });
  });
});

describe('delete_material_class', () => {
  it('refuses an unknown or default-only id and a custom class still in use, then deletes it once cleared', () => {
    let doc = apply(scene(), 'define_material_class', { id: 'mine', colour: '#123456', metalness: 0, roughness: 0.5 });
    expectRefusal(doc, 'delete_material_class', { id: 'nope' }, 'VIS_MATERIAL_CLASS_NOT_FOUND', 'id');
    expectRefusal(doc, 'delete_material_class', { id: 'frp' }, 'VIS_MATERIAL_CLASS_NOT_FOUND', 'id');
    doc = apply(doc, 'assign_material_class', { classId: 'mine', entityIds: [A] });
    const refused = expectRefusal(doc, 'delete_material_class', { id: 'mine' }, 'VIS_MATERIAL_CLASS_IN_USE');
    expect(refused.error?.ids).toEqual([A]);
    doc = apply(doc, 'assign_material_class', { classId: null, entityIds: [A] });
    const deleted = ok(doc, 'delete_material_class', { id: 'mine' });
    expect(deleted.document.display?.materialClasses).toBeUndefined();
    expectPure(doc, () => execute(doc, 'delete_material_class', { id: 'mine' }));
  });
});

describe('the class in the picture and in the properties', () => {
  const classed = (): CadDocument =>
    apply(
      apply(scene(), 'define_material_class', { id: 'signal_red', colour: '#ff0000', metalness: 0, roughness: 0.5 }),
      'assign_material_class',
      { classId: 'signal_red', entityIds: [A] },
    );

  it('withMaterialClassColours recolours 3D entities of coloured classes only and returns the same object when nothing is assigned', () => {
    const doc = scene();
    expect(withMaterialClassColours(doc)).toBe(doc);
    const styled = withMaterialClassColours(classed());
    expect(styled.entities[A]?.color).toBe('#ff0000');
    expect(styled.entities[B]?.color).toBe('#808080');
    const mixed = apply(
      apply(doc, 'assign_material_class', { classId: 'structural_steel_painted', entityIds: [A] }),
      'assign_material_class',
      { classId: 'concrete', entityIds: [B] },
    );
    expect(withMaterialClassColours(mixed).entities[A]?.color).toBe('#808080');
    expect(withMaterialClassColours(mixed).entities[B]?.color).toBe('#9a9a96');
  });

  it('render_view draws the class colour; a matching profile rule wins; no assignment, no change', () => {
    const doc = scene();
    const plain = top(doc);
    const withClass = top(classed());
    expect(withClass).not.toBe(plain);
    expect(withClass).toContain('rgb(206,0,0)');
    expect(plain).not.toContain('rgb(206,0,0)');
    const rule = { id: 'blue', when: { property: 'id', equals: A }, colour: '#0000ff', legend: 'b' };
    const profiled = apply(classed(), 'define_colour_profile', { id: 'p', name: 'P', rules: [rule] });
    const viaRule = top(profiled, { colourProfileId: 'p' });
    expect(viaRule).not.toContain('rgb(206,0,0)');
    expect(viaRule).toBe(top(apply(doc, 'define_colour_profile', { id: 'p', name: 'P', rules: [rule] }), { colourProfileId: 'p' }));
  });

  it('a profile rule can test the materialClass property, which is also the plan material class', () => {
    const doc = classed();
    expect(coreEntityProperties(doc, A).materialClass).toBe('signal_red');
    expect(coreEntityProperties(doc, B).materialClass).toBeUndefined();
    expect(planScene(doc).materialClasses).toEqual(['matclass:signal_red', 'unassigned']);
    const rule = { id: 'sr', when: { property: 'materialClass', equals: 'signal_red' }, colour: '#00ff00', legend: 'sr' };
    const profiled = apply(doc, 'define_colour_profile', { id: 'p', name: 'P', rules: [rule] });
    const shown = execute(profiled, 'render_view', { view: 'top', mode: 'vector', width: 200, height: 100, colourProfileId: 'p' });
    expect((shown.data as { legend: { count: number }[] }).legend[0]?.count).toBe(1);
  });

  it('render_walkthrough frames show the class colour', () => {
    const camera = { projection: 'perspective', eye: [1500, -6000, 3000], direction: [0, 1, -0.4], fovDeg: 50 };
    const prepare = (doc: CadDocument): CadDocument => {
      const first = apply(doc, 'save_viewpoint', { name: 'a', camera });
      const second = apply(first, 'save_viewpoint', { name: 'b', camera: { ...camera, eye: [1600, -6000, 3000] } });
      const keys = [
        { viewpointId: 'vp-1', seconds: 1 },
        { viewpointId: 'vp-2', seconds: 1 },
      ];
      return apply(second, 'create_walkthrough', { name: 'w', keys });
    };
    const frames = (doc: CadDocument): string[] => {
      const result = execute(doc, 'render_walkthrough', { id: 'wt-3', fps: 1, width: 96, height: 64 });
      expect(result.error, result.summary).toBeUndefined();
      return (result.data as { frameSha256: string[] }).frameSha256;
    };
    expect(frames(prepare(classed()))).not.toEqual(frames(prepare(scene())));
  });
});

describe('load validation of display material classes', () => {
  const problems = (display: unknown): string[] => validateDocumentValues({ ...JSON.parse(JSON.stringify(scene())), display });
  const klass = (extra: Record<string, unknown>): unknown => ({
    colourProfiles: {},
    materialClasses: { x: { id: 'x', name: 'x', colour: null, metalness: 0, roughness: 0, ...extra } },
  });

  it('accepts classes and assignments and rejects malformed ones', () => {
    expect(problems({ ...(klass({ colour: '#112233' }) as object), materialClassOf: { [A]: 'x' } })).toEqual([]);
    expect(problems(klass({ id: 'y' })).join()).toContain('materialClasses');
    expect(problems(klass({ colour: 'red' })).join()).toContain('#rrggbb');
    expect(problems(klass({ metalness: 2 })).join()).toContain('[0, 1]');
    expect(problems({ colourProfiles: {}, materialClasses: 5 }).join()).toContain('must be a record');
    expect(problems({ colourProfiles: {}, materialClassOf: { [A]: 3 } }).join()).toContain('materialClassOf');
  });
});

describe('hostile display material class data', () => {
  const problems = (display: unknown): string[] => validateDocumentValues({ ...JSON.parse(JSON.stringify(scene())), display });

  it('rejects a reserved entity id key and a non-string class id', () => {
    const hostile = JSON.parse('{"colourProfiles":{},"materialClassOf":{"__proto__":"concrete"}}') as unknown;
    expect(problems(hostile).join()).toContain('reserved JavaScript property name');
    expect(problems({ colourProfiles: {}, materialClassOf: { [A]: { id: 'concrete' } } }).join()).toContain('materialClassOf');
    expect(problems({ colourProfiles: {}, materialClassOf: [] }).join()).toContain('materialClassOf');
  });
});

describe('assignments follow their entity', () => {
  it('deleting an assigned entity drops its assignment: counts, delete_material_class and the picture follow', () => {
    let doc = apply(scene(), 'define_material_class', { id: 'mine', colour: '#ff0000', metalness: 0, roughness: 0.5 });
    const before = top(doc);
    doc = apply(doc, 'assign_material_class', { classId: 'mine', entityIds: [A] });
    const deleted = apply(doc, 'delete_entities', { ids: [A] });
    expect(deleted.display?.materialClassOf).toBeUndefined();
    expect(data<Listed>(deleted, 'list_material_classes', {}).classes.find((c) => c.id === 'mine')?.assigned).toBe(0);
    expect(ok(deleted, 'delete_material_class', { id: 'mine' }).rejected).toBeUndefined();
    const onlyB = apply(scene(), 'delete_entities', { ids: [A] });
    expect(top(deleted)).toBe(top(onlyB));
    expect(before).not.toBe(top(doc));
  });

  it('keeps the assignments of the entities that stay', () => {
    const doc = apply(scene(), 'assign_material_class', { classId: 'frp', entityIds: [A, B] });
    expect(apply(doc, 'delete_entities', { ids: [A] }).display?.materialClassOf).toEqual({ [B]: 'frp' });
  });

  it('deleting an override of a default while entities use it restores the default for them', () => {
    let doc = apply(scene(), 'define_material_class', { id: 'concrete', colour: '#101010', metalness: 0, roughness: 1 });
    doc = apply(doc, 'assign_material_class', { classId: 'concrete', entityIds: [A] });
    expect(withMaterialClassColours(doc).entities[A]?.color).toBe('#101010');
    const restored = ok(doc, 'delete_material_class', { id: 'concrete' }).document;
    expect(restored.display?.materialClassOf).toEqual({ [A]: 'concrete' });
    expect(withMaterialClassColours(restored).entities[A]?.color).toBe('#9a9a96');
  });

  it('refuses 2D shapes and curves (never drawn in a class colour) but lets a clear through', () => {
    const doc = apply(scene(), 'draw_rectangle', { width: 10, height: 10 });
    const line = doc.order.at(-1) as string;
    const refused = expectRefusal(
      doc,
      'assign_material_class',
      { classId: 'frp', entityIds: [A, line] },
      'VIS_MATERIAL_CLASS_INVALID',
      'entityIds',
    );
    expect(refused.error?.ids).toEqual([line]);
    expect(ok(doc, 'assign_material_class', { classId: null, entityIds: [line] }).affected).toEqual([line]);
  });
});

describe('shared colour chain and plan key (VIS-M8f follow-up)', () => {
  const polyline = (): CadDocument =>
    apply(scene(), 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
  const withClass = (doc: CadDocument, id: string, classId: string): CadDocument =>
    apply(doc, 'assign_material_class', { classId, entityIds: [id] });

  it('resolveEntityColour: rule, then class colour, then profile default (not 2D), then null', () => {
    const doc = withClass(polyline(), A, 'stainless_steel');
    const [, , line] = doc.order as [string, string, string];
    const box = doc.entities[A]!;
    const plain = doc.entities[B]!;
    expect(resolveEntityColour(doc.display, box, '#ff0000', '#00ff00')).toBe('#ff0000');
    expect(resolveEntityColour(doc.display, box, null, '#00ff00')).toBe('#c0c4c8');
    expect(resolveEntityColour(doc.display, plain, null, '#00ff00')).toBe('#00ff00');
    expect(resolveEntityColour(doc.display, plain, null, 'entity')).toBeNull();
    expect(resolveEntityColour(doc.display, plain, null, undefined)).toBeNull();
    expect(resolveEntityColour(doc.display, doc.entities[line]!, null, '#00ff00')).toBeNull();
    const painted = withClass(doc, B, 'structural_steel_painted');
    expect(resolveEntityColour(painted.display, painted.entities[B]!, null, '#00ff00')).toBe('#00ff00');
  });

  it('render_view applies the same chain: a class colour beats the profile default, an unclassed box takes the default', () => {
    const profile = (defaultColour: string): Record<string, unknown> => ({
      id: 'p',
      name: 'P',
      rules: [{ id: 'r', when: { property: 'kind', equals: 'sphere' }, colour: '#ff0000', legend: 'none' }],
      defaultColour,
    });
    const both = withClass(withClass(scene(), A, 'stainless_steel'), B, 'stainless_steel');
    const green = top(apply(both, 'define_colour_profile', profile('#00ff00')), { colourProfileId: 'p' });
    const entity = top(apply(both, 'define_colour_profile', profile('entity')), { colourProfileId: 'p' });
    expect(green).toBe(entity);
    const one = withClass(scene(), A, 'stainless_steel');
    expect(top(apply(one, 'define_colour_profile', profile('#00ff00')), { colourProfileId: 'p' })).not.toBe(
      top(apply(one, 'define_colour_profile', profile('entity')), { colourProfileId: 'p' }),
    );
  });

  it('namespaces the plan key: a materialId equal to a class id is a different bucket', () => {
    expect(materialClassPlanKey('concrete')).toBe('matclass:concrete');
    expect(materialClassIdOfPlanKey('matclass:concrete')).toBe('concrete');
    expect(materialClassIdOfPlanKey('concrete')).toBeUndefined();
    const base = withClass(scene(), A, 'concrete');
    const doc = { ...base, entities: { ...base.entities, [B]: { ...base.entities[B]!, materialId: 'concrete' } } } as CadDocument;
    expect(planScene(doc).materialClasses).toEqual(['matclass:concrete', 'concrete']);
  });
});
