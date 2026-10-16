/** The dynamics model as document data: save / load, load-time validation, history replay, clear_document. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { dynamicsProblems } from '@core/commands/persistence/dynamicsValidation';
import { dynamicEntityIds } from '@ui/viewport/3d/animationClickHelpers';

function rotorDocument(): CadDocument {
  let doc = createEmptyDocument();
  const step = (name: string, params: Record<string, unknown>): string => {
    const result = execute(doc, name, params);
    doc = result.document;
    return result.affected[0] ?? '';
  };
  const disc = step('add_cylinder', { radius: 100, height: 20, axis: [0, 1, 0] });
  const frame = step('add_box', { size: [10, 10, 10], position: [0, 0, -200] });
  step('add_rigid_body', { entityIds: [frame], fixed: true, id: 'frame' });
  step('add_rigid_body', { entityIds: [disc], id: 'rotor', density: 2700 });
  step('add_body_joint', { id: 'shaft', kind: 'revolute', child: 'rotor', anchor: [0, 0, 0], axis: [0, 1, 0], damping: 0.01 });
  step('add_motor', {
    id: 'engine',
    joint: 'shaft',
    kind: 'torque_curve',
    curve: [
      [0, 10],
      [3000, 12],
    ],
  });
  step('add_motor', { id: 'governor', joint: 'shaft', kind: 'speed', rpm: 1000, maxTorque: 50 });
  step('add_propeller', { id: 'prop', joint: 'shaft', diameter: 1, thrustCoefficient: 0.1, powerCoefficient: 0.05 });
  step('set_gravity', { gravity: [0, 0, -1.62] });
  return doc;
}

describe('dynamics persistence', () => {
  it('round-trips through save / load unchanged', () => {
    const doc = rotorDocument();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.dynamics).toEqual(doc.dynamics);
  });

  it('replaying the feature history regenerates the same dynamics model (undo / redo / parametric edits)', () => {
    const doc = rotorDocument();
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(replayed.dynamics).toEqual(doc.dynamics);
  });

  it('clear_document removes the dynamics model', () => {
    const cleared = execute(rotorDocument(), 'clear_document', {}).document;
    expect(cleared.dynamics).toBeUndefined();
  });

  it('accepts a valid model and an absent one', () => {
    expect(dynamicsProblems(undefined)).toEqual([]);
    expect(dynamicsProblems(rotorDocument().dynamics)).toEqual([]);
  });

  it('reports malformed records with their table and id', () => {
    const dynamics = structuredClone(rotorDocument().dynamics) as unknown as Record<string, Record<string, Record<string, unknown>>>;
    expect(dynamicsProblems({ gravity: [0, 0] })[0]).toMatch(/gravity/);
    const broken = (table: string, id: string, patch: Record<string, unknown>): string[] => {
      const copy = structuredClone(dynamics);
      copy[table] = { ...copy[table], [id]: { ...copy[table]?.[id], ...patch } };
      return dynamicsProblems(copy);
    };
    expect(broken('bodies', 'rotor', { entityIds: [] })[0]).toMatch(/dynamics\.bodies\['rotor'\]: entityIds/);
    expect(broken('bodies', 'rotor', { fixed: 'no' })[0]).toMatch(/fixed must be a boolean/);
    expect(broken('bodies', 'rotor', { massKg: -1 })[0]).toMatch(/positive/);
    expect(broken('joints', 'shaft', { kind: 'ball' })[0]).toMatch(/kind/);
    expect(broken('joints', 'shaft', { parent: 3 })[0]).toMatch(/parent and child/);
    expect(broken('joints', 'shaft', { axis: [0, 1] })[0]).toMatch(/axis/);
    expect(broken('joints', 'shaft', { damping: -1 })[0]).toMatch(/damping/);
    expect(broken('motors', 'engine', { curve: [] })[0]).toMatch(/torque_curve/);
    expect(broken('motors', 'governor', { maxTorque: 0 })[0]).toMatch(/speed needs/);
    expect(broken('motors', 'engine', { kind: 'jet' })[0]).toMatch(/kind/);
    expect(broken('motors', 'engine', { joint: 1 })[0]).toMatch(/joint must be a string/);
    expect(broken('propellers', 'prop', { diameter: 0 })[0]).toMatch(/diameter/);
    expect(broken('propellers', 'prop', { powerCoefficient: -1 })[0]).toMatch(/coefficients/);
    expect(broken('propellers', 'prop', { thrustDirection: 'up' })[0]).toMatch(/thrustDirection/);
    expect(broken('propellers', 'prop', { joint: null })[0]).toMatch(/joint/);
    expect(broken('bodies', 'rotor', { id: 'other' })[0]).toMatch(/whose id is 'rotor'/);
    expect(dynamicsProblems({ ...dynamics, gears: { g: { id: 'g', driver: 'a', driven: 'b', ratio: 0 } } })[0]).toMatch(/ratio/);
    expect(dynamicsProblems({ ...dynamics, gears: { g: { id: 'g', driver: 1, driven: 'b', ratio: 1 } } })[0]).toMatch(/driver/);
    expect(dynamicsProblems({ ...dynamics, joints: 'none' })[0]).toMatch(/dynamics\.joints must be an object/);
    expect(dynamicsProblems({ ...dynamics, bodies: JSON.parse('{"__proto__": {}}') as unknown })).toEqual(
      expect.arrayContaining([expect.stringMatching(/reserved/)]),
    );
  });

  it('refuses a body hanging on two joints', () => {
    const dynamics = structuredClone(rotorDocument().dynamics) as unknown as Record<string, Record<string, Record<string, unknown>>>;
    const twice = { ...dynamics, joints: { ...dynamics['joints'], extra: { ...dynamics['joints']?.['shaft'], id: 'extra' } } };
    expect(dynamicsProblems(twice)).toEqual(["dynamics.joints: body 'rotor' is the child of more than one joint"]);
  });

  it('a document with broken dynamics is refused on load', () => {
    const doc = rotorDocument();
    const text = serializeDocument({ ...doc, dynamics: { ...doc.dynamics!, gravity: [0, 0] as unknown as [number, number, number] } });
    expect(() => deserializeDocument(text)).toThrow(/gravity/);
  });

  it('the viewport keeps moving (non-fixed) body entities out of instancing', () => {
    const doc = rotorDocument();
    const ids = dynamicEntityIds(doc.dynamics);
    expect([...ids]).toEqual(doc.dynamics?.bodies['rotor']?.entityIds);
    expect(dynamicEntityIds(undefined).size).toBe(0);
  });
});
